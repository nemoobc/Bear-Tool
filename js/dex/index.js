// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/index.js (Dex v2) — the view entry.
//
// The app's standing contract: renderDex(root, opts) with root = #dexRoot;
// app.js switchView → refreshView('dex') calls it. The thin React shell
// (src/views/dex.jsx) carries the static chrome; this module paints and owns
// everything live.
//
// Milestone 1: an honest mounted state — network, wallet, engine gate. No
// fake buttons, no decorative stubs: what is not yet built (swap, pools,
// launch, bot — coming in milestones 2+) simply is not on screen yet, and the
// three rows answer the only questions that matter right now. Works with zero
// address, like every other view (app doctrine).
// ═══════════════════════════════════════════════════════════════

import { get, on, off } from '../state.js';
import { getNetworkById } from '../network.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui.js';
import { DEX_CHAIN_ID, dexChainOk } from './core.js';

function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}

// The single live subscription of the current paint. A stale handler must
// never rewrite a DOM node another view now owns, so every paint re-arms it
// and the handler bails once its root has left the document.
let repaint = null;

export function renderDex(root, opts = {}) {
  if (!root) return { ok: false, reason: 'no-root' };

  const net = getNetworkById(get('networkId')) || {};
  const chainOk = dexChainOk(net.chainId);
  const addr = get('address') || '';

  root.innerHTML = `
    <p class="small" id="dexHint">${t('dex.hint')}</p>
    <div class="dex-state" id="dexState">
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.net')}</span>
        <span class="dex-v">${chainOk ? '● ' : '○ '}${escapeHtml(net.name || '—')}</span>
      </div>
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.wallet')}</span>
        <span class="dex-v">${addr ? escapeHtml(shortAddr(addr)) : t('dex.wallet.none')}</span>
      </div>
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.engine')}</span>
        <span class="dex-v" id="dexEngineState">${chainOk ? t('dex.engine.on') : t('dex.engine.off')}</span>
      </div>
    </div>`;

  // A network switch while the view is open repaints the truth. Off before on:
  // re-arming the same key must never stack handlers.
  if (repaint) {
    try { off('networkId', repaint); } catch { /* first paint has none */ }
  }
  repaint = () => {
    if (typeof root.isConnected !== 'undefined' && !root.isConnected) {
      if (repaint) { try { off('networkId', repaint); } catch { /* already gone */ } }
      repaint = null;
      return;
    }
    renderDex(root, opts);
  };
  on('networkId', repaint);

  return { ok: true, chainOk, wallet: Boolean(addr) };
}
