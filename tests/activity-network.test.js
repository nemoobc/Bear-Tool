// Activity belongs to the network it was recorded on, and the network switcher
// must not offer the network you are already standing on as a destination.
//
// Reported live: "tx testnet dan mainnet nyatu di activity" (one undivided
// list) and "bisa ganti jaringan yang sama" (re-selecting the active network
// re-ran the whole switch: toast + dashboard reload for nothing).
//
// Two layers:
//   1. data layer — real state module + fake localStorage (same setup as
//      tests/activity-log.test.js): every future caller inherits the stamp;
//   2. view layer — textual assertions on app.js (rendering needs a DOM the
//      unit suite does not have; the e2e probe covers the live DOM).
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

// ── 1. data layer ──────────────────────────────────────────────────────

test('addActivity men-stempel netId jaringan aktif saat baris dibuat', () => {
  st.get('activity').length = 0;
  st.set('networkId', 'sepolia');
  const row = st.addActivity({ hash: '0xaa', type: 'send', status: 'pending', ts: 1, detail: 'x' });
  assert.equal(row.netId, 'sepolia', 'baris baru harus bawa jaringannya');
  assert.equal(st.get('activity')[0].netId, 'sepolia');
  st.set('networkId', 'ethereum');
});

test('update pending→success TIDAK mencuri jaringan baru (netId asli dipertahankan)', () => {
  st.get('activity').length = 0;
  st.set('networkId', 'sepolia');
  st.addActivity({ hash: '0xbb', type: 'send', status: 'pending', ts: 1, detail: 'x' });
  st.set('networkId', 'ethereum'); // user pindah sebelum receipt tiba
  const merged = st.addActivity({ hash: '0xbb', status: 'success', ts: 2 });
  assert.equal(merged.netId, 'sepolia', 'receipt tidak boleh menulis ulang jaringan asal');
  assert.equal(merged.ts, 1, 'ts asli juga tetap (kontrak lama)');
});

test('netId eksplisit dari pemanggil menang atas stempel', () => {
  st.get('activity').length = 0;
  st.set('networkId', 'ethereum');
  const row = st.addActivity({ hash: '0xcc', type: 'bridge', status: 'success', ts: 3, netId: 'base' });
  assert.equal(row.netId, 'base');
});

test('baris lama tanpa netId tetap ada di storage (bukan dihapus)', () => {
  // Rekam persis bentuk history LAMA: baris tanpa netId yang sudah
  // terpersist — loadActivity tidak boleh membuangnya.
  store['bear.activity'] = JSON.stringify([
    { hash: '0xlegacy', type: 'send', status: 'success', ts: 9 },
  ]);
  st.loadActivity();
  const row = st.get('activity').find((a) => a.hash === '0xlegacy');
  assert.ok(row, 'baris lama harus selamat dari loadActivity');
  assert.equal(row.netId, undefined, 'memang belum distempel — itu yang membuatnya "older"');
  delete store['bear.activity'];
});

// ── 2. view layer (textual app.js) ─────────────────────────────────────

