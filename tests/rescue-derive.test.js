// Bear Tool — rescue-derive.test.js
// The locked wallet used to be a field you retyped. It is derived now, and a
// pasted sponsor key stopped being mandatory — which is the whole reason the
// two helper buttons no longer fail on an empty form.
//
// Two failures this file exists to stop:
//
//  1. Drift. Deploy records one address, execute looks it up by another. The
//     helper is perfectly good and on-chain, yet the user is told to deploy it
//     again — having already paid for the first one. Deriving from ONE
//     function is what makes the two sides agree.
//
//  2. A key that is hex-shaped but not a usable scalar. 0x00…00 and 0xfff…f
//     are perfect 32-byte hex: they pass every regex in the file, and ethers
//     rejects both ("0 < bigint < curve.n"). That throw escaped validation —
//     no toast, no feedback, a button that appears to do nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

// eip7702-tools reads the target key straight out of the DOM. Hand it one
// controllable field and nothing else — every other selector stays null.
const field = { value: '', blur() {} };
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.document.querySelector = sel => (sel === '#rescueTargetKey' ? field : null);
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });

// `const { ethers } = globalThis;` runs at module load — set it first or
// every address reads as invalid and the fixture looks broken.
if (!globalThis.ethers) {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
}

const tools = await import('../js/eip7702-tools.js');
const state = await import('../js/state.js');
const { ethers } = globalThis;

const GOOD = '0x' + '11'.repeat(32);
const ZERO = '0x' + '0'.repeat(64);   // valid hex, not a valid scalar
const ONES = '0x' + 'f'.repeat(64);   // valid hex, not a valid scalar
const UNLOCKED = '0x2222222222222222222222222222222222222222';

test('a usable key resolves to its address', () => {
  assert.equal(tools.addressFromKey(GOOD), new ethers.Wallet(GOOD).address);
});

test('hex-shaped but unusable keys return null instead of throwing', () => {
  for (const bad of [ZERO, ONES]) {
    assert.equal(tools.addressFromKey(bad), null, `${bad.slice(0, 10)} must not throw`);
  }
  assert.equal(tools.addressFromKey('0x' + '11'.repeat(16)), null, 'too short');
  assert.equal(tools.addressFromKey('0xzz'.padEnd(66, '1')), null, 'not hex');
  assert.equal(tools.addressFromKey(GOOD.slice(2)), null, 'missing 0x prefix');
  assert.equal(tools.addressFromKey(''), null, 'empty');
});

test('the locked address is derived, never typed', () => {
  state.set('address', UNLOCKED);

  // No key: the unlocked wallet IS the locked wallet.
  field.value = '';
  assert.deepEqual(tools.deriveTargetAddress(), { address: UNLOCKED });

  // A key wins, so a locked wallet can be targeted from an unlocked session.
  field.value = GOOD;
  assert.deepEqual(tools.deriveTargetAddress(), { address: new ethers.Wallet(GOOD).address });

  // An unusable key is reported. It must never quietly fall back to the
  // unlocked wallet — that would rescue from the wrong account entirely.
  field.value = ZERO;
  assert.deepEqual(tools.deriveTargetAddress(), { error: 'Invalid target private key' });
});

test('with no key and no unlocked wallet it says which one it needs', () => {
  state.set('address', undefined);
  field.value = '';
  assert.deepEqual(tools.deriveTargetAddress(),
    { error: 'Unlock the target wallet or paste its private key' });
});

test('the sponsor is the picked key — never a silent fallback', () => {
  state.set('address', UNLOCKED);
  assert.equal(tools.sponsorAddressOf(GOOD), new ethers.Wallet(GOOD).address);
  assert.equal(tools.sponsorAddressOf(''), null,
    'empty pick falls back to nothing — auto-detect removed (2026-10-06)');
  assert.equal(tools.sponsorAddressOf(ZERO), null, 'unusable key must not throw');
  assert.equal(tools.sponsorAddressOf(ONES), null, 'unusable key must not throw');

  state.set('address', undefined);
  assert.equal(tools.sponsorAddressOf(''), null, 'nothing to sponsor with');
});
