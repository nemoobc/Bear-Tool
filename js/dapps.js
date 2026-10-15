// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// The curated dApp catalogue and the discovery view.
// The browser itself is js/dapp-browser.js; the pre-load security gate it uses
// is js/dapp-safety.js and the session/permission store is js/dapp-sessions.js.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, dappMark, dappLogo, openModal, closeModal } from './ui.js';
import { openDappBrowser as openInBrowser, openDappHome, openExternalNotice, initDappBrowser } from './dapp-browser.js';
import { classifyInput, inspectUrl, baseHost, VERDICT } from './dapp-safety.js';
import { listBlocked, listTrusted } from './dapp-sessions.js';
import { isNativeDappBrowser, nativeTabs, openNativeTab } from './native-dapp.js';
import { t } from './i18n.js';

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
// ── category face — cartoon icon tiles ───────────────────────────────────
// One source for BOTH dApps surfaces: this view's filter row and the browser
// overlay's category row (passed through initDappBrowser below). The tile
// colour rides as a --cat custom property so the CSS never hardcodes a
// palette; the face is a DRAWN cartoon mark — chunky round strokes, ink on
// the light tiles, white on the dark ones — never an emoji glyph: emoji
// render from the device font and look different on every phone (user, APK
// 2026-10-15: "ga kayak okx icon²nya, tapi versi cartoon gitu"). A category
// missing from the map falls back to a neutral folder tile, so a new
// catalogue entry renders instead of breaking the row.
const INK = '#2D2A32';
const WHITE = '#FFFFFF';
const FOLDER = 'M4 8a1.5 1.5 0 0 1 1.5-1.5h3.4l2.1 2.5h6.5A1.5 1.5 0 0 1 19 10.5V17a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 17z';
const face = (fg, paths) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${fg}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const CAT_STYLE = {
  All:        { glyph: face(INK, '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.5 2.4 13.9 0 16.4M12 3.8c-2.4 2.5-2.4 13.9 0 16.4"/>'), color: '#FFC93C' },
  Swap:       { glyph: face(WHITE, '<path d="M7 8.5h9M13 5.5l3 3-3 3M17 15.5H8M11 18.5l-3-3 3-3"/>'), color: '#6366F1' },
  Lending:    { glyph: face(INK, '<path d="M4.5 9.5 12 5l7.5 4.5M6.5 9.5V16M10.5 9.5V16M13.5 9.5V16M17.5 9.5V16M4.5 19h15"/>'), color: '#0EA5E9' },
  Staking:    { glyph: face(INK, '<rect x="6" y="11" width="12" height="9" rx="2.5"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/>'), color: '#10B981' },
  NFT:        { glyph: face(INK, '<rect x="4.5" y="5" width="15" height="14" rx="2.5"/><circle cx="9.2" cy="9.8" r="1.6"/><path d="M6.5 17.5l4.5-4.5 3 3 2-2 1.5 1.5"/>'), color: '#F59E0B' },
  Explorer:   { glyph: face(WHITE, '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'), color: '#64748B' },
  Governance: { glyph: face(INK, '<path d="M7 11.5 12 8l5 3.5V19a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/><path d="M9.5 14.5l2 2 3.5-3.5"/>'), color: '#A855F7' },
  Identity:   { glyph: face(INK, '<path d="M4.5 11V5.5a1 1 0 0 1 1-1H11l8.5 8.5-6.5 6.5z"/><circle cx="8.6" cy="8.6" r="1.3"/>'), color: '#EC4899' },
  Wallet:     { glyph: face(INK, '<path d="M12 4l7 2.5V11c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6.5z"/>'), color: '#22C55E' },
  Bridge:     { glyph: face(INK, '<path d="M4.5 18v-4.5a7.5 7.5 0 0 1 15 0V18M9 18v-4a3 3 0 0 1 6 0v4M3 18h18"/>'), color: '#F97316' },
};
export const catStyle = (name) => CAT_STYLE[name] || { glyph: face(INK, FOLDER), color: '#94A3B8' };

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

/**
 * Native only: a live "Browser" entry above the dApp grid showing how many tabs
 * the in-app browser still holds, and letting the user reopen it on any of
 * them. The browser keeps its session while the overlay is hidden, so without
 * this door back the only way in was another dApp card (which reloaded).
 */
