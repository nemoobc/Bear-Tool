// ═══════════════════════════════════════════════════════════════
// Bear Tool — bridge.js
// Bridge view: native + CURATED ERC-20 (fail closed).
// LI.FI quote (real API, fetch timeout) — NO simulated fallback:
// a failed quote is an honest error, never a fake route.
// Context-bound quote validation, guarded execution path.
//
// Security contract (bridge.test.js is the executable spec):
//   1. Two picker options max: native, plus the ONE curated stable
//      family present on BOTH chains. Any ERC-20 not in POPULAR_TOKENS
//      for the source chain, or without a curated destination twin,
//      is rejected loudly BEFORE the fetch — never substituted.
//   2. Quotes are bound to an immutable context: sequence id,
//      networkId, chainId, address, token (native or exact from/to
//      addresses), decimals, from/to chains, amount.
//   3. Quote state is cleared before any await; stale (out-of-order)
//      responses are ignored by sequence id.
//   4. API responses are validated field-by-field against the
//      context (chains, BOTH token addresses, address, amount,
//      tx value/chainId — value must be 0 for ERC-20, >0 for native,
//      approvalAddress sanity, destination address + calldata).
//   5. Execution re-verifies the whole context against the live
//      form, current account, state networkId and provider network
//      BEFORE signing, and re-checks the provider network AFTER the
//      awaited getNetwork() call (TOCTOU). Tx details come only
//      from the quote-bound snapshot.
//   6. ERC-20 execution: allowance is read on-chain against the
//      quote-bound spender ONLY → approve (reset-0 first when a
//      stale partial allowance exists, USDT-style) → RE-QUOTE and
//      full re-validation (an approval wait can outlive the quote,
//      research 2026-10-05 A2.7) → bridge tx. A fresh quote naming
//      a different spender than we just approved aborts honestly.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { resolveMax } from './max-ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt, withTimeout } from './safetx.js';
const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

import { getAllNetworks, getNetworkById, POPULAR_TOKENS } from './network.js';
import { t } from './i18n.js';
import { BRIDGE_ROUTERS, getBridgeRoutersForChain, CHAIN_NAMES } from './routers.js';
import { BRIDGE_ROUTE_FETCHERS } from './bridge-routes.js';
import { initTokenPicker, initNetworkPicker, initOptionPicker } from './token-picker.js';
import { explainError } from './errors.js';

const { ethers } = globalThis;

// Monotonic sequence for quote requests — lets in-flight responses
// detect "a newer quote was requested" and discard themselves.
let quoteSeq = 0;

// ── fetch with timeout (AbortController) ──
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── address / chain helpers (shared by quote validation + exec guard) ──
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isAddress(a) {
  try { ethers.getAddress(String(a)); return true; }
  catch { return false; }
}

function sameAddr(a, b) {
  try { return ethers.getAddress(String(a)) === ethers.getAddress(String(b)); }
  catch { return false; }
}

function sameChainId(a, b) {
  try { return BigInt(a) === BigInt(b); }
  catch { return false; }
}

// destination calldata sanity (no bytecode interpretation — surface sanity only)
function saneTxData(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return false;
  if (data.length % 2 !== 0) return false;
  if (data.length > 2 + 2 * 100000) return false;   // >100KB calldata = abuse/DoS
  return true;
}

// execution destination sanity (quote-bound, checked again at exec)
function saneExecAddress(addr) {
  return isAddress(addr) && String(addr).toLowerCase() !== ZERO_ADDRESS;
}

// ── curated ERC-20 helpers — the second token in the picker ──
// Family = the stable/wrap slot a symbol fills, matched by lowercase prefix so
// the on-chain spellings land in the same bucket: 'USDT0' (polygon), 'USD₮0'
// (arbitrum), 'USDt' (avalanche) are all usdt; 'DAI.e' is dai.
function familyOf(sym) {
  const s = String(sym || '').toLowerCase();
  if (s.startsWith('usdc')) return 'usdc';
  if (s.startsWith('usdt') || s.startsWith('usd₮')) return 'usdt';
  if (s.startsWith('usdb')) return 'usdb';
  if (s.startsWith('dai')) return 'dai';
  if (s.startsWith('weth')) return 'weth';
  if (s.startsWith('wbtc')) return 'wbtc';
  return null;
}
const FAMILY_PRIORITY = ['usdc', 'usdt', 'usdb', 'dai', 'weth', 'wbtc'];

// LI.FI deny-lists the NATIVE token on these chains: live probe 2026-10-05
// (every amount, both directions) → HTTP 400 code 1011 "Token 42220-0x00…00
// is invalid or in deny list". ERC-20 on the SAME chain quotes fine (Celo
// USDC → World Chain: 200, tool=layerswap), so the chain stays in the router
// registry — only the NATIVE row drops out when a curated ERC-20 alternative
// exists. If no alternative exists, native stays as the last resort and fails
// honestly at quote time (an empty picker helps nobody).
// Same signal that removed 97/80002 from lifi.chains (js/routers.js:140).
const NATIVE_DENY_CHAINS = new Set([42220]);

/**
 * The picker options for a chain pair — at most TWO:
 * native first (unless deny-listed), then the first family curated on BOTH
 * chains (from the curated POPULAR_TOKENS list; the second row only appears
 * when a destination twin address exists — a token without one is a bridge to
 * nowhere). The returned ERC-20 entry carries the SOURCE address (what the
 * wallet sends) and the twin address (what the quote asks LI.FI to deliver).
 */
