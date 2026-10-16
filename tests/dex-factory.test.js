// Bear Tool — tests/dex-factory.test.js
// The factory address is configuration with sharp edges: it becomes a LOG
// FILTER (pools.js) and a call target (launch flow). A garbage value read back
// would silently match nothing; a storage that throws would crash the feed.
// These tests pin the address contract and the ABI markers the rest of the
// module relies on. The DEPLOY path (compile → tx → remember) is proven for
// real in tests/dex-v2-onchain-e2e.mjs, not mocked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { factoryAddress, setFactoryAddress, deployFactory } = await import('../js/dex/factory.js');
const { BEAR_FACTORY_ABI, BEAR_SOURCE } = await import('../js/dex/bear-source.js');

const ADDR = '0xAbCd00000000000000000000000000000000Ef12';

test('the address is remembered per chain, stored lowercase, validated both ways', () => {
  store.clear();
  assert.equal(factoryAddress(), '', 'nothing stored = empty, never a guess');
  assert.equal(setFactoryAddress('nope'), false);
  assert.equal(setFactoryAddress('0x123'), false, 'truncated is not an address');
  assert.equal(setFactoryAddress(ADDR), true);
  assert.equal(factoryAddress(), ADDR.toLowerCase(), 'every later compare is lowercase');
  assert.equal(setFactoryAddress('  ' + ADDR + '  '), true, 'whitespace trimmed');
  assert.equal(setFactoryAddress(0), false, 'a number is not an address');
});

test('storage that throws reads as empty and refuses the write, without crashing the feed', () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError: storage blocked'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  assert.equal(factoryAddress(), '', 'a blocked storage is a "no factory yet", said safely');
  assert.equal(setFactoryAddress(ADDR), false, 'and the failure is reported, not swallowed silently as success');
  globalThis.localStorage = real;
});

test('the ABI carries everything factory.js and the launch UI will call', () => {
  const joined = BEAR_FACTORY_ABI.join('\n');
  assert.match(joined, /function pairFor\(address\) view returns \(address\)/);
  assert.match(joined, /function launch\(\(string,string,string,string,string,string,string\), uint256, address, uint256, uint256, uint256, uint256, uint256\) returns \(address, address\)/);
  assert.match(joined, /function createPool\(address, address, uint256, uint256\) returns \(address\)/);
  assert.match(joined, /event Launched\(/);
  assert.match(joined, /event PoolCreated\(/);
});

test('the factory source is self-contained (deploys token + pool from one compile)', () => {
  // The factory `new`s both other contracts, so its creation code must embed
  // them — a factory that cannot deploy its own pool is not a factory.
  assert.match(BEAR_SOURCE, /new BearToken\(/);
  assert.match(BEAR_SOURCE, /new BearPair\(/);
  assert.match(BEAR_SOURCE, /contract BearFactory/);
});

test('deployFactory is exported for the UI to bind to a button', () => {
  assert.equal(typeof deployFactory, 'function');
});
