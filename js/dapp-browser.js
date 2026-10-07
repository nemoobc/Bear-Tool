// ═══════════════════════════════════════════════════════════════
// dapp-browser.js — the in-app dApp browser.
//
// What the reference wallets have, and where each one is implemented here:
//
//   tabs, restore      MetaMask mobile, OKX Web3          → tab strip + session
//   omnibox            every browser                      → classifyInput()
//   back/fwd/reload    every browser                      → per-tab history
//   bookmarks          every browser                      → bear.dappBookmarks
//   discover/categories OKX, Trust, Coinbase              → home page + chips
//   session handling   Trust, Rabby                       → dapp-sessions.js
//   pre-load gate      MetaMask, Coinbase (Blockaid),     → dapp-safety.js
//                      Rabby, OKX
//   approvals/signing  Rabby simulation, all of them      → security.js
//
// Two things this browser deliberately does NOT fake:
//
//  1. In-page navigation is invisible. The frame is a cross-origin document, so
//     the parent cannot read where the page went, and the address bar keeps
//     showing the address we loaded. A native WebView can follow it; a web page
//     cannot. Saying so beats a bar that confidently shows a stale URL.
//  2. A cross-origin dApp cannot see window.ethereum, so it cannot detect this
//     wallet. Real dApp connection needs a proxy, an extension or WalletConnect;
//     see dapp-bridge.js for what is actually possible from a static page.
//
// The frame is hardened instead of being convenient: no referrer, no ambient
// cookies or storage (credentialless), an opaque origin (no allow-same-origin),
// and no clipboard/microphone/camera. The one thing it cannot do is reach a
// wallet, so the damage surface is a web page, not a signing key.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, toast } from './ui.js';
import { inspectUrl, classifyInput, VERDICT, renderSignalList, baseHost, matchHostList, matchCatalog } from './dapp-safety.js';
import { sanitizeForStore, isSecretishUrl } from './security.js';
import { getSecurityConfig, addBlockedHost, addTrustedHost, clearBrowsingData, listBlocked, listTrusted } from './dapp-sessions.js';
import { openPairWalletConnect } from './walletconnect.js';
import { get, set, on } from './state.js';
import { getNetworkById } from './network.js';

const LS = {
  tabs: 'bear.dapp.tabs',
  active: 'bear.dapp.active',
  bookmarks: 'bear.dappBookmarks',
  history: 'bear.dapp.history',
};

const SEARCH_URL = 'https://duckduckgo.com/?q=';

let catalog = [];
/** Category face (glyph + tile colour) injected with the catalogue — the
 *  discovery view owns the palette, this overlay only renders it. */
let catStyles = {};
let seq = 1;
let tabs = [];
let activeId = null;
let overlay = null;
// Where the keyboard was before the overlay opened, so closing hands focus back.
let lastFocused = null;
let el = {};
let loadedUrl = '';        // what the frame is actually showing right now
let phaseTimers = [];
// Research (WHATWG HTML #12311 + PR #12312 merged 2026-03-31; Firefox 1552504):
// a frame blocked by X-Frame-Options / CSP frame-ancestors fires NEITHER load
// NOR error — no event ever arrives — and `error` on an iframe never fires at
// all. The only portable failure signal is therefore TIME. Three stages: the
// progress stays honest while the page still has a chance (3s / 10s attention
// thresholds), and only a full 15s earns the fallback panel — with nothing on
// the stage covered, so any partial render is visible the whole way.
// 20s, not 15: a real dApp (Aave, measured) fires "load" only after ~38s on a
// weak device, and 15s put an accusation on screen while the page was merely
// slow. The e2e window (25s) still clears this with margin, and the sheet now
// carries a way out in both directions ("Show the page" + the ⚠ chip).
const LOAD_PHASE_MS = { slow: 3000, verySlow: 10000, timeout: 20000 };

/** Per-session memory of a gate decision, so the same host is not nagged twice. */
const sessionVerdicts = new Map();

// ── storage helpers ──────────────────────────────────────────────────────
const read = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

// ═══════════════════════════════════════════════════════════════
// TAB MODEL
// ═══════════════════════════════════════════════════════════════

function newTab(url = null, opts = {}) {
  const tab = {
    id: 't' + (seq++) + '-' + Date.now().toString(36),
    url: url || null,
    name: opts.name || 'New tab',
    hist: [],
    i: -1,
    incognito: !!opts.incognito,
  };
  if (url) pushHistory(tab, url, opts.name);
  return tab;
}

function pushHistory(tab, url, name) {
  // Anything that looks like a secret never reaches history or storage.
  const safe = sanitizeForStore(url);
  if (!safe) return false;
  tab.hist = tab.hist.slice(0, tab.i + 1);
  tab.hist.push({ url: safe, name: name || baseHost(safe) || safe });
  tab.i = tab.hist.length - 1;
  tab.url = safe;
  tab.name = name || tab.hist[tab.i].name;
  return true;
}

const active = () => tabs.find((x) => x.id === activeId) || null;
const persistable = () => tabs.filter((x) => !x.incognito);

// Exported for the behavioural session test (tests/dapp-session.test.js) —
// same precedent as matchCatalog in dapp-safety.js: logic that decides what
// leaves the device must be executable by a test, not grepped.
export function saveSession() {
  // Only non-incognito tabs are ever written to disk. An incognito tab that
  // outlives the overlay is discarded rather than quietly persisted.
  const rows = persistable()
    .filter((x) => x.url)
    .map((x) => ({ url: x.url, name: x.name, hist: x.hist, i: x.i }));
  write(LS.tabs, rows);
  if (activeId) {
    const a = tabs.find((x) => x.id === activeId && !x.incognito);
    if (a) write(LS.active, a.url);
  }
}