async function renderTabsEntry(container) {
  const bar = container.querySelector('.dapps-browser');
  if (!bar) return;
  const info = await nativeTabs();          // null on web, or with no session
  const tabs = (info && info.tabs) || [];
  if (!tabs.length) return;
  const label = (tab) => tab.title || tab.url || 'New tab';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'dappTabsBtn';
  btn.className = 'dapp-tabs-entry';
  btn.setAttribute('aria-label', 'Open the in-app browser tabs');
  btn.innerHTML = `<span class="dapp-tabs-ic" aria-hidden="true">\u29C9</span>
    <span class="dapp-tabs-lb">Browser</span>
    <span class="dapp-tabs-n" aria-hidden="true">${tabs.length}</span>`;
  btn.addEventListener('click', async () => {
    const fresh = await nativeTabs();
    const list = (fresh && fresh.tabs) || [];
    if (!list.length) return;
    openModal(`
      <h3>Browser tabs</h3>
      <p class="small">The in-app browser still has ${list.length} tab${list.length === 1 ? '' : 's'} open. Pick one to go back.</p>
      <div class="dapp-tabs-list" role="list">
        ${list.map((tab, i) => `<button type="button" class="dapp-tabs-row" role="listitem" data-i="${i}">
          <span class="dapp-tabs-row-t">${escapeHtml(label(tab))}</span>
          <span class="dapp-tabs-row-u">${escapeHtml(tab.url || '')}</span>
        </button>`).join('')}
      </div>`, { wide: true });
    const box = document.getElementById('modalBox');
    box?.querySelectorAll('.dapp-tabs-row').forEach((row) => {
      row.addEventListener('click', async () => {
        closeModal();
        await openNativeTab(Number(row.dataset.i) || 0);
      });
    });
  });
  bar.insertBefore(btn, bar.firstChild);
}

export function renderDapps(container) {
  if (!container) return;
  // Native build (APK): every dApp opens in-app (full-page WebView), where
  // X-Frame-Options / frame-ancestors do NOT apply — so the web-only split
  // ("Ready in-app" vs "Opens in a new tab") must not leak into the UI. On
  // native, all cards are in-app; the tab section never renders.
  const native = isNativeDappBrowser();
  const cats = [...new Set(POPULAR_DAPPS.map((d) => d.category))];
  const card = (d) => `
    <div class="dapp-card" role="button" tabindex="0"
         data-url="${escapeHtml(d.url)}" data-name="${escapeHtml(d.name)}"
         data-frameable="${native || d.frameable ? '1' : '0'}" data-category="${escapeHtml(d.category)}"
         aria-label="${escapeHtml(d.name)}, ${escapeHtml(d.category)}${native || d.frameable ? '' : ', opens in a new tab'}">
      <div class="dapp-icon" style="--cat:${catStyle(d.category).color}">${dappMark(d.name, catStyle(d.category).color, 44)}${dappLogo(d.url)}</div>
      <div class="dapp-name">${escapeHtml(d.name)}</div>
      <div class="dapp-category">${escapeHtml(d.category)}</div>
      <div class="dapp-frame-note">${native || d.frameable ? 'In-app' : '↗ New tab'}</div>
    </div>`;

  // One grid, two sections — what opens HERE first, what needs a real tab.
  // Both stay inside #dappGrid because every existing test counts cards
  // through it; the section headers are the only new markup it ever sees.
  const inApp = native ? POPULAR_DAPPS : POPULAR_DAPPS.filter((d) => d.frameable);
  const inTab = native ? [] : POPULAR_DAPPS.filter((d) => !d.frameable);
  const section = (key, label, list) => !list.length ? '' : `
    <div class="dapp-sec" data-sec="${key}">
      <h4 class="dapp-sec-h">${label} <span class="dapp-sec-n">${list.length}</span></h4>
      ${list.map(card).join('')}
    </div>`;

  container.innerHTML = `
    <div class="dapps-browser">
      <div class="dapps-hero">
        <div class="dapps-hero-title">${escapeHtml(t('dapps.browser'))}</div>
        <div class="dapps-hero-sub small">${escapeHtml(t('dapps.hero.sub'))}</div>
      </div>
      <div class="dapp-featured" aria-label="Most popular" role="list">
        ${POPULAR_DAPPS.slice(0, 6).map((d) => `
          <div class="dapp-feat-card" role="listitem" data-url="${escapeHtml(d.url)}" data-name="${escapeHtml(d.name)}" data-frameable="1">
            <div class="dapp-feat-icon" style="--cat:${catStyle(d.category).color}">${dappMark(d.name, catStyle(d.category).color, 36)}${dappLogo(d.url)}</div>
            <div class="dapp-feat-name">${escapeHtml(d.name)}</div>
          </div>`).join('')}
      </div>
      <div class="dapps-omni">
        <input type="text" id="dappSearch" placeholder="${escapeHtml(t('dapps.search', { n: POPULAR_DAPPS.length }))}" class="dapps-omni-input" autocomplete="off" spellcheck="false" aria-label="Search DApps or paste a URL" />
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
  container.querySelectorAll('.dapp-feat-card').forEach((el) => {
    el.addEventListener('click', () => openCard(el));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(el); } });
    el.tabIndex = 0; el.role = 'button'; el.setAttribute('aria-label', el.dataset.name);
  });
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

  // Native: the door back into a browser that was hidden but still has tabs.
  if (native) renderTabsEntry(container);
}

export { POPULAR_DAPPS };
