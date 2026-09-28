// Bear Tool — dapp-browser-imports.test.js
// Import the module for real. Do not read it and hope.
//
// dapps.test.js asserts the browser module owns its entry point with a regex over
// the source text. That is a good check of intent and a useless one of behaviour:
// the module was, at one point, structurally broken in a way that left every
// regex assertion satisfied — openDappBrowser present in the text, the iframe
// present, the overlay class present — while the file could not be evaluated.
//
// It showed up as 14 browser tests failing on `#dappBrowserOverlay.open`, and the
// cause was a fragment left at module level, so the module threw ReferenceError on
// import and the DApps grid's click handler was calling undefined. A probe finally
// printed it:
//
//   Uncaught ReferenceError: url is not defined   js/dapp-browser.js:725
//
//   node --check   → passed   (the braces balanced)
//   dapps.test.js  → passed   (it only greps the text)
//   679 unit tests → passed   (nothing imported this module)
//
// The class of bug is the one this project keeps finding: code nothing ever ran.
// The gate is one line long — actually import it — and it is the only kind that
// could have seen this.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A DOM small enough that importing cannot accidentally do anything, and honest
// enough that a module that reaches for the document at load time fails loudly here
// rather than silently in a browser.
if (!globalThis.document) {
  const noop = () => {};
  const el = () => ({
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    style: {}, dataset: {}, hidden: false, value: '', textContent: '',
    setAttribute: noop, getAttribute: () => null, appendChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], focus: noop, blur: noop, click: noop,
    insertAdjacentHTML: noop, remove: noop, closest: () => null, children: [],
  });
  globalThis.document = {
    createElement: el, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop,
    body: el(), documentElement: el(), head: el(), activeElement: null,
    readyState: 'complete', contains: () => false,
  };
}
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
  };
}
if (!globalThis.window) globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.location ??= { href: 'http://localhost/', origin: 'http://localhost' };

test('the dApp browser module can actually be imported', async () => {
  // The assertion is the absence of a throw. A module with a stray statement at
  // top level, a broken export, or a syntax error all land here.
  const mod = await import('../js/dapp-browser.js');
  assert.ok(mod, 'the module must produce a namespace object');
});

test('every public entry point is a function, and none is undefined', async () => {
  const mod = await import('../js/dapp-browser.js');
  // These are what dapps.js and app.js import by name. An import that resolves to
  // undefined is exactly what a broken module hands back, and it fails at the click,
  // not at the call site.
  for (const name of [
    'initDappBrowser', 'openDappBrowser', 'openDappHome', 'openExternalNotice',
    'closeDappBrowser', 'dappBrowserIsOpen', 'dappBrowserOnLock',
  ]) {
    assert.equal(typeof mod[name], 'function',
      `${name} must be a function — an undefined export means the module did not evaluate`);
  }
});

test('the catalogue injection is what the discovery view relies on', async () => {
  const mod = await import('../js/dapp-browser.js');
  // initDappBrowser({catalog}) is how the grid gets its dApps. If it is not a
  // function, the grid renders nothing and every card click is a no-op.
  assert.equal(typeof mod.initDappBrowser, 'function');
  // Calling it must not throw and must be safe to call before anything is built.
  assert.doesNotThrow(() => mod.initDappBrowser({ catalog: [] }));
});
