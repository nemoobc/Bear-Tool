// Bear Tool — ui-format.test.js
// Display formatting for balances and timestamps.
//
// fmtAmount had no test at all: the only thing named "fmtAmount" in tests/ was a
// COPY of the function pasted into onchain-test.mjs, which tests a copy and would
// keep passing if the real one were deleted. So nine render sites — the token
// list, the send dropdown, the token modal, the allowance rows — were formatting
// balances through unverified code.
//
// And the unverified code reported failure as a number:
//
//     decimals 255  → formatUnits throws  →  "0.00"
//     wei = null                            →  "0.00"
//     wei = undefined                       →  "0.00"
//     decimals 60    → 1e-54                →  "0"
//
// A user holding a real balance is told they hold nothing, with nothing on screen
// to say the number could not be read. That is invented data. The codebase
// already decided this input is attacker-shaped — max-amount.js says a custom
// network's `decimals` "can arrive as 2.5, -1 or NaN straight off the localStorage
// record" and formatDown throws a RangeError for it. Two failure modes for one
// unvalidated input, and the silent one is the one nine views use.
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });
if (!globalThis.ethers) {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
}

const { fmtAmount, fmtTime } = await import('../js/ui.js');

const isNumberish = (s) => /^[\d.,\s-]+$/.test(String(s).trim()) && /\d/.test(String(s));

test('a real balance still formats as a number', () => {
  assert.equal(fmtAmount(1000000000000000000n, 18), '1');
  assert.equal(fmtAmount(0n, 18), '0.00', 'a genuine zero must keep looking like a zero');
  assert.equal(fmtAmount(12345n, 0), '12,345');
  assert.equal(fmtAmount(1500000n, 6), '1.5');
});

test('an unreadable balance is reported as unreadable, never as a number', () => {
  // Each of these throws inside ethers.formatUnits, or produces a value that
  // formats to nothing. None of them means "the user holds zero".
  for (const [label, wei, decimals] of [
    ['decimals beyond the maximum', 1000n, 255],
    ['decimals far beyond 18', 1000000n, 60],
    ['decimals negative', 1000n, -3],
    ['decimals fractional', 1000n, 2.5],
    ['balance null', null, 18],
    ['balance undefined', undefined, 18],
    ['balance not a number', 'abc', 18],
  ]) {
    const out = fmtAmount(wei, decimals);
    assert.ok(!isNumberish(out),
      `${label} rendered as the number ${JSON.stringify(out)} — the user is told they hold nothing ` +
      'when the truth is that the balance could not be read');
    assert.ok(String(out).length > 0, `${label} must say something`);
  }
});

test('a balance too small to show at any precision is not rounded to zero', () => {
  // 1 wei with 60 decimals is a real, non-zero balance. Rounding it to "0" claims
  // the account is empty, which is the same lie as showing 0.00 for a parse error.
  const tiny = 1n;
  const out = fmtAmount(tiny, 60);
  assert.ok(!isNumberish(out) || /[1-9]/.test(String(out)),
    `a non-zero balance of 1 wei at 60 decimals rendered as ${JSON.stringify(out)}`);
});

test('fmtTime says so when there is no date, instead of printing Invalid Date', () => {
  const out = fmtTime(undefined);
  assert.notEqual(out, 'Invalid Date', '"Invalid Date" is the browser error leaking into the activity list');
  assert.ok(String(out).length > 0);
});

test('fmtTime does not throw on a BigInt timestamp', () => {
  // Every other helper here degrades; this one threw "Cannot convert a BigInt
  // value to a number", and a throw inside a render loop takes the view with it.
  // Wei-based counters and block timestamps are both bigints in this codebase's
  // neighbourhood, so the guard is not hypothetical.
  let out = null, threw = null;
  try { out = fmtTime(1750000000000n); } catch (e) { threw = e; }
  assert.equal(threw, null, `fmtTime threw on a bigint: ${threw && threw.message}`);
  assert.ok(out && String(out).length > 0);
});

test('fmtTime still formats a real millisecond timestamp', () => {
  const out = fmtTime(1750000000000);
  assert.match(String(out), /2025/, 'a valid timestamp must still render');
});

test('fmtTimeShort: hari ini = HH:MM; lama = tanggal pendek + HH:MM (bukan toLocaleString)', async () => {
  const { fmtTimeShort, fmtTime } = await import(new URL('../js/ui.js', import.meta.url).href);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5, 0);
  assert.equal(fmtTimeShort(today.getTime()), '09:05', 'hari ini hanya jam');
  const older = new Date(2026, 0, 3, 23, 59, 0);
  assert.match(fmtTimeShort(older.getTime()), /^\d{1,2} [A-Za-z]{3}\.? 23:59$/,
    'tahun sama: tanggal pendek + jam — dapat: ' + fmtTimeShort(older.getTime()));
  assert.notEqual(fmtTimeShort(today.getTime()), fmtTime(today.getTime()),
    'pendek, bukan toLocaleString panjang');
  assert.equal(typeof fmtTimeShort(null), 'string', 'null → string, tidak melempar');
  assert.equal(typeof fmtTimeShort(1790000000000n), 'string', 'bigint tidak melempar');
});
