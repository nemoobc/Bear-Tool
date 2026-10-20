// Bear Tool — rescue-fee.test.js
//
// The rescue fee sheet shows a number. This suite proves the number is
// either a real measurement or a labelled bound — never a plausible-looking
// lie.
//
// The lie exists and was measured: a node that skips the delegation tuple
// (wrong nonce) answers 46,584 gas for a sweep whose real transaction
// costs 79,859; a node that drops the authorization list entirely answers
// 22,460. Both look like prices. The module therefore refuses an estimate
// that does not carry the delegation's work, and the sheet falls back to a
// documented bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SWEEP_GAS_BOUND, SWEEP_GAS_PER_ERC721_ID, SWEEP_GAS_FLOOR, SWEEP_PLAIN_FLOOR,
  SWEEP_DELEGATION_MIN_EXTRA,
  boundSweepGas, feeWeiFromGas, isPlausibleSweepGas, authNonceFor,
  measurePlainBaseline, measureSweepGas,
} from '../js/rescue-fee.js';

test('the bound covers the sweep and grows with every ERC-721 id', () => {
  assert.equal(boundSweepGas({ type: 'erc20' }), SWEEP_GAS_BOUND);
  assert.equal(boundSweepGas({ type: 'erc721', idCount: 0 }), SWEEP_GAS_BOUND);
  assert.equal(boundSweepGas({ type: 'erc721', idCount: 3 }),
    SWEEP_GAS_BOUND + SWEEP_GAS_PER_ERC721_ID * 3n);
  // A garbage count must not produce a NaN-shaped bound.
  assert.equal(boundSweepGas({ type: 'erc721', idCount: 'x' }), SWEEP_GAS_BOUND);
});

test('a fee of zero is a missing number, not a free transaction', () => {
  assert.equal(feeWeiFromGas(63610n, 10n ** 9n), 63610n * 10n ** 9n);
  assert.equal(feeWeiFromGas(63610n, 0n), null);
  assert.equal(feeWeiFromGas(0n, 10n ** 9n), null);
  assert.equal(feeWeiFromGas(null, 10n ** 9n), null);
  assert.equal(feeWeiFromGas(63610n, null), null);
});

test('the floors sit between the measured lies and the measured truth', () => {
  // The measured numbers (anvil, prague):
  //   22,460 — a call into an account with no code (the node priced nothing)
  //   46,584 — a type-4 whose tuple was SKIPPED (caught by the margin rule
  //            below, not by a floor: the tuple's overhead is counted either way)
  //   32,758 — the honest plain estimate into an already-delegated target
  //   57,758 — the honest type-4 estimate of a one-NFT sweep
  assert.ok(!isPlausibleSweepGas(22460n), 'the no-code price is not a price');
  assert.ok(!isPlausibleSweepGas(22460n, SWEEP_PLAIN_FLOOR), 'the no-code price is not a price');
  assert.ok(isPlausibleSweepGas(37487n, SWEEP_PLAIN_FLOOR), 'the honest plain estimate passes');
  assert.ok(isPlausibleSweepGas(79859n), 'the honest type-4 estimate passes');
  assert.ok(!isPlausibleSweepGas(null));
  assert.ok(!isPlausibleSweepGas('nope'));

  // The floors themselves must sit in the gap the measurements leave.
  assert.ok(SWEEP_PLAIN_FLOOR > 22460n, 'the plain floor must be above the no-code price');
  assert.ok(SWEEP_PLAIN_FLOOR < 32758n, 'the plain floor must be below the cheapest honest plain estimate');
  assert.ok(SWEEP_GAS_FLOOR > 22460n, 'the type-4 floor must be above the no-code price');
  assert.ok(SWEEP_GAS_FLOOR < 57758n, 'the type-4 floor must be below the cheapest honest type-4 estimate');
});

test('the delegation tuple carries the authority nonce — and one more when it is the sender', () => {
  assert.equal(authNonceFor({ targetNonce: 7, sponsorAddress: '0xAA', targetAddress: '0xBB' }), 7);
  assert.equal(authNonceFor({ targetNonce: 7, sponsorAddress: '0xaa', targetAddress: '0xAA' }), 8,
    'a self-sponsor already consumed the nonce, so the tuple needs the next one');
});

