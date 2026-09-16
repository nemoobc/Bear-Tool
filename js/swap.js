// ═══════════════════════════════════════════════════════════════
// Bear Tool — swap.js
// Swap view: token select, flip, quote (KyberSwap Aggregator,
// CORS-safe, no API key), slippage wired, approve + execute path.
// Honest simulated fallback when chain unsupported or offline.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getNetworkById, ERC20_ABI } from './network.js';

const { ethers } = globalThis;

// ── KyberSwap Aggregator constants ──
const KYBER_API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'bear-tool';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CACHE_TTL = 30_000;

// chainId → KyberSwap API slug (verified supported chains)
const KYBER_CHAIN_SLUG = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
};

// ── simple quote cache (keyed by route params) ──
let quoteCache = { key: null, data: null, ts: 0 };

function cacheKey(slug, tokenIn, tokenOut, amountIn) {
  return `${slug}:${tokenIn}:${tokenOut}:${amountIn}`;
}

// ── token lookup helper ──
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
  // MAX button
  const maxBtn = $('#btnSwapMax');
  if (maxBtn) {
    maxBtn.addEventListener('click', () => {
      const sel = $('#swapFrom');
      const t = get('tokens').find(x => (x.address || 'native') === sel.value);
      if (t) $('#swapFromAmount').value = parseFloat(ethers.formatUnits(t.balance, t.decimals)).toFixed(6);
    });
  }
}

export function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tokens = get('tokens');
  const opts = tokens.map(t =>
    `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`
  ).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  // update balance displays
  const updateBalance = () => {
    const ft = tokens.find(x => (x.address || 'native') === from.value);
    const tt = tokens.find(x => (x.address || 'native') === to.value);
    const fb = $('#swapFromBalance'), tb = $('#swapToBalance');
    if (fb && ft) fb.textContent = `Balance: ${parseFloat(ethers.formatUnits(ft.balance, ft.decimals)).toFixed(4)}`;
    if (tb && tt) tb.textContent = `Balance: ${parseFloat(ethers.formatUnits(tt.balance, tt.decimals)).toFixed(4)}`;
  };
  from.addEventListener('change', updateBalance);
  to.addEventListener('change', updateBalance);
  updateBalance();
}

export function flipSwap() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tmp = from.value; from.value = to.value; to.value = tmp;
  $('#swapFromAmount').value = '';
  $('#swapToAmount').value = '';
  $('#swapQuote').classList.add('hidden');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── KyberSwap: fetch routes (quote) ──
async function kyberQuote(slug, tokenIn, tokenOut, amountIn) {
  const url = `${KYBER_API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetch(url, { headers: { 'x-client-id': CLIENT_ID } });
  if (!res.ok) throw new Error(`KyberSwap quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.routeSummary) throw new Error('KyberSwap: empty route');
  return json.data; // { routeSummary, routerAddress }
}