export function restoreSession() {
  const rows = read(LS.tabs, []).filter((r) => r && typeof r.url === 'string');
  if (!rows.length) return false;
  tabs = rows.map((r) => {
    const t = newTab();
    t.url = r.url; t.name = r.name || baseHost(r.url) || r.url;
    t.hist = Array.isArray(r.hist) && r.hist.length ? r.hist : [{ url: r.url, name: t.name }];
    t.i = Number.isInteger(r.i) ? Math.min(Math.max(r.i, 0), t.hist.length - 1) : t.hist.length - 1;
    t.url = t.hist[t.i].url;
    return t;
  });
  const want = read(LS.active, null);
  const found = want && tabs.find((x) => x.url === want);
  activeId = (found || tabs[0]).id;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// CHROME
// ═══════════════════════════════════════════════════════════════

// Chrome, in the order OKX Wallet lays it out (2026-10-07 rombak: no star,
// address centered, tab counter on the right):
//
//   TOP    [ ✕ ] [ 🔒 pill: url, dead-center ...... ] [ 🔗 ] [ ⛓ ] [ ▢n ]
//   TABS   the existing strip (kept verbatim — its ids are asserted by e2e)
//   STAGE  home page | frame | blocked
//   BOTTOM [ ‹ ] [ › ] [ ⟳ ] [ ⌂ ] [ ⋯ ]        ← five slots, one per thumb
//
// The address pill is absolutely centered (left:50% + translateX(-50%)), so
// the ✕ on the left and the icon row on the right may be any width without
// pushing it off-center; #dbrClose's margin-right:auto pins the icons right.
// The ★ bookmark button is gone — bookmarking lives in the ⋯ menu.
// Every id below is pre-existing except #dbrClose / #dbrNet / #dbrNetIc / #dbrBar.
// The five navigation buttons MOVED rather than changed identity, so the back /
// forward / home / reload / menu tests keep passing against the same selectors.
const SHELL = `
  <div class="dbr-top">
    <button class="dbr-btn dbr-ic" id="dbrClose" title="Close browser" aria-label="Close browser">✕</button>
    <div class="dbr-urlwrap">
      <span class="dbr-secure" id="dbrSecure" role="status" aria-live="polite"></span>
      <input type="text" id="dbrUrl" class="dbr-url" spellcheck="false" autocomplete="off"
             placeholder="Search DApps or type an address" aria-label="Address and search">
    </div>
    <button class="dbr-btn dbr-ic dbr-ext" id="dbrExt" title="Open this page in a new tab" aria-label="Open this page in a new tab" hidden>↗</button>
    <button class="dbr-btn dbr-ic dbr-conn" id="dbrConnect" title="Connect this site to the wallet" aria-label="Connect this site to the wallet" hidden>🔗</button>
    <button class="dbr-btn dbr-ic dbr-net" id="dbrNet" title="Switch network" aria-label="Current network — switch network">
      <span class="dbr-net-ic" id="dbrNetIc" aria-hidden="true"></span>
    </button>
    <button class="dbr-btn dbr-ic dbr-tabcount" id="dbrTabsBtn" title="Open tabs" aria-label="Open tabs" aria-haspopup="dialog" aria-expanded="false">1</button>
  </div>
  <div class="dbr-loadbar" id="dbrLoadbar" hidden aria-hidden="true"><span class="dbr-loadbar-fill" id="dbrLoadbarFill"></span></div>
  <div class="dbr-tabs" id="dbrTabs" role="tablist" aria-label="Open tabs"></div>
  <div class="dbr-menu" id="dbrMenuPop" hidden role="menu"></div>
  <div class="dbr-wc-hint" id="dbrWcHint" hidden>
    <span class="dbr-wc-hint-txt">This site can't see the wallet directly — in the site choose
      <strong>Connect -&gt; WalletConnect</strong>, copy the <code>wc:</code> link, then pair here.</span>
    <button class="dbr-wc-btn" id="dbrWcPair" type="button" title="Pair via WalletConnect" aria-label="Pair via WalletConnect">🔗</button>
    <button class="dbr-wc-btn" id="dbrWcHintX" type="button" title="Dismiss this hint" aria-label="Dismiss WalletConnect hint">✕</button>
  </div>
  <div class="dbr-stage" id="dbrStage">
    <div class="dbr-home" id="dbrHomePage"></div>
    <div class="dbr-loading" id="dbrLoading" role="status" hidden>
      <div class="dbr-progress" aria-hidden="true"></div>
      <span class="dbr-loading-txt" id="dbrLoadingTxt">Loading…</span>
    </div>
    <iframe id="dbrFrame" class="dbr-frame" title="dApp page"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      referrerpolicy="no-referrer" credentialless
      allow="clipboard-write" hidden></iframe>
    <div class="dbr-blocked" id="dbrBlocked" hidden></div>
    <button class="dbr-peak" id="dbrPeak" hidden title="The page may still be loading — open the report again"
            aria-label="Open the page report">⚠</button>
    <div class="dbr-tabgrid" id="dbrTabGrid" hidden role="dialog" aria-label="Open tabs"></div>
  </div>
  <div class="dbr-bar" id="dbrBar" role="toolbar" aria-label="Browser controls">
    <button class="dbr-bbtn" id="dbrBack" title="Back" aria-label="Back">‹</button>
    <button class="dbr-bbtn" id="dbrFwd" title="Forward" aria-label="Forward">›</button>
    <button class="dbr-bbtn" id="dbrReload" title="Reload" aria-label="Reload">⟳</button>
    <button class="dbr-bbtn" id="dbrHome" title="Home" aria-label="Home">⌂</button>
    <button class="dbr-bbtn" id="dbrMenu" title="Menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false">⋯</button>
  </div>`;

function build() {
  overlay = document.createElement('div');
  overlay.className = 'dapp-browser-overlay';
  overlay.id = 'dappBrowserOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'dApp browser');
  overlay.hidden = true;
  overlay.innerHTML = SHELL;
  document.body.appendChild(overlay);

  el = {
    close: overlay.querySelector('#dbrClose'),
    back: overlay.querySelector('#dbrBack'),
    fwd: overlay.querySelector('#dbrFwd'),
    reload: overlay.querySelector('#dbrReload'),
    home: overlay.querySelector('#dbrHome'),
    secure: overlay.querySelector('#dbrSecure'),
    url: overlay.querySelector('#dbrUrl'),
    ext: overlay.querySelector('#dbrExt'),
    connect: overlay.querySelector('#dbrConnect'),
    net: overlay.querySelector('#dbrNet'),
    netIc: overlay.querySelector('#dbrNetIc'),
    tabsBtn: overlay.querySelector('#dbrTabsBtn'),
    tabGrid: overlay.querySelector('#dbrTabGrid'),
    bar: overlay.querySelector('#dbrBar'),
    menu: overlay.querySelector('#dbrMenu'),
    menuPop: overlay.querySelector('#dbrMenuPop'),
    tabs: overlay.querySelector('#dbrTabs'),
    stage: overlay.querySelector('#dbrStage'),
    homePage: overlay.querySelector('#dbrHomePage'),
    loading: overlay.querySelector('#dbrLoading'),
    loadingTxt: overlay.querySelector('#dbrLoadingTxt'),
    loadbar: overlay.querySelector('#dbrLoadbar'),
    loadbarFill: overlay.querySelector('#dbrLoadbarFill'),
    frame: overlay.querySelector('#dbrFrame'),
    blocked: overlay.querySelector('#dbrBlocked'),
    peak: overlay.querySelector('#dbrPeak'),
    wcHint: overlay.querySelector('#dbrWcHint'),
    wcPair: overlay.querySelector('#dbrWcPair'),
    wcHintX: overlay.querySelector('#dbrWcHintX'),
  };

  wire();
}

// ── rendering ────────────────────────────────────────────────────────────
function paintTabs() {
  const bar = el.tabs;
  if (el.tabsBtn) {
    el.tabsBtn.textContent = String(tabs.length);
    el.tabsBtn.title = `Open tabs (${tabs.length})`;
    el.tabsBtn.setAttribute('aria-label', `Open tabs (${tabs.length})`);
  }
  bar.innerHTML = tabs.map((t) => `
    <div class="dbr-tab${t.id === activeId ? ' on' : ''}${t.incognito ? ' incog' : ''}" role="tab"
         aria-selected="${t.id === activeId}" tabindex="0" data-tab="${t.id}"
         title="${escapeHtml(t.name)}">
      <span class="dbr-tab-ic" aria-hidden="true">${t.incognito ? '🕶' : '◍'}</span>
      <span class="dbr-tab-nm">${escapeHtml(t.name || 'New tab')}</span>
      <button class="dbr-tab-x" data-close="${t.id}" aria-label="Close ${escapeHtml(t.name || 'tab')}">×</button>
    </div>`).join('')
    + `<button class="dbr-tab-new" id="dbrNew" title="New tab" aria-label="New tab">＋</button>`;

  bar.querySelectorAll('[data-tab]').forEach((n) => {
    n.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return;
      select(n.dataset.tab);
    });
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n.dataset.tab); }
    });
  });
  bar.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); closeTab(b.dataset.close); });
  });
  bar.querySelector('#dbrNew')?.addEventListener('click', () => addTab());
}