export function bridgeTokenOptions(fromNet, toNet) {
  const fromList = POPULAR_TOKENS[fromNet.chainId] || [];
  const toList = POPULAR_TOKENS[toNet.chainId] || [];
  const toFam = new Map(toList.map(t => [familyOf(t.symbol), t]));
  let erc20 = null;
  for (const fam of FAMILY_PRIORITY) {
    const src = fromList.find(t => familyOf(t.symbol) === fam);
    const dst = src ? toFam.get(fam) : null;
    if (src && dst) {
      erc20 = { value: src.address, symbol: src.symbol, decimals: src.decimals, toAddress: dst.address };
      break;
    }
  }
  const nativeDenied = NATIVE_DENY_CHAINS.has(fromNet.chainId) || NATIVE_DENY_CHAINS.has(toNet.chainId);
  const opts = [];
  if (!nativeDenied || !erc20) {
    opts.push({
      value: 'native', symbol: fromNet.symbol || 'Native', decimals: fromNet.decimals ?? 18, toAddress: null,
    });
  }
  if (erc20) opts.push(erc20);
  return opts;
}

/**
 * The approval decision for an ERC-20 bridge at execution time.
 * 'none' — native (skipApproval) or allowance already covers the amount.
 * 'approve' — fresh allowance: one exact-amount approve, never unlimited.
 * 'reset+approve' — a stale PARTIAL allowance: USDT-style tokens refuse
 *   0→N in one call, so the old value must be zeroed first (LI.FI approvals
 *   workflow, docs 2026-10-05).
 */
export function decideApproval({ skipApproval, allowance, amount }) {
  if (skipApproval) return 'none';
  if (allowance >= amount) return 'none';
  if (allowance > 0n) return 'reset+approve';
  return 'approve';
}

export function bindBridgeEvents() {
  // AUTO-ROUTE: quote refreshes automatically on any input change.
  // No manual "Get Route" button — the route is always live.
  const debouncedQuote = debounce(doBridge, 600);
  const el = (sel) => document.querySelector(sel);
  // Bridge had no MAX at all, unlike Send and Swap — so "send it all" meant
  // typing the number by hand and getting it wrong. Same rule as everywhere
  // else: subtract the fee when the token being bridged is the one paying it.
  const applyPct = async (pct) => {
    const tokSel = $('#bridgeToken');
    const t = (get('tokens') || []).find(x => (x.address || 'native') === tokSel?.value);
    const field = $('#bridgeAmount');
    const note = $('#bridgeMaxNote');
    if (!t || !field) return;
    const r = await resolveMax({
      token: { balance: t.balance, decimals: t.decimals, address: t.address, symbol: t.symbol },
      provider: get('provider'),
      from: get('address'),
      pct,
      // Bridging is heavier than a transfer; the 21k native default would have
      // MAX subtract a fee the transaction can never cover.
      gasLimit: 300000n,
    });
    if (!r.ok) {
      field.value = '';
      if (note) { note.textContent = r.message; note.classList.add('show'); }
      toast(pct === 100 ? 'MAX is not available here' : `${pct}% is not available here`, 'error');
      return;
    }
    field.value = r.amount;
    if (note) { note.textContent = r.message; note.classList.add('show'); }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 20% / 50% / 70% / MAX — one delegated listener for the static row.
  $('#bridgePctBtns')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-bridge-pct]');
    if (btn) applyPct(Number(btn.dataset.bridgePct));
  });

  // Sync BEFORE the debounced quote so the 600ms timer reads a settled pair.
  $('#bridgeToken')?.addEventListener('change', () => syncBridgeTokenSide(true));
  $('#bridgeToToken')?.addEventListener('change', () => syncBridgeTokenSide(false));
  // A different provider is a different quote — re-run it.
  $('#bridgeRouterSelect')?.addEventListener('change', debouncedQuote);

  ['#bridgeFromChain', '#bridgeToChain', '#bridgeToken', '#bridgeToToken', '#bridgeAmount'].forEach(sel => {
    const node = el(sel);
    if (node) {
      node.addEventListener('change', debouncedQuote);
      node.addEventListener('input', debouncedQuote);
    }
  });
  $('#btnBridgeExec').addEventListener('click', doBridgeExec);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function loadBridgeChains() {
  const from = $('#bridgeFromChain'), to = $('#bridgeToChain');
  if (!from || !to || !$('#bridgeToken')) return;
  const opts = getAllNetworks().map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)} (${escapeHtml(n.type)})</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  // default source = active network (so the quote matches the wallet)
  const activeId = get('networkId');
  if (activeId && [...from.options].some(o => o.value === activeId)) from.value = activeId;
  // Two options max: native first, then the ONE stable family curated on
  // BOTH the source and destination chain (spec 2026-10-05, "pemilihan
  // tokennya 1 harusnya ada 2"). The second row appears only when both
  // chains carry a curated twin — no curated twin, no option, no pretend.
  renderBridgeTokenOptions();

  // In-app pickers on top of the native selects, which stay authoritative.
  // A native select's option list is an OS popup that escapes the page on a
  // phone, so the chain/token/router lists are drawn inside the app instead.
  const nets = getAllNetworks();
  initNetworkPicker('bridgeFromChain', nets);
  initNetworkPicker('bridgeToChain', nets);
  initOptionPicker('bridgeRouterSelect',
    [...($('#bridgeRouterSelect')?.options || [])].map((o) => o.textContent));

  // Update bridge router selector with available routers for current chain pair
  updateBridgeRouterOptions();
  from.addEventListener('change', updateBridgeRouterOptions);
  to.addEventListener('change', updateBridgeRouterOptions);
  // The token list depends on the CHAIN PAIR (a family only qualifies when
  // both chains curate it) — repainting on either change keeps option #2
  // honest. Re-init is safe: initListPicker swaps the row/paint closures
  // instead of stacking bindings (token-picker.js re-entry guard).
  from.addEventListener('change', renderBridgeTokenOptions);
  to.addEventListener('change', renderBridgeTokenOptions);
  // The router list is rebuilt when the chain pair changes, so repaint the
  // picker's trigger too or it keeps showing the old provider.
  $('#bridgeRouterSelect')?.addEventListener('change', () => {
    const sel = $('#bridgeRouterSelect');
    const symEl = document.getElementById('bridgeRouterSelectBtn')?.querySelector('[data-symbol]');
    if (symEl) symEl.textContent = sel.selectedOptions[0]?.textContent || '—';
  });
}

