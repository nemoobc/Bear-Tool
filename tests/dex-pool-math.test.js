// Bear Tool — dex-pool-math.test.js
//
// pool-math.js is the offchain half of a two-file pair: the other half is the
// Solidity in bear-source.js (BearPair). Every number the swap panel shows has
// to survive the minOut check the contract runs, or the user's trade reverts
// after they tapped confirm. So these tests pin ARITHMETIC PROPERTIES — floor
// exactness, monotonicity, boundary errors — instead of snapshots, and one
// test reads the contract source itself to keep the fee constants welded shut.
//
// The live proof is tests/dex-v2-onchain-e2e.mjs: same functions, deployed
// contract, anvil, wei-for-wei. This file is the fast signal before that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWAP_FEE_BPS, getAmountOut, priceOf, bigSqrt, initialShares,
  addShares, removeAmounts, minOutWithSlippage, priceImpact,
} from '../js/dex/pool-math.js';
import { BEAR_SOURCE } from '../js/dex/bear-source.js';

const E18 = 10n ** 18n;

test('the fee is 0.3% and the contract source carries the same constants', () => {
  assert.equal(SWAP_FEE_BPS, 30, '30 bps = 0.3%');
  // Marker check: the Solidity fee math must contain the exact constants the
  // JS mirror uses. If someone edits one side, this goes red and forces a
  // conscious edit of both. (The e2e proves behavior; this pins the formula.)
  assert.match(BEAR_SOURCE, /inFee = amountIn \* 997/, 'contract: fee on the input side');
  assert.match(BEAR_SOURCE, /\(reserveIn \* 1000 \+ inFee\)/, 'contract: denominator with fee');
  assert.match(BEAR_SOURCE, /uint256 inFee = amountIn \* 997;/, 'no second fee formula hiding elsewhere');
});

test('getAmountOut floors exactly: never above the exact value, never more than one wei below', () => {
  const cases = [
    [10n * E18, 100n * E18, 800_000n * E18],   // the e2e's first buy
    [1n, 100n * E18, 800_000n * E18],          // 1 wei in
    [7n * E18, 3n, 999_999n],                  // dust reserves
    [123_456_789n, 987_654_321n, 5n],          // tiny pool, wei-scale
  ];
  for (const [amountIn, reserveIn, reserveOut] of cases) {
    const out = getAmountOut(amountIn, reserveIn, reserveOut);
    const num = amountIn * 997n * reserveOut;
    const den = reserveIn * 1000n + amountIn * 997n;
    assert.ok(out * den <= num, `floor overshoots: ${amountIn}/${reserveIn}/${reserveOut}`);
    assert.ok((out + 1n) * den > num, `more than one wei under: ${amountIn}/${reserveIn}/${reserveOut}`);
  }
});

test('getAmountOut refuses empty sides instead of inventing a price', () => {
  assert.throws(() => getAmountOut(0n, 100n, 100n), /amountIn/);
  assert.throws(() => getAmountOut(1n, 0n, 100n), /reserves/);
  assert.throws(() => getAmountOut(1n, 100n, 0n), /reserves/);
});

test('a bigger order always pays worse, and output never reaches the reserve', () => {
  const rIn = 100n * E18;
  const rOut = 800_000n * E18;
  let prev = 0n;
  let prevAvgPrice = null;
  for (const size of [1n * E18, 10n * E18, 100n * E18, 5_000n * E18]) {
    const out = getAmountOut(size, rIn, rOut);
    assert.ok(out > 0n, 'a real order buys something');
    assert.ok(out < rOut, 'the reserve can never fully drain on one swap');
    const avgPrice = (out * E18) / size;
    if (prevAvgPrice !== null) assert.ok(avgPrice < prevAvgPrice, 'slippage must bite');
    prevAvgPrice = avgPrice;
    assert.ok(out > prev, 'but more input still buys more, always');
    prev = out;
  }
});

test('the 0.3% fee makes the swap strictly worse than the fee-free quotient', () => {
  const rIn = 100n * E18;
  const rOut = 800_000n * E18;
  const size = 10n * E18;
  const withFee = getAmountOut(size, rIn, rOut);
  const noFee = (size * rOut) / (rIn + size);
  assert.ok(withFee < noFee, `fee must cost the trader: with=${withFee} without=${noFee}`);
  assert.ok(withFee > (noFee * 995n) / 1000n, 'but the fee is 0.3%, not a haircut');
});

