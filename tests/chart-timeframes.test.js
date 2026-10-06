// Rentang chart & kejujuran candle — user 2026-10-06: "chart time itu ga
// akurat candle nya sama semua".
//
// Akar masalah terukur (CoinGecko keyless, 2026-10-06): days=1 → 30min,
// 7 → 4h, 30 → 4h, 365 → 4d — TIDAK ADA candle 5m/1h keyless, jadi tombol
// 5m/1h/24h semuanya mengambil days=1 dan menampilkan candle identik.
// Perbaikan: tombol = rentang yang benar-benar bisa dibedakan API, merge
// candle tanpa membuang data, label sumbu waktu, fallback menghormati days.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { fitCandles } from '../js/price.js';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const price = fs.readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');

test('tombol chart = rentang terukur 24h/7d/30d/1y, default 24h — 5m/1h dilepas', () => {
  const btnBlock = app.slice(app.indexOf('chart-timeframes'), app.indexOf('chart-timeframes') + 700);
  const tfs = [...btnBlock.matchAll(/data-tf="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tfs, ['24h', '7d', '30d', '1y'], 'empat rentang, berurutan');
  assert.match(btnBlock, /data-tf="24h" class="chart-tf-btn active"|class="chart-tf-btn active" data-tf="24h"|<button class="chart-tf-btn active" data-tf="24h">/,
    '24h yang aktif saat modal terbuka');
  assert.ok(!app.includes('data-tf="5m"') && !app.includes('data-tf="1h"'),
    'tombol yang datanya identik (sama-sama days=1) tidak boleh tersisa');
});

test('CHART_TF_DAYS memetakan tiap tombol ke days yang berbeda', () => {
  assert.match(app,
    /const CHART_TF_DAYS = \{ '24h': 1, '7d': 7, '30d': 30, '1y': 365 \};/,
    'setiap rentang → days sendiri-sendiri');
});

test('gambar awal mengikuti tombol aktif, bukan nilai keras', () => {
  assert.match(app, /timeframe: document\.querySelector\('\.chart-tf-btn\.active'\)\?\.dataset\.tf \|\| '24h'/,
    'initial draw membaca tombol aktif');
});

test('stride filter digantikan fitCandles — tak ada lagi candle dibuang', () => {
  assert.doesNotMatch(app, /i % step2 === 0/,
    'filter stride lama (buang open/high/low tiap candle yang diskip) hilang');
  assert.match(app, /fitCandles\(candles, 60\)/, 'merge-down dipanggil di drawMiniChart');
  assert.match(app, /import \{[^}]*fitCandles[^}]*\} from '\.\/price\.js'/, 'fitCandles diimpor dari price.js');
});

test('label sumbu waktu: kiri/tengah/kanan dengan format mengikuti rentang', () => {
  const start = app.indexOf('async function drawMiniChart(');
  const fn = app.slice(start, start + 7000);
  assert.match(fn, /fmtChartTime\(display\[0\]\.time\)/, 'kiri = awal rentang');
  assert.match(fn, /fmtChartTime\(display\[Math\.floor\(display\.length \/ 2\)\]\.time\)/, 'tengah = titik tengah');
  assert.match(fn, /fmtChartTime\(display\[display\.length - 1\]\.time\)/, 'kanan = akhir rentang');
  assert.match(fn, /if \(days <= 1\) return d\.toLocaleTimeString/, '24h memakai jam');
  assert.match(fn, /days >= 365/, '1y memakai bulan+tahun');
});

test('price.js: fallback market_chart menghormati days + cache key per rentang', () => {
  assert.match(price, /export async function fetchPriceHistory\(\{ address, chainId, days = 1 \}\)/);
  assert.match(price, /`hist:\$\{address \? `\$\{chainId\}:\$\{String\(address\)\.toLowerCase\(\)\}` : `\$\{chainId\}:native`\}:\$\{days\}`/,
    'key bawa hari — isi cache 24h tak boleh menjawab 1y');
  const fn = price.slice(price.indexOf('export async function fetchPriceHistory'));
  assert.ok(!/days: 1 \}\)/.test(fn.slice(0, 1600)), 'url market_chart memakai days, bukan angka mati 1');
  assert.match(price, /fetchPriceHistory\(\{ address, chainId, days \}\)/, 'fetchOHLC fallback meneruskan days');
  assert.match(price, /stepMs = \(days \* 86400000\) \/ prices\.length/,
    'jarak pseudo-candle mengikuti rentang, bukan 5 menit tetap');
});

// ── perilaku fitCandles ──────────────────────────────────────────────────
const mk = (n) => Array.from({ length: n }, (_, i) => ({
  time: 1000 + i, open: i, high: i + 10, low: i - 10, close: i + 5,
}));

test('fitCandles: ≤max dikembalikan utuh (tanpa merge)', () => {
  const c = mk(48);
  assert.equal(fitCandles(c, 60).length, 48);
  assert.deepEqual(fitCandles(c, 60), c, 'identik, tidak tersentuh');
});

test('fitCandles: >max di-merge berpasangan — open pertama, close terakhir, high/low lintas', () => {
  const src = mk(180);
  const merged = fitCandles(src, 60);
  assert.ok(merged.length <= 60, `180 → ${merged.length} ≤ 60`);
  assert.ok(merged.length > 20, 'tidak dilebih-lebihkan sampai kehilangan bentuk');
  // Dua pass (180→90→45): kelompok pertama = candle 0..3 — open = open
  // candle 0, close = close candle 3, high/low = max/min keempatnya.
  const first = merged[0];
  assert.equal(first.open, src[0].open, 'open = open candle pertama');
  assert.equal(first.close, src[3].close, 'close = close candle akhir kelompok (data tak dibuang)');
  assert.equal(first.high, src[3].high, 'high = max kelompok');
  assert.equal(first.low, src[0].low, 'low = min kelompok');
  assert.equal(first.time, src[0].time, 'time = waktu awal kelompok');
});

test('fitCandles: ganjil — ekor terakhir ikut utuh, rentang high/low global terjaga', () => {
  const c = mk(45); // 45 ≤ 60 → tak dijamah
  assert.equal(fitCandles(c, 40).length, 23); // 45 → 23 (22 pasang + 1 ekor)
  const merged = fitCandles(c, 40);
  assert.equal(merged[merged.length - 1].time, 1000 + 44, 'ekor ganjil tidak hilang');
  const src = mk(101);
  const out = fitCandles(src, 60);
  assert.equal(Math.max(...out.map((x) => x.high)), Math.max(...src.map((x) => x.high)),
    'high global terjaga melewati merge');
  assert.equal(Math.min(...out.map((x) => x.low)), Math.min(...src.map((x) => x.low)),
    'low global terjaga melewati merge');
  assert.equal(out[0].open, src[0].open, 'open awal terjaga');
  assert.equal(out[out.length - 1].close, src[src.length - 1].close, 'close akhir terjaga');
});
