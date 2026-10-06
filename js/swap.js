// ═══════════════════════════════════════════════════════════════
// Bear Tool — swap.js
// Swap & Bridge view: token select, flip, auto-route quote
// (KyberSwap → Uniswap V3 → Uniswap V2), slippage wired,
// approve + execute path. NO simulated fallback — every quote is
// a real on-chain/API route or an honest error.
// ═══════════════════════════════════════════════════════════════

const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

import { $, toast, confirmTx, escapeHtml, spinnerDots, fmtAmount } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt, withTimeout } from './safetx.js';
import { getNetworkById, ERC20_ABI, POPULAR_TOKENS } from './network.js';
import { SWAP_ROUTERS, getSwapRoutersForChain, getBestSwapRouter, getRouterAddress, getQuoterAddress, CHAIN_NAMES } from './routers.js';
import { initTokenPicker } from './token-picker.js';
import { resolveMax } from './max-ui.js';
import { explainError } from './errors.js';

const { ethers } = globalThis;

// ── KyberSwap Aggregator constants ──
const KYBER_API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'bear-tool';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CACHE_TTL = 30_000;

// ── router ABIs ────────────────────────────────────────────────────────────
//
// These two were missing. Both `v2Quote` and `v3Quote` referenced them, so every
// call threw ReferenceError and the entire swap feature was dead: no quote, no
// swap, no venue, on any chain. It survived a long time because the fork swap
// test built its own V2 call with its own ABI, and the unit tests read this file
// as text instead of running it. Nothing in the suite executed this module.
//
// The registry rewrite is where they went: the detectors added then asserted that
// swap.js no longer defines UNISWAP_V2_ROUTER, UNISWAP_V3_ROUTER and
// UNISWAP_QUOTER_V3 — the local *address* tables — and read that as the rewrite
// being complete. The address tables were the point; the ABIs went with them.
//
// Declared from the call sites rather than from memory, and each entry is exercised
// on a fork by tests/fork/fork-swap-app.test.js, which calls v2Quote and
// uniswapV2Swap from this module. If a signature here were wrong the fork test
// fails, which is the only reason to trust an ABI written by hand.
const UNISWAP_V2_ABI = [
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

// Uniswap SwapRouter02 — the 0x68b34658… deployment, identical on every chain in
// the registry. Its exactInputSingle takes a 7-field struct with no deadline; the
// five-argument SwapRouter form would silently encode a different selector, so
// this is spelled out rather than folded into a shared V2 entry.
const UNISWAP_V3_ABI = [
  'function WETH9() view returns (address)',
  'function factory() view returns (address)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

// 1inch is gone: /swap/v6.0 answers 401 without a credential. Bungee/Socket
// answers 403. Neither is carried as a route, because a route the wallet cannot
// price is a dead end in a dropdown rather than a feature.

// ── ParaSwap API ──
const PARASWAP_API = 'https://api.paraswap.io';

// Router addresses are NOT listed here. They live in routers.js, which is the
// single source of truth and is the file that records which chains each address
// was verified on. Keeping a second copy in this module is how the two drifted:
// the registry advertised Uniswap V3 on Base while this map had no Base entry,
// and the registry's Base address was one with no contract behind it.

// Last-resort wrapped-native lookup for the V3 path, keyed by router ADDRESS.
// The V3 path asks the router for WETH9() first and only reads this if that
// reverts; the V2 path asks for WETH() and never needs a table. Keying by
// address rather than chain is deliberate: a chain can carry more than one V3
// router and they do not necessarily wrap the same token.
const CHAIN_WETH_BY_ROUTER = {
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45': { 1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 10: '0x4200000000000000000000000000000000000006', 137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
};

const CHAIN_WETH = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum WETH
  5: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6', // Goerli WETH
  10: '0x4200000000000000000000000000000000000006', // OP WETH
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // BSC WBNB
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // Polygon WMATIC
  8453: '0x4200000000000000000000000000000000000006', // Base WETH
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum WETH
  11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // Sepolia WETH (verified on-chain via router.WETH())
  // 2026-10-05: the new ETH-native mainnets — wrap/unwrap works here because
  // native ETH ↔ WETH is a deposit()/withdraw() call, no router, no quote
  // needed. Avalanche/Gnosis/Celo/Sonic/Mantle stay OUT: their wrapped natives
  // (WAVAX/WXDAI/…) were not in the verified token table, and a wrong wrap
  // address is a send-to-nowhere.
  130: '0x4200000000000000000000000000000000000006', // Unichain WETH
  324: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // zkSync Era WETH
  480: '0x4200000000000000000000000000000000000006', // World Chain WETH
  59144: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // Linea WETH
  534352: '0x5300000000000000000000000000000000000004', // Scroll WETH
  81457: '0x4300000000000000000000000000000000000004', // Blast WETH
};

// ── Extended popular tokens ──
// POPULAR_TOKENS used to be a SECOND map in this file with its own copy of the
// ethereum/sepolia/arbitrum rows — the two drifted the moment either changed.
// One source of truth now: swap re-exports the curated map from network.js
// (HUKUM 10; tests/network.test.js + tests/token-list.test.js pin it there).
export { POPULAR_TOKENS };

// chainId → KyberSwap API slug
const KYBER_CHAIN_SLUG = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
};

