// Bear Tool — network-type-detect.test.js
//
// LIVE BUG (user report, 2026-10-03): Add Custom Network → paste RPC → the
// network landed in the list wearing the MAINNET badge. Cause: detectFrom's
// unknown-chain branch hardcoded type:'mainnet', and CHAIN_PRESETS carries
// almost only mainnets — Sepolia (11155111) lives in NETWORKS, not in the
// presets catalogue, so a Sepolia RPC always hit the unknown branch.
// detectNetworkType is the single verdict for the paste-RPC path and the
// addCustomNetwork fallback.
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectNetworkType } = await import('../js/network.js');

test('chain yang diketahui app → type dari katalog, bukan hardcode mainnet', () => {
  assert.equal(detectNetworkType(11155111, 'https://rpc.sepolia.org'), 'testnet',
    'Sepolia ada di NETWORKS — wajib testnet (inti laporan)');
  assert.equal(detectNetworkType(80002, 'https://rpc-amoy.polygon.technology'), 'testnet');
  assert.equal(detectNetworkType(84532, 'https://sepolia.base.org'), 'testnet');
  assert.equal(detectNetworkType(1, 'https://eth.llamarpc.com'), 'mainnet');
  assert.equal(detectNetworkType(42220, 'https://celo-rpc.publicnode.com'), 'mainnet',
    'preset Celo = mainnet');
  assert.equal(detectNetworkType(560048, 'https://ethereum-hoodi-rpc.publicnode.com'), 'testnet',
    'preset Hoodi = testnet');
});

test('testnet di luar katalog + chain lokal dev → testnet', () => {
  assert.equal(detectNetworkType(80001, 'https://rpc-mumbai.maticvigil.com'), 'testnet');
  assert.equal(detectNetworkType(43113, 'https://api.avax-test.network/ext/bc/C/rpc'), 'testnet');
  assert.equal(detectNetworkType(31337, 'https://example.com'), 'testnet', 'anvil/hardhat');
  assert.equal(detectNetworkType(1337, 'https://example.com'), 'testnet');
});

test('RPC loopback (fork dev) → testnet walau chainId tak dikenal', () => {
  assert.equal(detectNetworkType(999999, 'http://127.0.0.1:8546'), 'testnet',
    'fork anvil user — laporan langsung');
  assert.equal(detectNetworkType(999999, 'http://localhost:8545'), 'testnet');
  assert.equal(detectNetworkType(999999, 'http://[::1]:8545'), 'testnet');
});

test('chain remote tak dikenal → mainnet (arah konservatif)', () => {
  assert.equal(detectNetworkType(999999, 'https://unknown-chain.example.com'), 'mainnet',
    'testnet salah-label mainnet hanya menambah warning; mainnet salah-label testnet menghilangkan peringatan bahaya');
});

test('alur paste-RPC di app.js memakai detectNetworkType, bukan hardcode', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /type: detectNetworkType\(chainId, url\)/,
    'detectFrom unknown branch wajib auto-detect');
  assert.doesNotMatch(app, /type: 'mainnet', symbol: 'ETH', rpc: \[url\]/,
    'hardcode mainnet di detectFrom harus hilang');
});
