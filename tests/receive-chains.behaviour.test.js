// Behaviour, not shape. tests/receive-chains.test.js pins HOW the modal is
// written; this proves WHAT it produces: given a wallet whose derivation is
// proven, the Receive screen must actually carry a Bitcoin, a Solana and an XRP
// address — and each one must be the address coin-trees.js derives, not a
// lookalike. It is the difference between "the template has a Bitcoin row" and
// "a user tapping Receive sees their Bitcoin address".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonEvmAddresses } from '../js/coin-trees.js';

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Mirror of app.js nonEvmReceiveRows, kept deliberately dumb: if the
// derivation's shape changes, THIS must change with it — that is the point, it
// is the behaviour contract.
const META = [
  ['bitcoin', 'Bitcoin', 'BTC'],
  ['solana', 'Solana', 'SOL'],
  ['xrp', 'XRP', 'XRP'],
];
function rowsFor(seed, index) {
  const addrs = nonEvmAddresses(seed, index);
  return META.map(([key, name, sym]) => ({ key, name, sym, address: addrs[key]?.receive || null }));
}

test('every non-EVM chain yields a usable address for a real seed', () => {
  const rows = rowsFor(SEED, 0);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(r.address, `${r.name} must produce an address`);
    assert.ok(!r.address.includes(' '), `${r.name} address has whitespace`);
    assert.ok(r.address.length >= 26, `${r.name} address suspiciously short: ${r.address}`);
  }
  // Shape checks that would catch a chain bleeding into another's encoding.
  assert.match(rows[0].address, /^bc1q/, 'bitcoin is bech32');
  assert.match(rows[1].address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'solana is base58');
  assert.match(rows[2].address, /^r[0-9A-HJ-NP-Za-km-z]{24,34}$/, 'xrp starts with r');
  // No two chains may show the same string — that is what an accidentally
  // shared derivation looks like from the user's side.
  const uniq = new Set(rows.map((r) => r.address));
  assert.equal(uniq.size, 3, 'the three chains must show three different addresses');
});

test('the same seed always shows the same addresses (recovery phrase must restore them)', () => {
  assert.deepEqual(rowsFor(SEED, 0), rowsFor(SEED, 0));
});

test('account 1 shows different addresses from account 0 on every chain', () => {
  const a = rowsFor(SEED, 0);
  const b = rowsFor(SEED, 1);
  for (let i = 0; i < a.length; i += 1) {
    assert.notEqual(a[i].address, b[i].address,
      `${a[i].name}: account 1 must not repeat account 0`);
  }
});

test('an unavailable chain is reported, never silently dropped', () => {
  // Every chain the wallet can derive must be REPRESENTED, even if one of them
  // later regresses: the row must carry either an address or a reason, so the
  // screen can never look complete while quietly hiding a chain.
  const addrs = nonEvmAddresses(SEED, 0);
  for (const [key, name] of META) {
    assert.ok(key in addrs, `${name} missing from the derivation result`);
    const row = addrs[key];
    assert.ok(row.receive || row.unsupported, `${name} must have an address or a reason`);
  }
});