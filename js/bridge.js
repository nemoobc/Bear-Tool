// ═══════════════════════════════════════════════════════════════
// Bear Tool — bridge.js
// Bridge view: NATIVE-token bridging only (fail closed).
// LI.FI quote (best effort) with honest simulated fallback,
// context-bound quote validation, guarded execution path.
//
// Security contract (bridge.test.js is the executable spec):
//   1. Native only — ERC-20 selection is rejected loudly, never
//      silently substituted with the native token.
//   2. Quotes are bound to an immutable context: sequence id,
//      networkId, chainId, address, token, from/to chains, amount.
//   3. Quote state is cleared before any await; stale (out-of-order)
//      responses are ignored by sequence id.
//   4. API responses are validated field-by-field against the
//      context (chains, token, address, amount, tx value/chainId,
//      destination address + calldata sanity).
//   5. Execution re-verifies the whole context against the live
//      form, current account, state networkId and provider network
//      BEFORE signing, and re-checks the provider network AFTER the
//      awaited getNetwork() call (TOCTOU). Tx details come only
//      from the quote-bound snapshot.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getAllNetworks, getNetworkById } from './network.js';
import { t } from './i18n.js';

const { ethers } = globalThis;

// Monotonic sequence for quote requests — lets in-flight responses
// detect "a newer quote was requested" and discard themselves.
let quoteSeq = 0;

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

export function bindBridgeEvents() {
  $('#btnBridgeQuote').addEventListener('click', doBridge);
  $('#btnBridgeExec').addEventListener('click', doBridgeExec);
}

