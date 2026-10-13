// Bear Tool — js/dex/tokens.js
// The Dex's LIVE token list — its home screen. Two kinds of row:
//   • the three native coins (the Dex's own coins, always present);
//   • launchpad tokens this wallet has deployed (PumpTokens on their own
//     bonding curve), which carry an on-chain image and a graduation progress.
// Nothing here is a hardcoded feed: it is the preset table plus whatever the
// wallet actually deployed, so the list can never show a coin that does not
// exist, and can never hide one that does. (User: "fitur daftar token live".)
import { t } from '../i18n.js';
import { get, set } from '../state.js';
import { $, escapeHtml } from '../ui.js';
import { DEX_PRESETS, dexChainOk, logoHtml, guardTokenLogos, provider, ethersLib } from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { graduationProgress, GRADUATION_ETH } from './curve.js';

// Launchpad tokens this wallet deployed, kept in local state. This is a
// convenience index of addresses YOU created — the chain is still the source
// of truth for each token's live state (read fresh below).
export function launchedTokens() {
  return Array.isArray(get('dex.launched')) ? get('dex.launched') : [];
}

export function rememberLaunchedToken(entry) {
  const list = launchedTokens().filter((x) => x.address.toLowerCase() !== entry.address.toLowerCase());
  list.unshift(entry);
  set('dex.launched', list.slice(0, 50)); // a sane cap; newest first
}

export function tokensHtml() {
  const natives = DEX_PRESETS.map((p) => `
    <button type="button" class="dex-token-row" data-dex-token="${escapeHtml(p.address)}">
      <span class="dex-token-face">${logoHtml(p, 34)}</span>
      <span class="dex-token-meta">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="small">${escapeHtml(p.symbol)} · <span class="mono">${escapeHtml(p.address.slice(0, 6))}…${escapeHtml(p.address.slice(-4))}</span></span>
      </span>
      <span class="dex-token-tag small">${escapeHtml(t('dex.tokens.native'))}</span>
    </button>`).join('');

  const launched = launchedTokens().map((tk) => `
    <button type="button" class="dex-token-row" data-dex-token="${escapeHtml(tk.address)}">
      <span class="dex-token-face">
        ${tk.image ? `<img src="${escapeHtml(tk.image)}" alt="">` : logoHtml({ address: tk.address, symbol: tk.symbol }, 34)}
      </span>
      <span class="dex-token-meta">
        <strong>${escapeHtml(tk.name)}</strong>
        <span class="small">${escapeHtml(tk.symbol)} · <span class="mono">${escapeHtml(tk.address.slice(0, 6))}…${escapeHtml(tk.address.slice(-4))}</span></span>
        <span class="dex-token-bar" id="dexProg_${escapeHtml(tk.address.slice(2, 10))}"></span>
      </span>
      <span class="dex-token-tag small dex-token-tag--curve">${escapeHtml(t('dex.tokens.curve'))}</span>
    </button>`).join('');

  return `
    <div class="field-label">${escapeHtml(t('dex.tokens.title'))}</div>
    <div class="small mb-8">${escapeHtml(t('dex.tokens.hint'))}</div>
    <div id="dexTokenList">${natives}${launched}</div>
    ${launched ? '' : `<div class="dex-empty mt-8">${escapeHtml(t('dex.tokens.none'))}</div>`}`;
}

export function bindTokens(host, onTrade) {
  const list = $('#dexTokenList', host);
  if (list) guardTokenLogos(list);
  // Live graduation progress for each launched curve token, read from chain.
  for (const tk of launchedTokens()) {
    readProgress(tk).then((pct) => {
      const bar = $(`#dexProg_${tk.address.slice(2, 10)}`, host);
      if (bar) bar.textContent = pct;
    });
  }
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-dex-token]');
      if (row && typeof onTrade === 'function') onTrade(row.dataset.dexToken);
    });
  }
}

// Reads realEthReserve + graduated from the live contract. Any failure is
// reported as "unread", never as a made-up progress number.
async function readProgress(tk) {
  const p = provider();
  if (!p || !dexChainOk()) return null;
  try {
    const E = ethersLib();
    const c = new E.Contract(tk.address, PUMP_ABI, p);
    const [reserve, graduated] = await Promise.all([c.realEthReserve(), c.graduated()]);
    if (graduated) return t('dex.tokens.graduated');
    const { bps } = graduationProgress(reserve, GRADUATION_ETH);
    return t('dex.tokens.progress', { pct: String(Number(bps) / 100) });
  } catch {
    return t('dex.tokens.unread');
  }
}