test('the plain baseline is measured without any plausibility judgement', async () => {
  let seen = null;
  const provider = { estimateGas: async (tx) => { seen = tx; return 22460n; } };
  const gas = await measurePlainBaseline({ provider, from: '0x1', to: '0x2', data: '0xabcd' });
  assert.equal(gas, 22460n);
  assert.deepEqual(seen, { from: '0x1', to: '0x2', data: '0xabcd' },
    'the baseline is a plain call — no authorization, no type');
});

test('a plain estimate of an already-delegated target is taken as the price', async () => {
  const provider = { estimateGas: async () => 37487n };
  const m = await measureSweepGas({ provider, from: '0x1', to: '0x2', data: '0xabcd' });
  assert.ok(m);
  assert.equal(m.gas, 37487n);
  assert.equal(m.kind, 'plain');
});

test('a plain estimate at the no-code price is refused, not shown', async () => {
  const provider = { estimateGas: async () => 22460n };
  assert.equal(await measureSweepGas({ provider, from: '0x1', to: '0x2', data: '0xabcd' }), null,
    'a node that did not run the helper code priced nothing');
});

test('the delegated estimate is taken only when the delegation was priced', async () => {
  const auth = { address: '0x9', nonce: 0, r: '0x1', s: '0x2', v: 27 };
  let seen = null;
  const provider = { estimateGas: async (tx) => { seen = tx; return 79859n; } };
  const m = await measureSweepGas({
    provider, from: '0x1', to: '0x2', data: '0xabcd', authorization: auth, plainGas: 22460n,
  });
  assert.ok(m);
  assert.equal(m.gas, 79859n);
  assert.equal(m.kind, 'delegated');
  assert.equal(seen.type, 4, 'the estimate must carry the type-4 shape');
  assert.deepEqual(seen.authorizationList, [auth], 'the REAL tuple has to be in the request');
});

test('a skipped tuple (the estimate without the delegation work) is refused', async () => {
  const auth = { address: '0x9', nonce: 0, r: '0x1', s: '0x2', v: 27 };
  // 46,584 measured: the node skipped the tuple and priced the accounting
  // overhead only. Over the plain baseline by 24,124 — less than the
  // delegation's work, so the number is not the price of the sweep.
  const provider = { estimateGas: async () => 46584n };
  const m = await measureSweepGas({
    provider, from: '0x1', to: '0x2', data: '0xabcd', authorization: auth, plainGas: 22460n,
  });
  assert.equal(m, null, 'a plausible-looking number that is not the price must not be shown');
});

test('a delegated estimate without a baseline cannot be judged, so it is refused', async () => {
  const auth = { address: '0x9', nonce: 0, r: '0x1', s: '0x2', v: 27 };
  const provider = { estimateGas: async () => 79859n };
  assert.equal(await measureSweepGas({
    provider, from: '0x1', to: '0x2', data: '0xabcd', authorization: auth,
  }), null);
});

test('the revoke shape asks for no margin — it does no work', async () => {
  // Measured: a revoke's correct estimate and its skipped-tuple estimate are
  // the same number (46,001), so the margin rule cannot apply to it.
  const auth = { address: '0x0', nonce: 0, r: '0x1', s: '0x2', v: 27 };
  const provider = { estimateGas: async () => 46001n };
  const m = await measureSweepGas({
    provider, from: '0x1', to: '0x2', data: '0x', authorization: auth, plainGas: 21000n, minExtra: 0n,
  });
  assert.ok(m);
  assert.equal(m.gas, 46001n);
});

test('a node that refuses or never answers yields no number at all', async () => {
  const boom = { estimateGas: async () => { throw new Error('node said no'); } };
  assert.equal(await measureSweepGas({ provider: boom, from: '0x1', to: '0x2', data: '0x' }), null);
  const silent = { estimateGas: () => new Promise(() => {}) };
  assert.equal(await measureSweepGas({ provider: silent, from: '0x1', to: '0x2', data: '0x', timeoutMs: 20 }), null,
    'a dead node must not hold the sheet hostage');
  assert.equal(await measureSweepGas({ provider: null, from: '0x1', to: '0x2', data: '0x' }), null);
});

test('the margin the module demands is the one the measurements support', () => {
  // Applied delegation: 57,399 (ERC-20) and 34,628 (one NFT) over the
  // baseline. Skipped tuple: 24,124 and 23,722. The rule sits between.
  assert.ok(24000n < SWEEP_DELEGATION_MIN_EXTRA);
  assert.ok(SWEEP_DELEGATION_MIN_EXTRA < 34000n);
});
