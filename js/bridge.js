// ═══════════════════════════════════════════════════════════════
// Bear Tool — bridge.js
// Bridge view: chain/token select, LI.FI quote (best effort) with
// honest simulated fallback, execute path.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getAllNetworks, getNetworkById } from './network.js';

const { ethers } = globalThis;

export function bindBridgeEvents() {
  $('#btnBridge').addEventListener('click', doBridge);
}

export function loadBridgeChains() {
  const from = $('#bridgeFromChain'), to = $('#bridgeToChain');
  const opts = getAllNetworks().map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)} (${escapeHtml(n.type)})</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  const tok = $('#bridgeToken');
  tok.innerHTML = get('tokens').map(t => `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`).join('');
}

export async function doBridge() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const fromNet = getNetworkById($('#bridgeFromChain').value);
  const toNet = getNetworkById($('#bridgeToChain').value);
  const amt = $('#bridgeAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to bridge', 'error');
  if (fromNet.chainId === toNet.chainId) return toast('Choose two different chains', 'error');

  // LI.FI /v1/quote requires fromAddress — honest error if wallet not unlocked
  const userAddr = get('address');
  if (!userAddr) return toast('Unlock wallet first', 'error');

  if (fromNet.type === 'mainnet' || toNet.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'BRIDGE ON MAINNET!',
      rows: [{ k: 'From', v: `${fromNet.name} (${fromNet.chainId})` }, { k: 'To', v: `${toNet.name} (${toNet.chainId})` }, { k: 'Amount', v: amt }],
      confirmText: 'Bridge', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }

  const box = $('#bridgeQuote');
  box.innerHTML = spinnerDots();
  box.classList.remove('hidden');
  try {
    // LI.FI quote (best effort) — fallback simulated ONLY on network failure
    const url = `https://li.quest/v1/quote?fromChain=${fromNet.chainId}&toChain=${toNet.chainId}&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=${ethers.parseEther(amt)}&fromAddress=${encodeURIComponent(userAddr)}`;
    const res = await fetch(url);
    if (res.ok) {
      const q = await res.json();
      // LI.FI /v1/quote returns a SINGLE object: { transactionRequest, estimate, ... }
      const txReq = q.transactionRequest;
      const est = q.estimate || {};
      if (!txReq?.to || !txReq?.data) throw new Error('LI.FI quote missing transactionRequest');
      set('bridgeQuote', { ...q, simulated: false });
      const fee = est?.feeCosts?.[0]?.amountUSD ?? '?';
      const dur = est?.executionDuration ?? '?';
      const route = `${est?.steps?.[0]?.tool ?? '?'} → ${est?.steps?.[1]?.tool ?? 'done'}`;
      box.innerHTML = `Route: ${escapeHtml(route)} · Est. time: ${escapeHtml(String(dur))}s<br>Fees: ≈ ${escapeHtml(String(fee))} USD`;

      // execute the real bridge tx from the LI.FI quote (double-submit guarded)
      await runTx('bridge', $('#btnBridge'), async () => {
        const provider = get('provider');
        const signer = get('signer').connect(provider);
        const tx = await signer.sendTransaction({
          to: txReq.to,
          data: txReq.data,
          value: txReq.value ? BigInt(txReq.value) : 0n,
        });
        toast('Bridge tx sent! ⏳', 'info');
        addActivity({ hash: tx.hash, type: 'bridge', status: 'pending', ts: Date.now(), detail: `${fromNet.name} → ${toNet.name} (${amt} tokens)` });
        const receipt = await tx.wait();
        addActivity({ hash: tx.hash, type: 'bridge', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${fromNet.name} → ${toNet.name} (${amt} tokens)` });
        toast(receipt.status === 1 ? 'Bridge confirmed! 🎉' : 'Bridge failed!', receipt.status === 1 ? 'success' : 'error');
        emit('refresh');
      });
    } else {
      set('bridgeQuote', { simulated: true });
      box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED route — no real bridge will happen. Connect LI.FI API for live routes.</div>
        Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)} (${escapeHtml(amt)} tokens)`;
    }
  } catch (e) {
    set('bridgeQuote', { simulated: true });
    box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED — no real bridge. (${escapeHtml(e?.message || 'network error')})</div>
      Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}`;
  }
}