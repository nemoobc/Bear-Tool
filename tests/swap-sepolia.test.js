// Bear Tool — swap-sepolia.test.js
// Uniswap on Sepolia: the V2 router and WETH have DIFFERENT addresses from
// mainnet. The old code reused the mainnet router (0x7a250d…) which has no
// code on Sepolia → testnet swaps always failed with an honest error.
// Verified on-chain 2026-09-18: V2Router02 0xeE567Fe… HAS CODE, WETH is
// 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14 (router.WETH()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const swap = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');

test('swap: Sepolia uses the correct Uniswap V2 router (not the mainnet one)', () => {
  assert.match(
    swap,
    /11155111: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3'/,
    'Sepolia V2 router must be the Sepolia V2Router02'
  );
});

test('swap: Sepolia WETH address is the verified on-chain one', () => {
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
  const quoterBlock = swap.match(/const UNISWAP_QUOTER_V3 = \{[\s\S]*?\};/);
  assert.ok(quoterBlock, 'UNISWAP_QUOTER_V3 map must exist');
  assert.ok(
    !quoterBlock[0].includes('11155111'),
    'Sepolia must not be listed in the V3 Quoter map'
  );
});