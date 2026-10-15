// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/index.js
// The Dex, v2 — ONE engine: real-reserve pools.
//
// The pure-launchpad rebuild deleted the old two-engine Dex (Uniswap V2 pools
// plus bonding-curve coins, a global pair and a second "ETH"). Order
// 2026-10-15 rebuilt it further, ORIGINAL from scratch: the curve is on its
// way out and the pool came back as the ONE engine (BearToken / BearPair /
// BearFactory, see docs/DEX-V2.md):
//
//   Feed    → pools born from the factory (curve coins still show while the
//             feed swaps over — M5 of the spec)
//   Swap    → buy/sell against a pool; every number a live reserve read
//   Pools   → reserves + price per pool, read from each pair
//   Create  → launch: ONE transaction deploys the token + its pair, seeds it
//             and locks the creator's LP
//
// The old V2-layer panels (Swap / Liquidity / Market Maker) and the DEX_PAIRS
// table stay deleted — a second way to trade is exactly what made the old Dex
// ambiguous. What lives here now is v2 code on the v2 engine.
//
// Rules that shape every line here:
//  - Sepolia ONLY. Any other chain → the view says so and every action refuses.
//  - Every number on screen is READ from a live contract. A coin whose contract
//    cannot be read says so instead of showing zeros that look like a real
//    price.
//  - Everything is a real transaction. No simulation, no invented fills.
// ═══════════════════════════════════════════════════════════════
import { createHtml, bindCreate } from './create.js';
import { tokensHtml, bindTokens, refreshFeed } from './tokens.js';
import { tokenTradeHtml, bindTokenTrade } from './trade.js';
import { swapHtml, bindSwap } from './swap.js';
import { poolsHtml, bindPools } from './pool-list.js';
import { lpHtml, bindLp } from './lp.js';
import { portfolioHtml, bindPortfolio } from './portfolio.js';
import {
  DEX_NETWORK_ID, DEX_CHAIN_ID, dexChainOk,
  provider,
  t, get, set, on, $, escapeHtml,
} from './core.js';

// Re-exported so the app (and the gates) read one entry point for the Dex's
// chain facts while the values live in core.js — a chain id is never written
// twice.
export { DEX_CHAIN_ID, DEX_NETWORK_ID, dexChainOk };

// The Dex's navigation. The nav carries feed / swap / pools / liquidity /
// portfolio — the v2 surfaces with a panel of their own; 'create' is a route
// you reach from the feed's launch button. A coin's own page hangs off the
// feed: you reach it by tapping a coin.
export const DEX_ROUTES = ['feed', 'swap', 'pools', 'liquidity', 'portfolio', 'create'];

// ── the view ───────────────────────────────────────────────────
let bound = false;

export function renderDex(root, opts = {}) {
  if (!root) return;
  // The feed is home. Landing anywhere else would mean the launchpad opens on
  // a form instead of on its coins.
  if (!get('dex.route')) set('dex.route', 'feed');
  if (!bound) {
    root.innerHTML = `
      <div id="dexWelcome" class="card mb-8 dex-welcome">
        <div class="dex-welcome-in">
          <h2 id="dexWelcomeTitle" class="dex-welcome-title"></h2>
          <img src="assets/bear.svg" alt="Bear Tool" id="dexWelcomeLogo" class="dex-welcome-logo">
          <p id="dexWelcomeSub" class="small dex-welcome-sub"></p>
          <button type="button" class="btn btn-primary" id="dexStartHere"></button>
        </div>
      </div>
      <div id="dexWorkspace" hidden>
        <div id="dexGate" class="card mb-8" hidden>
          <div class="small"><strong id="dexGateTitle"></strong> <span id="dexGateHow"></span></div>
          <button type="button" class="btn btn-primary mt-8" id="dexGateGo"></button>
        </div>
        <nav id="dexNav" class="dex-nav mb-8" aria-label="">
          <button type="button" class="dex-tab" data-dex-tab="feed" aria-pressed="true"></button>
          <button type="button" class="dex-tab" data-dex-tab="swap" aria-pressed="false"></button>
          <button type="button" class="dex-tab" data-dex-tab="pools" aria-pressed="false"></button>
          <button type="button" class="dex-tab" data-dex-tab="liquidity" aria-pressed="false"></button>
          <button type="button" class="dex-tab" data-dex-tab="portfolio" aria-pressed="false"></button>
        </nav>
        <div id="dexPanelHost" class="dex-panel"></div>
      </div>
    `;
    paintStatic();
    bindWelcome();
    bindNav();
    // The chain can move under the open view (Settings, dApp request): the
    // gate must follow it, not freeze at whatever it was on first paint.
    on('networkId', () => renderDex(root));
    bound = true;
  }
  if (opts.fresh) openWelcome();
  paintGate();
  renderPanel();
}

