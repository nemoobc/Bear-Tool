// Bear Tool — network.test.js
// Tests for network data + custom network + EIP-7702 delegation detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// mock localStorage (browser-only API)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

// mock ethers global (only needed for getProvider/getDelegation paths we test)
globalThis.ethers = { JsonRpcProvider: class {} };

const net = await import('../js/network.js');

test('NETWORKS: 12 networks, 6 mainnet + 6 testnet', () => {
  assert.equal(net.NETWORKS.length, 12);
  const main = net.NETWORKS.filter(n => n.type === 'mainnet');
  const test = net.NETWORKS.filter(n => n.type === 'testnet');
  assert.equal(main.length, 6);
  assert.equal(test.length, 6);
});

test('NETWORKS: all chainIds unique', () => {
  const ids = net.NETWORKS.map(n => n.chainId);
  assert.equal(new Set(ids).size, ids.length);
});

test('NETWORKS: every network has non-empty rpc + explorer + symbol', () => {
  for (const n of net.NETWORKS) {
    assert.ok(n.rpc.length > 0, n.id + ' rpc');
    assert.ok(n.explorer.startsWith('https://'), n.id + ' explorer');
    assert.ok(n.symbol.length > 0, n.id + ' symbol');
  }
});

test('POPULAR_TOKENS: Ethereum mainnet has 19 tokens', () => {
  assert.equal(net.POPULAR_TOKENS[1].length, 19);
});

test('getNetwork(1) → ethereum; getNetworkById(sepolia) → testnet', () => {
  assert.equal(net.getNetwork(1).id, 'ethereum');
  assert.equal(net.getNetworkById('sepolia').type, 'testnet');
  assert.equal(net.getNetwork(999999), undefined);
});

test('addCustomNetwork + removeCustomNetwork roundtrip', () => {
  const before = net.getAllNetworks().length;
  net.addCustomNetwork({ name: 'Test Chain', chainId: 12345, rpc: ['https://x'], symbol: 'TST', type: 'testnet' });
  assert.equal(net.getAllNetworks().length, before + 1);
  assert.equal(net.getNetwork(12345).name, 'Test Chain');
  const custom = net.getCustomNetworks();
  net.removeCustomNetwork(custom[0].id);
  assert.equal(net.getAllNetworks().length, before);
});

test('EIP7702 constants correct', () => {
  assert.equal(net.EIP7702.MAGIC, '0x05');
  assert.equal(net.EIP7702.DELEGATION_PREFIX, '0xef0100');
  assert.equal(net.EIP7702.GAS_PER_AUTH, 25000);
});

test('getDelegation: detects 0xef0100 prefix, returns delegate address', async () => {
  const delegate = '0x1234567890123456789012345678901234567890';
  const provider = { getCode: async () => '0xef0100' + delegate.slice(2) };
  const res = await net.getDelegation(provider, '0xabc');
  assert.equal(res.toLowerCase(), delegate.toLowerCase());
});

test('getDelegation: plain EOA (0x) → null', async () => {
  const provider = { getCode: async () => '0x' };
  assert.equal(await net.getDelegation(provider, '0xabc'), null);
});

test('getDelegation: regular contract code → null', async () => {
  const provider = { getCode: async () => '0x6080604052' };
  assert.equal(await net.getDelegation(provider, '0xabc'), null);
});