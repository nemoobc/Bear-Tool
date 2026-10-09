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
