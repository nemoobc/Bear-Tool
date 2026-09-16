// ═══════════════════════════════════════════════════════════════
// Bear Tool — swap.js
// Swap view: token select, flip, quote (0x API best effort with
// honest simulated fallback), slippage wired, execute path.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, fmtUsd, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getNetworkById, ERC20_ABI } from './network.js';

const { ethers } = globalThis;

export function bindSwapEvents() {
  $('#btnSwap').addEventListener('click', doSwap);
  $('#btnSwapFlip').addEventListener('click', flipSwap);
  $('#swapFromAmount').addEventListener('input', debounce(getSwapQuote, 600));
}

export function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const opts = get('tokens').map(t => `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
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

export async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;
  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const slippage = $('#swapSlippage').value;
  const quoteBox = $('#swapQuote');
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');
  try {
    // 0x API quote (best effort) — fallback to simulated quote
    const buyToken = to === 'native' ? net.symbol : to;
    const sellToken = from === 'native' ? net.symbol : from;
    const url = `https://api.0x.org/swap/v1/quote?buyToken=${buyToken}&sellToken=${sellToken}&sellAmount=${ethers.parseEther(amt)}&chainId=${net.chainId}&slippagePercentage=${slippage}`;
    const res = await fetch(url);
    if (res.ok) {
      const q = await res.json();
      set('swapQuote', q);
      $('#swapToAmount').value = ethers.formatEther(q.buyAmount);
      quoteBox.innerHTML = `Rate: 1 ${escapeHtml(sellToken)} ≈ ${(parseFloat(ethers.formatEther(q.buyAmount)) / parseFloat(amt)).toFixed(6)} ${escapeHtml(buyToken)}<br>
        Est. gas: ${escapeHtml(fmtUsd(parseFloat(q.estimatedGas) * 1e-9))} · Slippage: ${escapeHtml(q.slippagePercentage || slippage)}%`;
    } else {
      // simulated quote (offline fallback) — clearly labeled
      const rate = 1 + (Math.random() - 0.5) * 0.02;
      const out = parseFloat(amt) * rate;
      $('#swapToAmount').value = out.toFixed(6);
      set('swapQuote', { simulated: true, rate, out, sellToken, buyToken });
      quoteBox.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen. Connect 0x API key in Settings for live quotes.</div>
        Simulated quote (offline): 1 ${escapeHtml(sellToken)} ≈ ${rate.toFixed(6)} ${escapeHtml(buyToken)}`;
    }
  } catch {
    const out = parseFloat(amt);
    $('#swapToAmount').value = out.toFixed(6);
    set('swapQuote', { simulated: true, rate: 1, out, sellToken: from, buyToken: to });
    quoteBox.innerHTML = '<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen.</div> Simulated quote (offline): 1:1';
  }
}

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
    return toast('⚠️ SIMULATED — no real swap will happen. Connect 0x API key in Settings for live swaps.', 'info');
  }

  // real quote path (best effort — requires a working aggregator response)
  await runTx('swap', $('#btnSwap'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const spender = quote.allowanceTarget || quote.to;
    if (from !== 'native') {
      const c = new ethers.Contract(from, ERC20_ABI, signer);
      const allowance = await c.allowance(get('address'), spender);
      if (allowance < ethers.parseEther(amt)) {
        const txApprove = await c.approve(spender, ethers.MaxUint256);
        toast('Approving token...', 'info');
        await txApprove.wait();
      }
    }
    const tx = await signer.sendTransaction({
      to: quote.to,
      data: quote.data,
      value: quote.value ? BigInt(quote.value) : 0n
    });
    toast('Swap tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'swap', status: 'pending', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'swap', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    toast(receipt.status === 1 ? 'Swap confirmed! 🎉' : 'Swap failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}