// ── simple quote cache
let quoteCache = { key: null, data: null, ts: 0 };

// Native ↔ its wrapped twin has NO pool between them: every DEX quote for
// this pair dies with a pair/pool error (live report 2026-10-03: "pair eth ->
// weth error" on the sepolia fork). The WETH contract IS the route —
// deposit()/withdraw() are exactly 1:1, no slippage, no router, no allowance.
// Returns 'deposit' | 'withdraw' | null.
export function wrapDirection(chainId, from, to) {
  const weth = CHAIN_WETH[Number(chainId)];
  if (!weth || !from || !to) return null;
  const wl = weth.toLowerCase();
  if (from === 'native' && to !== 'native' && to.toLowerCase() === wl) return 'deposit';
  if (to === 'native' && from !== 'native' && from.toLowerCase() === wl) return 'withdraw';
  return null;
}

function cacheKey(slug, tokenIn, tokenOut, amountIn) {
  return `${slug}:${tokenIn}:${tokenOut}:${amountIn}`;
}

// ── token lookup helper
function tokenInfo(addr) {
  return get('tokens').find(t => t.address === addr) || null;
}

export function bindSwapEvents() {
  $('#btnSwap').addEventListener('click', doSwap);
  $('#btnSwapFlip').addEventListener('click', flipSwap);
  $('#swapFromAmount').addEventListener('input', debounce(getSwapQuote, 600));
  // slippage buttons
  document.querySelectorAll('.slippage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.slippage-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // 20% / 50% / 70% / MAX. The old single MAX filled the field with the entire
  // balance, which on the native token means the swap cannot pay its own gas —
  // the transaction is rejected and the user has no idea why. resolveMax
  // subtracts the fee first and truncates, and it leaves the field empty with an
  // explanation when the balance cannot cover the fee at all. A share is taken
  // of what is actually sendable, so 20% never rounds up past it.
  const applyPct = async (pct) => {
    const sel = $('#swapFrom');
    const t = get('tokens').find(x => (x.address || 'native') === sel.value);
    if (!t) return;
    const r = await resolveMax({
      token: { balance: t.balance, decimals: t.decimals, address: t.address, symbol: t.symbol },
      provider: get('provider'),
      from: get('address'),
      pct,
      // A swap is not a transfer. Reserving the 21k of a native transfer here
      // produced a MAX amount that provably could not pay for its own gas.
      gasLimit: 280000n,
    });
    const field = $('#swapFromAmount');
    const note = $('#swapMaxNote');
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
  // Delegated: the row is static, so one listener covers every button in it.
  $('#swapPctBtns')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-swap-pct]');
    if (btn) applyPct(Number(btn.dataset.swapPct));
  });
}

export function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  if (!from || !to) return;
  const net = getNetworkById(get('networkId'));

  // Offer the chain's popular tokens plus anything the user holds. Previously
  // this listed ONLY held tokens, so a wallet holding just ETH got a
  // single-option dropdown and swapping was impossible.
  const held = get('tokens') || [];
  const tokens = [...held];
  const seen = new Set(held.map(t => (t.address || 'native').toLowerCase()));
  for (const p of (POPULAR_TOKENS[net?.chainId] || [])) {
    if (!seen.has(p.address.toLowerCase())) {
      tokens.push({ address: p.address, symbol: p.symbol, decimals: p.decimals, balance: '0', usd: null });
      seen.add(p.address.toLowerCase());
    }
  }
  // native gas token must always be selectable
  if (!tokens.some(t => !t.address)) {
    tokens.unshift({
      address: null, symbol: net?.symbol || 'Native',
      decimals: net?.decimals ?? 18, balance: '0', usd: null
    });
  }

  const opts = tokens.map(t =>
    `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`
  ).join('');
  // Repainting the options must not steal the pair the user already chose —
  // this re-runs on every view switch and on every refresh, and re-entering
  // Swap used to snap the form straight back to the defaults.
  const keepFrom = from.value;
  const keepTo = to.value;
  from.innerHTML = opts;
  to.innerHTML = opts;
  const stillThere = (sel, v) => !!v && [...sel.options].some(o => o.value === v);
  if (stillThere(from, keepFrom)) from.value = keepFrom;
  else from.selectedIndex = 0;
  if (stillThere(to, keepTo)) to.value = keepTo;
  else if (to.options.length > 1) to.selectedIndex = 1;

  // Show an in-app chooser with logos on top of the native select, which stays
  // authoritative. A native select's option list is an OS popup that escapes
  // the page on a phone; the picker's list is clamped inside the app.
  initTokenPicker('swapFrom', tokens);
  initTokenPicker('swapTo', tokens);

  // update balance displays + auto-route quote on token change
  const updateBalance = () => {
    const ft = tokens.find(x => (x.address || 'native') === from.value);
    const tt = tokens.find(x => (x.address || 'native') === to.value);
    const fb = $('#swapFromBalance'), tb = $('#swapToBalance');
    // fmtAmount is the formatter send/dashboard already use (js/ui.js): grouped
    // thousands, precision that shrinks as the number grows, a genuine zero as
    // 0.00, and dust reported as — instead of the old hand-rolled
    // toFixed(4) which printed a lying "0.0000" for 1 wei.
    if (fb) fb.textContent = `Balance: ${ft ? fmtAmount(ft.balance, ft.decimals) : '—'}`;
    if (tb) tb.textContent = `Balance: ${tt ? fmtAmount(tt.balance, tt.decimals) : '—'}`;
    // auto-route: refresh quote when tokens change (if amount > 0)
    const amt = $('#swapFromAmount')?.value;
    if (amt && parseFloat(amt) > 0) getSwapQuote();
  };
  // re-binding on every view switch used to stack duplicate listeners
  if (from._bearBalanceHandler) from.removeEventListener('change', from._bearBalanceHandler);
  if (to._bearBalanceHandler) to.removeEventListener('change', to._bearBalanceHandler);
  from._bearBalanceHandler = updateBalance;
  to._bearBalanceHandler = updateBalance;
  from.addEventListener('change', updateBalance);
  to.addEventListener('change', updateBalance);
  updateBalance();
}