// ── the welcome screen ─────────────────────────────────────────
// Order is a direct user order: the heading sits ON TOP, the bear logo sits
// BELOW it, and "Start here" sits under the logo. The workspace stays hidden
// until Start here is pressed, so the first thing a click on "Dex" shows is
// this — not a wall of buttons.
function bindWelcome() {
  $('#dexStartHere').addEventListener('click', () => {
    $('#dexWelcome').hidden = true;
    $('#dexWorkspace').hidden = false;
    // Keyboard users land on the feed's first control, not back at the top.
    $('#dexPanelHost')?.querySelector('button, a, input')?.focus();
  });
}

function openWelcome() {
  $('#dexWelcome').hidden = false;
  $('#dexWorkspace').hidden = true;
}

function paintStatic() {
  $('#dexWelcomeTitle').textContent = t('dex.welcome.title');
  $('#dexWelcomeSub').textContent = t('dex.welcome.sub');
  $('#dexStartHere').textContent = t('dex.welcome.start');
  $('#dexGateTitle').textContent = t('dex.gate.needSepolia');
  $('#dexGateHow').textContent = t('dex.gate.howto');
  $('#dexGateGo').textContent = t('dex.gate.go');
  $('#dexGateGo').addEventListener('click', switchToSepolia);
}

// The gate's own way out: one click moves the app to Sepolia. getAllNetworks()
// filters every testnet out while Settings → Testnet mode is off, so the flag
// has to come up FIRST through the same single writer Settings uses; then
// activateNetwork is the one switch every other entry point uses (it no-ops
// when the chain is already the target). app.js is imported lazily: a static
// import would close a cycle — app.js already imports this file at line 35.
async function switchToSepolia() {
  if (dexChainOk()) return;
  const app = await import('../app.js');
  const settings = get('settings') || {};
  if (settings.testnet === false) app.setTestnetVisible(true);
  app.activateNetwork(DEX_NETWORK_ID);
}

function paintGate() {
  const ok = dexChainOk();
  $('#dexGate').hidden = ok;
  // Every control behind the gate is dimmed AND inert: a button that still
  // clicks on the wrong chain just fails later, with a worse message.
  const host = $('#dexPanelHost');
  if (host) {
    host.style.opacity = ok ? '' : '0.5';
    host.style.pointerEvents = ok ? '' : 'none';
    host.setAttribute('aria-disabled', String(!ok));
  }
  const nav = $('#dexNav');
  if (nav) {
    nav.style.opacity = ok ? '' : '0.5';
    nav.style.pointerEvents = ok ? '' : 'none';
  }
}

// ── routing ────────────────────────────────────────────────────
export function go(route) {
  set('dex.route', route);
  // Leaving the feed or the form also leaves whatever coin was open, or the
  // next render would drop you back onto a coin page you already left.
  set('dex.tokenView', null);
  renderPanel();
}

export function openCoin(address) {
  set('dex.tokenView', address);
  set('dex.route', 'feed');
  renderPanel();
}

export function renderPanel() {
  const host = $('#dexPanelHost');
  if (!host) return;
  // Fire teardown FIRST: panels register their own timers/listeners, and
  // clearing innerHTML does not run them — a timer attached to a detached node
  // keeps polling the chain forever.
  host.dispatchEvent(new CustomEvent('dex:teardown', { bubbles: false }));
  host.innerHTML = '';

  const coin = get('dex.tokenView');
  if (coin) { paintNav('feed'); renderCoin(host, coin); return; }
  const route = get('dex.route');
  if (route === 'swap') { paintNav('swap'); renderSwap(host); return; }
  if (route === 'pools') { paintNav('pools'); renderPools(host); return; }
  if (route === 'liquidity') { paintNav('liquidity'); renderLiquidity(host); return; }
  if (route === 'portfolio') { paintNav('portfolio'); renderPortfolio(host); return; }
  if (route === 'create') { paintNav(null); renderCreate(host); return; }
  paintNav('feed');
  renderFeed(host);
}

