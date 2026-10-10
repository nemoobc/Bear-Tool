// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// The curated dApp catalogue and the discovery view.
// The browser itself is js/dapp-browser.js; the pre-load security gate it uses
// is js/dapp-safety.js and the session/permission store is js/dapp-sessions.js.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, dappMark } from './ui.js';
import { openDappBrowser as openInBrowser, openDappHome, openExternalNotice, initDappBrowser } from './dapp-browser.js';
import { classifyInput, inspectUrl, baseHost, VERDICT } from './dapp-safety.js';
import { listBlocked, listTrusted } from './dapp-sessions.js';
import { isNativeDappBrowser } from './native-dapp.js';

// frameable:false → the site ships clickjacking protection (X-Frame-Options or
// frame-ancestors), so NO in-app browser can embed it. Re-probed live against
// the real response headers (not cached from a comment), 2026-09-26:
//
//   embeddable (4):  Aave, Lido, Snapshot, Balancer
//   blocked    (12): Uniswap SAMEORIGIN · Compound DENY · OpenSea DENY ·
//                    Blur DENY · Rocket Pool SAMEORIGIN · Etherscan SAMEORIGIN ·
//                    ENS frame-ancestors 'self' · 1inch frame-ancestors lists
//                    only specific wallet hosts (Ledger/Safe), not any origin ·
//                    Zora frame-ancestors 'self' · Across DENY ·
//                    Stargate frame-ancestors list · Safe SAMEORIGIN
//
// Two entries here were WRONG before this pass and are corrected below:
//   Compound was marked frameable:true but serves `X-Frame-Options: DENY`.
//   Lido was marked frameable:false but serves `frame-ancestors: *`, i.e. it
//     explicitly ALLOWS embedding and was being needlessly pushed to a new tab.
// Balancer was missing entirely and is embeddable.
//
// Not every site answers a plain fetch (PancakeSwap, Curve, Yearn, CoW Swap
// refused the probe), so they are not listed rather than guessed at.
const POPULAR_DAPPS = [
  { name: 'Uniswap', url: 'https://app.uniswap.org', icon: '🦄', category: 'Swap', frameable: false },
  { name: '1inch', url: 'https://app.1inch.io', icon: '🔗', category: 'Swap', frameable: false },
  { name: 'Curve', url: 'https://app.curve.finance', icon: '📉', category: 'Swap', frameable: false },
  { name: 'PancakeSwap', url: 'https://app.pancakeswap.finance', icon: '🥞', category: 'Swap', frameable: false },
  { name: 'Aave', url: 'https://app.aave.com', icon: '👻', category: 'Lending', frameable: true },
  { name: 'Balancer', url: 'https://app.balancer.fi', icon: '⚖️', category: 'Lending', frameable: true },
  { name: 'Compound', url: 'https://app.compound.finance', icon: '🏦', category: 'Lending', frameable: false },
  { name: 'Lido', url: 'https://stake.lido.fi', icon: '🏊', category: 'Staking', frameable: true },
  { name: 'Rocket Pool', url: 'https://rocketpool.net', icon: '🚀', category: 'Staking', frameable: false },
  { name: 'OpenSea', url: 'https://opensea.io', icon: '🌊', category: 'NFT', frameable: false },
  { name: 'Blur', url: 'https://blur.io', icon: '🎨', category: 'NFT', frameable: false },
  { name: 'Zora', url: 'https://zora.co', icon: '🪄', category: 'NFT', frameable: false },
  { name: 'Etherscan', url: 'https://etherscan.io', icon: '🔍', category: 'Explorer', frameable: false },
  { name: 'Snapshot', url: 'https://snapshot.org', icon: '📷', category: 'Governance', frameable: true },
  { name: 'ENS', url: 'https://app.ens.domains', icon: '🏷️', category: 'Identity', frameable: false },
  { name: 'Safe', url: 'https://app.safe.global', icon: '🛡️', category: 'Wallet', frameable: false },
  { name: 'Across', url: 'https://app.across.to', icon: '🌉', category: 'Bridge', frameable: false },
  { name: 'Stargate', url: 'https://stargate.finance', icon: '✦', category: 'Bridge', frameable: false }
];