export function flipSwap() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tmp = from.value; from.value = to.value; to.value = tmp;
  // Repaint BOTH pickers. Each picker repoints its logo/symbol on its OWN
  // select's 'change' (token-picker.js paintTrigger), so dispatching only on
  // `from` left the To trigger showing the old token: ETH=USDC, flip →
  // displayed "USDC = USDC" while the values had actually swapped.
  from.dispatchEvent(new Event('change'));
  to.dispatchEvent(new Event('change'));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

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

// ── KyberSwap: fetch routes (quote) ──
async function kyberQuote(slug, tokenIn, tokenOut, amountIn) {
  const url = `${KYBER_API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetchWithTimeout(url, { headers: { 'x-client-id': CLIENT_ID } });
  if (!res.ok) throw new Error(`KyberSwap quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.routeSummary) throw new Error('KyberSwap: empty route');
  return json.data; // { routeSummary, routerAddress }
}

// ── KyberSwap: build transaction data ──
async function kyberBuild(slug, routeSummary, sender, recipient, slippageBps) {
  const url = `${KYBER_API}/${slug}/api/v1/route/build`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID },
    body: JSON.stringify({
      routeSummary,
      sender,
      recipient,
      slippageTolerance: slippageBps,
    }),
  });
  if (!res.ok) throw new Error(`KyberSwap build HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.data || !json.data?.routerAddress) throw new Error('KyberSwap: empty build');
  return json.data; // { data (calldata), routerAddress (address) }
}

// ── ParaSwap: fetch swap quote + build ──
//
// Measured 2026-10-03 against api.paraswap.io with NO credential:
//   GET  /prices/?srcToken=…&destToken=…&amount=…&srcDecimals=…&destDecimals=…
//            &side=SELL&network=…&slippage=0.5     → 200 { priceRoute }
//   (the previous path-style /prices/1/0x…/0x…/amount answers
//    400 {"error":"Invalid tokens"} — it is why this was rewritten)
//   POST /transactions/{network}                   → 200 { to, data, value, … }
//        (400 "Cannot specify both slippage and destAmount" if slippage is
//         sent alongside a priceRoute that already carries destAmount)
//
// ignoreChecks: the build runs at QUOTE time, before doSwap's approve step.
// ParaSwap gates its build on balance + TokenTransferProxy allowance, and the
// allowance for a fresh token only exists AFTER that approve — gating here
// would deadlock: no quote → no approval → no quote. The chain still enforces
// everything at execution; ignoreChecks only skips a premature duplicate of
// checks the executor already owns.
//
// approveTo: priceRoute.tokenTransferProxy is the contract that actually PULLS
// the tokens. The calldata goes to a different address (Augustus, tx.to), and
// a plain `approve(tx.to, …)` passes the send and then fails the swap.
async function paraswapQuote(chainId, tokenIn, tokenOut, amountIn, fromAddr, slippageBps, srcDecimals, dstDecimals) {
  // tokenIn/Out: use NATIVE_SENTINEL for native
  const srcToken = tokenIn === NATIVE_SENTINEL ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : tokenIn;
  const dstToken = tokenOut === NATIVE_SENTINEL ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : tokenOut;
  const url = `${PARASWAP_API}/prices/?srcToken=${srcToken}&destToken=${dstToken}` +
    `&amount=${amountIn}&srcDecimals=${srcDecimals}&destDecimals=${dstDecimals}` +
    `&side=SELL&network=${chainId}&slippage=${slippageBps / 100}`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ParaSwap quote HTTP ${res.status}`);
  const json = await res.json();
  const priceRoute = json.priceRoute;
  if (!priceRoute?.destAmount) throw new Error('ParaSwap: empty quote');
  const buildRes = await fetchWithTimeout(`${PARASWAP_API}/transactions/${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      srcToken, destToken: dstToken,
      srcAmount: amountIn, destAmount: priceRoute.destAmount,
      userAddress: fromAddr,
      priceRoute, side: 'SELL', network: chainId,
      ignoreChecks: true,
    }),
  });
  if (!buildRes.ok) {
    // The API's own message ("Not enough WETH balance", …) beats a bare number.
    let detail = `HTTP ${buildRes.status}`;
    try { detail = (await buildRes.json()).error || detail; } catch { /* keep the number */ }
    throw new Error(`ParaSwap build ${detail}`);
  }
  const tx = await buildRes.json();
  if (!tx.to || !tx.data) throw new Error('ParaSwap: empty build');
  return {
    data: tx.data,
    routerAddress: tx.to,                       // where the calldata is SENT
    approveTo: priceRoute.tokenTransferProxy,   // what PULLS the tokens
    amountOut: BigInt(priceRoute.destAmount),
  };
}

// ── get quote — AUTO-ROUTE or user-selected router ──
// Every returned quote is REAL (API or on-chain). No simulation.
export async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;

  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const slippageBtn = document.querySelector('.slippage-btn.active');
  const slippage = slippageBtn ? slippageBtn.dataset.val : '0.5';
  const quoteBox = $('#swapQuote');
  if (!quoteBox) return;
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');

  const sellSymbol = from === 'native' ? net.symbol : (tokenInfo(from)?.symbol ?? '???');
  const buySymbol = to === 'native' ? net.symbol : (tokenInfo(to)?.symbol ?? '???');
  const toDecimals = to === 'native' ? 18 : (tokenInfo(to)?.decimals ?? 18);
  const fromDecimals = from === 'native' ? 18 : (tokenInfo(from)?.decimals ?? 18);

  const tokenIn = from === 'native' ? NATIVE_SENTINEL : from;
  const tokenOut = to === 'native' ? NATIVE_SENTINEL : to;
  const amountInWei = ethers.parseUnits(amt, fromDecimals).toString();
  const slippageBps = Math.round(parseFloat(slippage) * 100);
  const userAddr = get('address');

  // Check user-selected router (or 'auto' = try all)
  const selectedRouter = $('#swapRouterSelect')?.value || 'auto';
  const errors = [];

  // Helper: try a specific router
  async function tryRouter(id) {
    switch (id) {
      case 'kyberswap': {
        const slug = KYBER_CHAIN_SLUG[net.chainId];
        if (!slug) throw new Error('chain not supported');
        const key = cacheKey(slug, tokenIn, tokenOut, amountInWei);
        const now = Date.now();
        let quoteData;
        if (quoteCache.key === key && now - quoteCache.ts < CACHE_TTL) {
          quoteData = quoteCache.data;
        } else {
          quoteData = await kyberQuote(slug, tokenIn, tokenOut, amountInWei);
          quoteCache = { key, data: quoteData, ts: now };
        }
        const built = await kyberBuild(slug, quoteData.routeSummary, userAddr, userAddr, slippageBps);
        const outAmount = BigInt(quoteData.routeSummary.amountOut ?? '0');
        return { source: 'KyberSwap', built, routerAddress: built.routerAddress, outAmount };
      }
      case 'paraswap': {
        // The builder measured unauthenticated (see paraswapQuote) — it was in
        // the registry and in the dropdown with no case here, so selecting it
        // fell into the dex default and threw. Quote → approve proxy → send.
        const ps = await paraswapQuote(
          net.chainId, tokenIn, tokenOut, amountInWei, userAddr, slippageBps,
          fromDecimals, toDecimals);
        return {
          source: 'ParaSwap',
          built: { data: ps.data, routerAddress: ps.routerAddress, approveTo: ps.approveTo },
          routerAddress: ps.routerAddress,
          outAmount: ps.amountOut,
        };
      }
      default: {
        // Every on-chain venue goes through the same two builders, chosen by the
        // abi field the registry carries. A venue with no builder of its own
        // cannot be selected at all, which is why the registry only lists ones
        // that can be executed.
        const entry = SWAP_ROUTERS.find((r) => r.id === id);
        if (!entry) throw new Error('unknown router: ' + id);
        if (entry.type !== 'dex') throw new Error(`${entry.name} is not an on-chain route here`);
        const min = (out) => (out * (10000n - BigInt(slippageBps))) / 10000n;
        if (entry.abi === 'v3') {
          const v3 = await v3Quote(entry.id, net.chainId, tokenIn, tokenOut, amountInWei);
          return {
            source: entry.name,
            uniswap: { kind: 'v3', chainId: net.chainId, tokenIn, tokenOut, amountIn: amountInWei, amountOutMin: min(v3.amountOut), fee: v3.fee, router: v3.router },
            outAmount: v3.amountOut,
          };
        }
        const v2 = await v2Quote(entry.id, net.chainId, tokenIn, tokenOut, amountInWei);
        const outAmount = v2.amounts[v2.amounts.length - 1];
        return {
          source: entry.name,
          uniswap: { kind: 'v2', chainId: net.chainId, tokenIn, tokenOut, amountIn: amountInWei, amountOutMin: min(outAmount), router: v2.router },
          outAmount,
        };
      }
    }
  }

  // Show result from a successful quote
  function showResult(result) {
    const outFormatted = ethers.formatUnits(result.outAmount, toDecimals);
    const rate = parseFloat(outFormatted) / parseFloat(amt);
    // Stamp what this quote was actually BUILT for. The sign dialog renders
    // whatever is in the amount field at the time it opens, while the executed
    // calldata comes from this snapshot — so without a binding between them a
    // user could confirm "5 ETH" and have the router spend 100: the old
    // amountIn, silently, with the dialog vouching for the new one.
    let amountInWei = null;
    try { amountInWei = ethers.parseUnits(amt || '0', fromDecimals).toString(); } catch { amountInWei = null; }
    const quoteData = {
      simulated: false,
      amountInWei,
      fromToken: from,
      toToken: to,
      chainId: Number(getNetworkById(get('networkId'))?.chainId || 0),
      slippageBps: Math.round(parseFloat(slippage || 0.5) * 100),
      ...result,
    };
    delete quoteData.outAmount;
    set('swapQuote', quoteData);
    $('#swapToAmount').value = outFormatted;
    quoteBox.innerHTML =
      `Route: <b>${escapeHtml(result.source)}</b> · Rate: 1 ${escapeHtml(sellSymbol)} ≈ ${rate.toFixed(6)} ${escapeHtml(buySymbol)}<br>` +
      `Slippage: ${escapeHtml(slippage)}%`;
  }

  // ── native ↔ wrapped twin: direct WETH deposit/withdraw, never a DEX ──
  const wrapDir = wrapDirection(net.chainId, from, to);
  if (wrapDir) {
    return showResult({
      source: wrapDir === 'deposit' ? 'Wrap (direct)' : 'Unwrap (direct)',
      wrap: { weth: CHAIN_WETH[Number(net.chainId)], direction: wrapDir },
      outAmount: ethers.parseUnits(amt, fromDecimals),
    });
  }

  // If user selected a specific router, try ONLY that one
  if (selectedRouter !== 'auto') {
    try {
      const result = await tryRouter(selectedRouter);
      return showResult(result);
    } catch (e) {
      set('swapQuote', null);
      $('#swapToAmount').value = '';
      console.warn(`[BearTool] quote via ${selectedRouter} failed:`, e);
      quoteBox.innerHTML = `<div class="quote-error">⚠️ ${escapeHtml(explainError(e, `Quoting via ${selectedRouter}`))}</div>`;
      return;
    }
  }

  // AUTO mode: try all routers in priority order
  // Derived, not a hand-written list: a router added to the registry is tried
  // here automatically, and a router removed from it cannot linger in this array.
  // Aggregators first — they route across venues and usually price better.
  const routerOrder = SWAP_ROUTERS.map((r) => r.id).filter((id) => {
    const e = SWAP_ROUTERS.find((r) => r.id === id);
    return e && e.chains.includes(Number(net.chainId));
  });
  for (const id of routerOrder) {
    try {
      const result = await tryRouter(id);
      return showResult(result);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }

  // No real route — honest error.
  set('swapQuote', null);
  $('#swapToAmount').value = '';
  quoteBox.innerHTML =
    `<div class="quote-error">⚠️ No route available on ${escapeHtml(net.name)} — no swap will happen.</div>` +
    `<div class="quote-error-detail">${escapeHtml(errors.join(' · '))}</div>`;
}

// ── stale-quote guard ──────────────────────────────────────────────────────
// The quote is a snapshot of one specific amount, token pair and chain, and the
// calldata that will be sent was built from that snapshot. Every field the form
// can move must be read back — `toToken` was WRITTEN into the quote and never
// checked, so confirming "token in A" could broadcast a route built for token
// out B: the dialog vouching for a swap the transaction was not.
//
// It THROWS instead of returning a message the caller may forget to print, and
// doSwap turns that into a toast. Checked once before the confirmation dialogs
// and once more inside runTx, right before approve/broadcast.
export function assertQuoteFresh(quote, { from, to, chainId, wantWei } = {}) {
  if (!quote) throw new Error('Get a quote first');
  if (quote.amountInWei == null || wantWei == null || quote.amountInWei !== wantWei) {
    throw new Error('Quote is stale — waiting for a fresh one');
  }
  if (quote.fromToken && quote.fromToken !== from) {
    throw new Error('Quote is for a different token — re-quote');
  }
  if (quote.toToken && quote.toToken !== to) {
    throw new Error('Quote stale — ulangi swap');
  }
  if (quote.chainId && chainId && Number(quote.chainId) !== Number(chainId)) {
    throw new Error('Quote is from another network — re-quote');
  }
  return true;
}

// ── execute swap ──
export async function doSwap() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to swap', 'error');
  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const quote = get('swapQuote');
  if (!quote) return toast('Get a quote first', 'error');
  // Activity/dialog text carries SYMBOLS, never raw select values — an 0xfff…
  // address in an Activity row is unreadable (live report).
  const dispSym = (v) => v === 'native' ? (net.symbol || 'ETH') : (tokenInfo(v)?.symbol || v);

  // The quote is a snapshot of one specific amount, token pair and chain, and
  // the calldata that will be sent was built from that snapshot. The form can
  // have moved on since — a 20% button, a paste, a swap of the token select —
  // and then the dialog would vouch for an amount the transaction does not use.
  // Refuse and make it re-quote rather than sign something else.
  const fromDecimals = from === 'native' ? 18 : (tokenInfo(from)?.decimals ?? 18);
  let wantWei = null;
  try { wantWei = ethers.parseUnits(amt, fromDecimals).toString(); } catch { wantWei = null; }
  try {
    assertQuoteFresh(quote, { from, to, chainId: net.chainId, wantWei });
  } catch (e) {
    return toast(e?.message || 'Quote stale — ulangi swap', 'error');
  }
  // Show the slippage the route was actually built with, not a default that
  // was never wired to the active button.
  const slipPct = (quote.slippageBps ?? 50) / 100;

  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'MAINNET SWAP!',
      rows: [{ k: 'From', v: `${amt} ${dispSym(from)}` }, { k: 'To', v: dispSym(to) }, { k: 'Network', v: net.name }, { k: 'Route', v: quote.source || '?' }],
      confirmText: 'Swap', danger: true
    });
    if (!ok) return;
  }

  // sign confirmation — show full swap details before signing
  const signOk = await confirmTx({
    title: '✍️ SIGN SWAP',
    rows: [
      { k: 'Network', v: net.name },
      { k: 'From', v: `${amt} ${dispSym(from)}` },
      { k: 'To', v: `→ ${dispSym(to)}` },
      { k: 'Router', v: quote.source || 'Auto' },
      { k: 'Slippage', v: `${slipPct}%` }
    ],
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    danger: false
  });
  if (!signOk) return toast('Swap cancelled', 'info');

  if (!quote || quote.simulated || (!quote.built && !quote.uniswap && !quote.wrap)) {
    return toast('No valid quote — get a route first.', 'error');
  }

  await runTx('swap', $('#btnSwap'), async () => {
    // Last look at the form before anything is signed or sent: the confirm
    // dialog is not a lock, and a token select moved behind it must not be
    // broadcast. Same guard, so the pair can never diverge between the dialog
    // and the wire.
    assertQuoteFresh(quote, { from, to, chainId: net.chainId, wantWei });
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const userAddr = get('address');

    // ERC-20 approve if needed (shared by all routes). Wrap/unwrap needs no
    // allowance: withdraw() burns the caller's own WETH, deposit() pays in ETH.
    if (from !== 'native' && !quote.wrap) {
      const fromDecimals = tokenInfo(from)?.decimals ?? 18;
      const amountWei = ethers.parseUnits(amt, fromDecimals);
      const router = quote.built ? quote.built.routerAddress : quote.uniswap.router;
      // ParaSwap sends its calldata to Augustus but the tokens are pulled by
      // the TokenTransferProxy the priceRoute named — approving `router` there
      // would broadcast fine and then fail the swap. Kyber/DEX routes carry no
      // approveTo and keep approving the address they execute through.
      const approveTo = (quote.built && quote.built.approveTo) || router;
      const c = new ethers.Contract(from, ERC20_ABI, signer);
      // Balance BEFORE anything is approved. Broadcasting an approval for
      // tokens the wallet does not hold costs real gas and then fails at the
      // router anyway — a pointless two-transaction sequence the user cannot
      // read. Reading it locally (no extra RPC: the allowance read is already
      // a call) turns it into one sentence up front.
      const bal = await c.balanceOf(userAddr);
      if (bal < amountWei) {
        throw new Error(
          `Insufficient ${dispSym(from)} balance — you hold ` +
          `${ethers.formatUnits(bal, fromDecimals)} ${dispSym(from)}, the swap needs ${amt}`);
      }
      const allowance = await c.allowance(userAddr, approveTo);
      if (allowance < amountWei) {
        toast('Approving token...', 'info');
        // The exact amount, not MaxUint256. An unlimited approval is permanent:
        // the router keeps the right to pull the whole balance for as long as it
        // holds, so a bug or a compromise in the router — or in anything that
        // gets its calldata from there — can drain every future deposit into
        // this token, with no second prompt. Approving amountWei limits the
        // exposure to this one swap. The trade-off is a second approval once
        // the allowance is spent, which is the correct order of those two costs.
        const txApprove = await withTimeout(c.approve(approveTo, amountWei), BROADCAST_TIMEOUT_MS, 'approve broadcast');
        const { timedOut: approveTimedOut } = await waitForReceipt(txApprove, { timeoutMs: 90000, label: 'approve confirmation' });
        if (approveTimedOut) {
          toast('Approve sent but not confirmed in time. Re-open Swap and try again once it lands.', 'info');
          return;
        }
      }
    }

    let tx;
    if (quote.wrap) {
      // Direct WETH route (wrapDirection): exactly 1:1, no router, no pool.
      const w = quote.wrap;
      const wrapAmt = ethers.parseUnits(amt, 18);
      const weth = new ethers.Contract(w.weth, [
        'function deposit() payable',
        'function withdraw(uint256 wad)',
      ], signer);
      tx = await withTimeout(
        w.direction === 'deposit'
          ? weth.deposit({ value: wrapAmt })
          : weth.withdraw(wrapAmt),
        BROADCAST_TIMEOUT_MS, 'swap broadcast');
    } else if (quote.built) {
      // KyberSwap aggregator route
      tx = await withTimeout(signer.sendTransaction({
        to: quote.built.routerAddress,
        data: quote.built.data,
        value: from === 'native' ? ethers.parseEther(amt) : 0n,
      }), BROADCAST_TIMEOUT_MS, 'swap broadcast');
    } else if (quote.uniswap.kind === 'v3') {
      const u = quote.uniswap;
      tx = await uniswapV3Swap(signer, u.router, u.tokenIn, u.tokenOut, u.amountIn, u.amountOutMin, userAddr, u.fee);
    } else {
      const u = quote.uniswap;
      tx = await uniswapV2Swap(signer, u.router, u.tokenIn, u.tokenOut, u.amountIn, u.amountOutMin, userAddr);
    }
    toast('Swap tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'swap', status: 'pending', ts: Date.now(), detail: `${amt} ${dispSym(from)} → ${dispSym(to)}`, symbols: [from, to] });
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'swap', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${dispSym(from)} → ${dispSym(to)}`, symbols: [from, to] });
    toast(receipt.status === 1 ? 'Swap confirmed! 🎉' : 'Swap failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}

// ═══════════════════════════════════════════════════════════════
// UNISWAP V2 / V3 INTEGRATION
// ═══════════════════════════════════════════════════════════════

// ── Uniswap V2: getAmountsOut quote ──
// Honest guard: the router must have code on this chain, else it is
// skipped (a hardcoded address with no contract must never be used).
// Generic Uniswap-V2-family quote. The registry says which chains each router is
// deployed on, and the router itself is asked for its wrapped-native token —
// so adding a V2 fork is one registry entry, not another hardcoded WETH list.
export async function v2Quote(routerId, chainId, tokenIn, tokenOut, amountIn) {
  const routerAddr = getRouterAddress(routerId, chainId);
  if (!routerAddr) throw new Error(`${routerId} is not deployed on chain ${chainId}`);
  const provider = get('provider');
  const code = await provider.getCode(routerAddr);
  if (!code || code === '0x') throw new Error(`${routerId} router has no code on chain ${chainId}`);
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, provider);
  // Ask the contract rather than trusting a local table: if the router is not a
  // V2 fork this reverts, which is the honest failure, instead of quoting a path
  // through an address that does not implement the interface.
  const weth = await router.WETH();
  const inAddr = tokenIn === NATIVE_SENTINEL ? weth : tokenIn;
  const outAddr = tokenOut === NATIVE_SENTINEL ? weth : tokenOut;
  // Native and wrapped native are the same asset, and the token picker offers
  // both. Quoting ETH→WETH resolves to [WETH, WETH] and the router answers
  // IDENTICAL_ADDRESSES — a raw revert that reaches the user as a failed quote
  // for a perfectly ordinary request. Found by tests/fork/fork-swap-app.test.js,
  // which asked for the third direction and came back with one token twice.
  //
  // Say it in the user's terms instead of letting the router speak. Wrapping and
  // unwrapping are free and one-for-one, so there is no price to quote and
  // nothing to route.
  if (String(inAddr).toLowerCase() === String(outAddr).toLowerCase()) {
    const label = tokenIn === NATIVE_SENTINEL ? 'the native coin and its wrapped form'
      : tokenOut === NATIVE_SENTINEL ? 'its wrapped form and the native coin'
      : 'both tokens';
    throw new Error(`${label} are the same asset — pick a different token. Wrapping or unwrapping costs nothing and needs no route.`);
  }
  const path = [inAddr, outAddr];
  const amounts = await router.getAmountsOut(amountIn, path);
  return { amounts, router: routerAddr, path };
}