/** host + path for the tab-grid cards — a card is not an address bar. */
function shortUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return String(url);
  }
}

/**
 * The tab switcher grid — OKX's layout: cards, not chips.
 *
 * The strip under the address bar shows names only; at ten tabs it scrolls and
 * nothing tells you what is actually open. The count button in the top bar
 * opens this grid: one card per tab with its address, a close button on each,
 * a close-all, and a new-tab button. It is a dialog so the keyboard (Escape)
 * and screen readers treat it as a layer above the page.
 */
function toggleTabGrid(force) {
  const grid = el.tabGrid;
  if (!grid) return;
  const open = force ?? grid.hidden;
  grid.hidden = !open;
  el.tabsBtn?.setAttribute('aria-expanded', String(open));
  if (!open) return;

  const card = (t) => `
    <div class="dbr-tg-card${t.id === activeId ? ' on' : ''}" role="button" tabindex="0"
         data-tg="${t.id}" aria-label="Switch to ${escapeHtml(t.name || 'New tab')}">
      <button class="dbr-tg-x" data-tg-close="${t.id}" aria-label="Close ${escapeHtml(t.name || 'tab')}">×</button>
      <span class="dbr-tg-ic" aria-hidden="true">${t.incognito ? '🕶' : '◍'}</span>
      <span class="dbr-tg-nm">${escapeHtml(t.name || 'New tab')}</span>
      <span class="dbr-tg-url">${escapeHtml(shortUrl(t.url))}</span>
    </div>`;

  grid.innerHTML = `
    <div class="dbr-tg-head">
      <span class="dbr-tg-title">Open tabs (${tabs.length})</span>
      <button class="btn btn-sm btn-secondary" data-tg-all>✕ Close all</button>
    </div>
    <div class="dbr-tg-cards">${tabs.map(card).join('')}</div>
    <div class="dbr-tg-foot">
      <button class="btn btn-sm btn-primary" data-tg-new>＋ New tab</button>
      <button class="btn btn-sm btn-secondary" data-tg-done>Done</button>
    </div>`;

  grid.querySelectorAll('[data-tg]').forEach((n) => {
    const go = (e) => {
      if (e.target.closest('[data-tg-close]')) return;
      select(n.dataset.tg);
      toggleTabGrid(false);
    };
    n.addEventListener('click', go);
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); }
    });
  });
  grid.querySelectorAll('[data-tg-close]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); closeTab(b.dataset.tgClose); toggleTabGrid(true); });
  });
  grid.querySelector('[data-tg-new]')?.addEventListener('click', () => { addTab(); toggleTabGrid(false); });
  grid.querySelector('[data-tg-all]')?.addEventListener('click', () => {
    // Close every tab but the active one's replacement: the browser must keep
    // at least one tab alive (closing all is what "✕ Close browser" is for).
    const keep = tabs.find((t) => t.id === activeId) || tabs[0];
    tabs.forEach((t) => { if (t !== keep) closeTab(t.id); });
    toast('Other tabs closed', 'info');
    toggleTabGrid(true);
  });
  grid.querySelector('[data-tg-done]')?.addEventListener('click', () => toggleTabGrid(false));
  grid.querySelector('.dbr-tg-cards [data-tg]')?.focus();
}

function paintSecure(verdict) {
  const map = {
    [VERDICT.KNOWN]: { ic: '🔒', cls: 'ok', txt: 'Checked' },
    [VERDICT.CAUTION]: { ic: '⚠', cls: 'warn', txt: 'Unchecked site' },
    [VERDICT.DANGER]: { ic: '⛔', cls: 'bad', txt: 'Blocked' },
    [VERDICT.BLOCKED]: { ic: '⛔', cls: 'bad', txt: 'Blocked' },
  };
  const m = map[verdict?.verdict] || { ic: '🌐', cls: '', txt: '' };
  el.secure.className = 'dbr-secure ' + m.cls;
  el.secure.textContent = verdict ? `${m.ic} ${m.txt}` : '';
  el.secure.title = verdict ? verdict.signals.map((s) => `${s.level.toUpperCase()}: ${s.label}`).join('\n') : '';
}

function paint() {
  const t = active();
  paintTabs();
  if (!t) return;

  const onHome = !t.url;
  el.homePage.hidden = !onHome;
  el.frame.hidden = onHome;
  el.blocked.hidden = true;

  if (onHome) {
    loadedUrl = '';
    clearLoadTimers();
    loadbarFail();
    paintHome();
    el.url.value = '';
    el.secure.className = 'dbr-secure';
    el.secure.textContent = '';
    el.back.disabled = t.i <= 0;
    el.fwd.disabled = t.i >= t.hist.length - 1;
    el.connect.hidden = true;
    if (el.ext) el.ext.hidden = true;
    return;
  }

  // One frame for all tabs. If the target tab is already what is on screen, the
  // src is left alone so the page survives a tab round-trip.
  if (t.url !== loadedUrl) {
    loadedUrl = t.url;
    // Sandbox decided per navigation (see sandboxFor): modern dApps (Next.js
    // and friends) crash to a blank frame without their own storage — that is
    // the "ambiguous screen" bug — while a page from THIS origin must never
    // get allow-same-origin, or its scripts could walk into Bear Tool's
    // localStorage.
    el.frame.setAttribute('sandbox', sandboxFor(t.url));
    el.frame.src = t.url;
    el.loading.hidden = false;
    armLoadTimeout();
  }
  if (document.activeElement !== el.url) el.url.value = t.url;
  if (el.ext) el.ext.hidden = false; // a real page is on stage — ↗ applies to it

  const v = inspectUrl(t.url, catalog, securityOpts());
  paintSecure(v);
  el.back.disabled = t.i <= 0;
  el.fwd.disabled = t.i >= t.hist.length - 1;
  const connected = window.__bearSites?.some((s) => s.origin === originOf(t.url));
  el.connect.hidden = !connected;
  el.connect.textContent = connected ? '🔗 Connected' : '';
  el.connect.title = connected ? 'This site can reach the wallet — disconnect' : '';
}

const originOf = (u) => { try { return new URL(u).origin.toLowerCase(); } catch { return ''; } };
const securityOpts = () => ({ blockedHosts: listBlocked(), trustedHosts: listTrusted() });

// ── the home / discover page ─────────────────────────────────────────────
/** Glyph + colour for a category chip — injected via initDappBrowser; a
 *  category the palette does not know renders a neutral tile, never nothing. */
const catFace = (name) => catStyles[name] || { glyph: '📁', color: '#94A3B8' };

