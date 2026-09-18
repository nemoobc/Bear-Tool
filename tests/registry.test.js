// Bear Tool — registry tests (deterministic, no network)
// Exercises the deployed-contract registry: save/load roundtrip,
// checksum validation, dedupe, find/list/remove, corrupt-data safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

// ── localStorage stub ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const registry = await import('../js/registry.js');

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

test('registry: save + load roundtrip keeps address, chainId, extra', () => {
  store.clear();
  registry.saveDeployed('rescue', A, { chainId: 11155111, safe: B, target: C });
  const reg = registry.loadRegistry();
  assert.equal(reg.rescue.length, 1);
  assert.equal(reg.rescue[0].address.toLowerCase(), A.toLowerCase());
  assert.equal(reg.rescue[0].chainId, 11155111);
  assert.equal(reg.rescue[0].safe.toLowerCase(), B.toLowerCase());
  assert.equal(reg.rescue[0].target.toLowerCase(), C.toLowerCase());
  assert.ok(reg.rescue[0].ts > 0, 'timestamp recorded');
});

test('registry: checksummed address is normalized on save', () => {
  store.clear();
  const lower = '0x1111111111111111111111111111111111111111';
  registry.saveDeployed('batch', lower, { chainId: 1 });
  const reg = registry.loadRegistry();
  assert.equal(reg.batch[0].address, ethers.getAddress(lower), 'stored as checksummed');
});

test('registry: invalid address rejected', () => {
  store.clear();
  assert.throws(() => registry.saveDeployed('batch', '0x123', { chainId: 1 }), /Invalid contract address/);
  assert.throws(() => registry.saveDeployed('batch', 'not-an-address', { chainId: 1 }), /Invalid contract address/);
});

test('registry: invalid chainId rejected', () => {
  store.clear();
  assert.throws(() => registry.saveDeployed('batch', A, { chainId: 0 }), /Invalid chainId/);
  assert.throws(() => registry.saveDeployed('batch', A, { chainId: -1 }), /Invalid chainId/);
  assert.throws(() => registry.saveDeployed('batch', A, {}), /Invalid chainId/);
});

test('registry: unknown type rejected', () => {
  store.clear();
  assert.throws(() => registry.saveDeployed('nope', A, { chainId: 1 }), /Unknown registry type/);
});

test('registry: dedupe on (type, address, chainId) replaces old entry', () => {
  store.clear();
  registry.saveDeployed('rescue', A, { chainId: 1, safe: B });
  registry.saveDeployed('rescue', A, { chainId: 1, safe: C });
  const reg = registry.loadRegistry();
  assert.equal(reg.rescue.length, 1, 'same address+chain replaced');
  assert.equal(reg.rescue[0].safe.toLowerCase(), C.toLowerCase(), 'newest extra wins');
});

test('registry: same address on different chains are separate entries', () => {
  store.clear();
  registry.saveDeployed('rescue', A, { chainId: 1 });
  registry.saveDeployed('rescue', A, { chainId: 137 });
  assert.equal(registry.loadRegistry().rescue.length, 2);
});

test('registry: findDeployed filters by chainId + predicate', () => {
  store.clear();
  registry.saveDeployed('rescue', A, { chainId: 1, safe: B });
  registry.saveDeployed('rescue', C, { chainId: 137, safe: B });
  const hit = registry.findDeployed('rescue', 137, item => item.safe?.toLowerCase() === B.toLowerCase());
  assert.ok(hit, 'found on chain 137');
  assert.equal(hit.address.toLowerCase(), C.toLowerCase());
  assert.equal(registry.findDeployed('rescue', 1, item => item.safe?.toLowerCase() === C.toLowerCase()), null);
  assert.equal(registry.findDeployed('rescue', 999), null);
});

test('registry: listDeployed filters by chainId', () => {
  store.clear();
  registry.saveDeployed('batch', A, { chainId: 1 });
  registry.saveDeployed('batch', B, { chainId: 1 });
  registry.saveDeployed('batch', C, { chainId: 137 });
  assert.equal(registry.listDeployed('batch', 1).length, 2);
  assert.equal(registry.listDeployed('batch', 137).length, 1);
  assert.equal(registry.listDeployed('batch').length, 3);
});

test('registry: removeDeployed removes exact (type, address, chainId)', () => {
  store.clear();
  registry.saveDeployed('batch', A, { chainId: 1 });
  registry.saveDeployed('batch', A, { chainId: 137 });
  assert.equal(registry.removeDeployed('batch', A, 1), true);
  assert.equal(registry.removeDeployed('batch', A, 1), false, 'second remove is no-op');
  assert.equal(registry.loadRegistry().batch.length, 1, 'chain 137 entry survives');
});

test('registry: clearRegistry empties everything', () => {
  store.clear();
  registry.saveDeployed('batch', A, { chainId: 1 });
  registry.saveDeployed('rescue', B, { chainId: 137 });
  registry.clearRegistry();
  const reg = registry.loadRegistry();
  for (const type of ['batch', 'rescue', 'airdrop', 'proxy', 'revoker', 'token']) {
    assert.equal(reg[type].length, 0, type + ' must be empty');
  }
});

test('registry: corrupt / non-object data falls back to empty registry', () => {
  store.clear();
  store.set('bear.deployedContracts', '{not json');
  assert.deepEqual(registry.loadRegistry(), { batch: [], rescue: [], airdrop: [], proxy: [], revoker: [], token: [] });
  store.set('bear.deployedContracts', JSON.stringify({ batch: [{ address: '0xbad', chainId: 1 }, { address: A, chainId: 'x' }] }));
  const reg = registry.loadRegistry();
  assert.equal(reg.batch.length, 0, 'invalid entries dropped');
});