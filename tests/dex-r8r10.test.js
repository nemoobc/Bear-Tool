// Bear Tool — tests/dex-r8r10.test.js
//
// R8 — the chart's timeframes (1m/5m/1h/1d) are the SAME decoded trades re-cut
// by the clock (timeCandles + poolTimeCandles): no second read, and a quiet
// hour draws no candle at all — a gap is a fact, not a bar invented to hide
// it. The chips on the token page feed straight back into that maths.
//
// R10 — the LP panel's last clarity pieces: the fee-APR estimate built from
// the same 24h window the token page shows (feeAprBps, exact bigint math,
// shown only when the read succeeded) and the approve order said out loud at
// the moment money is committed. Plus the pool select that actually switches
// pools (option value = address — without it every switch silently reloaded
// the first pool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Same DOM shim as the other Dex panel tests: core.js reads localStorage at
// import time, and lp.js sits on top of core.js.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
for (const key of ['window', 'document', 'localStorage', 'navigator', 'location',
  'HTMLElement', 'Node', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true }); } catch { /* getter-only global */ }
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { timeCandles, PRICE_SCALE } = await import('../js/dex/chart.js');
const { historyTimeCandles, poolTimeCandles } = await import('../js/dex/history.js');
const { feeAprBps, lpHtml } = await import('../js/dex/lp.js');

const P = 10n ** 18n; // one whole unit in wei — volumes and prices read as integers

// A row exactly as the chart seam hands it to chart.js: price scaled by
// PRICE_SCALE, time in seconds, quote volume in wei.
const row = (time, price, vol = 0n) => ({ time, price: price * PRICE_SCALE, volQuote: vol });

const T0 = 1_700_000_000;
const B0 = Math.floor(T0 / 60) * 60; // the 1m bucket start around T0

// ── R8: time bucketing ───────────────────────────────────────────────

test('timeCandles: buckets follow the clock — a quiet bucket draws NO candle', () => {
  // T0 and T0+30 share the 1m bucket; T0+61 is two buckets later (T0+40..99
  // bucket holds no trade — and must NOT produce a candle).
  const out = timeCandles([
    row(T0, 2, 1n * P),
    row(T0 + 30, 3, 2n * P),
    row(T0 + 61, 4, 5n * P),
  ], 60);
  assert.equal(out.length, 2, 'two traded buckets only — the empty one is a gap, not a bar');
  assert.deepEqual(out.map((c) => c.time), [B0, B0 + 60], 'bucket starts, ascending');
  assert.deepEqual(
    { o: out[0].open, h: out[0].high, l: out[0].low, c: out[0].close, v: out[0].volume },
    { o: 2, h: 3, l: 2, c: 3, v: 3 },
    'open/close follow time order, high/low the extremes, volume the quote sum',
  );
  assert.deepEqual(
    { o: out[1].open, c: out[1].close, v: out[1].volume },
    { o: 4, c: 4, v: 5 },
    'a single-trade bucket is flat — what actually happened',
  );
});

test('timeCandles: one trade is a whole flat candle; volume is the quote sum', () => {
  const out = timeCandles([row(T0 + 12, 2.5, 3n * P)], 300);
  assert.equal(out.length, 1);
  assert.deepEqual({ ...out[0] }, { time: Math.floor((T0 + 12) / 300) * 300, open: 2.5, high: 2.5, low: 2.5, close: 2.5, volume: 3 });
});

test('timeCandles: refuses empty input and a broken interval instead of guessing', () => {
  assert.deepEqual(timeCandles([], 60), []);
  assert.deepEqual(timeCandles(null, 60), []);
  assert.deepEqual(timeCandles(undefined, 60), []);
  for (const bad of [0, -60, NaN, null, 'x']) assert.deepEqual(timeCandles([row(T0, 1)], bad), [], `interval ${bad}`);
});

test('timeCandles: rows with no readable time or price are skipped, never drawn at 1970', () => {
  const out = timeCandles([
    row(0, 9),            // timestamp never got read — where would this land?
    { time: T0, price: NaN, volQuote: 0n },
    row(T0, 2),
  ], 60);
  assert.equal(out.length, 1);
  assert.equal(out[0].close, 2);
});

