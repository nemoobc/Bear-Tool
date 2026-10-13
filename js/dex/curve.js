// Bear Tool — js/launchpad/curve.js
//
// The pricing half of a pump.fun-style launchpad, as pure functions.
//
// The model is a constant-product market maker (x*y=k) over VIRTUAL reserves.
// A fresh token starts with a virtual ETH reserve and a virtual token reserve
// that no one owns — they exist only to set the opening price and to make the
// curve steep at the start and flat near graduation. What a buyer actually
// takes home is the DIFFERENCE between the virtual token reserve before and
// after their trade; what a seller gets back is the difference in virtual ETH.
// Real ETH accumulates in the contract as people buy, and once that real
// reserve reaches the graduation threshold the liquidity is migrated to a
// real Uniswap V2 pool and the curve stops trading.
//
// Everything here is BigInt because the Solidity side is integer math: a JS
// number would drift from the chain by a few wei per trade, and a quote that
// disagrees with the executed price is a quote that lies. The rounding below
// mirrors Solidity's floor division on purpose, so the off-chain preview and
// the on-chain settle agree to the wei.
//
// No simulation anywhere: these are the SAME arithmetic the contract runs,
// used to preview a real transaction that will really be signed.

/** 1e18 — the decimals every launchpad token ships with. */
export const WAD = 10n ** 18n;

/** Basis points denominator (100%). */
export const BPS = 10_000n;

/**
 * The fee split, as pump.fun runs it: 1.25% of every trade.
 * 0.30% goes to the token's creator, 0.95% to the protocol.
 * Pinned by test — a silent change here silently changes every price.
 */
export const FEE_CREATOR_BPS = 30n;   // 0.30%
export const FEE_PROTOCOL_BPS = 95n;  // 0.95%
export const FEE_TOTAL_BPS = FEE_CREATOR_BPS + FEE_PROTOCOL_BPS; // 1.25%

/**
 * Virtual reserves for a brand-new curve.
 *
 * These two numbers ARE the launch parameters: their ratio is the opening
 * price, and their product is the constant k that never changes.
 *
 * They must be the SAME ORDER OF MAGNITUDE as the graduation target, or the
 * curve is dead on arrival: at 30 virtual ETH against a 0.015 ETH graduation
 * the whole bonding phase moved the virtual reserve from 30 to 30.015 ETH, so
 * the price never visibly moved and the chart drew a flat line. Opening at
 * 1 virtual ETH against a 2 ETH graduation makes the reserve triple across
 * the phase — the price roughly triples too, which is the curve a buyer
 * expects to walk — and 1–2 ETH is still faucet-sized on Sepolia.
 */
export const VIRTUAL_ETH = 1n * WAD;
export const VIRTUAL_TOKENS = 1_073_000_000n * WAD; // 1.073B, opening mcap ~1 ETH

/**
 * Real ETH (in wei) that must sit in the contract before the curve graduates
 * to a Uniswap V2 pool. Same order as VIRTUAL_ETH so the price really climbs
 * during the phase, and small enough that a graduation can actually be
 * exercised on Sepolia instead of being an unreachable constant.
 */
export const GRADUATION_ETH = 2n * WAD; // 2 ETH

/**
 * Apply a fee to an input amount, flooring the fee the way Solidity does.
 *
 * @param {bigint} amount
 * @param {bigint} bps
 * @returns {{net: bigint, fee: bigint}} amount after fee, and the fee taken
 */
export function takeFee(amount, bps) {
  const a = BigInt(amount);
  const fee = (a * bps) / BPS;
  return { net: a - fee, fee };
}

/**
 * Split a fee between creator and protocol.
 *
 * @param {bigint} fee
 * @returns {{creator: bigint, protocol: bigint}}
 */
export function splitFee(fee) {
  const f = BigInt(fee);
  const creator = (f * FEE_CREATOR_BPS) / FEE_TOTAL_BPS;
  return { creator, protocol: f - creator };
}

/**
 * How many tokens a buy of `ethIn` wei yields, and the reserves after.
 *
 * @param {bigint} virtualEth   current virtual ETH reserve (wei)
 * @param {bigint} virtualTokens current virtual token reserve (wei)
 * @param {bigint} ethIn        ETH the buyer sends (wei, pre-fee)
 * @returns {{tokensOut: bigint, netEth: bigint, fee: bigint,
 *            nextVirtualEth: bigint, nextVirtualTokens: bigint,
 *            executionPrice: bigint}} executionPrice is wei-per-token-scaled
 *   by WAD (token wei per ETH wei * WAD), i.e. tokens per 1 ETH in WAD.
 *
 * The fee is taken OFF THE TOP: only the net ETH joins the reserves. A trade
 * of exactly 0 returns 0 rather than dividing by zero.
 */