// ── KyberSwap: build transaction data ──
async function kyberBuild(slug, routeSummary, sender, recipient, slippageBps) {
  const url = `${KYBER_API}/${slug}/api/v1/route/build`;
  const res = await fetch(url, {
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

// ── simulated fallback (honest, labeled) ──
function simulatedQuote(amt, sellSymbol, buySymbol) {
  const rate = 1 + (Math.random() - 0.5) * 0.02;
  const out = parseFloat(amt) * rate;
  return { simulated: true, rate, out, sellSymbol, buySymbol };
}

// ── get quote (KyberSwap → simulated fallback) ──
export async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;

  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const slippageBtn = document.querySelector('.slippage-btn.active');
  const slippage = slippageBtn ? slippageBtn.dataset.val : '0.5';
  const quoteBox = $('#swapQuote');
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');

  const sellSymbol = from === 'native' ? net.symbol : (tokenInfo(from)?.symbol ?? '???');
  const buySymbol = to === 'native' ? net.symbol : (tokenInfo(to)?.symbol ?? '???');
  const toDecimals = to === 'native' ? 18 : (tokenInfo(to)?.decimals ?? 18);

  const slug = KYBER_CHAIN_SLUG[net.chainId];
  if (!slug) {
    const sim = simulatedQuote(amt, sellSymbol, buySymbol);
    $('#swapToAmount').value = sim.out.toFixed(6);
    set('swapQuote', sim);
    quoteBox.innerHTML =
      `<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen. Chain not supported by KyberSwap.</div>` +
      `Simulated: 1 ${escapeHtml(sellSymbol)} ≈ ${sim.rate.toFixed(6)} ${escapeHtml(buySymbol)}`;
    return;
  }

  const tokenIn = from === 'native' ? NATIVE_SENTINEL : from;
  const tokenOut = to === 'native' ? NATIVE_SENTINEL : to;
  const amountInWei = ethers.parseEther(amt).toString();
  const key = cacheKey(slug, tokenIn, tokenOut, amountInWei);
  const now = Date.now();

  try {
    let quoteData;
    if (quoteCache.key === key && now - quoteCache.ts < CACHE_TTL) {
      quoteData = quoteCache.data;
    } else {
      quoteData = await kyberQuote(slug, tokenIn, tokenOut, amountInWei);
      quoteCache = { key, data: quoteData, ts: now };
    }

    const userAddr = get('address');
    const slippageBps = Math.round(parseFloat(slippage) * 100);
    const built = await kyberBuild(slug, quoteData.routeSummary, userAddr, userAddr, slippageBps);

    const outAmount = BigInt(quoteData.routeSummary.amountOut ?? '0');
    const outFormatted = ethers.formatUnits(outAmount, toDecimals);
    const rate = parseFloat(outFormatted) / parseFloat(amt);

    set('swapQuote', { simulated: false, built });

    $('#swapToAmount').value = outFormatted;
    quoteBox.innerHTML =
      `Rate: 1 ${escapeHtml(sellSymbol)} ≈ ${rate.toFixed(6)} ${escapeHtml(buySymbol)}<br>` +
      `Slippage: ${escapeHtml(slippage)}%`;
  } catch (e) {
    console.warn('[BearTool] KyberSwap quote failed:', e.message);
    const sim = simulatedQuote(amt, sellSymbol, buySymbol);
    $('#swapToAmount').value = sim.out.toFixed(6);
    set('swapQuote', sim);
    quoteBox.innerHTML =
      `<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen. ${escapeHtml(e.message)}</div>` +
      `Simulated: 1 ${escapeHtml(sellSymbol)} ≈ ${sim.rate.toFixed(6)} ${escapeHtml(buySymbol)}`;
  }
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

  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'MAINNET SWAP!',
      rows: [{ k: 'From', v: `${amt} ${from}` }, { k: 'To', v: to }, { k: 'Network', v: net.name }],
      confirmText: 'Swap', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }

  if (quote.simulated) {
    return toast('⚠️ SIMULATED — no real swap will happen. Chain not supported or API offline.', 'info');
  }

  await runTx('swap', $('#btnSwap'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const userAddr = get('address');
    const router = quote.built.routerAddress;

    // ERC-20 approve if needed
    if (from !== 'native') {
      const fromDecimals = tokenInfo(from)?.decimals ?? 18;
      const amountWei = ethers.parseUnits(amt, fromDecimals);
      const c = new ethers.Contract(from, ERC20_ABI, signer);
      const allowance = await c.allowance(userAddr, router);
      if (allowance < amountWei) {
        toast('Approving token...', 'info');
        const txApprove = await c.approve(router, ethers.MaxUint256);
        await txApprove.wait();
      }
    }

    // execute swap transaction
    const tx = await signer.sendTransaction({
      to: router,
      data: quote.built.data,
      value: from === 'native' ? ethers.parseEther(amt) : 0n,
    });
    toast('Swap tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'swap', status: 'pending', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'swap', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    toast(receipt.status === 1 ? 'Swap confirmed! 🎉' : 'Swap failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}