test('timeCandles: past the cap the NEWEST buckets survive, ascending', () => {
  const rows = [];
  for (let i = 0; i < 70; i++) rows.push(row(T0 + i * 60, i + 1));
  const out = timeCandles(rows, 60, 60);
  assert.equal(out.length, 60, 'cap respected');
  assert.equal(out[0].time, B0 + 10 * 60, 'the oldest 10 buckets are the ones dropped');
  assert.equal(out[out.length - 1].close, 70, 'the newest trade is still the close');
  assert.deepEqual([...out.map((c) => c.time)].sort((a, b) => a - b), out.map((c) => c.time), 'ascending');
});

test('timeCandles: unsorted input lands in the same buckets — order is not the caller’s job', () => {
  const sorted = timeCandles([row(T0, 1), row(T0 + 61, 2)], 60);
  const shuffled = timeCandles([row(T0 + 61, 2), row(T0, 1)], 60);
  assert.deepEqual(shuffled, sorted);
});

test('poolTimeCandles is the same time maths — one shape, one chart', async () => {
  assert.equal(poolTimeCandles, historyTimeCandles, 'the pool name must BE the shared function, not a fork');
  assert.deepEqual(poolTimeCandles([], 60), []);
  assert.deepEqual(poolTimeCandles(null, 60), []);
});

test('poolTimeCandles maps decoded trades: block order asc, price scaled, quote volume', () => {
  const out = poolTimeCandles([
    { block: 20, time: T0 + 120, price: 3, eth: 2n * P },
    { block: 10, time: T0 + 30, price: 1, eth: 1n * P },
  ], 60);
  assert.equal(out.length, 2, 'T0+30 → B0; T0+120 → B0+120');
  assert.deepEqual(out.map((c) => c.time), [B0, B0 + 120]);
  assert.deepEqual(
    { o: out[0].open, c: out[0].close, v: out[0].volume },
    { o: 1, c: 1, v: 1 },
    'the seam flips newest-first rows back to chain order before bucketing',
  );
  assert.equal(out[1].close, 3);
});

// ── R10: fee APR estimate ────────────────────────────────────────────

test('feeAprBps: the exact hand-computed example — 100 quote over 1000 reserve, 20 bps net', () => {
  // feeYear = 100e18 × 20/10000 × 365 = 73e18; TVL = 2×1000e18;
  // APR = 73/2000 = 3.65% → 365 bps of percent.
  const v = feeAprBps({ volQuote: 100n * P, quoteReserve: 1000n * P, creatorFeeBps: 10 });
  assert.equal(v, 365n);
});

test('feeAprBps: an old pair (no creator getter → 0) credits the LP the whole 0.3%', () => {
  // 100 × 30 × 365 / 2000 = 547.5 → floor 547 (no rounding up, ever).
  assert.equal(feeAprBps({ volQuote: 100n * P, quoteReserve: 1000n * P, creatorFeeBps: 0 }), 547n);
});

test('feeAprBps: a quiet window is a true zero; an undividable one is null; junk is null', () => {
  assert.equal(feeAprBps({ volQuote: 0n, quoteReserve: 1000n * P }), 0n, 'we looked, nothing traded — that is a zero');
  assert.equal(feeAprBps({ volQuote: 100n * P, quoteReserve: 0n }), null, 'nothing honest to divide by');
  assert.equal(feeAprBps({ volQuote: 100, quoteReserve: 1000n * P }), null, 'not bigint → not our math');
  assert.equal(feeAprBps({}), null);
});

test('feeAprBps: a creator at (or past, defensively) the cap leaves the LP nothing to extrapolate', () => {
  assert.equal(feeAprBps({ volQuote: 100n * P, quoteReserve: 1000n * P, creatorFeeBps: 30 }), 0n);
  assert.equal(feeAprBps({ volQuote: 100n * P, quoteReserve: 1000n * P, creatorFeeBps: 35 }), 0n);
});

// ── wiring pins: the seams a test can hold without a chain ───────────

