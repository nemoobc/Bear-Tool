import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tradesToCandles, PRICE_SCALE, LWC_SRI, LWC_VERSION, LWC_URL, chartEngine, barsSvg, paintBars } from '../js/dex/chart.js';

const S = (n) => n * PRICE_SCALE; // helper: human price -> scaled
const trade = (price, vol = 1n, block = 1) => ({ price: S(price), volQuote: vol, block });

test('empty / non-array input yields no candles, never a crash', async () => {
  assert.deepEqual(await tradesToCandles([], async () => 1), []);
  assert.deepEqual(await tradesToCandles(null, async () => 1), []);
  assert.deepEqual(await tradesToCandles(undefined, async () => 1), []);
});

test('a single trade is a flat candle: open=high=low=close, real time', async () => {
  const seen = [];
  // The callback receives the trade ROW, not just its block: two trades can
  // share a block, and a block alone cannot tell them apart.
  const out = await tradesToCandles([trade(2.5, 3n, 42)], async (row) => { seen.push(row); return 1700000000; });
  assert.equal(out.length, 1);
  assert.equal(seen.length, 1, 'time is resolved once, for the candle\'s last trade');
  assert.equal(seen[0].block, 42, 'time comes from the trade block, not from now()');
  assert.equal(seen[0].price, 2.5 * PRICE_SCALE, 'the whole row is handed over, not just the block');
  const c = out[0];
  assert.equal(c.open, 2.5); assert.equal(c.high, 2.5);
  assert.equal(c.low, 2.5); assert.equal(c.close, 2.5);
  assert.equal(c.volume, 3 / PRICE_SCALE, 'volume is quote units, scale divided out');
});

test('open is FIRST trade and close is LAST — never max/min', async () => {
  // Rises then falls: max is 9 (trade 2), but close must be 4 (trade 4).
  const out = await tradesToCandles(
    [trade(1), trade(9), trade(6), trade(4)], async () => 100, 1);
  assert.equal(out.length, 1, 'forced into one candle');
  assert.equal(out[0].open, 1, 'open is the first trade, not the lowest');
  assert.equal(out[0].close, 4, 'close is the last trade, not the highest');
  assert.equal(out[0].high, 9, 'high is the true maximum');
  assert.equal(out[0].low, 1, 'low is the true minimum');
});

test('volume sums every trade in the bucket as bigint-safe arithmetic', async () => {
  const big = 10n ** 30n; // far beyond float precision
  const out = await tradesToCandles(
    [trade(1, big, 1), trade(1, big, 1), trade(1, 5n, 1)], async () => 100, 1);
  assert.equal(out[0].volume, Number(big * 2n + 5n) / PRICE_SCALE, 'sum before dividing');
});

test('bucketing caps candle count and keeps ascending time order', async () => {
  const trades = [];
  for (let i = 0; i < 100; i++) trades.push(trade(1 + i / 100, 1n, 1000 - i)); // DESCENDING blocks
  const out = await tradesToCandles(trades, async (row) => row.block, 10);
  assert.ok(out.length <= 10, `cap respected, got ${out.length}`);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].time > out[i - 1].time, 'candles must be ascending by time');
  }
});

test('blocks are retained per candle so a bar can be traced to chain', async () => {
  const out = await tradesToCandles(
    [trade(1, 1n, 7), trade(2, 1n, 8), trade(3, 1n, 9)], async () => 100, 1);
  assert.deepEqual(out[0].blocks, [7, 8, 9], 'every source block is auditable');
});

test('the pinned CDN facts are exact, not floating', () => {
  assert.equal(LWC_VERSION, '5.2.1');
  assert.match(LWC_URL, /lightweight-charts@5\.2\.1\/dist\/lightweight-charts\.standalone\.production\.js$/);
  // The IIFE build, which sets window.LightweightCharts — not the .mjs main.
  assert.equal(LWC_URL.includes('standalone.production.js'), true);
  assert.match(LWC_SRI, /^sha384-[A-Za-z0-9+/]{64}$/,
    'SRI is sha384: exactly 48 bytes -> 64 base64 chars, no padding');
});