function updateBridgeRouterOptions() {
  const fromVal = $('#bridgeFromChain')?.value;
  const toVal = $('#bridgeToChain')?.value;
  const sel = $('#bridgeRouterSelect');
  if (!sel || !fromVal || !toVal) return;
  const fromNet = getNetworkById(fromVal);
  const toNet = getNetworkById(toVal);
  if (!fromNet || !toNet) return;
  const fromRouters = getBridgeRoutersForChain(fromNet.chainId);
  const toRouters = getBridgeRoutersForChain(toNet.chainId);
  const fromIds = new Set(fromRouters.map(r => r.id));
  const common = toRouters.filter(r => fromIds.has(r.id));
  const currentVal = sel.value;
  sel.innerHTML = '<option value="auto">Auto (Best Route)</option>' +
    common.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  if ([...sel.options].some(o => o.value === currentVal)) sel.value = currentVal;
  // The in-app picker snapshots the labels at init — refresh them here or it
  // keeps offering the previous provider list after the options are rebuilt.
  initOptionPicker('bridgeRouterSelect', [...sel.options].map(o => o.textContent));
}

// The destination-side value of one option: native stays "native", an ERC-20
// carries the TWIN address (what the quote asks the router to deliver). Both
// columns are painted from this, so the pair can never drift apart.
function toValueOf(o) {
  return o.value === 'native' ? 'native' : o.toAddress;
}

// Repaint BOTH token columns for the CURRENT chain pair. Keeps the selection
// when it is still a valid option, otherwise falls back to native (never keeps
// a token the new source chain does not curate). The destination column is
// painted from the SAME option list, so "eth token = bnb token" holds by
// construction instead of two lists happening to agree.
function renderBridgeTokenOptions() {
  const tok = $('#bridgeToken');
  const toTok = $('#bridgeToToken');
  if (!tok) return null;
  const fromNet = getNetworkById($('#bridgeFromChain')?.value) || getNetworkById(get('networkId'));
  const toNet = getNetworkById($('#bridgeToChain')?.value);
  if (!fromNet || !toNet) return null;
  const opts = bridgeTokenOptions(fromNet, toNet);
  // Keep the selection only if it survives in the NEW list — checking the
  // OLD options (pre-fix) meant a stale ERC-20 address could outlive a chain
  // switch and land as an invalid value. Any drop falls back to the first
  // option of the new list (native normally, the ERC-20 on deny-listed pairs).
  const keep = opts.some(o => o.value === tok.value) ? tok.value : (opts[0]?.value ?? 'native');
  // The destination chain may spell the twin differently (USDC vs USDbC) —
  // the right column shows the token as IT exists there.
  const destMeta = (o) => {
    if (o.value === 'native') return null;
    return (POPULAR_TOKENS[toNet.chainId] || []).find(x => sameAddr(x.address, o.toAddress)) || null;
  };
  const destSymbol = (o) => destMeta(o)?.symbol || o.symbol;
  tok.innerHTML = opts.map(o => {
    const label = o.value === 'native'
      ? `${o.symbol} — ${t('bridge.native')}`
      : `${o.symbol} (ERC-20)`;
    return `<option value="${escapeHtml(o.value)}">${escapeHtml(label)}</option>`;
  }).join('');
  tok.value = keep;
  initTokenPicker('bridgeToken', opts.map(o => ({
    address: o.value === 'native' ? null : o.value,
    symbol: o.symbol, decimals: o.decimals, balance: '0', usd: null,
  })));
  if (toTok) {
    const cur = opts.find(o => o.value === keep) || opts[0];
    toTok.innerHTML = opts.map(o => {
      const label = o.value === 'native'
        ? `${destSymbol(o)} — ${t('bridge.native')}`
        : `${destSymbol(o)} (ERC-20)`;
      return `<option value="${escapeHtml(toValueOf(o))}">${escapeHtml(label)}</option>`;
    }).join('');
    toTok.value = cur ? toValueOf(cur) : 'native';
    initTokenPicker('bridgeToToken', opts.map(o => ({
      address: o.value === 'native' ? null : o.toAddress,
      symbol: destSymbol(o), decimals: destMeta(o)?.decimals ?? o.decimals, balance: '0', usd: null,
    })));
  }
  return opts;
}

// One choice, two views: editing either column moves the other to the option
// that matches it (same family, opposite chain). Called on `change` of each
// column — both directions, so the user can start from either side like swap.
function syncBridgeTokenSide(fromSide) {
  const fromNet = getNetworkById($('#bridgeFromChain')?.value) || getNetworkById(get('networkId'));
  const toNet = getNetworkById($('#bridgeToChain')?.value);
  const tok = $('#bridgeToken'), toTok = $('#bridgeToToken');
  if (!fromNet || !toNet || !tok || !toTok) return;
  const opts = bridgeTokenOptions(fromNet, toNet);
  const o = fromSide
    ? (opts.find(x => x.value === tok.value) || opts[0])
    : (opts.find(x => toValueOf(x) === toTok.value) || opts[0]);
  if (!o) return;
  if (fromSide) toTok.value = toValueOf(o);
  else tok.value = o.value;
}

