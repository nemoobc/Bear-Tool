// Bear Tool — js/dex/pool-math.js
// The ONE place the DEX v2's offchain numbers are computed.
//
// Mirrors BearPair in js/dex/bear-source.js to the wei, on purpose:
//   - same 0.3% fee (997/1000) on the input side,
//   - same floor division at every step (a number that floats up is a quote
//     that reverts on minOut — the display must undershoot, never overshoot),
//   - same sqrt for initial LP shares so the launch preview matches the mint.
//
// tests/dex-pool-math.test.js pins fixed vectors; tests/dex-v2-onchain-e2e.mjs
// proves the same functions against the deployed contract on anvil. If this
// file and the contract ever disagree, the e2e goes red — that is the point.
//
// All functions are pure BigInt in / BigInt out. No ethers, no DOM, no state.

export const SWAP_FEE_BPS = 30; // 0.3% — kept in the pool for the LPs

/** Output of an exact-in swap against real reserves. Floor division. */
export function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n) throw new Error('getAmountOut: amountIn must be > 0');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('getAmountOut: reserves must be > 0');
  const inFee = amountIn * 997n;
  return (inFee * reserveOut) / (reserveIn * 1000n + inFee);
}

/** Price one whole token in reserve units, as a float — display only. */
export function priceOf(reserveQuote, reserveToken) {
  if (reserveToken <= 0n) return null;
  return Number(reserveQuote) / Number(reserveToken);
}

/**
 * The contract's integer sqrt (babylonian). Integer in, integer out — the
 * initial LP share count must match the contract's mint call exactly.
 */
export function bigSqrt(y) {
  if (y <= 0n) return 0n;
  if (y > 3n) {
    let z = y;
    let x = y / 2n + 1n;
    while (x < z) {
      z = x;
      x = (y / x + x) / 2n;
    }
    return z;
  }
  return 1n;
}

/** Initial LP shares minted when a pool is seeded: sqrt(quoteIn * tokenIn). */
export function initialShares(quoteIn, tokenIn) {
  if (quoteIn <= 0n || tokenIn <= 0n) throw new Error('initialShares: amounts must be > 0');
  return bigSqrt(quoteIn * tokenIn);
}

/**
 * Shares minted by a later addLiquidity: min of each side's proportional claim,
 * using the reserves read BEFORE the deposit — exactly the contract's rule.
 */
export function addShares(quoteIn, tokenIn, quoteReserve, tokenReserve, totalSupply) {
  if (quoteReserve <= 0n || tokenReserve <= 0n) throw new Error('addShares: reserves must be > 0');
  if (totalSupply <= 0n) throw new Error('addShares: pool has no shares');
  const s1 = (quoteIn * totalSupply) / quoteReserve;
  const s2 = (tokenIn * totalSupply) / tokenReserve;
  return s1 < s2 ? s1 : s2;
}

/** Amounts returned by burning `shares`, floor per side. */
export function removeAmounts(shares, quoteReserve, tokenReserve, totalSupply) {
  if (totalSupply <= 0n) throw new Error('removeAmounts: pool has no shares');
  return {
    quoteOut: (shares * quoteReserve) / totalSupply,
    tokenOut: (shares * tokenReserve) / totalSupply,
  };
}

/**
 * Slippage guard for an exact-in swap: the minimum the trader is willing to
 * accept, with the tolerance applied DOWNWARD (a guard that rounds up refuses
 * trades that would have passed).
 */
export function minOutWithSlippage(amountOut, slipBps) {
  if (amountOut <= 0n) return 0n;
  // 10000 bps = "accept anything" (minOut 0). Beyond that is nonsense; clamp
  // instead of going negative, so garbage input can never tighten the guard.
  const bps = BigInt(Math.max(0, Math.min(10000, Math.floor(slipBps))));
  return (amountOut * (10000n - bps)) / 10000n;
}

/**
 * Price impact of a trade as a fraction (0..1], float for display only.
 * How far the marginal price moves — the honest number under the quote.
 */
export function priceImpact(amountIn, reserveIn, reserveOut) {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0;
  const spot = Number(reserveOut) / Number(reserveIn);
  const out = Number(getAmountOut(amountIn, reserveIn, reserveOut));
  const exec = amountIn > 0n ? out / Number(amountIn) : 0;
  if (spot === 0) return 0;
  const impact = 1 - exec / spot;
  return impact > 0 ? impact : 0;
}
