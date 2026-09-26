// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/max-amount.test.js
// The MAX button. Written as the failure it replaces: an amount equal to the
// whole balance, on a chain where that balance is also the gas.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  maxSpendable, formatDown, computeMax, checkSpendable, gasCost, gasBuffer,
  defaultGasLimit, NATIVE_TRANSFER_GAS,
} from '../js/max-amount.js';

const ETH = 10n ** 18n;
const gwei = (n) => BigInt(n) * 10n ** 9n;

// ── the original bug, as a test ──────────────────────────────────────────
test('MAX on the gas token leaves room for the fee', () => {
  // 0.05 ETH balance, 30 gwei, 21000 gas → 0.00063 ETH of fee.
  const bal = ETH / 20n;
  const gas = gasCost({ gasLimit: NATIVE_TRANSFER_GAS, gasPriceWei: gwei(30) });
  const m = maxSpendable({ balance: bal, gasWei: gas, paysGas: true });
  assert.ok(m < bal, 'must be less than the balance, or the tx cannot pay itself');
  assert.equal(bal - m >= gas, true, 'the fee must be covered by what is left out');
  assert.equal(m > 0n, true);
});

test('MAX on a non-gas token is the full balance', () => {
  // 100 USDC being swapped, gas paid in ETH: nothing to subtract.
  const bal = 100n * 10n ** 6n;
  const m = maxSpendable({ balance: bal, gasWei: gwei(30) * 21000n, paysGas: false });
  assert.equal(m, bal);
});

test('MAX never returns a negative amount', () => {
  assert.equal(maxSpendable({ balance: 0n, gasWei: gwei(30), paysGas: true }), 0n);
  assert.equal(maxSpendable({ balance: 1n, gasWei: ETH, paysGas: true }), 0n);
  assert.equal(maxSpendable({ balance: -5n, gasWei: 0n, paysGas: true }), 0n);
});

test('MAX refuses a junk balance instead of throwing', () => {
  assert.equal(maxSpendable({ balance: 'not-a-number', gasWei: 1n, paysGas: true }), 0n);
  assert.equal(maxSpendable({ gasWei: 'x', balance: 10n, paysGas: true }), 10n);
});

// ── rounding: the subtle one ────────────────────────────────────────────
test('formatDown truncates and never rounds up', () => {
  // 1.9999999 ETH shown at 6 dp must be 1.999999, or the typed value exceeds
  // the real maximum and the transaction fails again.
  const v = 1999999900000000000n;
  assert.equal(formatDown(v, 18, 6), '1.999999');
  assert.ok(formatDown(v, 18, 6) !== '2');
});

test('formatDown strips trailing zeros and handles zero', () => {
  assert.equal(formatDown(1000000000000000000n, 18, 6), '1');
  assert.equal(formatDown(1500000000000000000n, 18, 6), '1.5');
  assert.equal(formatDown(0n, 18, 6), '0');
  assert.equal(formatDown(0n, 18, 6) === '0', true);
});

test('formatDown respects the token decimals, including 6 and 0', () => {
  assert.equal(formatDown(1234567n, 6, 6), '1.234567');
  assert.equal(formatDown(42n, 0, 6), '42');
  assert.equal(formatDown(1500n, 3, 6), '1.5');
});

test('formatDown caps the decimals at what the token has', () => {
  // Asking for 6 dp on a 0-decimal token must not invent digits.
  assert.equal(formatDown(7n, 0, 6), '7');
});

// ── the cushion ─────────────────────────────────────────────────────────
test('gasBuffer scales with the fee but never vanishes', () => {
  assert.equal(gasBuffer(0n), 0n);
  assert.ok(gasBuffer(10n ** 15n) > 10n ** 13n, '2% of a large fee');
  assert.equal(gasBuffer(1n), 1000n, 'a tiny L2 fee still gets an absolute floor');
});

test('keepBuffer:false leaves the fee and nothing more', () => {
  const bal = 10n * ETH;
  const gas = 10n ** 15n;
  assert.equal(maxSpendable({ balance: bal, gasWei: gas, paysGas: true, keepBuffer: false }), bal - gas);
});

// ── the message the user actually sees ───────────────────────────────────
test('computeMax: a normal balance produces a usable amount and a reason', () => {
  const r = computeMax({
    balance: ETH / 10n, decimals: 18,
    gasWei: gasCost({ gasLimit: 21000n, gasPriceWei: gwei(30) }),
    paysGas: true, symbol: 'ETH',
  });
  assert.equal(r.ok, true);
  assert.match(r.amount, /^\d+(\.\d+)?$/);
  assert.ok(Number(r.amount) < 0.1, 'must be under the 0.1 balance');
  assert.match(r.message, /fee/i);
});

test('computeMax: a balance that cannot pay the fee explains both numbers', () => {
  // The "$1 balance, gas eats it" case that used to surface as a node error.
  const r = computeMax({ balance: 10n ** 15n, decimals: 18, gasWei: 5n * 10n ** 15n, paysGas: true, symbol: 'ETH' });
  assert.equal(r.ok, false);
  assert.equal(r.amount, '', 'no amount may be written when nothing can be sent');
  assert.equal(r.shortfallWei, 4n * 10n ** 15n);
  assert.match(r.message, /not enough/i);
  assert.match(r.message, /smaller amount|pick a token/i, 'it must say what to do next');
});

test('computeMax: a non-gas token reports the full balance and says why', () => {
  const r = computeMax({ balance: 25000000n, decimals: 6, gasWei: gwei(30) * 21000n, paysGas: false, symbol: 'USDC' });
  assert.equal(r.ok, true);
  assert.equal(r.amount, '25');
  assert.match(r.message, /another token/i);
});

test('computeMax: zero balance is reported, not silently zero-filled', () => {
  const r = computeMax({ balance: 0n, decimals: 18, gasWei: 0n, paysGas: false });
  assert.equal(r.ok, false);
  assert.equal(r.amount, '');
});

// ── the check that catches a stale balance ──────────────────────────────
test('checkSpendable catches amount+gas exceeding the balance', () => {
  const bal = ETH / 10n;
  const gas = 10n ** 15n;
  const bad = checkSpendable({ amountWei: bal, balance: bal, gasWei: gas, paysGas: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.shortfall, gas);
  assert.match(bad.message, /short by/i);
});

test('checkSpendable passes when the fee fits', () => {
  const r = checkSpendable({ amountWei: ETH / 20n, balance: ETH / 10n, gasWei: 10n ** 15n, paysGas: true });
  assert.equal(r.ok, true);
  assert.equal(r.shortfall, 0n);
});

test('checkSpendable ignores the fee for a non-gas token', () => {
  const bal = 100n * 10n ** 6n;
  assert.equal(checkSpendable({ amountWei: bal, balance: bal, gasWei: 10n ** 18n, paysGas: false }).ok, true);
});

// ── gas limit defaults ──────────────────────────────────────────────────
test('defaultGasLimit distinguishes a native transfer from a token transfer', () => {
  assert.equal(defaultGasLimit(true), 21000n);
  assert.equal(defaultGasLimit(false), 65000n);
});

test('gasCost multiplies and survives junk', () => {
  assert.equal(gasCost({ gasLimit: 21000n, gasPriceWei: gwei(30) }), 21000n * gwei(30));
  assert.equal(gasCost({ gasLimit: 'x', gasPriceWei: 1n }), 0n);
  assert.equal(gasCost({}), 0n);
});
