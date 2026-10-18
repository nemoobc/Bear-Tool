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

// ── 2026-10-18 (user report: "pas tambahin network testnet nyatu ke mainnet")
// Chain TAK DIKETAHUI yang namanya jujur bilang testnet tidak boleh masuk ke
// bagian MAINNET. Nama = sinyal aman: label testnet hanya menambah kehati-hatian.
test('nama jujur menentukan: "… Testnet" tak dikenal → testnet, bukan anggota mainnet', () => {
  assert.equal(detectNetworkType(97799, 'https://rpc.zetafox.io', 'ZetaFox Testnet'), 'testnet');
  assert.equal(detectNetworkType(880011, 'https://rpc.manggo.dev', 'Manggo Test Chain'), 'testnet');
  assert.equal(detectNetworkType(6102, 'https://rpc.pow.io', 'Pow Sepolia'), 'testnet',
    'sepolia dalam nama chain tak dikenal = sinyal testnet');
  assert.equal(detectNetworkType(97799, 'https://rpc.zetafox.io', 'Zeta Fox Mainnet'), 'mainnet',
    'nama bilang mainnet → mainnet (bukan dibalik)');
  assert.equal(detectNetworkType(97799, 'https://rpc.zetafox.io', 'ZetaFox Main'), 'mainnet');
  // dApp mengirim nama bohong untuk chain id yang SUDAH DIKETAHUI: katalog menang.
  assert.equal(detectNetworkType(1, 'https://eth.llamarpc.com', 'Fake Testnet'), 'mainnet',
    'chain id 1 adalah Ethereum — nama bohong dari dApp tidak mengubah kelasnya');
});

test('alur tambah-network memakai nama saat deteksi (sanitize + addCustomNetwork)', async () => {
  const net = await import('../js/network.js');
  const san = net.sanitizeChainRequest({
    chainId: '0x17e27', chainName: 'Rusk Testnet',
    rpcUrls: ['https://rpc.rusk.example'], nativeCurrency: { symbol: 'RST', decimals: 18 },
  });
  assert.ok(san.ok);
  assert.equal(san.net.type, 'testnet', 'dApp add-chain: nama testnet → type testnet (tidak nyatu)');
  assert.equal(san.net.icon, '', 'tidak ada emoji tersimpan untuk network baru');

  const store = new Map();
  globalThis.localStorage.getItem = (k) => (store.has(k) ? store.get(k) : null);
  globalThis.localStorage.setItem = (k, v) => store.set(k, String(v));
  const added = net.addCustomNetwork({ name: 'Manggo Test Chain', chainId: 880011,
    symbol: 'MG', rpc: ['https://rpc.manggo.dev'], explorer: '' });
  const last = added[added.length - 1];
  assert.equal(last.type, 'testnet', 'addCustomNetwork punya nama → verdict testnet');
});

test('alur paste-RPC di app.js memakai detectNetworkType, bukan hardcode', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /type: detectNetworkType\(chainId, url\)/,
    'detectFrom unknown branch wajib auto-detect');
  assert.doesNotMatch(app, /type: 'mainnet', symbol: 'ETH', rpc: \[url\]/,
    'hardcode mainnet di detectFrom harus hilang');
});
