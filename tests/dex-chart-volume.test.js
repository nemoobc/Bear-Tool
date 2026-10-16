// tests/dex-chart-volume.test.js
// Chart: the volume histogram must be drawn from the same lifted series as the
// OHLC candles (flat-candle lift applied), and every volume value must be
// Number.isFinite-guarded — invalid → 0, never NaN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('chart volume histogram uses the lifted series, never raw candles', () => {
  const src = read('../js/dex/chart.js');
  // Volume and OHLC must come from the same array (renderableCandles output).
  assert.match(src, /volSeries\.setData\(series\.map/,
    'volume histogram drawn from the lifted series, not raw candles');
  assert.ok(!/volSeries\.setData\(candles\.map/.test(src),
    'no remaining volume feed from raw candles');
});

test('chart volume value is Number.isFinite-guarded (invalid → 0, never NaN)', () => {
  const src = read('../js/dex/chart.js');
  assert.match(src, /value: Number\.isFinite\(volume\)\s*\?\s*volume\s*:\s*0/,
    'invalid volume → 0, so the histogram never receives NaN; no double PRICE_SCALE division');
});