export function quoteBuy(virtualEth, virtualTokens, ethIn) {
  const vE = BigInt(virtualEth);
  const vT = BigInt(virtualTokens);
  const in_ = BigInt(ethIn);
  if (in_ <= 0n || vE <= 0n || vT <= 0n) {
    return {
      tokensOut: 0n, netEth: 0n, fee: 0n,
      nextVirtualEth: vE, nextVirtualTokens: vT, executionPrice: 0n,
    };
  }
  const { net, fee } = takeFee(in_, FEE_TOTAL_BPS);
  // Floor the OUTPUT, never the reserve. Flooring the token reserve would
  // hand the buyer the dust and shrink k; flooring tokensOut leaves the dust
  // in the pool, so the product only ever grows. (tokensOut is algebraically
  // vT - k/(vE+net); floored as a whole it is <= that, i.e. pool-favouring.)
  const nextVirtualEth = vE + net;
  const tokensOut = (vT * net) / nextVirtualEth;
  const nextVirtualTokens = vT - tokensOut;
  // price in token-wei per ETH-wei, scaled by WAD so it stays readable
  const executionPrice = tokensOut > 0n ? (tokensOut * WAD) / net : 0n;
  return {
    tokensOut, netEth: net, fee,
    nextVirtualEth, nextVirtualTokens, executionPrice,
  };
}

/**
 * How much ETH a sell of `tokensIn` yields, and the reserves after.
 *
 * @param {bigint} virtualEth
 * @param {bigint} virtualTokens
 * @param {bigint} tokensIn token wei the seller hands back (pre-fee)
 * @returns {{ethOut: bigint, netTokens: bigint, fee: bigint,
 *            nextVirtualEth: bigint, nextVirtualTokens: bigint,
 *            executionPrice: bigint}}
 *
 * Symmetric to quoteBuy: the fee comes off the tokens, and only the net
 * tokens rejoin the reserves.
 */
export function quoteSell(virtualEth, virtualTokens, tokensIn) {
  const vE = BigInt(virtualEth);
  const vT = BigInt(virtualTokens);
  const in_ = BigInt(tokensIn);
  if (in_ <= 0n || vE <= 0n || vT <= 0n) {
    return {
      ethOut: 0n, netTokens: 0n, fee: 0n,
      nextVirtualEth: vE, nextVirtualTokens: vT, executionPrice: 0n,
    };
  }
  const { net, fee } = takeFee(in_, FEE_TOTAL_BPS);
  // Same rule as quoteBuy: floor the ETH out, so the dust stays in the pool
  // and k only grows. ethOut is algebraically vE - k/(vT+net).
  const nextVirtualTokens = vT + net;
  const ethOut = (vE * net) / nextVirtualTokens;
  const nextVirtualEth = vE - ethOut;
  const executionPrice = ethOut > 0n ? (ethOut * WAD) / net : 0n;
  return {
    ethOut, netTokens: net, fee,
    nextVirtualEth, nextVirtualTokens, executionPrice,
  };
}

/**
 * Graduation progress in basis points, and whether the curve has graduated.
 *
 * @param {bigint} realEthReserve wei of real ETH actually held
 * @param {bigint} [threshold] defaults to GRADUATION_ETH
 * @returns {{bps: bigint, graduated: boolean}}
 *
 * Capped at 10000 so a reserve past the threshold reads as "done", not as
 * 137% — a progress bar that can overflow is a progress bar that lies.
 */
export function graduationProgress(realEthReserve, threshold = GRADUATION_ETH) {
  const held = BigInt(realEthReserve);
  const cap = BigInt(threshold);
  if (cap <= 0n) return { bps: BPS, graduated: held > 0n };
  const raw = (held * BPS) / cap;
  const bps = raw > BPS ? BPS : raw;
  return { bps, graduated: held >= cap };
}

/**
 * The live price on the curve in token-wei per ETH-wei, scaled by WAD.
 *
 * @param {bigint} virtualEth
 * @param {bigint} virtualTokens
 * @returns {bigint} tokens per 1 ETH, in WAD (1e18 = 1:1)
 */
export function spotPrice(virtualEth, virtualTokens) {
  const vE = BigInt(virtualEth);
  const vT = BigInt(virtualTokens);
  if (vE <= 0n) return 0n;
  return (vT * WAD) / vE;
}

/**
 * Tokens per wei, in human units, for display only. Never feeds a trade.
 *
 * @param {bigint} tokenWei
 * @param {number} [digits]
 * @returns {string}
 */
export function fmtTokens(tokenWei, digits = 4) {
  const wad = Number(tokenWei) / Number(WAD);
  return wad.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * Wei of ETH to a human string, for display only.
 *
 * @param {bigint} ethWei
 * @param {number} [digits]
 * @returns {string}
 */
export function fmtEth(ethWei, digits = 6) {
  const eth = Number(ethWei) / Number(WAD);
  return eth.toLocaleString('en-US', { maximumFractionDigits: digits });
}