// ── Uniswap V3: exactInputSingle quote (via provider call) ──
// Tries common fee tiers (3000 → 500 → 10000) until one quotes.
// Generic V3 quote. Router and quoter are separate deployments and they are not
// deployed on the same chains — QuoterV2 (CREATE2) exists on Base while
// SwapRouter02 does not — so both are looked up per chain and the entry is only
// listed for chains where the ROUTER answers. A quoter without a router quotes a
// swap that cannot be sent.
export async function v3Quote(routerId, chainId, tokenIn, tokenOut, amountIn, fee = 3000) {
  const quoterAddr = getQuoterAddress(routerId, chainId);
  const routerAddr = getRouterAddress(routerId, chainId);
  if (!quoterAddr || !routerAddr) throw new Error(`${routerId} is not available on chain ${chainId}`);
  const provider = get('provider');
  const qcode = await provider.getCode(quoterAddr);
  if (!qcode || qcode === '0x') throw new Error(`${routerId} quoter has no code on chain ${chainId}`);
  const rcode = await provider.getCode(routerAddr);
  if (!rcode || rcode === '0x') throw new Error(`${routerId} router has no code on chain ${chainId}`);

  const quoterABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ];
  const quoter = new ethers.Contract(quoterAddr, quoterABI, provider);
  const router = new ethers.Contract(routerAddr, UNISWAP_V3_ABI, provider);
  let weth = null;
  try { weth = await router.WETH9(); } catch { /* fall through to the table */ }
  if (!weth) weth = CHAIN_WETH[chainId];
  if (!weth) throw new Error(`${routerId}: no wrapped-native token on chain ${chainId}`);

  const fees = [fee, 500, 10000, 100];
  let lastErr;
  for (const f of fees) {
    try {
      const result = await quoter.quoteExactInputSingle({
        tokenIn: tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
        tokenOut: tokenOut === NATIVE_SENTINEL ? weth : tokenOut,
        amountIn, fee: f, sqrtPriceLimitX96: 0,
      });
      return { amountOut: result.amountOut, router: routerAddr, fee: f };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`${routerId}: no pool for any fee tier`);
}

