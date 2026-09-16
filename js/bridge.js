// ═══════════════════════════════════════════════════════════════
// Bear Tool — bridge.js
// Bridge view: chain/token select, LI.FI quote (best effort) with
// honest simulated fallback, execute path.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, fmtUsd, escapeHtml, spinnerDots } from './ui.js';
import { get, set, requireUnlock } from './state.js';
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
    // LI.FI quote (best effort) — fallback simulated
    const url = `https://li.quest/v1/quote?fromChain=${fromNet.chainId}&toChain=${toNet.chainId}&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=${ethers.parseEther(amt)}`;
    const res = await fetch(url);
    if (res.ok) {
      const q = await res.json();
      set('bridgeQuote', q);
      box.innerHTML = `Route: ${escapeHtml(q.routes?.[0]?.steps?.length || '?')} steps · Est. time: ${escapeHtml(q.routes?.[0]?.estimate?.executionDuration || '?')}s<br>
        Fee: ${escapeHtml(fmtUsd(parseFloat(q.routes?.[0]?.estimate?.feeCosts?.[0]?.amountUSD || 0)))}`;
    } else {
      set('bridgeQuote', { simulated: true });
      box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED route — no real bridge will happen. Connect LI.FI API for live routes.</div>
        Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)} (${escapeHtml(amt)} tokens)`;
    }
  } catch {
    set('bridgeQuote', { simulated: true });
    box.innerHTML = `<div class="simulated-banner">⚠️ SIMULATED route — no real bridge will happen.</div>
      Simulated route: ${escapeHtml(fromNet.name)} → ${escapeHtml(toNet.name)}`;
  }
}