test('chartEngine reads the global and tolerates a missing window', () => {
  assert.equal(chartEngine({ LightweightCharts: 'X' }), 'X');
  assert.equal(chartEngine({}), null);
  assert.equal(chartEngine(null), null);
});

// ── the hand-rolled fallback ─────────────────────────────────────
// The library loads from a pinned CDN; a blocked CDN used to leave an empty
// box (user: "chart ga keliatan"). barsSvg is the fallback the comment always
// promised — same palette, same candles, no dependency — finally kept.

test('bars fallback: no candles still draw a frame with the empty label', () => {
  const svg = barsSvg([], { empty: 'No trades yet', width: 300, height: 200 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /No trades yet/, 'an empty chart must SAY so, not show a blank box');
  assert.match(svg, /viewBox="0 0 300 200"/);
  assert.equal((svg.match(/data-bar/g) || []).length, 0, 'no trades, no bars');
});

test('bars fallback: one bar per candle, coloured by direction', () => {
  const candles = [
    { open: 1, high: 2, low: 0.5, close: 1.5 },   // up
    { open: 2, high: 2.2, low: 1.3, close: 1.4 }, // down
  ];
  const svg = barsSvg(candles, { width: 320, height: 220 });
  assert.equal((svg.match(/data-bar/g) || []).length, 2, 'one bar per candle');
  assert.equal((svg.match(/data-dir="up"/g) || []).length, 1);
  assert.equal((svg.match(/data-dir="down"/g) || []).length, 1);
  // The SAME palette the library path draws from — one map, two renderers.
  assert.ok(svg.includes('#1B8F4E'), 'up colour comes from the light palette');
  assert.ok(svg.includes('#D64545'), 'down colour comes from the light palette');
  const dark = barsSvg(candles, { width: 320, height: 220, theme: 'dark' });
  assert.ok(dark.includes('#0ecb81') && dark.includes('#f6465d'), 'dark theme keeps the exchange palette');
});

test('bars fallback: a flat series still draws — no divide by zero', () => {
  const svg = barsSvg([{ open: 5, high: 5, low: 5, close: 5 }], { width: 300, height: 200 });
  assert.equal((svg.match(/data-bar/g) || []).length, 1);
  assert.ok(!svg.includes('NaN'), 'a flat price must never produce NaN coordinates');
});

test('bars fallback: labels are the caller\'s formatter, escaped', () => {
  const svg = barsSvg([{ open: 1, high: 2, low: 1, close: 2 }], { fmt: (v) => `P${v}`, width: 300, height: 200 });
  assert.match(svg, /P2<\/text>/, 'the top label uses the caller formatter');
  assert.match(svg, /P1<\/text>/, 'and so does the bottom label');
  const empty = barsSvg([], { empty: 'a <b> & "c"' });
  assert.ok(!empty.includes('<b>'), 'a label must never become markup');
  assert.ok(empty.includes('&lt;b&gt;'), 'and must ride in escaped');
});

test('paintBars fills the host, respects its width, and returns a teardown', () => {
  const host = { innerHTML: '', clientWidth: 280 };
  const td = paintBars(host, [{ open: 1, high: 1, low: 1, close: 1 }], { height: 100 });
  assert.match(host.innerHTML, /^<svg /);
  assert.match(host.innerHTML, /viewBox="0 0 280 100"/, 'the live host width must win over the default');
  assert.equal(typeof td, 'function');
  td();
  assert.equal(host.innerHTML, '', 'teardown must leave nothing behind');
});

test('drawCandles falls back to the bars — the old null path is gone', () => {
  const src = readFileSync(new URL('../js/dex/chart.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!LWC\) return paintBars\(host, candles, opts\)/,
    'a missing library must paint bars, not return null — null left an empty box');
  assert.ok(!/if \(!LWC\) return null/.test(src), 'the dead null fallback must stay dead');
});
