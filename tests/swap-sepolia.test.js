// Bear Tool — swap-sepolia.test.js
// Uniswap on Sepolia: the V2 router and WETH have DIFFERENT addresses from
// mainnet. The old code reused the mainnet router (0x7a250d…) which has no
// code on Sepolia → testnet swaps always failed with an honest error.
// Verified on-chain 2026-09-18: V2Router02 0xeE567Fe… HAS CODE, WETH is
// 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14 (router.WETH()).
//
// These assertions now read js/routers.js rather than js/swap.js. swap.js used
// to keep its own copy of the address maps, and that duplication is how the two
// drifted — the registry advertised routes the executor had no entry for. The
// facts being checked here are unchanged and were re-confirmed during the
// registry rewrite: measured against three endpoints on 2026-09-27, the Sepolia
// V2Router02 answers WETH() and factory(), and the QuoterV2 has no code on
// Sepolia at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routers = fs.readFileSync(new URL('../js/routers.js', import.meta.url), 'utf8');
const swap = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
const { SWAP_ROUTERS, getRouterAddress, getQuoterAddress } =
  // .href, not .pathname: on Windows pathname is /C:/Users/… and feeding that
  // to pathToFileURL yields file:///C:/C:/Users/… — the doubled prefix that
  // scope.test.js already carries a note about, hit from a different direction.
  await import(new URL('../js/routers.js', import.meta.url).href);

const SEPOLIA = 11155111;
const MAINNET_V2 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

test('swap: Sepolia uses the correct Uniswap V2 router (not the mainnet one)', () => {
  const addr = getRouterAddress('uniswap_v2', SEPOLIA);
  assert.equal(addr, '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    'Sepolia V2 router must be the Sepolia V2Router02');
  assert.notEqual(addr, MAINNET_V2,
    'the mainnet router has no code on Sepolia — reusing it made every testnet swap fail');
  assert.match(routers, /11155111: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3'/);
});

test('swap: the entry only claims Sepolia for the router that is there', () => {
  const entry = SWAP_ROUTERS.find((r) => r.id === 'uniswap_v2');
  assert.ok(entry.chains.includes(SEPOLIA));
  // A chain listed without an address is a chain the UI offers and the
  // executor cannot serve.
  assert.ok(entry.router[SEPOLIA], 'a listed chain must have an address');
});

test('swap: Sepolia WETH address is the verified on-chain one', () => {
  // The V2 path asks the router for its own WETH(), so this table is a
  // last-resort fallback rather than the source of truth. It still has to be
  // right when it is reached.
  assert.match(
    swap,
    /11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'/,
    'Sepolia WETH must be 0xfFf9976782d46CC…'
  );
  assert.ok(
    !swap.includes('0xfFf997675846FbDE638e6Be6E0Cee9B40AC2EF02'),
    'the old wrong Sepolia WETH address must be gone'
  );
});

test('swap: QuoterV3 must not claim Sepolia support (no code on-chain)', () => {
  // Measured on 2026-09-27: the CREATE2 QuoterV2 has code on Ethereum,
  // Optimism, Polygon, Arbitrum and Base, and none on Sepolia, BNB or the BSC
  // testnet. Listing it for Sepolia would offer a route that cannot be quoted.
  assert.equal(getQuoterAddress('uniswap_v3', SEPOLIA), null,
    'Sepolia must not be listed in the V3 Quoter map');
  const entry = SWAP_ROUTERS.find((r) => r.id === 'uniswap_v3');
  assert.ok(!entry.chains.includes(SEPOLIA),
    'and the entry must not claim Sepolia either');
  assert.doesNotMatch(routers, /11155111:[^\n]*61fFE014bA17989E743c5F6cB21bF9697530B21e/,
    'no Sepolia key in the quoter map');
});

// ── the send-time estimate gets a buffer ──
//
// CI 37020081620 polygon: QuickSwap leg3 SHIPPED gasLimit=174636 and ran out
// of gas at exactly it. waitForTx's enrichment replayed at 5M (success → OOG,
// not a revert) and a fresh estimate at the same state read 185052 — the
// estimate came back ~6% low and nothing in the old send path noticed. These
// two tests pin the fix: the buffer exists, and a failed pre-estimate leaves
// the send exactly as it was before the fix.

test('swap: a send-time estimate ships ×1.25 gas — the CI OOG class cannot recur silently', async () => {
  const { withSwapGasBuffer } = await import(new URL('../js/swap.js', import.meta.url).href);
  let seen = null;
  const signer = { estimateGas: async (req) => { seen = req; return 174636n; } };
  const out = await withSwapGasBuffer(signer, { to: '0xrouter', data: '0xdead' });
  assert.equal(out.gasLimit, 218295n, '174636 × 5/4 = 218295 — menutup kekurangan 6% dengan margin');
  assert.equal(seen?.data, '0xdead', 'estimate membaca request yang sama yang akan dikirim');
});

test('swap: a failed pre-estimate must not block the send — no buffer, path unchanged', async () => {
  const { withSwapGasBuffer } = await import(new URL('../js/swap.js', import.meta.url).href);
  const signer = { estimateGas: async () => { throw new Error('HTTP error 429'); } };
  const req = { to: '0xrouter', data: '0xbeef' };
  const out = await withSwapGasBuffer(signer, req);
  assert.deepEqual(out, req, 'tanpa estimate tanpa buffer — jalur kirim persis seperti sebelum fix');
  assert.equal(out.gasLimit, undefined);
});
