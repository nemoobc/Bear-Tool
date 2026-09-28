// ═══════════════════════════════════════════���═══════════════════════════════
// Bear Tool — tests/max-amount-regression.test.js
// Locks the two MAX defects found by audit. Both are silent-or-fatal in a
// money context, which is exactly why they survived a green suite: the old
// tests only ever passed hand-written decimal integers in.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toBig, formatDown, computeMax, maxSpendable } from '../js/max-amount.js';
import { resolveMax } from '../js/max-ui.js';

const ETH = 10n ** 18n;

// ── defect 1: toBig silently answered 0 for real number formats ──────────
// BigInt() rejects exponent and decimal strings outright, and the old
// implementation funnelled every rejection into the `fb = 0n` fallback. A
// balance arriving as "1e18" therefore read as an EMPTY WALLET, and MAX wrote
// 0 into the field with no error anywhere. Silent, and wrong.
test('toBig: exponent notation is parsed, not swallowed as zero', () => {
  assert.equal(toBig('1e18'), ETH, '"1e18" must be 10^18, never 0');
  assert.equal(toBig('1E18'), ETH);
  assert.equal(toBig('2.5E3'), 2500n);
  assert.equal(toBig('-1e3'), -1000n);
  assert.equal(toBig('1.5e2'), 150n);
});

test('toBig: decimal strings truncate toward zero and never round up', () => {
  // Rule 2 of max-amount.js: rounding up by one wei reintroduces the exact
  // failure MAX exists to remove.
  assert.equal(toBig('1.5'), 1n);
  assert.equal(toBig('1.9'), 1n);
  assert.equal(toBig('-1.5'), -1n);
  assert.equal(toBig('0.000000000000000001'), 0n);
});

test('toBig: hex survives — raw JSON-RPC speaks "0x", and dropping it would be the same silent-zero bug', () => {
  assert.equal(toBig('0x10'), 16n);
  assert.equal(toBig('0xff'), 255n);
  assert.equal(toBig('0x'), 0n);
});

test('toBig: genuinely unparseable input still falls back instead of throwing', () => {
  for (const junk of ['1_000', 'abc', '', '   ', '12abc34']) {
    assert.equal(toBig(junk), 0n, `${JSON.stringify(junk)} should be 0n`);
  }
  assert.equal(toBig('nope', 7n), 7n, 'an explicit fallback is still honoured');
});

// ── defect 2: formatDown THREW on a bad `decimals`, killing the MAX button ─
// `10n ** -1n` and `BigInt(6.5)` both throw. `decimals` is not trustworthy: a
// custom network's value comes straight out of localStorage and
// addCustomNetwork() (network.js) validates nothing at all. An uncaught throw in
// the click handler left the form dead — no amount, no explanation, no button.
test('formatDown: out-of-range decimals fail loudly with a readable reason', () => {
  for (const bad of [-1, 2.5, NaN, 300, Infinity, 'x']) {
    assert.throws(
      () => formatDown(ETH, bad),
      /decimals must be an integer/,
      `decimals=${String(bad)} must throw a RangeError that names the problem`,
    );
  }
});

test('formatDown: valid decimals still render, including the boundaries', () => {
  assert.equal(formatDown(ETH, 18), '1');
  assert.equal(formatDown(ETH, 6), '1000000000000');
  assert.equal(formatDown(ETH, 0), '1000000000000000000');   // no fraction at all
  assert.equal(formatDown(ETH, 8), '10000000000');   // 1e18 wei at 8dp = 1e10
  assert.equal(formatDown(0n, 18), '0');
  assert.equal(formatDown(1n, 18), '0');                    // below dp → truncates to 0
});

test('formatDown: dp is clamped rather than throwing', () => {
  assert.equal(formatDown(ETH, 6, 99), '1000000000000');   // dp > decimals → capped at 6
  assert.equal(formatDown(ETH, 18, 2.9), '1');              // fractional dp → truncated
  assert.equal(formatDown(ETH, 18, 0), '1');                // no decimals wanted
  assert.equal(formatDown(ETH, 6, 3), '1000000000000');     // dp < decimals is a real truncation
  assert.equal(formatDown(1234567n, 6, 3), '1.234');        // truncates, never rounds to 1.235
});

// ── the user-visible consequence: MAX must never write a wrong 0 ──────────
test('MAX with a 1e18-formatted balance fills the field, it does not empty it', () => {
  const balance = '1e18';                       // as an RPC might hand it over
  const spendable = maxSpendable({ balance, gasWei: 0n, paysGas: false });
  assert.equal(spendable, ETH, 'a 1e18 balance must not read as 0');
  const r = computeMax({ balance, decimals: 18, gasWei: 0n, paysGas: false, dp: 6 });
  assert.ok(r.ok, `computeMax should succeed, got: ${r.message}`);
  assert.equal(r.amount, '1', 'MAX must write 1, not 0');
});

// ── 0% must stay 0%: `Number(pct) || 100` treated 0 as "no value given" ───
test('a 0% share writes nothing — it must not fall through to 100%', async () => {
  const tok = { balance: '1000000000000000000', decimals: 18, address: null, symbol: 'T' };
  const zero = await resolveMax({ token: tok, provider: null, from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', pct: 0 });
  assert.equal(zero.ok, true, 'a 0% share is valid, just empty');
  assert.equal(zero.amount, '0', `0% must write 0, not the whole balance (${zero.amount})`);
  const full = await resolveMax({ token: tok, provider: null, from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', pct: 100 });
  assert.equal(full.amount, '1', '100% is the whole balance here — the two must differ');
});

test('a fractional percentage is clamped, never thrown', async () => {
  const res = await resolveMax({
    token: { balance: '1000000000000000000', decimals: 18, address: null, symbol: 'T' },
    provider: null, from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', pct: 33.333,
  });
  assert.equal(res.ok, true, 'a fractional pct must not throw out of the handler');
  assert.ok(res.amount !== undefined);
});

// ── and a bad token must not leave the form dead ──────────────────────────
test('resolveMax: invalid token decimals return a "not available" result, not a thrown handler', async () => {
  const res = await resolveMax({
    token: { balance: '1000000000000000000', decimals: 2.5, address: null, symbol: 'BAD' },
    provider: null,
    from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    pct: 100,
  });
  assert.equal(res.ok, false, 'a bad decimals must not report success');
  assert.match(res.message, /decimals are invalid/i,
    'the reason must reach the user so the form stays usable');
  assert.equal(res.amount, '', 'no amount is written when the token is unusable');
});
