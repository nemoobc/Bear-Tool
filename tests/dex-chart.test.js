import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradesToCandles, PRICE_SCALE, LWC_SRI, LWC_VERSION, LWC_URL, chartEngine } from '../js/dex/chart.js';

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