export function loadBridgeChains() {
  const from = $('#bridgeFromChain'), to = $('#bridgeToChain'), tok = $('#bridgeToken');
  if (!from || !to || !tok) return;
  const opts = getAllNetworks().map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)} (${escapeHtml(n.type)})</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  // default source = active network (so the quote matches the wallet)
  const activeId = get('networkId');
  if (activeId && [...from.options].some(o => o.value === activeId)) from.value = activeId;
  // NATIVE ONLY — honest UI: ERC-20 is never offered, so nothing can pretend support.
  const net = getNetworkById(get('networkId'));
  const sym = net?.symbol || 'Native';
  tok.innerHTML = `<option value="native">${escapeHtml(sym)} — ${escapeHtml(t('bridge.native_only'))}</option>`;
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

  // NATIVE ONLY — fail closed: reject non-native selection loudly.
  // Never silently substitute the native token for an ERC-20 pick.
  const tok = $('#bridgeToken').value;
  if (tok !== 'native') {
    set('bridgeQuote', null);
    return toast(t('bridge.native_only_reject'), 'error');
  }

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

  // Native = 18 decimals. Amount format already validated above, so this
  // cannot throw here — it must be part of the immutable context.
  const amountSmallest = ethers.parseUnits(amt, 18).toString();

  // Immutable quote context + seq id captured BEFORE the first await
  // (confirmTx is an await — the old quote must die before it opens),
  // and OLD quote state cleared so nothing stale survives the pause.
  const seq = ++quoteSeq;
  const context = Object.freeze({
    seq,
    networkId: get('networkId'),
    chainId: Number(fromNet.chainId),
    address: ethers.getAddress(userAddr),
    token: 'native',
    tokenSymbol: fromNet.symbol || 'native',
    fromChainId: Number(fromNet.chainId),
    toChainId: Number(toNet.chainId),
    amount: amt,
    amountSmallest
  });
  set('bridgeQuote', null);

  if (fromNet.type === 'mainnet' || toNet.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'BRIDGE ON MAINNET!',
      rows: [{ k: 'From', v: `${fromNet.name} (${fromNet.chainId})` }, { k: 'To', v: `${toNet.name} (${toNet.chainId})` }, { k: 'Amount', v: `${amt} ${fromNet.symbol || ''}` }],
      confirmText: 'Get Route', danger: true, requireType: 'YA'
    });
    if (!ok) return;   // confirm cancelled — nothing to do; next request gets a fresh seq
  }

  const box = $('#bridgeQuote');
  const routeBox = $('#bridgeRoute');
  const execBtn = $('#btnBridgeExec');
  box.innerHTML = spinnerDots();
  box.classList.remove('hidden');
  routeBox.classList.add('hidden');
  routeBox.innerHTML = '';
  execBtn.classList.add('hidden');
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
    // LI.FI quote (best effort) — fallback simulated ONLY on network failure.
    // fromToken/toToken = 0x0 (native on both sides; no ERC-20 in scope);
    // toAddress pinned explicitly so the response destination is exact.
    const NATIVE = ZERO_ADDRESS;
    const url = `https://li.quest/v1/quote?fromChain=${fromNet.chainId}&toChain=${toNet.chainId}&fromToken=${NATIVE}&toToken=${NATIVE}&fromAmount=${amountSmallest}&fromAddress=${encodeURIComponent(userAddr)}&toAddress=${encodeURIComponent(userAddr)}`;
    const res = await fetch(url);
    // this request was superseded while awaiting — ignore entirely
    if (seq !== quoteSeq) return;
    if (res.ok) {
      const q = await res.json();
      if (seq !== quoteSeq) return;
      const txReq = q.transactionRequest;
      const est = q.estimate || {};
      if (!txReq?.to || !txReq?.data) throw new Error('LI.FI quote missing transactionRequest');
      // Field-by-field validation against the captured context —
      // a mismatching/malicious response must never reach execution.
      if (!sameChainId(q.action?.fromChainId, context.fromChainId)) throw new Error('Quote fromChain mismatch');
      if (!sameChainId(q.action?.toChainId, context.toChainId)) throw new Error('Quote toChain mismatch');
      const fromTok = q.action?.fromToken?.address;
      const toTok = q.action?.toToken?.address;
      if (!sameAddr(fromTok || ZERO_ADDRESS, ZERO_ADDRESS)) throw new Error('Quote fromToken is not native');
      if (!sameAddr(toTok || ZERO_ADDRESS, ZERO_ADDRESS)) throw new Error('Quote toToken is not native');
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
      if (txValue <= 0n) throw new Error('Quote tx value missing for native bridge');
      if (txValue > ctxAmt) throw new Error('Quote tx value exceeds requested amount');
      // Quote-bound immutable snapshot — execution uses ONLY this.
      set('bridgeQuote', {
        simulated: false,
        context,
        tx: { to: ethers.getAddress(txReq.to), data: txReq.data, value: txValue, chainId: Number(context.fromChainId) }
      });
      const fee = est?.feeCosts?.[0]?.amountUSD ?? '?';
      const dur = est?.executionDuration ?? '?';
      const route = `${est?.steps?.[0]?.tool ?? '?'} → ${est?.steps?.[1]?.tool ?? 'done'}`;
      box.innerHTML = '';
      box.classList.add('hidden');
      routeBox.innerHTML = `
        <div class="route-row"><span class="route-label">Route</span><span class="route-val">${escapeHtml(route)}</span></div>
        <div class="route-row"><span class="route-label">Est. time</span><span class="route-val">${escapeHtml(String(dur))}s</span></div>
        <div class="route-row"><span class="route-label">Fees</span><span class="route-val">≈ ${escapeHtml(String(fee))} USD</span></div>
        <div class="route-row"><span class="route-label">From</span><span class="route-val">${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}</span></div>
      `;
      routeBox.classList.remove('hidden');
      execBtn.classList.remove('hidden');
    } else {
      if (seq !== quoteSeq) return;
      set('bridgeQuote', { simulated: true });
      box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED route — no real bridge will happen. Connect LI.FI API for live routes.</div>
        Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)} (${escapeHtml(amt)} tokens)`;
    }
  } catch (e) {
    if (seq !== quoteSeq) return;
    set('bridgeQuote', { simulated: true });
    box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED — no real bridge. (${escapeHtml(e?.message || 'network error')})</div>
      Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}`;
  }
}

export async function doBridgeExec() {
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

    const tx = await connected.sendTransaction({ to, data, value, chainId });
    toast('Bridge tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'bridge', status: 'pending', ts: Date.now(), detail: `${context.tokenSymbol} ${context.amount} · chain ${context.fromChainId} → ${context.toChainId}` });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'bridge', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${context.tokenSymbol} ${context.amount} · chain ${context.fromChainId} → ${context.toChainId}` });
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
  if (typeof tx.value !== 'bigint' || tx.value <= 0n) throw new Error('Bridge tx value missing');
  if (tx.value > ctxAmt) throw new Error('Bridge tx value exceeds requested amount');
  return { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId };
}