function paintHome() {
  const cats = [...new Set(catalog.map((d) => d.category))];
  const recent = read(LS.history, []).slice(0, 8);
  const bms = read(LS.bookmarks, []);
  const known = catalog.filter((d) => d.frameable);

  el.homePage.innerHTML = `
    <div class="dbr-hero">
      <div class="dbr-hero-t">Bear dApp browser</div>
      <p class="small dim">Every address is checked before it loads. Nothing here can reach your keys:
      the page runs in its own origin with no cookies, no referrer and no clipboard.</p>
    </div>
    ${bms.length ? `<div class="dbr-sec-h">🔖 Bookmarks</div>
      <div class="dbr-mini">${bms.map((b) => `<button class="dbr-chip" data-open="${escapeHtml(b.url)}" data-name="${escapeHtml(b.name || baseHost(b.url))}">${escapeHtml(b.name || baseHost(b.url))}</button>`).join('')}</div>` : ''}
    ${recent.length ? `<div class="dbr-sec-h">🕘 Recent</div>
      <div class="dbr-mini">${recent.map((h) => `<button class="dbr-chip" data-open="${escapeHtml(h.url)}" data-name="${escapeHtml(h.name || baseHost(h.url))}">${escapeHtml(h.name || baseHost(h.url))}</button>`).join('')}</div>` : ''}
    <div class="dbr-sec-h">◆ Loadable in-app <span class="small dim">(${known.length} verified frameable)</span></div>
    <div class="dbr-grid">${known.map(cardHTML).join('')}</div>
    <div class="dbr-sec-h">▦ All ${catalog.length} DApps</div>
    <div class="dbr-chips dbr-cats" role="group" aria-label="Filter by category">
      ${['', ...cats].map((c, i) => {
        const face = catFace(c || 'All');
        const label = c || 'All';
        return `<button class="dbr-chip dbr-chip-cat${i === 0 ? ' on' : ''}" data-cat="${escapeHtml(c)}" aria-pressed="${i === 0}" style="--cat:${face.color}"><span class="dbr-chip-ic" aria-hidden="true">${face.glyph}</span><span class="dbr-chip-lb">${escapeHtml(label)}</span></button>`;
      }).join('')}
    </div>
    <div class="dbr-grid" id="dbrGridAll">${catalog.map(cardHTML).join('')}</div>
    <p class="small dim" id="dbrNoMatch" hidden>No DApp matches that filter.</p>`;

  el.homePage.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.open, b.dataset.name));
  });
  el.homePage.querySelectorAll('.dbr-card').forEach((c) => {
    c.addEventListener('click', () => go(c.dataset.url, c.dataset.name));
  });
  el.homePage.querySelectorAll('[data-cat]').forEach((chip) => {
    chip.addEventListener('click', () => {
      el.homePage.querySelectorAll('[data-cat]').forEach((c) => {
        c.classList.toggle('on', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      });
      const cat = chip.dataset.cat;
      let shown = 0;
      el.homePage.querySelectorAll('#dbrGridAll .dbr-card').forEach((c) => {
        const hit = !cat || c.dataset.category === cat;
        c.hidden = !hit;
        if (hit) shown++;
      });
      const none = el.homePage.querySelector('#dbrNoMatch');
      if (none) none.hidden = !!shown;
    });
  });
}

const cardHTML = (d) => `
  <button class="dbr-card" data-url="${escapeHtml(d.url)}" data-name="${escapeHtml(d.name)}"
          data-category="${escapeHtml(d.category || '')}" style="--cat:${catFace(d.category || '').color}">
    <span class="dbr-card-ic" aria-hidden="true">${escapeHtml(d.icon || '◈')}</span>
    <span class="dbr-card-nm">${escapeHtml(d.name)}</span>
    <span class="dbr-card-ct">${escapeHtml(d.category || '')}${d.frameable === false ? ' ↗' : ''}</span>
  </button>`;

// ═══════════════════════════════════════════════════════════════
// THE GATE
// ═══════════════════════════════════════════════════════════════

/**
 * Navigate, but only after the gate has agreed.
 * @returns {boolean} whether the load went ahead
 */
/**
 * The sandbox flags for one navigation — decided per URL, not once in markup.
 *
 * Modern dApps (Next.js, Aave, most of the catalogue) crash to a blank frame
 * without their own origin storage: the console shows
 * "Failed to read 'localStorage' … sandboxed and lacks the allow-same-origin
 * flag" and the page dies behind an empty screen (probe 2026-10-05: Aave,
 * edge pixels 0.5% → 4.1% once the flag was added).
 *
 * The same flag on a page from BEAR TOOL'S OWN origin would be the opposite
 * disaster: allow-scripts + allow-same-origin there means the frame can reach
 * into this app's localStorage, where the keystore lives. So the flag is
 * granted only across origins — cross-site frames get THEIR origin back (not
 * ours), and a same-origin frame stays on the minimal set.
 *
 * Everything else (no allow-top-navigation, no allow-downloads) is unchanged.
 */
export function sandboxFor(url, selfOrigin = (typeof location !== 'undefined' ? location.origin : '')) {
  const BASE = 'allow-scripts allow-forms allow-popups allow-modals';
  try {
    const target = new URL(String(url), selfOrigin || undefined);
    if (target.origin === selfOrigin) return BASE;
    return BASE + ' allow-same-origin';
  } catch {
    return BASE;
  }
}

function navigate(rawUrl, name) {
  // A wc: URI typed or pasted here is a pairing request, not a search query —
  // classifyInput would send it to the local search results instead.
  const rawTrim = String(rawUrl || '').trim();
  if (rawTrim.toLowerCase().startsWith('wc:')) {
    openPairWalletConnect(rawTrim);
    el.url.value = active()?.url || '';
    return false;
  }
  const verdict = classifyInput(rawUrl);

  if (verdict.kind === 'blocked') {
    // Not just a toast. A toast leaves whatever was in the blocked panel from
    // the PREVIOUS attempt on screen, so refusing javascript:alert() could
    // leave a homograph warning about a different site sitting there — the user
    // reads evidence that has nothing to do with what they just typed.
    schemeSheet(verdict.reason);
    return false;
  }

  if (verdict.kind === 'search') {
    // Search locally first. The query never leaves the device unless the user
    // presses the explicit external-search button, so typing a project name
    // into a wallet does not become a tracking beacon.
      // An empty address bar must do nothing at all. classifyInput already said so —
      // it returns reason:'empty' — and this searched anyway. `includes('')` is true
      // against every entry, so pressing Enter in a blank field opened the first dApp
      // in the catalogue: Uniswap, measured. This is the one surface in the app that
      // can ask for a signature, and a stray keystroke must not drop anyone into it.
      if (verdict.reason === 'empty') return false;
      const q = verdict.url || '';
      // matchCatalog, not an inline includes(): a one-character query matched nearly
      // every name, and the catalogue's own order decided which dApp opened.
      const hit = matchCatalog(catalog, q);
    if (hit) { return navigate(hit.url, hit.name); }
    toast('No DApp in the catalogue matches “' + q.slice(0, 40) + '”. Type a full address to open it.', 'info');
    return false;
  }

  const url = verdict.url;

  // A pasted seed phrase must never be navigated to, and never be stored.
  const sec = isSecretishUrl(url);
  if (sec.secret) {
    toast('Refused: ' + sec.why + '. This address is not opened and not saved.', 'error');
    return false;
  }

  const v = inspectUrl(url, catalog, securityOpts());

  if (v.verdict === VERDICT.BLOCKED) {
    toast(v.signals[0]?.detail || 'That address is blocked.', 'error');
    reportSheet(v, { canProceed: false });
    return false;
  }

  if (v.verdict === VERDICT.DANGER) {
    // No "continue anyway". Every DANGER signal is a homograph, a script
    // scheme or a lure shape, and each of those is the whole attack.
    reportSheet(v, { canProceed: false });
    return false;
  }

  if (v.verdict === VERDICT.CAUTION && !sessionVerdicts.get(v.host)) {
    reportSheet(v, { canProceed: true });
    return false;
  }

  return load(url, name);
}