function renderFeed(host) {
  host.innerHTML = `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.tokens.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.tokens.hint'))}</div>
      </div>
      <button type="button" class="btn btn-primary" id="dexGoCreate">
        + ${escapeHtml(t('dex.tab.create'))}
      </button>
    </div>
    ${tokensHtml()}`;
  $('#dexGoCreate', host).addEventListener('click', () => go('create'));

  // The feed is the SCREEN, not a preamble to one: a grid of coins, with the
  // launch button a single compact action in the corner. An empty feed scoped to
  // one wallet is empty for every new visitor, which is what made this look like
  // nothing but a create form.
  let scope = 'all';
  const paint = async () => { await refreshFeed(host, scope); };

  // `host` is #dexPanelHost, a PERSISTENT node — renderPanel() clears its
  // innerHTML but that does NOT detach listeners attached to the host itself.
  // Attaching this click handler per-render therefore stacked a new one on
  // every feed paint (leak + duplicated work). Define it once, attach once,
  // and remove it on teardown so the next render attaches exactly one again.
  const onScopeClick = async (e) => {
    const btn = e.target.closest('[data-dex-scope]');
    if (!btn) return;
    scope = btn.dataset.dexScope;
    for (const b of host.querySelectorAll('[data-dex-scope]')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    paint();
  };

  bindTokens(host, (address) => openCoin(address));

  // One paint now, so the feed is never blank — and it reports honestly when it
  // cannot read the chain. The recurring refresh only starts when a provider
  // exists: without one the pass has nothing to query, and an interval that can
  // never do useful work is one more timer the tab (or a test runner) holds open.
  paint();
  host.addEventListener('click', onScopeClick);
  host.addEventListener('dex:teardown', () => host.removeEventListener('click', onScopeClick), { once: true });
  if (!dexChainOk() || !provider()) return;
  const timer = setInterval(paint, 20_000);
  host.addEventListener('dex:teardown', () => clearInterval(timer), { once: true });
}

function renderCreate(host) {
  host.innerHTML = `
    <button type="button" class="btn btn-secondary btn-block mb-8" id="dexCreateBack">
      ← ${escapeHtml(t('dex.tokens.title'))}
    </button>
    ${createHtml()}`;
  $('#dexCreateBack', host).addEventListener('click', () => go('feed'));
  // A freshly launched coin IS a coin page — send the user straight to it
  // instead of dropping them back on a feed they have to find it in.
  bindCreate(host, (address) => { if (address) openCoin(address); });
}

// ── the v2 surfaces ────────────────────────────────────────────
// Their panels live in their own modules; the router paints the shell and
// hands over. Both panels read the chain through pool-data.js, so no two
// screens can disagree about a pool.

// Attached once, next to the welcome's own binding: the nav nodes are painted
// once by renderDex and persist across renders, so binding per-render would
// stack duplicate listeners on every visit.
function bindNav() {
  const nav = $('#dexNav');
  if (!nav) return;
  for (const btn of nav.querySelectorAll('[data-dex-tab]')) {
    btn.addEventListener('click', () => go(btn.dataset.dexTab));
  }
}

// Labels and pressed-state are re-painted every render — switching language
// or route must never leave a tab reading the previous language, or two tabs
// marked as current.
function paintNav(active) {
  const nav = $('#dexNav');
  if (!nav) return;
  nav.setAttribute('aria-label', t('dex.nav.label'));
  for (const btn of nav.querySelectorAll('[data-dex-tab]')) {
    const tab = btn.dataset.dexTab;
    btn.textContent = t(`dex.tab.${tab}`);
    btn.setAttribute('aria-pressed', String(tab === active));
  }
}

function renderSwap(host) {
  host.innerHTML = swapHtml();
  bindSwap(host);
}

function renderPools(host) {
  host.innerHTML = poolsHtml();
  // A pool row's one action is "swap this token": remember the pick and hop
  // to the Swap tab — the same tab the user could have chosen directly.
  bindPools(host, (address) => { set('dex.swapToken', address); go('swap'); });
}

function renderLiquidity(host) {
  host.innerHTML = lpHtml();
  bindLp(host);
}

function renderPortfolio(host) {
  host.innerHTML = portfolioHtml();
  // The portfolio is a mirror — its two actions hand off to the panels that
  // own the real work (LP management, swapping), with the pool preselected.
  bindPortfolio(host, {
    onManageLp: (address) => { set('dex.lpToken', address); go('liquidity'); },
    onSwap: (address) => { set('dex.swapToken', address); go('swap'); },
  });
}

// A coin's own page. The address is resolved against what this wallet actually
// deployed: an address we never deployed is not a coin of ours, and rendering
// it anyway would mean showing a contract we know nothing about.
function renderCoin(host, address) {
  const token = coinByAddress(address);
  if (!token) {
    host.innerHTML = `
      <div class="dex-empty">${escapeHtml(t('dex.tokens.unknown'))}</div>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexCoinBack">
        ← ${escapeHtml(t('dex.tokens.title'))}
      </button>`;
    $('#dexCoinBack', host).addEventListener('click', () => go('feed'));
    return;
  }
  host.innerHTML = tokenTradeHtml(token);
  bindTokenTrade(host, token, () => go('feed'));
}

// Resolves a coin address against the wallet's own launched list. Kept here so
// the feed and the coin page agree on what "a coin" is.
function coinByAddress(address) {
  const a = String(address || '').toLowerCase();
  if (!a) return null;
  const list = Array.isArray(get('dex.launched')) ? get('dex.launched') : [];
  const local = list.find((x) => String(x.address).toLowerCase() === a);
  if (local) return local;
  // A coin the chain told us about but this browser never stored (launched on
  // another device, or before a storage wipe) must still open. The coin page
  // reads name, symbol and creator from the contract, so an entry carrying just
  // the address is enough — and nothing here is invented.
  return { address, name: '', symbol: '', image: '' };
}
