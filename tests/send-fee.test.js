// Bear Tool — send-fee.test.js
// The speed buttons, at the arithmetic. send.js used to compute 90%/120% and
// then let `feeData.maxFeePerGas || …` win — slow and fast were labels on the
// confirmation modal while a normal fee went out. These tests pin the three
// shapes of chain (1559, legacy-only, nothing) against every speed, and pin
// "normal = the values the old code sent" so the default path cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeeParams, speedPercent } from '../js/fee-params.js';

const G = 1_000_000_000n; // 1 gwei

const fee1559 = {
  gasPrice: 100n * G,
  maxFeePerGas: 200n * G,
  maxPriorityFeePerGas: 2n * G,
};

test('speed percent: slow 90, fast 120, anything else 100', () => {
  assert.equal(speedPercent('slow'), 90n);
  assert.equal(speedPercent('fast'), 120n);
  assert.equal(speedPercent('normal'), 100n);
  assert.equal(speedPercent(undefined), 100n);
  assert.equal(speedPercent('turboboost'), 100n);
});

test('1559 normal is byte-identical to what the old code sent', () => {
  const p = buildFeeParams(fee1559, 'normal');
  // Old code: `feeData.maxFeePerGas || gasPrice` / `feeData.maxPriorityFeePerGas || gasPrice`
  assert.equal(p.maxFeePerGas, fee1559.maxFeePerGas);
  assert.equal(p.maxPriorityFeePerGas, fee1559.maxPriorityFeePerGas);
  assert.equal(p.baseFee, fee1559.gasPrice);
});

test('1559 slow scales the cap AND the tip together', () => {
  const p = buildFeeParams(fee1559, 'slow');
  assert.equal(p.maxFeePerGas, 200n * G * 90n / 100n);
  assert.equal(p.maxPriorityFeePerGas, 2n * G * 90n / 100n);
  assert.ok(p.maxPriorityFeePerGas <= p.maxFeePerGas, 'tip must never exceed the cap');
});

test('1559 fast scales the cap AND the tip together', () => {
  const p = buildFeeParams(fee1559, 'fast');
  assert.equal(p.maxFeePerGas, 200n * G * 120n / 100n);
  assert.equal(p.maxPriorityFeePerGas, 2n * G * 120n / 100n);
  assert.ok(p.maxPriorityFeePerGas <= p.maxFeePerGas, 'tip must never exceed the cap');
});

test('legacy chain (no maxFee): speed scales gasPrice into both fields', () => {
  const legacy = { gasPrice: 100n * G, maxFeePerGas: null, maxPriorityFeePerGas: null };
  const slow = buildFeeParams(legacy, 'slow');
  assert.equal(slow.maxFeePerGas, 90n * G);
  assert.equal(slow.maxPriorityFeePerGas, 90n * G);
  const fast = buildFeeParams(legacy, 'fast');
  assert.equal(fast.maxFeePerGas, 120n * G);
  assert.equal(fast.maxPriorityFeePerGas, 120n * G);
  const normal = buildFeeParams(legacy, 'normal');
  assert.equal(normal.maxFeePerGas, 100n * G);
  assert.equal(normal.maxPriorityFeePerGas, 100n * G);
});

test('missing tip falls back to the SCALED base — slow can mint no self-contradiction', () => {
  // gasPrice present, tip unread: the fallback must move with the speed, and
  // the cap must move with it too — otherwise slow sends cap 200 / tip 90-ish
  // while fast sends cap 200 / tip 120 (the old bug in miniature).
  const noTip = { gasPrice: 100n * G, maxFeePerGas: 200n * G, maxPriorityFeePerGas: null };
  const p = buildFeeParams(noTip, 'fast');
  assert.equal(p.maxFeePerGas, 240n * G);
  assert.equal(p.maxPriorityFeePerGas, 120n * G);
  const s = buildFeeParams(noTip, 'slow');
  assert.equal(s.maxFeePerGas, 180n * G);
  assert.equal(s.maxPriorityFeePerGas, 90n * G);
});

test('all-null fee data → undefined fields, never 0n (ethers estimates)', () => {
  const dead = { gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null };
  for (const speed of ['slow', 'normal', 'fast']) {
    const p = buildFeeParams(dead, speed);
    assert.equal(p.maxFeePerGas, undefined, `maxFee must be undefined at ${speed}`);
    assert.equal(p.maxPriorityFeePerGas, undefined, `tip must be undefined at ${speed}`);
    assert.equal(p.baseFee, 0n);
  }
  // 0n is the other way a node says "unknown" — falsy, same verdict.
  const zero = { gasPrice: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n };
  assert.equal(buildFeeParams(zero, 'fast').maxFeePerGas, undefined);
});

test('null/absent feeData behaves like all-null instead of throwing', () => {
  assert.equal(buildFeeParams(null, 'fast').maxFeePerGas, undefined);
  assert.equal(buildFeeParams(undefined, 'slow').maxPriorityFeePerGas, undefined);
  assert.equal(buildFeeParams({}, 'normal').maxFeePerGas, undefined);
});

test('gasPrice only via maxFee (L2 that reports no gasPrice)', () => {
  const l2 = { gasPrice: null, maxFeePerGas: 50n * G, maxPriorityFeePerGas: null };
  const p = buildFeeParams(l2, 'fast');
  assert.equal(p.maxFeePerGas, 60n * G);
  assert.equal(p.maxPriorityFeePerGas, 60n * G); // scaled base = scaled maxFee
  assert.equal(p.baseFee, 50n * G);
});