function load(url, name) {
  const t = active();
  if (!t) return false;
  if (!pushHistory(t, url, name)) {
    toast('Not opened: that address looks like it carries a secret.', 'error');
    return false;
  }
  rememberHistory(url, name);
  saveSession();
  paint();
  return true;
}

/**
 * The panel shown when the address itself cannot be navigated — a javascript:
 * or data: URL, or a host on the user's blocklist. It always states the reason
 * for THIS attempt rather than leaving the previous report in place.
 */
function schemeSheet(reason) {
  el.blocked.innerHTML = `
    <div class="dbr-report" role="alertdialog" aria-label="Address refused">
      <div class="dbr-rep-h"><span aria-hidden="true">⛔</span> That address was not opened</div>
      <ul class="dsig-list"><li class="dsig dsig-fail"><span class="dsig-mark" aria-hidden="true">✖</span>
        <span><strong>Refused</strong> — ${escapeHtml(reason)}</span></li></ul>
      <div class="dbr-rep-btns">
        <button class="btn btn-sm btn-secondary" data-act="back">Back</button>
      </div>
    </div>`;
  el.blocked.hidden = false;
  el.frame.hidden = true;
  el.homePage.hidden = true;
  el.blocked.querySelector('[data-act="back"]')?.addEventListener('click', () => {
    el.blocked.innerHTML = '';
    el.blocked.hidden = true;
    paint();
  });
}

/** The pre-load sheet. Also the reporting UI when there is no way past it. */
function reportSheet(v, { canProceed }) {
  const previous = el.blocked.innerHTML;
  el.blocked.innerHTML = `
    <div class="dbr-report" role="alertdialog" aria-labelledby="dbrRepTitle">
      <div class="dbr-rep-h" id="dbrRepTitle">
        <span aria-hidden="true">${canProceed ? '⚠' : '⛔'}</span>
        ${canProceed ? 'Before you open this site' : 'This site was not opened'}
      </div>
      <div class="dbr-rep-host">${escapeHtml(v.host || v.url)}</div>
      <ul class="dsig-list">${renderSignalList(v.signals)}</ul>
      <p class="small dim">Bear Tool’s own checks, not a third-party malware scan. They catch the
      shapes phishing actually uses; they cannot certify a site as honest.</p>
      <div class="dbr-rep-btns">
        ${canProceed ? '<button class="btn btn-sm btn-primary" data-act="proceed">Open anyway</button>' : ''}
        ${canProceed ? '<button class="btn btn-sm btn-secondary" data-act="ext">↗ Open in a new tab</button>' : ''}
        <button class="btn btn-sm btn-secondary" data-act="back">${previous ? 'Back' : 'Close'}</button>
        ${canProceed ? '<button class="btn btn-sm btn-secondary" data-act="trust">Trust this site</button>' : ''}
        <button class="btn btn-sm btn-danger" data-act="block">Block this site</button>
      </div>
      ${canProceed ? '<label class="dbr-remember"><input type="checkbox" id="dbrDontAsk"> Don’t ask again for this site this session</label>' : ''}
    </div>`;
  el.blocked.hidden = false;
  el.frame.hidden = true;
  el.homePage.hidden = true;

  const box = el.blocked;
  box.querySelector('[data-act="proceed"]')?.addEventListener('click', () => {
    const dontAsk = box.querySelector('#dbrDontAsk')?.checked;
    if (dontAsk) sessionVerdicts.set(v.host, 'proceed');
    el.blocked.hidden = true;
    load(v.url);
  });
  // The other way past the sheet: the site may refuse embedding outright, and
  // the frame cannot report that (a Chromium error page fires a normal "load" —
  // measured, 2026-10-07). Offering the real browser here is the honest door.
  box.querySelector('[data-act="ext"]')?.addEventListener('click', () => {
    openExternal(v.url);
  });
  box.querySelector('[data-act="back"]')?.addEventListener('click', () => {
    if (previous) { el.blocked.innerHTML = previous; el.blocked.hidden = true; paint(); }
    else el.blocked.hidden = true, paint();
  });
  box.querySelector('[data-act="trust"]')?.addEventListener('click', () => {
    addTrustedHost(v.host);
    sessionVerdicts.set(v.host, 'proceed');
    toast('Marked ' + v.host + ' as trusted. You can undo this in Settings → Security.', 'info');
    el.blocked.hidden = true;
    load(v.url);
  });
  box.querySelector('[data-act="block"]')?.addEventListener('click', () => {
    addBlockedHost(v.host);
    el.blocked.innerHTML = '';
    el.blocked.hidden = true;
    toast('Blocked ' + v.host + '. It stays blocked even after a reload.', 'info');
    paint();
  });
  // Defence in depth: even if a caller ever passed canProceed:true for a
  // DANGER verdict, the button is removed here rather than trusted upstream.
  if (v.verdict === VERDICT.DANGER) el.blocked.querySelector('[data-act="proceed"]')?.remove();
}

// ═══════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════

const MAX_TABS = 20; // MetaMask's own ceiling — beyond this the grid is unusable

function addTab(opts = {}) {
  // The tab strip grew without a limit: every stray "＋" stacked another live
  // frame, each one a page that keeps running. The switcher grid says how many
  // are open and this is where that number stops growing.
  if (tabs.length >= MAX_TABS) {
    toast(`Maximum ${MAX_TABS} tabs reached. Close one first.`, 'error');
    return;
  }
  const t = newTab(null, opts);
  tabs.push(t);
  activeId = t.id;
  paint();
  el.url.focus();
}

function select(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  activeId = id;
  paint();
}

function closeTab(id) {
  const i = tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const wasActive = tabs[i].id === activeId;
  const wasIncognito = tabs[i].incognito;
  tabs.splice(i, 1);
  if (wasActive) {
    const next = tabs[i] || tabs[i - 1];
    activeId = next ? next.id : null;
  }
  if (!tabs.length) {
    // Never leave a browser with nothing to type in.
    const t = newTab(null);
    tabs.push(t);
    activeId = t.id;
  } else if (wasIncognito && wasActive) {
    // An incognito tab closed: forget the frame so nothing of it is on screen.
    loadedUrl = '';
    if (el.frame) el.frame.removeAttribute('src');
  }
  saveSession();
  paint();
}

