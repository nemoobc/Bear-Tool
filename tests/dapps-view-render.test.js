// Bear Tool — dapps-view-render.test.js
// Behaviour, not source text.
//
// The DApps screen was blank on the deployed site and nothing said so. Measured
// in a real browser at https://nemoobc.github.io/Bear-Tool/ with no wallet:
//
//   view active            true
//   computed display       "block"
//   #dappsContainer.innerHTML.length   0
//   #dappGrid exists       false
//   .dapp-card count       0
//   "unlock" text present  false
//   console errors         []
//
// A view that is active, visible, empty, unexplained and error-free is the worst
// kind of failure: there is nothing for the user to report and nothing for a log
// to catch. The cause was in app.js:
//
//   function refreshView(view) {
//     if (!get('address')) return;                 ← bail out
//     ...
//     if (view === 'dapps') renderDapps(...)      ← never reached without a wallet
//   }
//
// The catalogue is POPULAR_DAPPS — a hardcoded array of 19 links. Listing links
// is not a wallet operation, and nothing in renderDapps reads the address.
//
// So the gate below calls refreshView('dapps') for real, with no wallet in state,
// and asserts the container actually got a grid. It imports app.js and runs its
// function; it does not read app.js and hope. That distinction has already cost
// this project once — see the header of dapp-browser-imports.test.js, where every
// regex assertion passed while the module could not be evaluated at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const APP = new URL('../js/app.js', import.meta.url).href;

// ── DOM stub ────────────────────────────────────────────────────────────────
// Installed before the import so the whole module graph loads against it. A
// module that reaches for the document at load time fails here, loudly, instead
// of silently in a browser.
const noop = () => {};
const el = () => ({
  classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
  style: {}, dataset: {}, hidden: false, value: '', textContent: '', innerHTML: '',
  setAttribute: noop, getAttribute: () => null, appendChild: noop, removeChild: noop,
  addEventListener: noop, removeEventListener: noop, querySelector: () => null,
  querySelectorAll: () => [], focus: noop, blur: noop, click: noop, closest: () => null,
  children: [], parentNode: null, insertAdjacentHTML: noop, remove: noop, getContext: () => null,
});
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

// querySelector is routed through a registry the tests own, so a test can decide
// which nodes exist without rebuilding the document between assertions.
const nodes = new Map();
globalThis.document = {
  createElement: el, getElementById: (id) => nodes.get('#' + id) || null,
  querySelector: (sel) => nodes.get(sel) || null,
  querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop,
  body: el(), documentElement: el(), head: el(), activeElement: null,
  readyState: 'complete', contains: () => false,
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  location: { href: 'http://localhost/', origin: 'http://localhost' },
};
globalThis.navigator ??= { userAgent: 'node', clipboard: { writeText: async () => {} } };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop, addListener: noop });
globalThis.fetch ??= async () => { throw new Error('no network in a unit test'); };
globalThis.alert ??= noop;
globalThis.confirm ??= () => false;

const app = await import(APP);
const { POPULAR_DAPPS } = await import(new URL('../js/dapps.js', import.meta.url).href);
const { get, set } = await import(new URL('../js/state.js', import.meta.url).href);

/** A #dappsContainer that records whatever renderDapps writes into it. */
function container() {
  const node = el();
  node.innerHTML = '';
  nodes.set('#dappsContainer', node);
  return node;
}

/** A .view.active that repaintActiveView will read. */
function activeView(id) {
  const node = el();
  node.id = id;
  nodes.set('.view.active', node);
}

const cards = (html) => (html.match(/class="dapp-card"/g) || []).length;

// ── the bug ─────────────────────────────────────────────────────────────────

test('the DApps view renders its grid with no wallet in state', () => {
  set('address', null);
  nodes.clear();
  const box = container();

  app.refreshView('dapps');

  assert.notEqual(box.innerHTML.length, 0,
    'the DApps container must not stay empty — that is the reported bug: a visible, ' +
    'blank, unexplained screen with no console error');
  assert.match(box.innerHTML, /id="dappGrid"/,
    '#dappGrid must exist; it did not when the render was gated behind the address');
  assert.equal(cards(box.innerHTML), POPULAR_DAPPS.length,
    `every catalogue entry must produce a card (${POPULAR_DAPPS.length} expected)`);
  assert.ok(POPULAR_DAPPS.length >= 15,
    'the catalogue is meant to be a usable list — a near-empty array is its own silent failure');
});

test('the grid is rendered even when the wallet is locked', () => {
  // Same assertion, expressed the way a user hits it: a fresh profile, or a page
  // reloaded behind the lock screen. Both leave address null.
  set('address', null);
  nodes.clear();
  const box = container();

  app.refreshView('dapps');
  const locked = cards(box.innerHTML);

  set('address', '0x1111111111111111111111111111111111111111');
  nodes.clear();
  const withWallet = container();
  app.refreshView('dapps');
  const unlocked = cards(withWallet.innerHTML);

  assert.equal(locked, unlocked,
    'the catalogue must not depend on wallet state at all — both must render identically');
  assert.ok(locked > 0, 'locked users must still get the grid');
});

// ── the companion bug: unlocking never repainted the open view ──────────────

test('unlocking repaints the view the user is looking at', () => {
  set('address', null);
  nodes.clear();
  const box = container();
  activeView('view-dapps');
  assert.equal(box.innerHTML.length, 0, 'precondition: nothing rendered yet');

  // What the boot-time on('address') listener does when the address arrives.
  set('address', '0x2222222222222222222222222222222222222222');
  assert.ok(app.repaintActiveView(), 'repaintActiveView must do work on a non-dashboard view');

  set('address', null);
  nodes.clear();
  const box2 = container();
  activeView('view-dapps');
  app.repaintActiveView();
  assert.ok(cards(box2.innerHTML) > 0,
    'after unlocking, the open view must actually be rendered — not just marked active');
});

test('repainting the dashboard is skipped, because unlock already loads it', () => {
  set('address', '0x3333333333333333333333333333333333333333');
  nodes.clear();
  activeView('view-dashboard');
  assert.equal(app.repaintActiveView(), false,
    'every unlock path already calls loadDashboard(); doing it again would double the network work');
});

test('repainting with no active view is a no-op, not a throw', () => {
  set('address', '0x4444444444444444444444444444444444444444');
  nodes.clear();
  assert.equal(app.repaintActiveView(), false, 'nothing active means nothing to repaint');
  set('address', null);
});

test('category chips are icon tiles and the filter contract survives the face-lift', () => {
  // live: "rombak UI/UX dApps (…, ikon OKX)" — the text pill row becomes an
  // OKX-style row of icon tiles. The filter binds on .dapp-chip + data-cat and
  // announces aria-pressed, so all three must ride along with the new face.
  set('address', null);
  nodes.clear();
  const box = container();
  app.refreshView('dapps');
  const html = box.innerHTML;

  const cats = [...new Set(POPULAR_DAPPS.map((d) => d.category))];
  assert.equal((html.match(/dapp-chip-ic/g) || []).length, cats.length + 1,
    'every chip (All + each category) must carry an icon tile');
  assert.ok(html.includes('class="dapp-chip'), '.dapp-chip is what the click handler binds');
  assert.ok(html.includes('data-cat='), 'filter keys on data-cat');
  assert.ok((html.match(/aria-pressed=/g) || []).length >= cats.length + 1,
    'each chip announces its pressed state');
  assert.ok(/class="dapp-chip[^>]*--cat:/.test(html),
    'each chip declares its tile colour as a --cat custom property');
});
