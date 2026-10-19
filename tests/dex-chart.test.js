// Bear Tool — tests/dex-chart.test.js
// M8: the chart's MATH half — the part that must never lie on a canvas.
// Bucketing, moving averages, RSI, Bollinger, axis steps, viewport. The
// renderer half is exercised in the browser suite (CI E2E): a canvas in jsdom
// is a lie, so unit tests only assert what decides the pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketCandles, sma, ema, rsi, bollinger, niceStep, viewport } from '../js/dex/chart.js';

const MIN = 60_000;

const mkRow = (ts, price, amount) => ({ ts, price, amount });

test('bucketCandles: rolls swaps into ms buckets, oldest-left, gaps stay gaps', () => {
  assert.deepEqual(bucketCandles([], MIN), []);
  const one = bucketCandles([mkRow(10_000_000, 1.5, 2)], MIN);
  assert.equal(one.length, 1, 'a single swap is one honest bar, not none');

  // newest-first input: two rows in the newest minute, one two minutes back
  const rows = [
    mkRow(10_139_999, 3, 1),  // bucket 10_080_000
    mkRow(10_100_000, 2, 1),  // bucket 10_080_000
    mkRow(9_600_000, 1, 4),   // bucket 9_600_000
  ].map((r) => ({ ...r, ts: Math.floor(r.ts / MIN) * MIN }));
  const cs = bucketCandles(rows, MIN);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].t <= cs[1].t, true, 'oldest first');
  const lastBar = cs[cs.length - 1];
  assert.deepEqual(
    [lastBar.o, lastBar.h, lastBar.l, lastBar.c],
    [3, 3, 2, 2],
    'trail arrives newest-first: open = the row the bucket first saw, close = its last',
  );
  assert.equal(lastBar.v, 2, 'volume is the bucket sum, not the last row');
  assert.equal(cs[0].v, 4);
});

test('bucketCandles: a short history is honest (2 bars max, no padding)', () => {
  const rows = [mkRow(5_000, 2, 1), mkRow(1_000, 1, 1)];
  const cs = bucketCandles(rows, 10_000);
  assert.equal(cs.length, 1, 'both rows share one bucket');
});

test('sma: exact window means, warm-up bars are null (no half-lies)', () => {
  const v = [1, 2, 3, 4, 5];
  assert.deepEqual(sma(v, 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma(v, 1), [1, 2, 3, 4, 5]);
  assert.deepEqual(sma([], 3), []);
});

test('ema: seeds with the first bar, warm-up hidden until the window fills', () => {
  assert.deepEqual(ema([2, 2, 2], 1), [2, 2, 2], 'k=1 → the EMA of a flat run is the run');
  assert.deepEqual(ema([1, 2, 3], 3), [null, null, (3 - 1.5) * 0.5 + 1.5], 'n=3 → alpha 0.5: 1 → 1.5 → 2.25, disclosed only at i=n-1');
});

test('rsi: the classic extremes and the warm-up contract', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + 1);
  const rUp = rsi(up, 14);
  assert.equal(rUp[14], 100, 'all gains → RSI 100');
  assert.equal(rUp.slice(0, 14).every((x) => x === null), true);

  const down = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.equal(rsi(down, 14)[14], 0, 'all losses → RSI 0');

  const flat = new Array(20).fill(5);
  assert.equal(rsi(flat, 14)[19], 50, 'a flat market is neutral, not bullish');

  // perfectly symmetric ±1 alternation → avgGain == avgLoss at the seed → rsi[14] = 50
  const zig = Array.from({ length: 21 }, (_, i) => 100 - (i % 2));
  assert.equal(rsi(zig, 14)[14], 50, 'the window seed is symmetric');
  assert.ok(Math.abs(rsi(zig, 14)[20] - 50) < 2, 'Wilder smoothing drifts back toward 50, never far');
  assert.deepEqual(rsi([1, 2], 14), [null, null], 'shorter than the window → all null');
});

test('bollinger: a flat series stays flat (sd=0), bands hug the mean', () => {
  const v = new Array(30).fill(7);
  const bb = bollinger(v, 20, 2);
  assert.equal(bb.mid[25], 7);
  assert.equal(bb.up[25], 7);
  assert.equal(bb.lo[25], 7);
  assert.equal(bb.up[10], null, 'warm-up is not invented');
});

test('niceStep: round-ish steps a human can read', () => {
  assert.equal(niceStep(1, 5), 0.2);
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(0, 5), 1, 'a zero span still yields a step');
  assert.equal(niceStep(2.5, 5), 0.5);
});

test('viewport: slices the end, pads 6%, never inverted', () => {
  const cs = Array.from({ length: 30 }, (_, i) => ({ o: i + 1, h: i + 2, l: i, c: i + 1.5, v: 1 }));
  const V = viewport(cs, 10, Infinity);
  assert.equal(V.slice.length, 10);
  assert.equal(V.end, 30);
  assert.equal(V.begin, 20);
  assert.ok(V.yLo <= Math.min(...V.slice.map((c) => c.l)));
  assert.ok(V.yHi >= Math.max(...V.slice.map((c) => c.h)));
  assert.equal(viewport([], 10, 5), null, 'no candles → no viewport');
  const V2 = viewport(cs, 100, 5);
  assert.equal(V2.slice.length, 30, 'fewer candles than the window shows them all');
});