function back() {
  const t = active();
  if (!t || t.i <= 0) return;
  t.i--;
  const e = t.hist[t.i];
  t.url = e.url; t.name = e.name;
  loadedUrl = '';
  saveSession();
  paint();
}

function fwd() {
  const t = active();
  if (!t || t.i >= t.hist.length - 1) return;
  t.i++;
  const e = t.hist[t.i];
  t.url = e.url; t.name = e.name;
  loadedUrl = '';
  saveSession();
  paint();
}

function isBookmarked(url) {
  return read(LS.bookmarks, []).some((b) => b.url === url);
}

function toggleBookmark() {
  const t = active();
  if (!t?.url) return;
  const list = read(LS.bookmarks, []);
  const i = list.findIndex((b) => b.url === t.url);
  if (i >= 0) list.splice(i, 1);
  else list.push({ url: t.url, name: t.name || baseHost(t.url) });
  write(LS.bookmarks, list);
  toast(i >= 0 ? 'Bookmark removed' : 'Bookmarked', 'info');
  paint();
}

function rememberHistory(url, name) {
  const list = read(LS.history, []);
  const clean = sanitizeForStore(url);
  if (!clean) return;
  const next = [{ url: clean, name: name || baseHost(clean), at: Date.now() }];
  for (const h of list) if (h.url !== clean) next.push(h);
  write(LS.history, next.slice(0, 60));
}

function go(raw, name) {
  const t = active();
  if (!t) return;
  // Name matters: without it pushHistory falls back to the hostname, so
  // opening Aave from the home grid renamed the tab (and the Recent entry
  // that opened it) to "app.aave.com" on every visit.
  navigate(raw, name);
}

/**
 * Hand a URL to a real browser.
 *
 * `window.open(...)` is a no-op inside the Capacitor WebView: nothing in
 * @capacitor/android overrides WebChromeClient.onCreateWindow (grep of
 * node_modules/@capacitor/android), so the call returns null and the click does
 * nothing at all. That is the whole of "cannot browse": every frameable:false
 * dApp lands on a sheet whose only forward button was this dead call.
 *
 * A target=_blank anchor works in both worlds. A desktop browser opens a tab.
 * The Android WebView ships with multiple-window support disabled, so
 * target=_blank falls through to shouldOverrideUrlLoading, where Capacitor
 * already fires ACTION_VIEW (Bridge.java:420) and the system browser takes it.
 * One path, no feature detection, no plugin.
 */
function openExternal(url) {
  if (!url) return false;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// WIRING
// ═══════════════════════════════════════════════════════════════

function toggleMenu(force) {
  const open = force ?? el.menuPop.hidden;
  el.menuPop.hidden = !open;
  el.menu.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const t = active();
  const rows = [
    ['tab', '＋ New tab', () => addTab()],
    ['incog', '🕶 Incognito tab', () => addTab({ incognito: true })],
    ['sep'],
    ['open', '↗ Open in a new browser tab', () => { openExternal(t?.url); }],
    ['share', '🔗 Copy address', async () => { try { await navigator.clipboard.writeText(t?.url || ''); toast('Address copied', 'info'); } catch { toast('Clipboard refused by the browser', 'error'); } }],
    ['wc', '🔗 Pair via WalletConnect', () => openPairWalletConnect()],
    ['sep'],
    ['bm', isBookmarked(t?.url) ? '🔖 Remove bookmark' : '🔖 Bookmark this page', () => toggleBookmark()],
    ['hist', '🕘 Clear history', () => { write(LS.history, []); toast('History cleared', 'info'); paint(); }],
    ['data', '🧹 Clear all browsing data', () => { clearBrowsingData(); tabs = []; const nt = newTab(); tabs.push(nt); activeId = nt.id; toast('Tabs, history and bookmarks cleared', 'info'); paint(); }],
    ['sep'],
    ['close', '✕ Close browser', () => close()],
  ];
  el.menuPop.innerHTML = rows.map((r) => r[0] === 'sep'
    ? '<div class="dbr-menu-sep" role="separator"></div>'
    : `<button class="dbr-menu-item" role="menuitem" data-mi="${r[0]}">${r[1]}</button>`).join('');
  el.menuPop.querySelectorAll('[data-mi]').forEach((b) => {
    const row = rows.find((r) => r[0] === b.dataset.mi);
    b.addEventListener('click', () => { el.menuPop.hidden = true; el.menu.setAttribute('aria-expanded', 'false'); row[2]?.(); });
  });
}

/**
 * The shared "no page arrived" screen.
 *
 * Shown when the frame fires an error, AND when neither load nor error arrives
 * before LOAD_PHASE_MS.timeout. The second case was the eternal spinner: a hardened
 * frame that hangs — a dApp that never finishes loading inside the sandbox, or a
 * blocked response that fires nothing at all — left an opaque Loading sheet over
 * the stage forever, with no control the user could press. The wording covers
 * both causes instead of accusing X-Frame-Options when the truth is a hang.
 */
function showDidNotLoad() {
  el.loading.hidden = true;
  loadbarFail();
  el.blocked.innerHTML = `<div class="dbr-report" data-kind="didnotload" role="alertdialog" aria-label="Page did not load">
    <div class="dbr-rep-h">⚠ This page did not load</div>
    <p class="small dim">${escapeHtml(el.frame.src || '')} did not finish loading in time. Either the site
    refuses to be embedded (X-Frame-Options / frame-ancestors — no web page can bypass that, only a
    native app can) or it is simply slow: heavy dApps can take 30s+ to fire "load", and if you can see
    the page behind this sheet, that is what is happening — wait or press Show the page. Roughly half
    of all dApps block embedding; the honest way out is a real browser tab:</p>
    <div class="dbr-rep-btns"><button class="btn btn-sm btn-primary" data-act="popup">↗ Open in a new tab</button>
    <button class="btn btn-sm btn-secondary" data-act="peek">👁 Show the page</button>
    <button class="btn btn-sm btn-secondary" data-act="copy"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy URL</button>
    <button class="btn btn-sm btn-secondary" data-act="wc">🔗 Pair via WalletConnect</button>
    <button class="btn btn-sm btn-secondary" data-act="back">Back</button></div></div>`;
  el.blocked.hidden = false;
  // "Show the page": the sheet may be wrong. A slow frame (Aave fires load at
  // ~38s) is behind it, alive, and the user must be able to look at it right
  // now instead of arguing with a verdict. The ⚠ chip stays behind as the way
  // back — and vanishes for good the moment the load really lands.
  el.blocked.querySelector('[data-act="peek"]')?.addEventListener('click', () => {
    el.blocked.hidden = true;
    if (el.peak) el.peak.hidden = false;
  });
  if (el.peak) el.peak.onclick = () => showDidNotLoad();
  el.blocked.querySelector('[data-act="popup"]')?.addEventListener('click', () => {
    openExternal(el.frame.src);
  });
  // The dApp refused to be embedded: hand the connection to the relay instead.
  el.blocked.querySelector('[data-act="wc"]')?.addEventListener('click', () => { el.blocked.hidden = true; openPairWalletConnect(); });
  // Programmatic copy can be refused without a gesture or permission — the
  // address bar still shows the URL, so a refusal says that instead of failing
  // silently.
  el.blocked.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.frame.src || '');
      toast('Address copied', 'info');
    } catch {
      toast('Copy was refused — the address is in the address bar.', 'error');
    }
  });
  el.blocked.querySelector('[data-act="back"]')?.addEventListener('click', () => { el.blocked.hidden = true; paint(); });
}

