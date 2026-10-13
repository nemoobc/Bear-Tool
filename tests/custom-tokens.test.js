// Add Token must survive a refresh (user, 2026-10-06: "token yang ku add
// tiba-tiba hilang"). state.tokens is memory — the dashboard rebuilds it from
// native + POPULAR_TOKENS on every load — so the typed facts (chain, address,
// symbol, decimals) persist in localStorage and join the SAME balanceOf
// pipeline at load. Two layers, like tests/activity-network.test.js:
//   1. data layer — real state module + fake localStorage;
//   2. view layer — textual assertions on app.js (save handler + dashboard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
const st = await import('../js/state.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// ── 1. data layer ──────────────────────────────────────────────────────

test('persist → get roundtrip, difilter per chain', () => {
  delete store['bear.customTokens'];
  st.persistCustomToken({ address: '0xAbC', symbol: 'FOO', decimals: 6, chainId: 8453 });
  st.persistCustomToken({ address: '0xDeF', symbol: 'BAR', decimals: 18, chainId: 1 });
  const base = st.getCustomTokens(8453);
  assert.equal(base.length, 1, 'hanya token chain itu yang ikut');
  assert.equal(base[0].symbol, 'FOO');
  assert.equal(st.getCustomTokens().length, 2, 'tanpa chain = semua custom token');
  assert.equal(st.getCustomTokens(137).length, 0, 'chain tanpa custom = kosong');
});

test('idempoten: (chain, alamat) sama tidak diduplikasi; beda chain = entitas beda', () => {
  delete store['bear.customTokens'];
  st.persistCustomToken({ address: '0xABC', symbol: 'FOO', decimals: 6, chainId: 1 });
  st.persistCustomToken({ address: '0xabc', symbol: 'FOO', decimals: 6, chainId: 1 });
  assert.equal(st.getCustomTokens().length, 1, 'checksum beda = alamat sama');
  st.persistCustomToken({ address: '0xabc', symbol: 'FOO', decimals: 6, chainId: 8453 });
  assert.equal(st.getCustomTokens().length, 2, 'kontrak di dua chain = dua entitas');
});

test('payload rusak / penyimpanan korup tidak melempar', () => {
  store['bear.customTokens'] = '{oops';
  assert.deepEqual(st.getCustomTokens(), [], 'JSON rusak → daftar kosong, bukan throw');
  st.persistCustomToken(null);                       // tanpa objek
  st.persistCustomToken({ address: '0x1' });         // tanpa chainId → bukan token
  st.persistCustomToken({ address: 123, chainId: 1 }); // alamat bukan string
  assert.deepEqual(st.getCustomTokens(), []);        // tetap aman
  delete store['bear.customTokens'];
  st.persistCustomToken({ address: '0xOk', symbol: 'OK', decimals: 'x', chainId: 1 });
  const ok = st.getCustomTokens(1);
  assert.equal(ok.length, 1, 'persist tetap jalan setelah payload rusak');
  assert.equal(ok[0].decimals, 18, 'decimals non-numerik jatuh ke 18 (standar ERC-20)');
  delete store['bear.customTokens'];
});

// ── 2. view layer (textual app.js) ─────────────────────────────────────

test('handler Add Token memanggil persistCustomToken dengan fakta token', () => {
  // `normalized` (getAddress from the literal bytes), bukan `addr` mentah:
  // alamat yang diketik salah case disimpan dalam bentuk EIP-55 yang benar.
  assert.match(app,
    /persistCustomToken\(\{ address: normalized, symbol: sym, decimals: Number\(dec\), chainId \}\)/,
    'simpan ke localStorage wajib di jalur konfirmasi Add Token');
});

test('dashboard memuat custom token chain aktif ke pipeline balanceOf', () => {
  const at = app.indexOf('const popular = POPULAR_TOKENS');
  assert.ok(at > -1, 'blok pembangun token list ada');
  const body = app.slice(at, at + 1200);
  assert.match(body, /getCustomTokens\(net\.chainId\)/, 'custom token dibaca per chain aktif');
  assert.match(body, /const list = \[\.\.\.popular, \.\.\.custom\]/,
    'custom ikut promise balanceOf yang sama — bukan daftar statis');
  assert.match(body, /!popular\.some\(/, 'dedupe vs POPULAR_TOKENS (tak boleh baris dobel)');
  assert.match(body, /address: list\[i\]\.address/, 'fallback gagal balance juga baca list gabungan');
});

// ── 3. delete — separuh lain dari Add Token (user, 2026-10-13) ─────────

test('removeCustomToken: buang persis (chain, alamat), case-insensitive, return jujur', () => {
  delete store['bear.customTokens'];
  st.persistCustomToken({ address: '0xAbC', symbol: 'FOO', decimals: 6, chainId: 8453 });
  st.persistCustomToken({ address: '0xDeF', symbol: 'BAR', decimals: 18, chainId: 1 });
  assert.equal(st.removeCustomToken('0xabc', 8453), true, 'alamat beda kapital = entitas sama');
  assert.equal(st.getCustomTokens(8453).length, 0, 'baris chain 8453 gugur');
  assert.equal(st.getCustomTokens().length, 1, 'chain lain utuh');
  assert.equal(st.removeCustomToken('0xabc', 8453), false, 'sudah hilang → false (toast bohong = bug)');
  assert.equal(st.removeCustomToken('0xdef', 137), false, 'chain 137 tak punya baris itu — kontrak sama di dua chain = dua entitas');
  assert.equal(st.getCustomTokens(1).length, 1, 'percobaan di 137 tak menyentuh baris chain 1');
  st.persistCustomToken({ address: '0xDEF', symbol: 'BAZ', decimals: 18, chainId: 137 });
  assert.equal(st.removeCustomToken('0xdef', 1), true, 'entitas chain 1 memang bisa dihapus lewat chain 1');
  assert.equal(st.getCustomTokens(1).length, 0, 'baris chain 1 gugur');
  assert.equal(st.getCustomTokens(137).length, 1, 'alamat sama di chain 137 TIDAK ikut gugur — scoping per chain');
  assert.equal(st.removeCustomToken('', 1), false, 'alamat kosong → false, tanpa throw');
  store['bear.customTokens'] = '{oops';
  assert.equal(st.removeCustomToken('0xabc', 1), false, 'storage rusak → false, tanpa throw');
  delete store['bear.customTokens'];
});

test('view: tombol Remove HANYA untuk token custom; handler bersihkan dua layer', () => {
  assert.match(app, /const isCustom = !!\(address && net\?\.chainId && getCustomTokens\(Number\(net\.chainId\)\)/,
    'status custom = alamat ada + terdaftar di persist untuk chain aktif');
  assert.match(app, /\$\{isCustom \? `<button[^>]*id="tokenRemove"/,
    'tombol dirender kondisional — popular/native tak punya tombol yang berbohong');
  const at = app.indexOf('removeBtn.onclick');
  assert.ok(at > -1, 'handler tombol Remove ada');
  const body = app.slice(at, at + 700);
  assert.match(body, /removeCustomToken\(address, Number\(net\.chainId\)\)/, 'panggil removeCustomToken dengan chain aktif');
  assert.match(body, /set\('tokens', list\)/, 'state.tokens (memori) ikut dibersihkan');
  assert.match(body, /renderAssets\(list\)/, 'daftar aset dirender ulang — hasil langsung terlihat');
  assert.match(body, /toast\(`\$\{symbol\} removed`/, 'toast hanya setelah baris benar-benar gugur');
  assert.match(body, /closeModal\(\)/, 'modal menutup sekali di akhir');
});
