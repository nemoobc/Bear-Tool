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

test('NETWORKS: 23 networks, 17 mainnet + 6 testnet', () => {
  // 2026-10-05: +11 mainnet promoted from CHAIN_PRESETS (4 L1: Avalanche,
  // Gnosis, Celo, Sonic · 7 L2: Linea, Scroll, Blast, Mantle, zkSync Era,
  // Unichain, World Chain). Every addition was probe-verified for eth_chainId
  // (2 endpoints each, publicnode or drpc among them) and confirmed present
  // in LI.FI's 70-chain set (docs/research/bridge-tokens-2026-10-05.md A5).
  assert.equal(net.NETWORKS.length, 23);
  const main = net.NETWORKS.filter(n => n.type === 'mainnet');
  const test = net.NETWORKS.filter(n => n.type === 'testnet');
  assert.equal(main.length, 17);
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

test('POPULAR_TOKENS: Ethereum mainnet has 23 tokens', () => {
  // 19 curated entries + the four swap-list extras (rETH, cbETH, wstETH, FRAX)
  // that used to live in a SECOND POPULAR_TOKENS inside js/swap.js. One source
  // of truth now: swap re-exports this map (HUKUM 10).
  assert.equal(net.POPULAR_TOKENS[1].length, 23);
});

test('POPULAR_TOKENS: every shipped mainnet carries a curated list', () => {
  // "disetiap jaringan list coin sesuaikan" — a mainnet with no list leaves the
  // picker with only the native coin. ≥2 = native + at least one ERC-20 stable/wrap.
  for (const n of net.NETWORKS.filter(x => x.type === 'mainnet')) {
    const list = net.POPULAR_TOKENS[n.chainId] || [];
    assert.ok(list.length >= 2, `${n.id} (${n.chainId}) has ${list.length} curated tokens, needs ≥2`);
  }
});

test('POPULAR_TOKENS: every testnet carries a list, except BSC testnet (no curated source)', () => {
  // 97 has no official token list anywhere (research C: LI.FI rejects it,
  // Circle publishes none, BNB docs 404) — native-only is the honest state.
  const NO_SOURCE = new Set([97]);
  for (const n of net.NETWORKS.filter(x => x.type === 'testnet')) {
    if (NO_SOURCE.has(n.chainId)) continue;
    const list = net.POPULAR_TOKENS[n.chainId] || [];
    assert.ok(list.length >= 1, `${n.id} (${n.chainId}) has no curated tokens`);
  }
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

test('getAllNetworks: testnet mode OFF hides testnets, ON shows them', async () => {
  const { get, set } = await import('../js/state.js');
  // default settings have testnet: true
  set('settings', { ...get('settings'), testnet: true });
  const all = net.getAllNetworks();
  assert.ok(all.some(n => n.type === 'testnet'), 'testnet mode ON must include testnets');
  assert.ok(all.some(n => n.type === 'mainnet'), 'testnet mode ON must include mainnets');
  // turn testnet OFF
  set('settings', { ...get('settings'), testnet: false });
  const filtered = net.getAllNetworks();
  assert.ok(!filtered.some(n => n.type === 'testnet'), 'testnet mode OFF must hide testnets');
  assert.ok(filtered.some(n => n.type === 'mainnet'), 'testnet mode OFF must keep mainnets');
  // restore default
  set('settings', { ...get('settings'), testnet: true });
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
// ── RPC endpoint hygiene ────────────────────────────────────────
// Measured 2026-09-17 from a mobile/Termux network: llamarpc, ankr and
// cloudflare-eth were all unreachable, which surfaced as the global
// "All RPCs failed for Ethereum" error and an empty dashboard.
const DEAD_RPC = [
  'eth.llamarpc.com', 'binance.llamarpc.com', 'base.llamarpc.com',
  'arbitrum.llamarpc.com', 'optimism.llamarpc.com',
  'rpc.ankr.com',
  'cloudflare-eth.com',
  'polygon-rpc.com',
  'rpc.sepolia.org',
  'rpc-amoy.polygon.technology'
];

test('RPC: every network has ≥2 endpoints (no single point of failure)', () => {
  for (const n of net.NETWORKS) {
    assert.ok(n.rpc.length >= 2, `${n.id} needs ≥2 endpoints, has ${n.rpc.length}`);
  }
});

test('RPC: no known-dead endpoint is configured', () => {
  for (const n of net.NETWORKS) {
    for (const url of n.rpc) {
      for (const dead of DEAD_RPC) {
        assert.ok(!url.includes(dead), `${n.id} still points at unreachable endpoint ${url}`);
      }
    }
  }
});

test('RPC: every mainnet has a publicnode/drpc endpoint (verified reachable fallback)', () => {
  for (const n of net.NETWORKS.filter(x => x.type === 'mainnet')) {
    assert.ok(
      n.rpc.some(u => u.includes('publicnode.com') || u.includes('drpc.org')),
      `${n.id} has no publicnode/drpc fallback`
    );
  }
});

test('RPC: every endpoint is https', () => {
  for (const n of net.NETWORKS) {
    for (const u of n.rpc) assert.ok(u.startsWith('https://'), u);
  }
});

test('RPC: no duplicate endpoints within a network', () => {
  for (const n of net.NETWORKS) {
    assert.equal(new Set(n.rpc).size, n.rpc.length, n.id + ' has duplicate rpc urls');
  }
});