// A shipped gas estimate can be LOW. CI 37020081620 polygon: QuickSwap leg3
// shipped gasLimit=174636 and ran out of gas at exactly it — waitForTx's
// replay at 5M succeeded, and a fresh estimate at that very state returned
// 185052 (+5.96%). The divergence comes from upstream state quirks at send
// time, which nothing in the app can fix; the gas LIMIT is ours. +25% is
// refunded when unused, so a wrong estimate stops costing a failed swap and
// starts costing nothing — the buffer is only skipped when the pre-estimate
// itself fails, leaving the send path exactly as it was.
const SWAP_GAS_BUFFER_DEN = 4n;
export async function withSwapGasBuffer(signer, req) {
  try {
    const est = await signer.estimateGas(req);
    return { ...req, gasLimit: (est * (SWAP_GAS_BUFFER_DEN + 1n)) / SWAP_GAS_BUFFER_DEN };
  } catch {
    return req;
  }
}

export async function uniswapV2Swap(signer, routerAddr, tokenIn, tokenOut, amountIn, amountOutMin, to, deadline) {
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, signer);
  const weth = await router.WETH();
  const path = [tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
                 tokenOut === NATIVE_SENTINEL ? weth : tokenOut];
  const txDeadline = deadline || Math.floor(Date.now() / 1000) + 60 * 20;
  let req;
  if (tokenIn === NATIVE_SENTINEL) {
    req = await router.swapExactETHForTokens.populateTransaction(amountOutMin, path, to, txDeadline, { value: amountIn });
  } else if (tokenOut === NATIVE_SENTINEL) {
    req = await router.swapExactTokensForETH.populateTransaction(amountIn, amountOutMin, path, to, txDeadline);
  } else {
    req = await router.swapExactTokensForTokens.populateTransaction(amountIn, amountOutMin, path, to, txDeadline);
  }
  return signer.sendTransaction(await withSwapGasBuffer(signer, req));
}