test('renderActivity & modal koin pakai SATU filter jaringan; baris lama tanpa netId tak ditampilkan', () => {
  const start = app.indexOf('function renderActivity(');
  const end = app.indexOf('function showActivityDetail(', start);
  assert.ok(start > -1 && end > start, 'renderActivity harus ditemukan');
  const body = app.slice(start, end);

  assert.match(body, /const visible = currentNetworkActivity\(\)/,
    'view activity tinggal pakai helper bersama');
  assert.doesNotMatch(body, /Network not recorded/,
    'baris tanpa jaringan tak lagi dicampur ke tampilan (user 2026-10-06: nyatu)');

  // Satu helper untuk SEMUA permukaan activity — modal koin dulu pakai filter
  // sendiri (tanpa netId) sehingga isinya beda dengan fitur Activity.
  const helper = app.indexOf('function currentNetworkActivity(');
  assert.ok(helper > -1, 'helper currentNetworkActivity ada');
  assert.match(app.slice(helper, helper + 900), /a && a\.netId === activeId/,
    'helper = netId cocok dengan jaringan aktif');
  assert.match(app.slice(app.indexOf('const tokenActs ='), app.indexOf('const tokenActs =') + 200),
    /currentNetworkActivity\(\)\.filter\(\(a\) => activityMatchesSymbol/,
    'modal koin membaca activity lewat helper yang sama');

  assert.match(body, /showActivityDetail\(visible\[Number\(row\.dataset\.actIndex\)\]\)/,
    'indeks baris harus menunjuk ke visible, bukan ke seluruh activity');
  assert.doesNotMatch(body, /list\.innerHTML = get\('activity'\)\.map/,
    'render tanpa filter = bug "nyatu" hidup lagi');
});

test('showActivityDetail: baris dibaca dari JARINGANNYA sendiri, bukan jaringan aktif', () => {
  const start = app.indexOf('async function showActivityDetail(');
  assert.ok(start > -1);
  const body = app.slice(start, start + 3000);
  assert.match(body, /const rowNetId = a\.netId \|\| activeId/,
    'jaringan baris = netId baris, fallback jaringan aktif utk baris lama');
  assert.match(body, /getNetworkById\(rowNetId\)/, 'explorer/net dibawa dari rowNetId');
  assert.match(body, /await getProvider\(net\.chainId\)/,
    'baris lintas-jaringan dibaca dari provider jaringannya sendiri');
});

test('switcher: jaringan aktif ditandai non-destinasi dan kliknya di-guard sebelum set', () => {
  // netRow menandai baris aktif:
  const nr = app.indexOf('function netRow(');
  assert.ok(nr > -1, 'netRow harus ada');
  const nrBody = app.slice(nr, app.indexOf('function ', nr + 10) > 0 ? nr + 1600 : nr + 1600);
  assert.match(nrBody, /data-net-current="1"/, 'baris aktif membawa penanda data-net-current');
  assert.match(nrBody, /aria-disabled="true"/, 'baris aktif diberi aria-disabled');
  assert.match(nrBody, /✓ Current/, 'baris aktif menjawab kenapa tap tak berbuat apa-apa');

  // handler: guard datang SEBELUM set('networkId'):
  const at = app.indexOf("$all('[data-net]').forEach(el => el.addEventListener('click'");
  assert.ok(at > -1, 'handler klik [data-net] harus ada');
  const handler = app.slice(at, at + 700);
  const guard = handler.indexOf('dataset.netCurrent');
  const setter = handler.indexOf("set('networkId', el.dataset.net)");
  assert.ok(guard > -1, 'guard netCurrent harus ada');
  assert.ok(setter > -1, 'set networkId tetap ada untuk jaringan lain');
  assert.ok(guard < setter, 'guard harus mendahului set — jaringan sama tidak boleh terswitch');
});

// ── 3. per-wallet (user 2026-10-06: "pake 2 wallet tx nya nyatu") ─────────

test('addActivity men-stempel addr wallet pencipta; receipt tidak boleh mencuri', () => {
  st.get('activity').length = 0;
  st.set('address', '0xAAA');
  st.set('networkId', 'ethereum');
  const row = st.addActivity({ hash: '0xwallet', type: 'send', status: 'pending', ts: 1, detail: 'x' });
  assert.equal(row.addr, '0xAAA', 'baris baru harus bawa wallet yang mengirim');
  st.set('address', '0xBBB'); // user ganti wallet sebelum receipt tiba
  const merged = st.addActivity({ hash: '0xwallet', status: 'success', ts: 2 });
  assert.equal(merged.addr, '0xAAA', 'wallet lain yang sedang aktif tidak boleh mengklaim baris');
  st.set('address', null);
});

test('baris lama tanpa addr: tetap di storage & tak pernah diklaim wallet yang lewat', () => {
  store['bear.activity'] = JSON.stringify([
    { hash: '0xlegacy2', type: 'send', status: 'success', ts: 9 },
  ]);
  st.loadActivity();
  st.set('address', '0xWHO');
  st.addActivity({ hash: '0xlegacy2', status: 'success', ts: 10 }); // heal/merge path
  const row = st.get('activity').find((a) => a.hash === '0xlegacy2');
  assert.ok(row, 'baris lama selamat');
  assert.ok(!row.addr, 'wallet yang kebetulan lewat tidak boleh mengatribusi baris lama');
  st.set('address', null);
  delete store['bear.activity'];
});

test('view: filter SATU helper kini netId + addr — dua wallet satu jaringan terpisah', () => {
  const helper = app.indexOf('function currentNetworkActivity(');
  assert.ok(helper > -1);
  const body = app.slice(helper, helper + 900);
  assert.match(body, /a && a\.netId === activeId && a\.addr === me/,
    'helper wajib menyaring jaringan DAN wallet (user 2026-10-06: nyatu)');
  assert.match(body, /const me = get\('address'\)/, 'wallet aktif dibaca dari state');
});