// The immutable URL builder — quote time and the post-approval re-quote build
// it from the SAME context, so the two requests can never drift apart.
function quoteUrl(context) {
  const NATIVE = ZERO_ADDRESS;
  return `https://li.quest/v1/quote?fromChain=${context.fromChainId}&toChain=${context.toChainId}` +
    `&fromToken=${context.tokenAddress || NATIVE}&toToken=${context.toTokenAddress || NATIVE}` +
    `&fromAmount=${context.amountSmallest}` +
    `&fromAddress=${encodeURIComponent(context.address)}&toAddress=${encodeURIComponent(context.address)}`;
}

// Field-by-field validation of a LI.FI quote response against the captured
// context. Throws on ANY mismatch — a mismatching/malicious response must
// never reach execution. Used at quote time (doBridge) AND at the post-
// approval re-quote inside doBridgeExec (an approval wait can outlive the
// quote; research 2026-10-05 A2.7), so both paths validate identically.
// Returns the immutable snapshot execution is allowed to use.
function validateQuote(q, context) {
  const txReq = q.transactionRequest;
  const est = q.estimate || {};
  if (!txReq?.to || !txReq?.data) throw new Error('LI.FI quote missing transactionRequest');
  if (!sameChainId(q.action?.fromChainId, context.fromChainId)) throw new Error('Quote fromChain mismatch');
  if (!sameChainId(q.action?.toChainId, context.toChainId)) throw new Error('Quote toChain mismatch');
  const fromTok = q.action?.fromToken?.address;
  const toTok = q.action?.toToken?.address;
  const isNative = context.token === 'native';
  if (isNative) {
    if (!sameAddr(fromTok || ZERO_ADDRESS, ZERO_ADDRESS)) throw new Error('Quote fromToken is not native');
    if (!sameAddr(toTok || ZERO_ADDRESS, ZERO_ADDRESS)) throw new Error('Quote toToken is not native');
  } else {
    // ERC-20: BOTH addresses must be exactly the curated pair from context —
    // an substituted token on either side is a different contract entirely.
    if (!sameAddr(fromTok, context.tokenAddress)) throw new Error('Quote fromToken mismatch');
    if (!sameAddr(toTok, context.toTokenAddress)) throw new Error('Quote toToken mismatch');
  }
  if (!sameAddr(q.action?.fromAddress, context.address)) throw new Error('Quote fromAddress mismatch');
  // toAddress was requested explicitly — the response must match it exactly.
  if (!sameAddr(q.action?.toAddress, context.address)) throw new Error('Quote toAddress mismatch');
  const ctxAmt = BigInt(context.amountSmallest);
  if (BigInt(q.action?.fromAmount ?? -1) !== ctxAmt) throw new Error('Quote fromAmount mismatch');
  if (BigInt(est?.fromAmount ?? -1) !== ctxAmt) throw new Error('Quote estimate.fromAmount mismatch');
  if (!saneExecAddress(txReq.to)) throw new Error('Quote destination address invalid');
  if (!saneTxData(txReq.data)) throw new Error('Quote calldata invalid');
  if (!sameChainId(txReq.chainId, context.fromChainId)) throw new Error('Quote transactionRequest.chainId mismatch');
  const txValue = BigInt(txReq.value ?? -1);
  if (isNative) {
    if (txValue <= 0n) throw new Error('Quote tx value missing for native bridge');
    if (txValue > ctxAmt) throw new Error('Quote tx value exceeds requested amount');
  } else if (txValue !== 0n) {
    // ERC-20 funds move via the approval pull — native value riding along on
    // an ERC-20 route is a mismatch, not a bonus. Fail closed.
    throw new Error('Quote tx value must be 0 for an ERC-20 bridge');
  }
  let approvalAddress = null;
  if (!isNative) {
    if (!saneExecAddress(est?.approvalAddress)) throw new Error('Quote approvalAddress invalid');
    approvalAddress = ethers.getAddress(est.approvalAddress);
  }
  const steps = (Array.isArray(q.includedSteps) && q.includedSteps.length)
    ? q.includedSteps : (est?.steps || []);
  const toolName = (s) => (typeof s?.tool === 'string' ? s.tool : (s?.tool?.key || s?.action?.tool || '?'));
  const route = steps.length > 1 ? `${toolName(steps[0])} → ${toolName(steps[1])}`
    : steps.length === 1 ? `${toolName(steps[0])} → done` : 'auto';
  return {
    tx: { to: ethers.getAddress(txReq.to), data: txReq.data, value: txValue, chainId: Number(context.fromChainId) },
    approvalAddress,
    skipApproval: !!est.skipApproval,
    fee: est?.feeCosts?.[0]?.amountUSD ?? '?',
    dur: est?.executionDuration ?? '?',
    route,
    // Destination output for the Auto best-route comparison (see
    // bridgeRouterCandidates). Missing/odd field → 0n, which ranks last.
    toAmount: bigOrZero(est?.toAmountMin ?? est?.toAmount),
  };
}

function bigOrZero(v) {
  try { return BigInt(v ?? 0); } catch { return 0n; }
}

// ── router dispatch ──
// ONE entry that turns (router id + context) into a validated snapshot.
// Quote time and the post-approval re-quote both call it, so the two paths
// cannot drift apart — the same reason validateQuote is shared.
const routerName = (id) => BRIDGE_ROUTERS.find(r => r.id === id)?.name || id;

/**
 * Which routers may answer for this chain pair: the registry entries
 * covering BOTH chains, minus the native-only ones when an ERC-20 is being
 * bridged, narrowed to what the picker says (Auto = all of them).
 */
function bridgeRouterCandidates(fromNet, toNet, isNative) {
  const wanted = $('#bridgeRouterSelect')?.value || 'auto';
  // An EXPLICIT pick means exactly that router — the select is rebuilt from
  // the pair∩registry on every chain change (updateBridgeRouterOptions), so
  // an option the pair does not cover cannot be chosen through the UI; if the
  // value got there some other way, the adapter fails honestly before any tx.
  if (wanted !== 'auto') return [wanted];
  const fromIds = new Set(getBridgeRoutersForChain(fromNet.chainId).map(r => r.id));
  const pair = getBridgeRoutersForChain(toNet.chainId).filter(r => fromIds.has(r.id));
  return pair.filter(r => isNative || !r.nativeOnly).map(r => r.id);
}

