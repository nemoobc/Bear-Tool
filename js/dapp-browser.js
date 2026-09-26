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
import { inspectUrl, classifyInput, VERDICT, renderSignalList, baseHost, matchHostList } from './dapp-safety.js';
import { sanitizeForStore, isSecretishUrl } from './security.js';
import { getSecurityConfig, addBlockedHost, addTrustedHost, clearBrowsingData, listBlocked, listTrusted } from './dapp-sessions.js';

const LS = {
  tabs: 'bear.dapp.tabs',
  active: 'bear.dapp.active',
  bookmarks: 'bear.dappBookmarks',
  history: 'bear.dapp.history',
};

const SEARCH_URL = 'https://duckduckgo.com/?q=';

let catalog = [];
let seq = 1;
let tabs = [];
let activeId = null;
let overlay = null;
let el = {};
let loadedUrl = '';        // what the frame is actually showing right now

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

function saveSession() {
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

function restoreSession() {
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

const SHELL = `
  <div class="dbr-top">
    <button class="dbr-btn" id="dbrBack" title="Back" aria-label="Back">‹</button>
    <button class="dbr-btn" id="dbrFwd" title="Forward" aria-label="Forward">›</button>
    <button class="dbr-btn" id="dbrReload" title="Reload" aria-label="Reload">⟳</button>
    <button class="dbr-btn" id="dbrHome" title="Home" aria-label="Home">⌂</button>
    <div class="dbr-secure" id="dbrSecure" role="status" aria-live="polite"></div>
    <div class="dbr-urlwrap">
      <input type="text" id="dbrUrl" class="dbr-url" spellcheck="false" autocomplete="off"
             placeholder="Search DApps or type an address" aria-label="Address and search">
    </div>
    <button class="dbr-btn" id="dbrBm" title="Bookmark this page" aria-label="Bookmark this page" aria-pressed="false">★</button>
    <button class="dbr-btn" id="dbrConnect" title="Connect this site to the wallet" aria-label="Connect this site to the wallet">🔗</button>
    <button class="dbr-btn" id="dbrMenu" title="Menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false">⋯</button>
  </div>
  <div class="dbr-tabs" id="dbrTabs" role="tablist" aria-label="Open tabs"></div>
  <div class="dbr-menu" id="dbrMenuPop" hidden role="menu"></div>
  <div class="dbr-stage" id="dbrStage">
    <div class="dbr-home" id="dbrHomePage"></div>
    <div class="dbr-loading" id="dbrLoading" hidden><span class="dbr-spin" aria-hidden="true"></span> Loading…</div>
    <iframe id="dbrFrame" class="dbr-frame" title="dApp page"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      referrerpolicy="no-referrer" credentialless allow="" hidden></iframe>
    <div class="dbr-blocked" id="dbrBlocked" hidden></div>
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
    back: overlay.querySelector('#dbrBack'),
    fwd: overlay.querySelector('#dbrFwd'),
    reload: overlay.querySelector('#dbrReload'),
    home: overlay.querySelector('#dbrHome'),
    secure: overlay.querySelector('#dbrSecure'),
    url: overlay.querySelector('#dbrUrl'),
    bm: overlay.querySelector('#dbrBm'),
    connect: overlay.querySelector('#dbrConnect'),
    menu: overlay.querySelector('#dbrMenu'),
    menuPop: overlay.querySelector('#dbrMenuPop'),
    tabs: overlay.querySelector('#dbrTabs'),
    stage: overlay.querySelector('#dbrStage'),
    homePage: overlay.querySelector('#dbrHomePage'),
    loading: overlay.querySelector('#dbrLoading'),
    frame: overlay.querySelector('#dbrFrame'),
    blocked: overlay.querySelector('#dbrBlocked'),
  };

  wire();
}

// ── rendering ────────────────────────────────────────────────────────────
function paintTabs() {
  const bar = el.tabs;
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
    paintHome();
    el.url.value = '';
    el.secure.className = 'dbr-secure';
    el.secure.textContent = '';
    el.back.disabled = t.i <= 0;
    el.fwd.disabled = t.i >= t.hist.length - 1;
    el.bm.setAttribute('aria-pressed', 'false');
    el.connect.hidden = true;
    return;
  }

  // One frame for all tabs. If the target tab is already what is on screen, the
  // src is left alone so the page survives a tab round-trip.
  if (t.url !== loadedUrl) {
    loadedUrl = t.url;
    el.frame.src = t.url;
    el.loading.hidden = false;
  }
  if (document.activeElement !== el.url) el.url.value = t.url;

  const v = inspectUrl(t.url, catalog, securityOpts());
  paintSecure(v);
  el.back.disabled = t.i <= 0;
  el.fwd.disabled = t.i >= t.hist.length - 1;
  el.bm.setAttribute('aria-pressed', String(isBookmarked(t.url)));
  el.bm.title = isBookmarked(t.url) ? 'Remove bookmark' : 'Bookmark this page';
  const connected = window.__bearSites?.some((s) => s.origin === originOf(t.url));
  el.connect.hidden = !connected;
  el.connect.textContent = connected ? '🔗 Connected' : '';
  el.connect.title = connected ? 'This site can reach the wallet — disconnect' : '';
}

const originOf = (u) => { try { return new URL(u).origin.toLowerCase(); } catch { return ''; } };
const securityOpts = () => ({ blockedHosts: listBlocked(), trustedHosts: listTrusted() });

// ── the home / discover page ─────────────────────────────────────────────
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
    ${bms.length ? `<div class="dbr-sec-h">★ Bookmarks</div>
      <div class="dbr-mini">${bms.map((b) => `<button class="dbr-chip" data-open="${escapeHtml(b.url)}">${escapeHtml(b.name || baseHost(b.url))}</button>`).join('')}</div>` : ''}
    ${recent.length ? `<div class="dbr-sec-h">🕘 Recent</div>
      <div class="dbr-mini">${recent.map((h) => `<button class="dbr-chip" data-open="${escapeHtml(h.url)}">${escapeHtml(h.name || baseHost(h.url))}</button>`).join('')}</div>` : ''}
    <div class="dbr-sec-h">◆ Loadable in-app <span class="small dim">(${known.length} verified frameable)</span></div>
    <div class="dbr-grid">${known.map(cardHTML).join('')}</div>
    <div class="dbr-sec-h">▦ All ${catalog.length} DApps</div>
    <div class="dbr-chips" role="group" aria-label="Filter by category">
      <button class="dbr-chip on" data-cat="">All</button>
      ${cats.map((c) => `<button class="dbr-chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
    </div>
    <div class="dbr-grid" id="dbrGridAll">${catalog.map(cardHTML).join('')}</div>
    <p class="small dim" id="dbrNoMatch" hidden>No DApp matches that filter.</p>`;

  el.homePage.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.open));
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
          data-category="${escapeHtml(d.category || '')}">
    <span class="dbr-card-ic" aria-hidden="true">${d.icon || '◈'}</span>
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
function navigate(rawUrl, name) {
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
    const q = verdict.url || '';
    const hit = catalog.find((d) => (d.name + ' ' + d.category).toLowerCase().includes(q.toLowerCase()));
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

function addTab(opts = {}) {
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

function go(raw) {
  const t = active();
  if (!t) return;
  navigate(raw);
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
    ['open', '↗ Open in a new browser tab', () => { const u = t?.url; if (u) window.open(u, '_blank', 'noopener'); }],
    ['share', '🔗 Copy address', async () => { try { await navigator.clipboard.writeText(t?.url || ''); toast('Address copied', 'info'); } catch { toast('Clipboard refused by the browser', 'error'); } }],
    ['sep'],
    ['bm', isBookmarked(t?.url) ? '★ Remove bookmark' : '☆ Bookmark this page', () => toggleBookmark()],
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

function wire() {
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
  el.bm.addEventListener('click', toggleBookmark);
  el.menu.addEventListener('click', () => toggleMenu());
  el.connect.addEventListener('click', () => {
    const t = active();
    if (!t?.url) return;
    window.__bearDisconnectSite?.(originOf(t.url));
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(el.url.value); }
    if (e.key === 'Escape') { el.url.value = active()?.url || ''; el.url.blur(); }
  });
  el.url.addEventListener('focus', () => el.url.select());

  el.frame.addEventListener('load', () => { el.loading.hidden = true; });
  el.frame.addEventListener('error', () => {
    el.loading.hidden = true;
    el.blocked.innerHTML = `<div class="dbr-report"><div class="dbr-rep-h">⚠ This page did not load</div>
      <p class="small dim">${escapeHtml(el.frame.src || '')} refused to render here. Most often the site
      sends <code>X-Frame-Options</code> or <code>frame-ancestors</code>, which no web page can bypass —
      only a native app can. Use “Open in a new browser tab”.</p>
      <div class="dbr-rep-btns"><button class="btn btn-sm btn-primary" data-act="popup">↗ Open in a new tab</button>
      <button class="btn btn-sm btn-secondary" data-act="back">Back</button></div></div>`;
    el.blocked.hidden = false;
    el.blocked.querySelector('[data-act="popup"]')?.addEventListener('click', () => {
      window.open(el.frame.src, '_blank', 'noopener');
    });
    el.blocked.querySelector('[data-act="back"]')?.addEventListener('click', () => { el.blocked.hidden = true; paint(); });
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!el.menuPop.hidden) { el.menuPop.hidden = true; return; } if (el.blocked.hidden) close(); }
    // Ctrl/Cmd+T new tab, Ctrl/Cmd+L focus the address bar — the two everyone
    // reaches for first.
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
}

export function openDappBrowser(url, name) {
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
        <button class="btn btn-sm btn-secondary" data-act="block">Block this site</button>
        <button class="btn btn-sm btn-secondary" data-act="home">Back to DApps</button>
      </div>
    </div>`;
  el.homePage.hidden = false;
  el.frame.hidden = true;
  el.blocked.hidden = true;
  el.url.value = '';
  el.homePage.querySelector('[data-act="popup"]')?.addEventListener('click', () => {
    window.open(url, '_blank', 'noopener');
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
}

export function dappBrowserIsOpen() {
  return !!overlay && !overlay.hidden;
}

/** Called by the bridge when the wallet locks: an open browser is a risk. */
export function dappBrowserOnLock() {
  sessionVerdicts.clear();
}
