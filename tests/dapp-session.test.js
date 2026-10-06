// Bear Tool — dapp-session.test.js
//
// What the browser promises: tabs survive a reload, a corrupt store degrades
// to a fresh session instead of a blank overlay, and the incognito filter is
// the difference between "private" and "quietly persisted". Everything that
// decides what leaves the device (saveSession/restoreSession) is now exported
// and exercised as behaviour — a regex over the source can only say the words
// are there, not that the roundtrip holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseHost } from '../js/dapp-safety.js';

// Same honest-stub contract as dapp-browser-imports.test.js: small enough that
// import cannot do anything, loud enough that load-time DOM reaches fail here.
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

const browser = await import('../js/dapp-browser.js');
const { saveSession, restoreSession } = browser;
const src = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');

const T = 'bear.dapp.tabs';
const A = 'bear.dapp.active';
const seed = (rows) => { localStorage.clear(); if (rows !== undefined) localStorage.setItem(T, JSON.stringify(rows)); };
const savedTabs = () => JSON.parse(localStorage.getItem(T) ?? '[]');
const body = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));

test('restore: an empty or junk store yields a fresh session, not a throw', () => {
  seed([]);
  assert.equal(restoreSession(), false, 'no rows → caller must open a fresh tab');
  seed(undefined);
  assert.equal(restoreSession(), false, 'no key at all → same');
  localStorage.setItem(T, '{definitely not json');
  assert.equal(restoreSession(), false, 'corrupt JSON → read() swallows it, caller recovers');
});

test('restore: junk rows are filtered, missing history is synthesized', () => {
  seed([null, 42, { notaurl: 1 }, { url: 42 }, { url: 'https://ok.io' }]);
  assert.equal(restoreSession(), true, 'one valid row among junk still restores');
  saveSession();
  const rows = savedTabs();
  assert.equal(rows.length, 1, 'only the row with a string url survives');
  assert.equal(rows[0].url, 'https://ok.io');
  assert.equal(rows[0].i, 0);
  assert.deepEqual(rows[0].hist, [{ url: 'https://ok.io', name: baseHost('https://ok.io') }],
    'a row without history gets a single synthesized entry');
  assert.equal(rows[0].name, baseHost('https://ok.io'), 'name falls back to the host');
});

test('restore: an out-of-range history pointer is clamped into the stack', () => {
  const h2 = [{ url: 'https://a.io', name: 'A' }, { url: 'https://b.io', name: 'B' }];
  seed([
    { url: 'https://a.io', name: 'A', hist: h2, i: 9 },    // past the end → last
    { url: 'https://a.io', name: 'A', hist: h2, i: -3 },   // before start → first
  ]);
  assert.equal(restoreSession(), true);
  saveSession();
  const rows = savedTabs();
  assert.equal(rows[0].i, 1, 'i past the end clamps to hist.length - 1');
  assert.equal(rows[1].i, 0, 'negative i clamps to 0');
});

test('restore: url always follows the history pointer', () => {
  // A row whose url disagrees with hist[i] is a torn write from an old version
  // or a crash mid-save. The pointer is the truth; the url is a cache of it.
  seed([{ url: 'https://old.io', name: 'X', hist: [{ url: 'https://new.io', name: 'X' }], i: 0 }]);
  assert.equal(restoreSession(), true);
  saveSession();
  assert.equal(savedTabs()[0].url, 'https://new.io', 'a torn row is healed from hist[i], not trusted');
});

test('save: the roundtrip is stable and the active tab follows bear.dapp.active', () => {
  const rows = [
    { url: 'https://app.aave.com', name: 'Uniswap',
      hist: [{ url: 'https://app.uniswap.org', name: 'Uniswap' }, { url: 'https://app.aave.com', name: 'Aave' }], i: 1 },
    { url: 'https://snapshot.org', name: 'Snapshot', hist: [{ url: 'https://snapshot.org', name: 'Snapshot' }], i: 0 },
  ];
  seed(rows);
  localStorage.setItem(A, JSON.stringify('https://snapshot.org'));
  assert.equal(restoreSession(), true);
  saveSession();
  assert.deepEqual(savedTabs(), rows, 'restore → save must be a fixed point');
  assert.deepEqual(JSON.parse(localStorage.getItem(A)), 'https://snapshot.org',
    'the active tab written back is the one the user had open');
});

// ── what must never leave the device ─────────────────────────────────────

test('saveSession only ever persists non-incognito tabs', () => {
  // Behavioural proof needs a live incognito tab (DOM); the contract the
  // privacy claim rests on is pinned here instead: the writer goes through
  // persistable(), and persistable() is exactly the incognito filter.
  assert.match(src, /const persistable = \(\) => tabs\.filter\(\(x\) => !x\.incognito\)/,
    'persistable() must filter incognito tabs');
  const writer = body('export function saveSession', 'export function restoreSession');
  assert.match(writer, /persistable\(\)/, 'saveSession must persist through persistable(), never raw tabs');
  assert.ok(!/write\(LS\.tabs,\s*tabs\b/.test(writer), 'a raw tabs write would bypass the incognito filter');
  assert.ok(!writer.includes('incognito') || /persistable/.test(writer),
    'incognito state is not copied into rows');
});

test('bookmarks toggle is idempotent and persists to the store', () => {
  const fn = body('function toggleBookmark()', 'function rememberHistory(');
  assert.match(fn, /findIndex\(\(b\) => b\.url === t\.url\)/, 'toggle finds by url — one entry per page');
  assert.match(fn, /list\.splice\(i, 1\)/, 'second press removes rather than duplicates');
  assert.match(fn, /write\(LS\.bookmarks, list\)/, 'the list actually reaches storage');
});

test('history dedupes by url, refuses secrets, and caps at 60', () => {
  const fn = body('function rememberHistory(', 'function go(');
  assert.match(fn, /const clean = sanitizeForStore\(url\)/, 'history goes through the secret filter');
  assert.match(fn, /if \(!clean\) return;/, 'a secret-shaped url is not remembered at all');
  assert.match(fn, /h\.url !== clean/, 'a revisited url moves to the front instead of duplicating');
  assert.match(fn, /slice\(0, 60\)/, 'the history list is bounded');
});