// The browser itself lives in dapp-browser.js: tabs, the pre-load security
// gate, the omnibox and the menu. This file stays the catalogue plus the
// discovery view, so the security checks can be unit-tested without the grid.
// ── category face — OKX-style icon tiles ─────────────────────────────────
// One source for BOTH dApps surfaces: this view's filter row and the browser
// overlay's category row (passed through initDappBrowser below). The old face
// was a text pill; the tile colour rides as a --cat custom property so the CSS
// never hardcodes a palette. A category missing from the map falls back to a
// neutral tile, so a new catalogue entry renders instead of breaking the row.
export const CAT_STYLE = {
  All:        { glyph: '🌐', color: '#FFC93C' },
  Swap:       { glyph: '🔁', color: '#6366F1' },
  Lending:    { glyph: '🏦', color: '#0EA5E9' },
  Staking:    { glyph: '🌾', color: '#10B981' },
  NFT:        { glyph: '🖼️', color: '#F59E0B' },
  Explorer:   { glyph: '🔍', color: '#64748B' },
  Governance: { glyph: '🗳️', color: '#A855F7' },
  Identity:   { glyph: '🏷️', color: '#EC4899' },
  Wallet:     { glyph: '🛡️', color: '#22C55E' },
  Bridge:     { glyph: '🌉', color: '#F97316' },
};
export const catStyle = (name) => CAT_STYLE[name] || { glyph: '📁', color: '#94A3B8' };

initDappBrowser({ catalog: POPULAR_DAPPS, catStyle: CAT_STYLE });

/**
 * Open a dApp in the in-app browser, or hand it to a new browser tab when the
 * site refuses framing. Both paths still go through the security gate first —
 * opening in a new tab is not a way around it.
 */
export function openDappBrowser(url, name) {
  if (!url) return openDappHome();
  // Native build (Capacitor): the WebView host opens every site full-page —
  // frameability and the external-notice sheet are web-build concepts.
  if (isNativeDappBrowser()) return openInBrowser(url, name);
  const entry = POPULAR_DAPPS.find((d) => d.url === url || baseHost(d.url) === baseHost(url));
  if (entry && entry.frameable === false) {
    // X-Frame-Options / frame-ancestors cannot be worked around from a web page.
    // The browser explains that and offers the button, rather than silently
    // throwing the user into a new tab they did not ask for. The address is
    // vetted on the way: a new tab is still a page they are about to trust.
    const v = inspectUrl(url, POPULAR_DAPPS, { blockedHosts: listBlocked(), trustedHosts: listTrusted() });
    if (v.verdict === VERDICT.BLOCKED || v.verdict === VERDICT.DANGER) {
      return openExternalNotice(url, entry.name, v.signals.find((x) => x.level === 'fail')?.detail);
    }
    return openExternalNotice(url, entry.name,
      'This site sends a clickjacking protection header, so no in-app browser can embed it.');
  }
  return openInBrowser(url, name);
}

export { openDappHome, openInBrowser, openExternalNotice };

/**
 * True when the omnibox holds something to OPEN (a host or URL) rather than a
 * filter query. Exported so the unit tests pin the boundary: "aave" filters,
 * "app.aave.com" and "https://app.aave.com" open, spaces always mean search.
 */
export function looksLikeUrl(v) {
  // One detector, one truth: delegate to classifyInput, the gate the browser
  // itself uses. A second regex here drifted from it — this one had no port,
  // no localhost, no IDN rule — so `localhost:8123` was an address to the
  // address bar and a filter to the Open button, and Enter did nothing.
  return classifyInput(v).kind === 'url';
}

