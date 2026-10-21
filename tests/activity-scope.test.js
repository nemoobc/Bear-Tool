// Bear Tool — tests/activity-scope.test.js
//
// "Di fitur Activity itu bug, harusnya ga perlu buka link explore" +
// "List Activity kosong padahal aku pernah tx" (user report 2026-10-21).
//
// The Activity list is scoped to THIS wallet + THIS network (one shared
// filter, so the token modal and the view cannot disagree). When that scope
// came up empty the screen said "No transactions made in Bear Tool yet" and
// pushed the user to the explorer — while the app HELD the user's own rows
// on another network or under another account. The user saw an empty list
// next to a link to somebody else's history.
//
// Two layers, like the sibling activity tests:
//   1. data layer — the pure grouping helper (state.js), driven with the
//      real rows the app writes;
//   2. view layer — textual assertions on app.js: the view must render
//      those rows under their own heading, and must not claim "nothing
//      yet" while it is showing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
};
const st = await import('../js/state.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const view = readFileSync(new URL('../js/activity-view.js', import.meta.url), 'utf8');

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const row = (over = {}) => ({
  hash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
  type: 'send', status: 'success', ts: 1, detail: 'x', netId: 'sepolia', addr: ME, ...over,
});

// ── 1. data layer: the grouping ─────────────────────────────────────────

test('baris wallet ini di jaringan lain muncul sebagai "otherNetworks"', () => {
  const rows = [row({ netId: 'sepolia' }), row({ netId: 'ethereum' })];
  const g = st.activityElsewhere(rows, 'ethereum', ME);
  assert.equal(g.otherNetworks.length, 1, 'the sepolia row is the one on another network');
  assert.equal(g.otherNetworks[0].netId, 'sepolia');
  assert.equal(g.otherWallets.length, 0);
});

test('baris wallet lain di jaringan ini muncul sebagai "otherWallets"', () => {
  const rows = [row({ netId: 'sepolia', addr: OTHER }), row({ netId: 'sepolia', addr: ME })];
  const g = st.activityElsewhere(rows, 'sepolia', ME);
  assert.equal(g.otherWallets.length, 1, 'the other account\'s row is listed');
  assert.equal(g.otherWallets[0].addr, OTHER);
  assert.equal(g.otherNetworks.length, 0);
});

test('baris yang SUDAH di scope ini tidak masuk bagian scope lain', () => {
  const rows = [row({ netId: 'sepolia', addr: ME })];
  const g = st.activityElsewhere(rows, 'sepolia', ME);
  assert.equal(g.otherNetworks.length + g.otherWallets.length, 0,
    'a row the main list already shows is not repeated as "elsewhere"');
});

test('baris tanpa hash atau tanpa stempel tidak pernah diklaim', () => {
  const rows = [row({ hash: null }), row({ netId: '', addr: '' }), row({ netId: 'sepolia', addr: ME })];
  const g = st.activityElsewhere(rows, 'sepolia', ME);
  assert.equal(g.otherNetworks.length, 0, 'an unstamped row belongs to nobody');
  assert.equal(g.otherWallets.length, 0, 'an unstamped row belongs to nobody');
});

// ── 2. view layer: the view must SHOW them ─────────────────────────────

test('view activity menampilkan baris scope lain saat scope ini kosong', () => {
  const start = app.indexOf('function renderActivity(');
  const end = app.indexOf('function showActivityDetail(', start);
  assert.ok(start > -1 && end > start, 'renderActivity harus ditemukan');
  const body = app.slice(start, end);
  // The two groups are rendered, each under its own heading.
  assert.match(body, /groups\.otherNetworks/, 'baris jaringan lain harus dirender');
  assert.match(body, /groups\.otherWallets/, 'baris wallet lain harus dirender');
  assert.match(body, /act\.otherNetworks/, 'heading "jaringan lain"');
  assert.match(body, /act\.otherWallets/, 'heading "wallet lain"');
  // The headline must not claim "no transactions at all" while the view is
  // showing the user's own rows.
  assert.match(body, /act\.emptyScoped/, 'judul empty state harus berbeda saat scope lain ada');
  assert.match(body, /elsewhere \? t\('act\.emptyScoped'\) : t\('act\.empty'\)/,
    'judul empty state dipilih berdasarkan ada/tidaknya baris scope lain');
  // The main list keeps the ONE shared filter — the token modal reads it too.
  assert.match(body, /const visible = currentNetworkActivity\(\)/,
    'list utama tetap pakai helper bersama');
  // …and the groups it renders must actually be DEFINED. A refactor that
  // used `groups` without binding it shipped a ReferenceError on the live
  // screen (caught by the Android E2E, not by these source assertions).
  assert.match(body, /const groups = activityGroups\(\)/,
    'kelompok scope lain harus memang dibuat');
  // Every extra row carries its scope, so a tap opens the record it shows.
  assert.match(body, /row\.dataset\.actScope/, 'baris extra harus membawa scope-nya');
  assert.match(view, /data-act-scope="\$\{scope\}"/, 'tiap baris extra menandai scope-nya');
});
