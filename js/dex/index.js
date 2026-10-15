// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/index.js
// The LAUNCHPAD.
//
// This is the pure-launchpad rebuild (user: "ambigu fitur dexnya, rombak ulang
// semuanya" → "opsi 1"). The old Dex carried two trading engines at once —
// Uniswap V2 pools (swap / liquidity / market maker) AND bonding-curve coins —
// plus a global pair and a second "ETH" (the 0x8847 preset vs native Sepolia
// ETH). Two ways to trade, no rule saying which, is what made it ambiguous.
//
// The rebuild's whole job is to delete that ambiguity:
//
//   THE SUBJECT IS A TOKEN.  Not a pair, not a pool, not an engine.
//   1 way to create it  → Create a coin
//   1 way to trade it   → its own curve, ETH in / ETH out
//   1 way to read it    → its own candle chart + trade tape, both from the
//                         curve's events
//
// So there are no tabs, no pair picker, no V2 router, no pools, no market
// maker. Three screens — the feed (home), a coin, and the launch form — and
// nothing else. The Swap / Liquidity / Market Maker panels, the DEX_PAIRS
// table, loadPair and chooseCoin are gone, not hidden: a feature that stays in
// the file with nothing wired to it is just a second, broken way to trade.
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
import {
  DEX_NETWORK_ID, DEX_CHAIN_ID, dexChainOk,
  provider,
  t, get, set, on, $, escapeHtml,
} from './core.js';

// Re-exported so the app (and the gates) read one entry point for the Dex's
// chain facts while the values live in core.js — a chain id is never written
// twice.
export { DEX_CHAIN_ID, DEX_NETWORK_ID, dexChainOk };

// The launchpad's navigation. Two top-level destinations, because that is all
// there is: browse the feed, or launch a coin. A coin's own page is a third
// state, but it hangs off the feed — you reach it by tapping a coin, never by
// hunting for a tab.
export const DEX_ROUTES = ['feed', 'create'];

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
        <div id="dexPanelHost" class="dex-panel"></div>
      </div>
    `;
    paintStatic();
    bindWelcome();
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
  if (!host) return;
  host.style.opacity = ok ? '' : '0.5';
  host.style.pointerEvents = ok ? '' : 'none';
  host.setAttribute('aria-disabled', String(!ok));
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
  if (coin) { renderCoin(host, coin); return; }
  if (get('dex.route') === 'create') { renderCreate(host); return; }
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