async function fetchBoundQuote(routerId, context) {
  if (routerId === 'lifi') {
    const res = await fetchWithTimeout(quoteUrl(context));
    if (!res.ok) throw new Error(`LI.FI HTTP ${res.status}`);
    // Field-by-field validation against the captured context — a mismatching
    // or malicious response must never reach execution.
    return validateQuote(await res.json(), context);
  }
  const fn = BRIDGE_ROUTE_FETCHERS[routerId];
  if (!fn) throw new Error(`Unknown bridge router: ${routerId}`);
  return fn(context, (url, opts) => fetchWithTimeout(url, opts));
}

/**
 * Everything the exec entry guard pins, re-checked after the 30–60s
 * approve+re-quote window — hoisted to ONE source of truth so the two
 * sites cannot drift apart again (critic 2026-10-05: the mirror was found
 * asymmetric twice — first unlocked/provider/networkId, then the from/to
 * selects; a third edit must not be able to re-asymmetrize them).
 * Returns the toast to show, or null when the context still holds.
 *
 * Async on purpose: the live provider network is re-read AFTER the awaits
 * (TOCTOU, same rule as the entry path) — locking the wallet or switching
 * chains mid-window aborts exactly like drift in the amount.
 */
export async function approvalWindowDrift(q, context, provider, fromNet, toNet) {
  if (get('bridgeQuote') !== q || $('#bridgeToken').value !== context.token ||
      String($('#bridgeAmount').value) !== String(context.amount) ||
      $('#bridgeFromChain').value !== fromNet.id || $('#bridgeToChain').value !== toNet.id ||
      !sameAddr(get('address'), context.address)) {
    return 'Bridge context changed. Get a new route.';
  }
  if (!get('unlocked') || get('provider') !== provider ||
      get('networkId') !== context.networkId) {   // network id is a STRING key, not a chainId
    return 'Bridge context changed. Get a new route.';
  }
  try {
    const live = await provider.getNetwork();
    if (!sameChainId(live.chainId, context.fromChainId)) {
      return 'Bridge context changed. Get a new route.';
    }
  } catch {
    return 'Provider network unavailable — bridge not signed';
  }
  return null;
}