/** Arm the phase watchdog for the src that was just assigned. */
function armLoadTimeout() {
  clearLoadTimers();
  loadbarStart();
  if (el.peak) el.peak.hidden = true; // a new navigation erases the last report
  const phase = (ms, text) => phaseTimers.push(setTimeout(() => {
    if (el.loading.hidden) return; // stale: the load already landed
    if (text) { if (el.loadingTxt) el.loadingTxt.textContent = text; }
    else showDidNotLoad();
  }, ms));
  if (el.loadingTxt) el.loadingTxt.textContent = 'Loading…';
  phase(LOAD_PHASE_MS.slow, 'Still loading…');
  phase(LOAD_PHASE_MS.verySlow, 'Taking longer than usual…');
  phase(LOAD_PHASE_MS.timeout, '');
}

function clearLoadTimers() {
  phaseTimers.forEach(clearTimeout);
  phaseTimers = [];
}

/**
 * The thin progress bar under the address bar (OKX/MetaMask placement).
 *
 * A real page load reports no progress to an embedding frame — an iframe only
 * ever says "load" or "error" — so the bar shows an honest phase instead of a
 * fake percentage: it grows to 70% while the load runs, snaps to 100% when the
 * frame says "load", and hides when the load fails. Slow is not broken, so the
 * crawl from 0→70% deliberately takes longer than a normal page.
 */
function loadbarStart() {
  if (!el.loadbar) return;
  el.loadbar.hidden = false;
  el.loadbarFill.style.transition = 'none';
  el.loadbarFill.style.width = '0%';
  // Next frame, so the transition from 0 is actually painted.
  requestAnimationFrame(() => {
    el.loadbarFill.style.transition = 'width 12s cubic-bezier(.1,.6,.3,1)';
    el.loadbarFill.style.width = '70%';
  });
}

function loadbarDone() {
  if (!el.loadbar || el.loadbar.hidden) return;
  el.loadbarFill.style.transition = 'width .25s ease-out';
  el.loadbarFill.style.width = '100%';
  setTimeout(() => { el.loadbar.hidden = true; }, 350);
}

function loadbarFail() {
  if (!el.loadbar) return;
  el.loadbar.hidden = true;
}

/**
 * The chain badge in the top-right corner — the OKX position.
 *
 * It reuses the app's own picker rather than growing a second one. That picker
 * lives at z-index 1000 and this overlay at 9000, so a click straight through
 * would put the sheet BEHIND the browser and look like a dead button: the
 * browser is dropped under the modal for the duration and restored after.
 */
function switchNetworkFromBrowser() {
  const pill = document.getElementById('networkPill');
  if (!pill || !overlay) return;
  overlay.style.zIndex = '999';
  let seen = false;
  let ticks = 0;
  const iv = setInterval(() => {
    const open = !!document.querySelector('.modal-overlay.open');
    if (open) { seen = true; ticks = 0; return; }
    if (!seen && ++ticks < 8) return;   // picker not up yet — give it 2s
    clearInterval(iv);
    overlay.style.zIndex = '';
  }, 250);
  pill.click();
}

function paintNetwork() {
  if (!el.net || !el.netIc) return;
  const net = getNetworkById(get('networkId'));
  if (!net) { el.netIc.textContent = '⛓'; el.net.style.removeProperty('--net-color'); return; }
  el.netIc.textContent = net.icon || '⛓';
  el.net.style.setProperty('--net-color', net.color || 'var(--border)');
  el.net.title = `Network: ${net.name} (chain ${net.chainId}) — tap to switch`;
  el.net.setAttribute('aria-label', `Current network ${net.name} — switch network`);
}