// ── Uniswap V3: execute swap ──
export async function uniswapV3Swap(signer, routerAddr, tokenIn, tokenOut, amountIn, amountOutMin, to, fee = 3000) {
  const router = new ethers.Contract(routerAddr, UNISWAP_V3_ABI, signer);
  let weth = null;
  try { weth = await router.WETH9(); } catch { /* fall through to the table */ }
  if (!weth) weth = CHAIN_WETH_BY_ROUTER[routerAddr];
  if (!weth) throw new Error('V3 route: no wrapped-native token known for this router');
  const params = {
    tokenIn: tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
    tokenOut: tokenOut === NATIVE_SENTINEL ? weth : tokenOut,
    fee,
    recipient: to,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  };
  if (tokenIn === NATIVE_SENTINEL) {
    const req = await router.exactInputSingle.populateTransaction(params, { value: amountIn });
    return signer.sendTransaction(await withSwapGasBuffer(signer, req));
  }
  const req = await router.exactInputSingle.populateTransaction(params);
  return signer.sendTransaction(await withSwapGasBuffer(signer, req));
}

// ── Multi-router quote: KyberSwap → Uniswap V3 → Uniswap V2 ──
// Returns the best REAL quote or throws — never a simulation.
export async function getBestQuote(chainId, tokenIn, tokenOut, amountIn) {
  const slug = KYBER_CHAIN_SLUG[chainId];
  const errors = [];
  // 1. Try KyberSwap
  if (slug) {
    try {
      const kyber = await kyberQuote(slug, tokenIn, tokenOut, amountIn);
      return { source: 'KyberSwap', data: kyber, simulated: false };
    } catch (e) { errors.push(`KyberSwap: ${e.message}`); }
  } else {
    errors.push('KyberSwap: chain not supported');
  }
  // 2. Then every on-chain venue the registry lists for this chain, in order.
  //    One loop instead of a hand-written ladder, so a new registry entry is
  //    tried without editing this function.
  for (const r of getSwapRoutersForChain(chainId)) {
    if (r.type !== 'dex') continue;
    try {
      if (r.abi === 'v3') {
        const v3 = await v3Quote(r.id, chainId, tokenIn, tokenOut, amountIn);
        return { source: r.name, data: v3, simulated: false };
      }
      const v2 = await v2Quote(r.id, chainId, tokenIn, tokenOut, amountIn);
      const outAmount = v2.amounts[v2.amounts.length - 1];
      return { source: r.name, data: { ...v2, amountOut: outAmount }, simulated: false };
    } catch (e) { errors.push(`${r.name}: ${e.message}`); }
  }
  // 4. No real route — honest failure.
  throw new Error(`No route available: ${errors.join(' · ')}`);
}

// ── get supported DEXes for a chain (real only) ──
// From the registry, so this can no longer claim a venue for a chain where the
// address has nothing behind it — which is exactly what the old chain-keyed maps
// did, and why the UI and the executor could disagree.
export function getSupportedDEXes(chainId) {
  return getSwapRoutersForChain(chainId).map((r) => r.name);
}