export async function doBridge() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const fromNet = getNetworkById($('#bridgeFromChain').value);
  const toNet = getNetworkById($('#bridgeToChain').value);
  const amt = $('#bridgeAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to bridge', 'error');
  if (!/^\d*\.?\d+$/.test(amt.trim())) return toast('Invalid amount', 'error');
  if (!fromNet || !toNet) return toast('Unknown network selected', 'error');
  if (fromNet.chainId === toNet.chainId) return toast('Choose two different chains', 'error');

  // Token selection: native, or a curated ERC-20 with a curated destination
  // twin. Anything else fails closed BEFORE the fetch — a token we cannot map
  // to a destination address must never reach the router, and never gets
  // silently substituted with the native token.
  const tok = $('#bridgeToken').value;
  let tokenMeta = null;
  let toTokenAddress = null;
  if (tok !== 'native') {
    const meta = (POPULAR_TOKENS[fromNet.chainId] || []).find(x => sameAddr(x.address, tok));
    const twin = meta && (POPULAR_TOKENS[toNet.chainId] || [])
      .find(x => familyOf(x.symbol) === familyOf(meta.symbol));
    if (!meta || !twin) {
      set('bridgeQuote', null);
      return toast(t('bridge.token_not_routable'), 'error');
    }
    tokenMeta = meta;
    toTokenAddress = twin.address;
  }
  // The destination column is DERIVED display, not an independent choice:
  // repaint it from the pair being quoted here (it is painted from this same
  // list, so the value matches an option exactly). The PAIR itself is still
  // fail-closed above — a token without a curated twin never reaches fetch;
  // and if the user drives the destination column instead, syncBridgeTokenSide
  // moves the source column, which is what every drift guard checks.
  const toTokEl = $('#bridgeToToken');
  if (toTokEl) toTokEl.value = toTokenAddress || 'native';

  // Quote must match the ACTIVE network — a quote for a chain the
  // wallet is not on would be unsigned context, refuse before fetch.
  const activeNet = getNetworkById(get('networkId'));
  if (!activeNet || !sameChainId(activeNet.chainId, fromNet.chainId)) {
    set('bridgeQuote', null);
    return toast(t('bridge.wrong_active_chain'), 'error');
  }

  // LI.FI /v1/quote requires fromAddress — honest error if wallet not unlocked
  const userAddr = get('address');
  if (!userAddr || !isAddress(userAddr)) return toast('Unlock wallet first', 'error');

  // Amount precision follows the TOKEN: 18 for native, the curated decimals
  // for an ERC-20 (USDC is 6 — 18 would inflate the amount a million-fold).
  // The regex above validates the SHAPE, not the precision: a fully-precise
  // paste ("5.1234567" into 6-decimal USDC) throws NUMERIC_FAULT here.
  // Red-team 2026-10-05: without this catch the rejection escaped the caller
  // (auto-quote runs with no .catch) — silent failure, the PREVIOUS quote
  // stayed bound and Bridge stayed clickable. Fail closed: kill the quote,
  // disable the button, hide the stale route, say WHY.
  const decimals = tokenMeta ? tokenMeta.decimals : 18;
  let amountSmallest;
  try {
    amountSmallest = ethers.parseUnits(amt, decimals).toString();
  } catch {
    quoteSeq++;                    // kill any in-flight quote request too —
    // without this bump a response already on the wire could bind AFTER the
    // clear below and repaint the route box for an amount that never parsed
    // (exec still rejects it as stale; the UI must not lie in the meantime).
    set('bridgeQuote', null);
    $('#btnBridgeExec').disabled = true;
    $('#bridgeRoute').classList.add('hidden');
    $('#bridgeRoute').innerHTML = '';
    $('#bridgeQuote').classList.add('hidden');
    return toast(`Amount has more decimal places than this token supports (${decimals} decimals)`, 'error');
  }

  // Immutable quote context + seq id captured BEFORE the first await
  // (confirmTx is an await — the old quote must die before it opens),
  // and OLD quote state cleared so nothing stale survives the pause.
  const seq = ++quoteSeq;
  const context = Object.freeze({
    seq,
    networkId: get('networkId'),
    chainId: Number(fromNet.chainId),
    address: ethers.getAddress(userAddr),
    token: tok,
    tokenAddress: tokenMeta ? ethers.getAddress(tokenMeta.address) : null,
    toTokenAddress: tokenMeta ? ethers.getAddress(toTokenAddress) : null,
    tokenDecimals: decimals,
    tokenSymbol: tokenMeta ? tokenMeta.symbol : (fromNet.symbol || 'native'),
    fromChainId: Number(fromNet.chainId),
    toChainId: Number(toNet.chainId),
    amount: amt,
    amountSmallest
  });
  set('bridgeQuote', null);
  // No confirmTx here — this is auto-QUOTE only. Safety confirmation
  // happens at EXECUTION time (doBridgeExec), not at quote time.

  const box = $('#bridgeQuote');
  const routeBox = $('#bridgeRoute');
  const execBtn = $('#btnBridgeExec');
  box.innerHTML = spinnerDots();
  box.classList.remove('hidden');
  routeBox.classList.add('hidden');
  routeBox.innerHTML = '';
  // The button stays VISIBLE but disabled while no quote exists — hiding it
  // left the screen with no bridge button at all when a quote failed (live
  // report, 2026-10-03). Disabled = honest "waiting for a route";
  // doBridgeExec still refuses a missing/stale quote on its own.
  execBtn.disabled = true;
  try {
    // Reject live drift before the fetch — the captured context must
    // still match the form/wallet at request time.
    if (get('networkId') !== context.networkId ||
        String($('#bridgeAmount').value) !== String(context.amount) ||
        $('#bridgeToken').value !== context.token ||
        !sameAddr(get('address'), context.address)) {
      throw new Error('Form changed during confirmation');
    }
    // Fail closed: nothing stale may be executable while this quote
    // request is in flight (e.g. a quote that sneaked in during the
    // confirm dialog). Cleared again right before the fetch.
    set('bridgeQuote', null);
    // LI.FI quote (real API) — honest error on failure, never simulated.
    // fromToken/toToken: the curated addresses (or 0x0 native on both sides);
    // toAddress pinned explicitly so the response destination is exact.
    // Candidate routers for this chain pair: the picker's explicit choice,
    // or every registry entry covering BOTH chains when it says Auto. The
    // native-only adapters drop out before a single request goes out when an
    // ERC-20 is selected.
    const candidates = bridgeRouterCandidates(fromNet, toNet, tok === 'native');
    if (!candidates.length) throw new Error('No bridge router covers this chain pair');
    const settled = await Promise.allSettled(candidates.map(id => fetchBoundQuote(id, context)));
    if (seq !== quoteSeq) return;                 // superseded while awaiting
    const ok = [], errs = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push({ id: candidates[i], bound: r.value });
      else errs.push(`${routerName(candidates[i])}: ${r.reason?.message || r.reason}`);
    });
    if (!ok.length) {
      // Every candidate refused — say WHICH and why. No silent fallback and
      // no invented route: an empty picker helps nobody, a fake one loses money.
      set('bridgeQuote', null);
      box.innerHTML = `<div class="quote-error">⚠️ No route available — no bridge will happen.</div>
        <div class="quote-error-detail">${escapeHtml(errs.join(' · '))}</div>
        <div class="quote-error-detail">${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)} (${escapeHtml(amt)} ${escapeHtml(fromNet.symbol || '')})</div>`;
      return;
    }
    // "Auto (Best Route)" means what it says: the response carrying the most
    // of the destination token wins — toAmount is that token's smallest unit,
    // so all candidates are directly comparable.
    ok.sort((a, b) => (b.bound.toAmount > a.bound.toAmount ? 1 : -1));
    const win = ok[0];
    const bound = win.bound;
    // Quote-bound immutable snapshot — execution uses ONLY this.
    set('bridgeQuote', {
      simulated: false,
      context,
      approvalAddress: bound.approvalAddress,
      skipApproval: bound.skipApproval,
      tx: bound.tx,
      router: win.id,
      routerName: routerName(win.id),
      toAmount: bound.toAmount,
    });
    const fee = bound.fee;
    const dur = bound.dur;
    const route = bound.route;
    box.innerHTML = '';
    box.classList.add('hidden');
    routeBox.innerHTML = `
      <div class="route-row"><span class="route-label">Provider</span><span class="route-val">${escapeHtml(routerName(win.id))}</span></div>
        <div class="route-row"><span class="route-label">Route</span><span class="route-val">${escapeHtml(route)}</span></div>
        <div class="route-row"><span class="route-label">Est. time</span><span class="route-val">${escapeHtml(String(dur))}s</span></div>
        <div class="route-row"><span class="route-label">Fees</span><span class="route-val">≈ ${escapeHtml(String(fee))} USD</span></div>
        <div class="route-row"><span class="route-label">From</span><span class="route-val">${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}</span></div>
      `;
    routeBox.classList.remove('hidden');
    execBtn.disabled = false;
  } catch (e) {
    if (seq !== quoteSeq) return;
    set('bridgeQuote', null);
    box.innerHTML = `<div class="quote-error">⚠️ ${escapeHtml(explainError(e, 'Bridge quote'))} No bridge will be started.</div>
      <div class="quote-error-detail">${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}</div>`;
  }
}