export function renderDapps(container) {
  if (!container) return;
  const cats = [...new Set(POPULAR_DAPPS.map((d) => d.category))];
  const card = (d) => `
    <div class="dapp-card" role="button" tabindex="0"
         data-url="${escapeHtml(d.url)}" data-name="${escapeHtml(d.name)}"
         data-frameable="${d.frameable ? '1' : '0'}" data-category="${escapeHtml(d.category)}"
         aria-label="${escapeHtml(d.name)}, ${escapeHtml(d.category)}${d.frameable ? '' : ', opens in a new tab'}">
      <div class="dapp-icon" style="--cat:${catStyle(d.category).color}">${dappMark(d.name, catStyle(d.category).color, 44)}</div>
      <div class="dapp-name">${escapeHtml(d.name)}</div>
      <div class="dapp-category">${escapeHtml(d.category)}</div>
      <div class="dapp-frame-note">${d.frameable ? 'In-app' : '↗ New tab'}</div>
    </div>`;

  // One grid, two sections — what opens HERE first, what needs a real tab.
  // Both stay inside #dappGrid because every existing test counts cards
  // through it; the section headers are the only new markup it ever sees.
  const inApp = POPULAR_DAPPS.filter((d) => d.frameable);
  const inTab = POPULAR_DAPPS.filter((d) => !d.frameable);
  const section = (key, label, list) => `
    <div class="dapp-sec" data-sec="${key}">
      <h4 class="dapp-sec-h">${label} <span class="dapp-sec-n">${list.length}</span></h4>
      ${list.map(card).join('')}
    </div>`;

  container.innerHTML = `
    <div class="dapps-browser">
      <div class="dapps-omni">
        <input type="text" id="dappSearch" placeholder="Search ${POPULAR_DAPPS.length} DApps or paste a URL…" class="dapps-omni-input" autocomplete="off" spellcheck="false" aria-label="Search DApps or paste a URL" />
        <button id="dappGo" class="btn btn-primary btn-sm" hidden>Open</button>
      </div>
      <div class="dapp-chips" role="group" aria-label="Filter by category">
        <button class="dapp-chip active" data-cat="" aria-pressed="true" style="--cat:${catStyle('All').color}"><span class="dapp-chip-ic" aria-hidden="true">${catStyle('All').glyph}</span><span class="dapp-chip-lb">All</span></button>
        ${cats.map((c) => `<button class="dapp-chip" data-cat="${escapeHtml(c)}" aria-pressed="false" style="--cat:${catStyle(c).color}"><span class="dapp-chip-ic" aria-hidden="true">${catStyle(c).glyph}</span><span class="dapp-chip-lb">${escapeHtml(c)}</span></button>`).join('')}
      </div>
      <div id="dappGrid" class="dapp-grid">
        ${section('inapp', 'Ready in-app', inApp)}
        ${section('tab', 'Opens in a new tab', inTab)}
      </div>
      <p id="dappNoMatch" class="small text-center" style="display:none;padding:24px 0">No DApp matches that filter.</p>
    </div>`;

  const openCard = (el) => openDappBrowser(el.dataset.url, el.dataset.name, el.dataset.frameable === '1');
  container.querySelectorAll('.dapp-card').forEach((el) => {
    el.addEventListener('click', () => openCard(el));
    // Cards are divs with role="button", so Enter/Space must be wired by hand.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(el); }
    });
  });

  // Filter: free text + category chip, both narrowing the same list. A section
  // whose cards are all filtered out hides its header too, so the view never
  // shows a lone heading over an empty grid.
  const grid = container.querySelector('#dappGrid');
  const noMatch = container.querySelector('#dappNoMatch');
  const search = container.querySelector('#dappSearch');
  let cat = '';
  const apply = () => {
    const q = (search?.value || '').toLowerCase().trim();
    let shown = 0;
    grid.querySelectorAll('.dapp-card').forEach((el) => {
      const hay = (el.dataset.name + ' ' + el.dataset.category + ' ' + el.dataset.url).toLowerCase();
      const hit = (!q || hay.includes(q)) && (!cat || el.dataset.category === cat);
      el.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    grid.querySelectorAll('.dapp-sec').forEach((sec) => {
      const left = [...sec.querySelectorAll('.dapp-card')].some((c) => c.style.display !== 'none');
      sec.hidden = !left;
    });
    noMatch.style.display = shown ? 'none' : '';
  };
  search?.addEventListener('input', apply);
  container.querySelectorAll('.dapp-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      cat = chip.dataset.cat;
      container.querySelectorAll('.dapp-chip').forEach((c) => {
        const on = c === chip;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      apply();
    });
  });

  // One omnibox: typing filters, and the Open button only shows up when what is
  // in the field is actually an address (OKX's single search/URL field).
  const goBtn = container.querySelector('#dappGo');
  const syncGo = () => { if (goBtn) goBtn.hidden = !looksLikeUrl(search?.value || ''); };
  search?.addEventListener('input', syncGo);
  const go = () => {
    const url = (search?.value || '').trim();
    if (looksLikeUrl(url)) openDappBrowser(url);
  };
  goBtn?.addEventListener('click', go);
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // An address opens; anything else stays where it is — the filter already
      // ran on every keystroke, so there is nothing left to submit.
      if (looksLikeUrl((search.value || '').trim())) go();
    }
  });
}

export { POPULAR_DAPPS };