function wire() {
  el.close.addEventListener('click', () => close());
  el.net.addEventListener('click', switchNetworkFromBrowser);
  // The permanent escape hatch: a frame that shows nothing (the site refuses
  // embedding — X-Frame-Options fires a fake "load" on Chromium's error page,
  // measured, so no watchdog can catch it) still needs a one-press way out.
  // The ↗ sits in the toolbar instead of hiding behind the ⋯ menu for that reason.
  el.ext?.addEventListener('click', () => { const t = active(); if (t?.url) openExternal(t.url); });

  // The tab-count button opens the switcher grid; a click anywhere on the
  // stage (the grid is inside it, but not on a card) closes it.
  el.tabsBtn?.addEventListener('click', () => toggleTabGrid());
  el.stage?.addEventListener('click', (e) => {
    if (!el.tabGrid || el.tabGrid.hidden) return;
    if (e.target.closest('.dbr-tg-card') || e.target.closest('.dbr-tg-foot') || e.target.closest('.dbr-tg-head')) return;
    toggleTabGrid(false);
  });
  paintNetwork();
  // The active chain can change while the browser is open — from another pill,
  // from a dApp request — so the badge tracks it instead of going stale.
  on('networkId', paintNetwork);
  el.back.addEventListener('click', back);
  el.fwd.addEventListener('click', fwd);
  el.reload.addEventListener('click', () => {
    const t = active();
    if (!t?.url) return;
    // Reassigning src is a real reload; the browser may serve from cache, which
    // is what a user pressing reload expects.
    loadedUrl = '';
    paint();
  });
  el.home.addEventListener('click', () => {
    const t = active();
    if (!t) return;
    t.url = null; t.name = 'New tab'; t.hist = []; t.i = -1;
    saveSession();
    paint();
  });
  el.menu.addEventListener('click', () => toggleMenu());
  el.connect.addEventListener('click', () => {
    const t = active();
    if (!t?.url) return;
    window.__bearDisconnectSite?.(originOf(t.url));
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(el.url.value); }
    if (e.key === 'Escape') {
      // A mid-edit Escape must cancel the edit and KEEP the tab. This handler
      // runs before the document-level one below and restores the value first —
      // so the document guard read the already-restored value, always decided
      // "not being typed", and closed the overlay anyway: a cancel threw the
      // tab away (e2e 18-dapp-browser:212). Swallow the event only when
      // something was actually being edited; an untouched or empty bar still
      // bubbles so Escape closes the browser as documented there.
      const current = active()?.url || '';
      const typed = el.url.value !== '' && el.url.value !== current;
      el.url.value = current;
      el.url.blur();
      if (typed) e.stopPropagation();
    }
  });
  el.url.addEventListener('focus', () => el.url.select());

  // The one honest instruction at the exact moment it matters: the site is
  // loaded and its own Connect button cannot reach the wallet from inside the
  // sandbox. Pair button + dismiss (persisted) — the menu row and the omnibox
  // wc: route remain for anyone who dismisses it.
  el.wcPair.addEventListener('click', () => openPairWalletConnect());
  el.wcHintX.addEventListener('click', () => {
    set('dappWcHint', 'dismissed');
    el.wcHint.hidden = true;
  });

  // No page, no spinner: both real failures (error) and the silent one (neither
  // event ever arrives) end on the same screen with a way out.
  el.frame.addEventListener('load', () => {
    clearLoadTimers();
    loadbarDone();
    if (el.peak) el.peak.hidden = true;
    el.loading.hidden = true;
    if (el.wcHint) el.wcHint.hidden = get('dappWcHint') === 'dismissed';
    // A page that finally finishes AFTER the timeout sheet appeared replaces the
    // sheet with the real content — it is only about the load that just ended.
    if (el.blocked.querySelector('.dbr-report[data-kind="didnotload"]')) el.blocked.hidden = true;
  });
  el.frame.addEventListener('error', () => { clearLoadTimers(); loadbarFail(); showDidNotLoad(); });

  // On document, not on the overlay.
  //
  // The listener used to hang off the overlay element, so it only ever fired for
  // keystrokes that landed INSIDE it. Measured with a probe rather than by reading:
  // after opening a dApp and pressing Escape twice, focus sat on a plain <div> with
  // no id, the address bar was not the active element, and the overlay stayed open
  // both times. The whole keyboard surface of the in-app browser was unreachable —
  // Escape, Ctrl+T, Ctrl+L, Ctrl+W — not because the logic was wrong but because
  // nothing was listening where the keystrokes actually go.
  //
  // openModal in ui.js already gets this right: bind on document, guard on the
  // overlay being open. This is the same fix in the same shape.
  document.addEventListener('keydown', (e) => {
    if (!overlay || overlay.hidden) return;

    if (e.key === 'Escape') {
      // A menu is the one thing that eats the first press: it is a popup sitting on
      // top of everything.
      if (!el.menuPop.hidden) { el.menuPop.hidden = true; return; }
      // The tab grid is the next layer down: it must close before Escape is
      // allowed to close the whole browser.
      if (el.tabGrid && !el.tabGrid.hidden) { toggleTabGrid(false); return; }
      // An address bar that is mid-edit swallows Escape — the input's own handler
      // restores the page you are on and blurs, which is the right answer for "I typed
      // the wrong thing". An untouched one must not, and neither must an EMPTY one:
      // the field starts empty on the browser home screen, so comparing only against
      // the page URL read "" !== undefined as "being typed" and swallowed the key
      // exactly when the overlay opened. Both are excluded.
      const current = active()?.url || '';
      const beingTyped = el.url.value !== '' && el.url.value !== current;
      if (e.target === el.url && beingTyped) return;
      // Otherwise leave — including when the "this site refuses framing" screen is
      // up, which is what most real dApps produce. It carries only "Open in a new tab"
      // and "Back", so before this there was no keyboard way out of the overlay at all.
      close();
      return;
    }

    // Ctrl/Cmd+T new tab, Ctrl/Cmd+L focus the address bar — the two everyone reaches
    // for first.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') { e.preventDefault(); addTab(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); el.url.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); closeTab(activeId); }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/** The catalogue is injected rather than imported, so this module never has to
 *  know about the discovery view and the gate stays testable on its own. */
export function initDappBrowser(cfg = {}) {
  catalog = cfg.catalog || [];
  catStyles = cfg.catStyle || {};
}

export function openDappBrowser(url, name) {
  if (!overlay) build();
  overlay.hidden = false;
  // Land the cursor in the address bar, which is what a browser does when one opens
  // and what makes Ctrl+L and typing work for someone who never touches a mouse. The
  // shortcuts themselves no longer depend on this — the listener is on document — but
  // the keyboard should still start inside the thing the keyboard is for.
  lastFocused = document.activeElement;

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    try { el.url?.focus(); } catch { /* not laid out yet */ }
  });
  if (!tabs.length) {
    if (!restoreSession()) {
      const t = newTab();
      tabs.push(t);
      activeId = t.id;
    }
  }
  paint();
  if (url) navigate(url, name);
  return { navigate, close };
}

export function openDappHome() {
  return openDappBrowser(null);
}

/**
 * A site that refuses framing still gets a page in the browser.
 *
 * It used to be a silent window.open, which left the user back on the DApps
 * list with a new browser tab they did not ask for and no idea why. Saying
 * "this site cannot be embedded, here is the button" keeps them in control and
 * tells them the truth about the header that caused it.
 */
export function openExternalNotice(url, name, reason) {
  if (!overlay) build();
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
  if (!tabs.length) {
    if (!restoreSession()) {
      const t = newTab();
      tabs.push(t);
      activeId = t.id;
    }
  }
  const v = inspectUrl(url, catalog, securityOpts());
  if (v.verdict === VERDICT.BLOCKED || v.verdict === VERDICT.DANGER) {
    // Vet before offering the button: a new tab is still a page to trust.
    reportSheet(v, { canProceed: false });
    return { navigate, close };
  }
  const t = active();
  t.url = null; t.name = name || baseHost(url) || url; t.hist = []; t.i = -1;
  el.homePage.innerHTML = `
    <div class="dbr-report">
      <div class="dbr-rep-h"><span aria-hidden="true">↗</span> ${escapeHtml(t.name)} will not open inside Bear Tool</div>
      <p class="small dim">${escapeHtml(reason || 'This site sends a clickjacking protection header. No web page can override it — only a native app can embed the site.')}</p>
      <div class="dbr-rep-host">${escapeHtml(url)}</div>
      <ul class="dsig-list">${renderSignalList(v.signals)}</ul>
      <div class="dbr-rep-btns">
        <button class="btn btn-sm btn-primary" data-act="popup">↗ Open in a browser tab</button>
        <button class="btn btn-sm btn-secondary" data-act="wc">🔗 Pair via WalletConnect</button>
        <button class="btn btn-sm btn-secondary" data-act="block">Block this site</button>
        <button class="btn btn-sm btn-secondary" data-act="home">Back to DApps</button>
      </div>
    </div>`;
  el.homePage.hidden = false;
  el.frame.hidden = true;
  el.blocked.hidden = true;
  el.url.value = '';
  el.homePage.querySelector('[data-act="popup"]')?.addEventListener('click', () => {
    openExternal(url);
  });
  // The pairing route for the same dead end: the page lives outside the frame,
  // but the wallet still reaches it through the relay (WC_PROJECT_ID is wired).
  el.homePage.querySelector('[data-act="wc"]')?.addEventListener('click', () => {
    openPairWalletConnect();
  });
  el.homePage.querySelector('[data-act="block"]')?.addEventListener('click', () => {
    addBlockedHost(v.host);
    toast('Blocked ' + v.host, 'info');
    el.homePage.innerHTML = '';
    t.url = null;
    paintHome();
  });
  el.homePage.querySelector('[data-act="home"]')?.addEventListener('click', () => {
    el.homePage.innerHTML = '';
    t.url = null;
    paint();
  });
  paintTabs();
  return { navigate, close };
}

export function closeDappBrowser() {
  close();
}

function close() {
  if (!overlay) return;
  saveSession();
  overlay.classList.remove('open');
  overlay.hidden = true;
  el.url.blur();
  if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) {
    try { lastFocused.focus(); } catch { /* it went away while we were open */ }
  }
  lastFocused = null;
}

export function dappBrowserIsOpen() {
  return !!overlay && !overlay.hidden;
}

/** Called by the bridge when the wallet locks: an open browser is a risk. */
export function dappBrowserOnLock() {
  sessionVerdicts.clear();
}