// ── single-flight guard ──
// The ERC-20 flow spends SECONDS inside approve + re-quote with the button
// still live. A double-click (or an impatient second tap) would run a SECOND
// full exec in parallel: two allowance reads against a not-yet-mined approve,
// a second approve, and — worst case — two bridge transfers. Red-team finding
// 2026-10-05: one execution at a time, second entry rejected loudly.
let execInFlight = false;

export async function doBridgeExec() {
  if (execInFlight) return toast('Bridge already in progress — wait for it to finish', 'error');
  execInFlight = true;
  try {
    return await doBridgeExecInner();
  } finally {
    execInFlight = false;
  }
}

async function doBridgeExecInner() {
  if (!get('unlocked')) { requireUnlock(); return; }
  // Reject absent / unbound / simulated quotes — there is no safe
  // default. An old pre-fix quote has no context and must not sign.
  const q = get('bridgeQuote');
  if (!q || q.simulated || !q.context || !q.tx) return toast(t('bridge.no_valid_route'), 'error');
  const { context, tx: boundTx } = q;

  // Re-verify immutable context against the LIVE UI + wallet state.
  // Any drift (form edited, account switched, network switched)
  // invalidates the quote — the user must re-quote.
  const fromNet = getNetworkById($('#bridgeFromChain').value);
  const toNet = getNetworkById($('#bridgeToChain').value);
  if (!fromNet || !toNet) return toast(t('bridge.wrong_active_chain'), 'error');
  const amt = $('#bridgeAmount').value;
  const tok = $('#bridgeToken').value;
  const userAddr = get('address');
  if (tok !== context.token) return toast(t('bridge.stale_quote'), 'error');
  if (!sameChainId(fromNet.chainId, context.fromChainId)) return toast(t('bridge.stale_quote'), 'error');
  if (!sameChainId(toNet.chainId, context.toChainId)) return toast(t('bridge.stale_quote'), 'error');
  if (String(amt) !== String(context.amount)) return toast(t('bridge.stale_quote'), 'error');
  if (!userAddr || !sameAddr(userAddr, context.address)) return toast(t('bridge.account_changed'), 'error');
  const activeNet = getNetworkById(get('networkId'));
  if (!activeNet || activeNet.id !== context.networkId) return toast(t('bridge.wrong_active_chain'), 'error');
  if (!sameChainId(activeNet.chainId, context.chainId)) return toast(t('bridge.wrong_active_chain'), 'error');

  // Live provider chain check BEFORE any confirmation — a wrong-chain
  // provider must never show a sign dialog (and never sign). The full
  // TOCTOU double-check still runs inside runTx after the confirm await.
  const provider = get('provider');
  if (!provider) return toast(t('bridge.no_provider'), 'error');
  let preNet;
  try {
    preNet = await provider.getNetwork();
  } catch {
    // RPC down / switching — fail loudly, never show a misleading dialog.
    return toast(t('bridge.wrong_active_chain'), 'error');
  }
  if (!preNet || !sameChainId(preNet.chainId, context.chainId)) return toast(t('bridge.wrong_active_chain'), 'error');

  // Mainnet safety confirmation at EXECUTION time (not quote time)
  if (fromNet.type === 'mainnet' || toNet.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'EXECUTE BRIDGE ON MAINNET!',
      rows: [{ k: 'From', v: `${fromNet.name} (${fromNet.chainId})` }, { k: 'To', v: `${toNet.name} (${toNet.chainId})` }, { k: 'Amount', v: `${context.amount} ${context.tokenSymbol || ''}` }],
      confirmText: 'Bridge', danger: true
    });
    if (!ok) return;
  }

  // sign confirmation — show full bridge details before signing
  const signOk = await confirmTx({
    title: '✍️ SIGN BRIDGE',
    rows: [
      { k: 'From chain', v: `${fromNet.name} (${fromNet.chainId})` },
      { k: 'To chain', v: `${toNet.name} (${toNet.chainId})` },
      { k: 'Amount', v: `${context.amount} ${context.tokenSymbol || ''}` },
      { k: 'Router', v: q.routerName || 'Auto' },
      { k: 'Est. time', v: '~2-10 min' }
    ],
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    danger: false
  });
  if (!signOk) return toast('Bridge cancelled', 'info');

  // Quote-bound immutable tx details (never re-read the API payload).
  const { to, data, value, chainId } = boundTxChecks(boundTx, context);

  await runTx('bridge', $('#btnBridgeExec'), async () => {
    const provider = get('provider');
    if (!provider) return toast(t('bridge.no_provider'), 'error');
    // Live provider network must match the quote's source chain —
    // checked BEFORE signing, then RE-checked after the await
    // (a provider/network swap between the two checks is the TOCTOU
    // this double-check exists to catch).
    const netPre = await provider.getNetwork();
    if (!sameChainId(netPre?.chainId, chainId)) return toast(t('bridge.wrong_active_chain'), 'error');
    const netPost = await provider.getNetwork();
    if (!sameChainId(netPost?.chainId, chainId)) return toast(t('bridge.wrong_active_chain'), 'error');
    // Await may allow the form, account, network, provider or quote to change.
    if (!get('unlocked') || get('bridgeQuote') !== q || get('provider') !== provider ||
        get('networkId') !== context.networkId || !sameAddr(get('address'), context.address) ||
        $('#bridgeFromChain').value !== fromNet.id || $('#bridgeToChain').value !== toNet.id ||
        $('#bridgeToken').value !== context.token || $('#bridgeAmount').value !== context.amount) {
      return toast('Bridge context changed. Get a new route.', 'error');
    }
    // All guards passed — NOW connect the (possibly unconnected) app
    // signer to the verified provider and sign. `connect` must never
    // happen before every guard above: an unconnected base Wallet has
    // no provider, and a wrong-chain connection must be impossible.
    const signer = get('signer');
    if (!signer?.sendTransaction) return toast('No signer available', 'error');
    if (signer.address && !sameAddr(signer.address, context.address)) return toast(t('bridge.account_changed'), 'error');
    const connected = typeof signer.connect === 'function' ? signer.connect(provider) : signer;
    if (!connected?.sendTransaction) return toast('No signer available', 'error');
    if (connected.address && !sameAddr(connected.address, context.address)) return toast(t('bridge.account_changed'), 'error');

    // ── ERC-20: allowance → approve → RE-QUOTE → bridge ──
    // The approve spender comes ONLY from the quote-bound snapshot
    // (q.approvalAddress, validated against the response at quote time).
    // Native skips this block entirely: no allowance, no extra fetch.
    let sendParams = { to, data, value, chainId };
    if (context.tokenAddress) {
      const spender = q.approvalAddress;
      if (!saneExecAddress(spender)) return toast('Quote has no approval spender — bridge not signed', 'error');
      const erc20 = new ethers.Interface([
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
      ]);
      let allowance = 0n;
      try {
        const raw = await provider.call({
          to: context.tokenAddress,
          data: erc20.encodeFunctionData('allowance', [context.address, spender]),
        });
        allowance = BigInt(raw);
      } catch {
        // An unreadable allowance must stop the flow — never assume approval.
        return toast('Could not read token allowance — bridge not signed', 'error');
      }
      const decision = decideApproval({
        skipApproval: q.skipApproval, allowance, amount: BigInt(context.amountSmallest),
      });
      if (decision !== 'none') {
        const sendApprove = async (amtWei, label) => {
          const atx = await withTimeout(
            connected.sendTransaction({
              to: context.tokenAddress,
              data: erc20.encodeFunctionData('approve', [spender, amtWei]),
              value: 0n, chainId,
            }),
            BROADCAST_TIMEOUT_MS, `${label} broadcast`);
          const r = await waitForReceipt(atx, { label });
          if (r.timedOut || r.receipt?.status !== 1) throw new Error(`${label} not confirmed`);
          return atx;
        };
        try {
          if (decision === 'reset+approve') await sendApprove(0n, 'approval reset');
          await sendApprove(BigInt(context.amountSmallest), 'approval');
        } catch (e) {
          return toast(`${explainError(e, 'Approval')} — bridge not signed`, 'error');
        }
        toast('Approval confirmed — refreshing route…', 'success');
        // The original quote can outlive this approval wait (LI.FI quotes
        // last minutes, research A2.7) — re-quote and validate from scratch.
        if (get('bridgeQuote') !== q) return toast('Bridge context changed. Get a new route.', 'error');
        let fresh;
        try {
          // Same router that won the quote (its name is in the sign dialog);
          // fetchBoundQuote re-validates field-by-field like quote time did.
          fresh = await fetchBoundQuote(q.router || 'lifi', context);
        } catch (e) {
          return toast(`Approval done, but no fresh route (${explainError(e, 're-quote')}) — try again`, 'error');
        }
        // A fresh quote may name a DIFFERENT spender than we just approved —
        // executing against it would fail the allowance pull. Refuse honestly.
        if (!sameAddr(fresh.approvalAddress, spender)) {
          return toast('Route changed during approval — get a new quote', 'error');
        }
        // The entry guard's whole set, one source of truth — see
        // approvalWindowDrift (hoisted from this exact site, critic R3).
        const driftMsg = await approvalWindowDrift(q, context, provider, fromNet, toNet);
        if (driftMsg) return toast(driftMsg, 'error');
        sendParams = fresh.tx;
      }
    }

// Every broadcast is wrapped. Only send.js bounded its broadcast with a
// timeout; the bridge, swap and 7702 paths would wait on a node that never
// answers, leaving the button spinning and the flow dead. 15s matches
// send.js: a broadcast either gets a hash or it is not happening.
    const tx = await withTimeout(
      connected.sendTransaction(sendParams),
      BROADCAST_TIMEOUT_MS, 'bridge broadcast');
    toast('Bridge tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'bridge', status: 'pending', ts: Date.now(), detail: `${context.tokenSymbol} ${context.amount} · chain ${context.fromChainId} → ${context.toChainId}`, symbol: context.tokenSymbol });
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'bridge', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${context.tokenSymbol} ${context.amount} · chain ${context.fromChainId} → ${context.toChainId}`, symbol: context.tokenSymbol });
    toast(receipt.status === 1 ? 'Bridge confirmed! 🎉' : 'Bridge failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}

// Validate the quote-bound tx snapshot at execution time. Returns the
// exact send parameters — the only place tx details may come from.
function boundTxChecks(tx, context) {
  if (!saneExecAddress(tx.to)) throw new Error('Bridge destination address invalid');
  if (!saneTxData(tx.data)) throw new Error('Bridge calldata invalid');
  if (!sameChainId(tx.chainId, context.fromChainId)) throw new Error('Bridge tx chainId mismatch');
  const ctxAmt = BigInt(context.amountSmallest);
  if (typeof tx.value !== 'bigint') throw new Error('Bridge tx value missing');
  if (context.token === 'native') {
    if (tx.value <= 0n) throw new Error('Bridge tx value missing');
    if (tx.value > ctxAmt) throw new Error('Bridge tx value exceeds requested amount');
  } else if (tx.value !== 0n) {
    // ERC-20 route: funds move via approval pull, native value must be 0.
    throw new Error('Bridge tx value must be 0 for ERC-20');
  }
  return { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId };
}