test('bigSqrt is the floor square root, on both sides of the boundary', () => {
  assert.equal(bigSqrt(0n), 0n);
  assert.equal(bigSqrt(1n), 1n);
  assert.equal(bigSqrt(3n), 1n);
  assert.equal(bigSqrt(4n), 2n);
  assert.equal(bigSqrt(9n), 3n);
  assert.equal(bigSqrt(15n), 3n);
  assert.equal(bigSqrt(16n), 4n);
  // Property sweep: s*s <= n < (s+1)^2 for every n in view.
  for (let n = 0n; n < 200n; n++) {
    const s = bigSqrt(n);
    assert.ok(s * s <= n, `sqrt floor above n=${n}`);
    assert.ok((s + 1n) * (s + 1n) > n, `sqrt floor below n=${n}`);
    if (n > 0n) assert.ok(s > 0n, 'every positive number has a positive floor');
  }
});

test('initialShares mirrors the contract mint: sqrt(quoteIn * tokenIn)', () => {
  assert.equal(initialShares(4n, 9n), 6n);
  assert.equal(initialShares(1n * E18, 1n * E18), 1n * E18);
  // The launch preview for the e2e's seed: sqrt(100e18 * 800000e18).
  const s = initialShares(100n * E18, 800_000n * E18);
  const n = 100n * E18 * 800_000n * E18;
  assert.ok(s * s <= n && (s + 1n) * (s + 1n) > n, 'floor property at seed scale');
  assert.throws(() => initialShares(0n, 1n), /amounts/);
  assert.throws(() => initialShares(1n, 0n), /amounts/);
});

test('addShares is the SMALLER side\'s claim — an imbalanced deposit gets what it paid for', () => {
  // Balanced: both sides claim 100 shares.
  assert.equal(addShares(50n, 200n, 100n, 400n, 200n), 100n);
  // Imbalanced: the quote side claims 100, the token side only 50 → 50.
  assert.equal(addShares(50n, 100n, 100n, 400n, 200n), 50n);
  // Dust floors to zero rather than minting something for nothing.
  assert.equal(addShares(1n, 1n, 1_000_000n, 1_000_000n, 500_000n), 0n);
  assert.throws(() => addShares(1n, 1n, 0n, 1n, 1n), /reserves/);
  assert.throws(() => addShares(1n, 1n, 1n, 1n, 0n), /shares/);
});

test('removeAmounts floors per side; full supply returns everything it can', () => {
  const { quoteOut, tokenOut } = removeAmounts(100n, 1_000n, 4_000n, 1_000n);
  assert.equal(quoteOut, 100n);
  assert.equal(tokenOut, 400n);
  // Floor per side, not a shared ratio — the pool keeps the dust.
  const dust = removeAmounts(1n, 999n, 1n, 1_000n);
  assert.equal(dust.quoteOut, 0n);
  assert.equal(dust.tokenOut, 0n);
  // The last LP (shares == totalSupply) takes the full balances, to the wei.
  const last = removeAmounts(7n, 999n, 123n, 7n);
  assert.equal(last.quoteOut, 999n);
  assert.equal(last.tokenOut, 123n);
  assert.throws(() => removeAmounts(1n, 1n, 1n, 0n), /shares/);
});

test('minOutWithSlippage rounds the guard DOWN so it never refuses a good trade', () => {
  assert.equal(minOutWithSlippage(1_000_000n, 0), 1_000_000n, '0 bps = take every wei');
  assert.equal(minOutWithSlippage(1_000_000n, 100), 990_000n, '1% off, exactly');
  assert.equal(minOutWithSlippage(99n, 100), 98n, 'math.floor(99*99/100) = 98');
  assert.equal(minOutWithSlippage(1n, 100), 0n, 'one wei cannot be cut by 1% — floor to 0');
  assert.equal(minOutWithSlippage(1_000n, 10_000), 0n, '100% slippage = accept anything, floor 0');
  assert.equal(minOutWithSlippage(1_000n, 50_000), 0n, 'slippage beyond 100% clamps at "accept anything"');
  assert.equal(minOutWithSlippage(1_000n, -5), 1_000n, 'negative clamps to 0 bps, no growth');
  assert.equal(minOutWithSlippage(0n, 100), 0n);
});

test('priceImpact grows with the order and stays inside (0,1)', () => {
  const rIn = 100n * E18;
  const rOut = 800_000n * E18;
  const small = priceImpact(1n * E18, rIn, rOut);
  const big = priceImpact(50n * E18, rIn, rOut);
  assert.ok(small > 0 && small < 1, `small trade impact sane: ${small}`);
  assert.ok(big > small, 'bigger order, bigger impact');
  assert.ok(big < 1, 'impact can approach 100% but never claim it');
  assert.equal(priceImpact(0n, rIn, rOut), 0);
  assert.equal(priceImpact(1n, 0n, rOut), 0);
});

test('priceOf is display-only and refuses to divide by an empty side', () => {
  assert.equal(priceOf(100n * E18, 800_000n * E18), 0.000125);
  assert.equal(priceOf(1n, 0n), null);
});
