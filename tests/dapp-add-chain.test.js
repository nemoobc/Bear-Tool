// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapp-add-chain.test.js
// EIP-3085: a dApp asks for a chain the wallet does not know.
// 2026-10-15 (user: "wc connect add network gabisa" for a dApp on a new
// testnet). The pipeline pinned here: sanitizeChainRequest (pure) → the
// caller's cancel/confirm sheet → installRequestedChain (probe + registry).
// The dApp's raw payload must never reach addCustomNetwork, and an RPC that
// answers with a DIFFERENT chain id must install nothing.
// ═══════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { sanitizeChainRequest, installRequestedChain, probeChainId, rpcLabel } =
  await import('../js/network.js');

beforeEach(() => { mem.clear(); });

// 534351 (Scroll Sepolia) is in the app's testnet id list but NOT in the
// registry — reachable only through the add path, which is the point.
const ID = 534351;
const RPC = 'https://sepolia-rpc.scroll.io';
const payload = (over = {}) => ({
  chainId: '0x' + ID.toString(16),
  chainName: 'Scroll Sepolia',
  rpcUrls: [RPC],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorerUrls: ['https://sepolia.scrollscan.com'],
  ...over,
});

test('a proper EIP-3085 payload sanitizes into a registry-shaped network', () => {
  const s = sanitizeChainRequest(payload());
  assert.equal(s.ok, true);
  assert.equal(s.net.chainId, ID);
  assert.equal(s.net.name, 'Scroll Sepolia');
  assert.deepEqual(s.net.rpc, [RPC]);
  assert.equal(s.net.symbol, 'ETH');
  assert.equal(s.net.decimals, 18);
  assert.equal(s.net.explorer, 'https://sepolia.scrollscan.com');
  assert.equal(s.net.type, 'testnet', 'a listed testnet id must classify as testnet');
  assert.equal(mem.size, 0, 'sanitize is pure — nothing may be written');
});

test('numeric chain ids are accepted; name is trimmed and capped', () => {
  const s = sanitizeChainRequest(payload({ chainId: ID, chainName: '  ' + 'N'.repeat(80) + '  ' }));
  assert.equal(s.ok, true);
  assert.equal(s.net.chainId, ID);
  assert.equal(s.net.name.length, 40, 'a 200-char name must not reach the network list raw');
  assert.equal(s.net.name, 'N'.repeat(40));
});

test('an unsafe first RPC is skipped for the first safe one', () => {
  const s = sanitizeChainRequest(payload({ rpcUrls: ['http://evil.example', 'ws://x', RPC] }));
  assert.equal(s.ok, true);
  assert.deepEqual(s.net.rpc, [RPC], 'http to a remote host is refused; the https one wins');
});

test('no safe RPC at all → refused, nothing installed', () => {
  const s = sanitizeChainRequest(payload({ rpcUrls: ['http://evil.example', 'javascript:alert(1)'] }));
  assert.equal(s.ok, false);
  assert.equal(s.code, 32602);
  assert.match(s.message, /RPC/);
});

test('missing name → refused (the list needs something to show)', () => {
  const s = sanitizeChainRequest(payload({ chainName: '   ' }));
  assert.equal(s.ok, false);
  assert.match(s.message, /name/i);
});

test('garbage chain ids are refused, huge ones too', () => {
  for (const chainId of ['banana', '0x', '', 0, -1, 1.5, {}, null]) {
    const s = sanitizeChainRequest(payload({ chainId }));
    assert.equal(s.ok, false, JSON.stringify(chainId));
    assert.equal(s.code, 32602);
  }
  // 2^53-1 is the last safe integer — 2^53 is out.
  assert.equal(sanitizeChainRequest(payload({ chainId: '0x1fffffffffffff' })).ok, true);
  assert.equal(sanitizeChainRequest(payload({ chainId: '0x20000000000000' })).ok, false);
});

test('currency fields are clamped, not trusted', () => {
  const s = sanitizeChainRequest(payload({ nativeCurrency: { symbol: 'E TH 😀', decimals: 99 } }));
  assert.equal(s.ok, true);
  assert.equal(s.net.symbol, 'ETH', 'a junk symbol falls back, it never reaches the UI raw');
  assert.equal(s.net.decimals, 18);
  const s2 = sanitizeChainRequest(payload({ nativeCurrency: { symbol: 'USDC', decimals: 6 } }));
  assert.equal(s2.net.symbol, 'USDC');
  assert.equal(s2.net.decimals, 6, 'a real 6-decimals chain keeps 6');
});

test('explorer URLs: only http(s) survives; junk is dropped', () => {
  const s = sanitizeChainRequest(payload({ blockExplorerUrls: ['javascript:x', 'https://ok.example/scan'] }));
  assert.equal(s.net.explorer, 'https://ok.example/scan');
  const s2 = sanitizeChainRequest(payload({ blockExplorerUrls: ['javascript:x'] }));
  assert.equal(s2.ok, true);
  assert.equal(s2.net.explorer, '');
});

test('rpcLabel shows the host, never the key path', () => {
  assert.equal(rpcLabel('https://sepolia-rpc.scroll.io/secret-key-abc'), 'sepolia-rpc.scroll.io');
  assert.equal(rpcLabel('not a url'), 'not a url');
});

test('probeChainId: answers with a number, garbage/unreachable → null', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ result: '0x' + ID.toString(16) }) });
  assert.equal(await probeChainId(RPC), ID);
  globalThis.fetch = async () => ({ json: async () => ({ result: 'banana' }) });
  assert.equal(await probeChainId(RPC), null);
  globalThis.fetch = async () => { throw new Error('CORS'); };
  assert.equal(await probeChainId(RPC), null, 'no answer is null, not a crash');
});

test('install: matching probe → registered once, second call reuses', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ result: '0x' + ID.toString(16) }) });
  const s = sanitizeChainRequest(payload());
  const ins = await installRequestedChain(s.net);
  assert.equal(ins.ok, true);
  assert.equal(ins.reused, false);
  assert.equal(ins.net.chainId, ID);
  assert.ok(String(ins.net.id).startsWith('custom-'), 'registered with a custom- id');
  const stored = JSON.parse(mem.get('bear.customNetworks'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].custom, true);
  assert.equal(stored[0].type, 'testnet');
  const again = await installRequestedChain(s.net);
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(JSON.parse(mem.get('bear.customNetworks')).length, 1, 'no duplicate rows');
});

test('install: an RPC that reports a DIFFERENT chain → refused, nothing stored', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ result: '0x1' }) }); // mainnet
  const s = sanitizeChainRequest(payload());
  const ins = await installRequestedChain(s.net);
  assert.equal(ins.ok, false);
  assert.match(ins.message, /reports chain/i);
  assert.equal(mem.has('bear.customNetworks'), false, 'a spoofing RPC installs nothing');
});

test('install: a probe that cannot answer still installs what the user approved', async () => {
  globalThis.fetch = async () => { throw new Error('CORS'); };
  const s = sanitizeChainRequest(payload());
  const ins = await installRequestedChain(s.net);
  assert.equal(ins.ok, true, 'MetaMask parity: a CORS-less RPC must not block the add');
  assert.equal(JSON.parse(mem.get('bear.customNetworks')).length, 1);
});

test('install: junk input is refused without throwing', async () => {
  for (const bad of [null, {}, { chainId: 1 }, { chainId: NaN, rpc: ['https://x.example'] }]) {
    const r = await installRequestedChain(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});