test('token page: four timeframe chips, 1m default, clicking re-cuts the SAME trades', () => {
  const page = read('../js/dex/token-page.js');
  assert.match(page, /const CHART_TFS = \[/, 'one source of truth for the choices');
  for (const [sec, label] of [[60, '1m'], [300, '5m'], [3600, '1h'], [86400, '1d']]) {
    assert.match(page, new RegExp(`\\{ sec: ${sec}, label: '${label}' \\}`), `chip ${label} defined`);
  }
  assert.match(page, /data-tf="\$\{tf\.sec\}"/, 'buttons render from the choice list');
  assert.match(page, /aria-pressed="\$\{tf\.sec === DEFAULT_TF\}"/, 'the default chip starts pressed');
  assert.match(page, /const DEFAULT_TF = 60;/, '1m is the default');
  assert.match(page, /id="dexTpTfs" role="group"/, 'the chip row is a labelled group');
  assert.match(page, /chartTf = Number\(btn\.dataset\.tf\) \|\| DEFAULT_TF;/, 'click sets the timeframe');
  assert.match(page, /poolTimeCandles\(chartTrades, chartTf\)/, 'and re-cuts from the rows already read — no second fetch');
  assert.doesNotMatch(page, /poolCandles\(/, 'the count-bucketed path is gone from the token page');
  assert.match(page, /dex\.tp\.tfThin/, 'the one-candle note is stated');
});

test('token page: an overtaken draw tears itself down — no two charts in one host', () => {
  const page = read('../js/dex/token-page.js');
  assert.match(page, /const seq = \+\+chartSeq;/, 'every draw takes a ticket');
  assert.match(page, /if \(seq === chartSeq\) chartTearDown = handle;/, 'the newest draw keeps its handle');
  assert.match(page, /else \{ try \{ handle\(\); \} catch \{ \/\* stale draw \*\/ \} \}/, 'a stale one is removed at once');
  assert.match(page, /addEventListener\('dex:teardown'/, 'leaving the page still tears the chart down');
});

test('LP panel: APR shown only from a successful 24h read; approve order said aloud', () => {
  const lp = read('../js/dex/lp.js');
  assert.match(lp, /id="dexLpApr"/, 'the APR line exists in the shell');
  assert.match(lp, /pool24h\(\{ E: ethersLib\(\), provider: provider\(\), pair: row\.pair \}\)/, 'volume read joins the pool load');
  assert.match(lp, /day\.ok\s*\n?\s*\? feeAprBps\(/, 'a failed read hides the line — never a zero not seen');
  assert.match(lp, /t\('dex\.lp\.approveSteps', \{ q: cur\.qSym, t: cur\.tSym \}\)/, 'the confirm sheet spells the approve order (add flow)');
  assert.match(lp, /t\('dex\.lp\.approveNote', \{ q: cur\.qSym, t: cur\.tSym \}\)/, 'the note under the button is named for this pool');
  const tmpl = lpHtml();
  assert.match(tmpl, /id="dexLpApr"><\/div>/, 'APR slot starts empty — filled only after a read');
  assert.match(tmpl, /id="dexLpApproveNote"><\/div>/, 'approve note starts empty — no raw placeholder');
});

test('the pool select carries the address as its value — switching pools actually switches', () => {
  const lp = read('../js/dex/lp.js');
  assert.match(lp, /o\.value = r\.address;/, 'option value = address (label stays the text)');
  assert.match(lp, /if \(sel\.value !== want\) return;/, 'a late read for a pool the user left does not paint over the new one');
});

test('the new keys exist in BOTH languages with matching placeholders', () => {
  const src = read('../js/i18n.js');
  const both = (key) => [...src.matchAll(new RegExp(`'${key}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((m) => m[1]);
  for (const key of ['dex.tp.tfGroup', 'dex.tp.tfThin', 'dex.lp.apr', 'dex.lp.approveNote', 'dex.lp.approveSteps', 'dex.lp.stepsLabel']) {
    assert.equal(both(key).length, 2, `${key} in en + id`);
  }
  const [enTf, idTf] = both('dex.tp.tfThin');
  for (const v of [enTf, idTf]) assert.match(v, /\{\{tf\}\}/, 'tfThin carries the chip label');
  const [enApr, idApr] = both('dex.lp.apr');
  for (const v of [enApr, idApr]) {
    assert.match(v, /\{\{p\}\}.*\{\{v\}\}.*\{\{q\}\}/, 'apr names percentage, volume and symbol');
    assert.doesNotMatch(v, /\{\{q\}\}.*\{\{v\}\}/, 'and the APR qualifier keeps the order p,v,q');
  }
  for (const v of both('dex.lp.approveNote')) assert.match(v, /\{\{q\}\}/);
  for (const v of both('dex.lp.approveSteps')) assert.match(v, /\{\{q\}\}/);
  for (const v of both('dex.lp.approveSteps')) assert.match(v, /\{\{t\}\}/);
  for (const v of both('dex.lp.stepsLabel')) assert.doesNotMatch(v, /\{\{/, 'a bare label has no placeholders');
  for (const v of both('dex.tp.tfGroup')) assert.doesNotMatch(v, /\{\{/);
});
