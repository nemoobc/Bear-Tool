// Bear Tool — js/launchpad/curve.js
//
// The pricing half of a pump.fun-style launchpad, as pure functions.
//
// The model is a constant-product market maker (x*y=k) over VIRTUAL reserves.
// A fresh token starts with a virtual quote reserve and a virtual token reserve
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
export const VIRTUAL_QUOTE = 1n * WAD;
export const VIRTUAL_TOKENS = 1_073_000_000n * WAD; // 1.073B, opening mcap ~1 ETH

/**
 * Real ETH (in wei) that must sit in the contract before the curve graduates
 * to a Uniswap V2 pool. Same order as VIRTUAL_QUOTE so the price really climbs
 * during the phase, and small enough that a graduation can actually be
 * exercised on Sepolia instead of being an unreachable constant.
 */
export const GRADUATION_QUOTE = 2n * WAD; // 2 ETH

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
 * @param {bigint} virtualQuote   current virtual quote reserve (wei)
 * @param {bigint} virtualTokens current virtual token reserve (wei)
 * @param {bigint} ethIn        ETH the buyer sends (wei, pre-fee)
 * @returns {{tokensOut: bigint, netEth: bigint, fee: bigint,
 *            nextVirtualQuote: bigint, nextVirtualTokens: bigint,
 *            executionPrice: bigint}} executionPrice is wei-per-token-scaled
 *   by WAD (token wei per ETH wei * WAD), i.e. tokens per 1 ETH in WAD.
 *
 * The fee is taken OFF THE TOP: only the net ETH joins the reserves. A trade
 * of exactly 0 returns 0 rather than dividing by zero.
 */
export function quoteBuy(virtualQuote, virtualTokens, ethIn) {
  const vE = BigInt(virtualQuote);
  const vT = BigInt(virtualTokens);
  const in_ = BigInt(ethIn);
  if (in_ <= 0n || vE <= 0n || vT <= 0n) {
    return {
      tokensOut: 0n, netEth: 0n, fee: 0n,
      nextVirtualQuote: vE, nextVirtualTokens: vT, executionPrice: 0n,
    };
  }
  const { net, fee } = takeFee(in_, FEE_TOTAL_BPS);
  // Floor the OUTPUT, never the reserve. Flooring the token reserve would
  // hand the buyer the dust and shrink k; flooring tokensOut leaves the dust
  // in the pool, so the product only ever grows. (tokensOut is algebraically
  // vT - k/(vE+net); floored as a whole it is <= that, i.e. pool-favouring.)
  const nextVirtualQuote = vE + net;
  const tokensOut = (vT * net) / nextVirtualQuote;
  const nextVirtualTokens = vT - tokensOut;
  // price in token-wei per ETH-wei, scaled by WAD so it stays readable
  const executionPrice = tokensOut > 0n ? (tokensOut * WAD) / net : 0n;
  return {
    tokensOut, netEth: net, fee,
    nextVirtualQuote, nextVirtualTokens, executionPrice,
  };
}

/**
 * How much ETH a sell of `tokensIn` yields, and the reserves after.
 *
 * @param {bigint} virtualQuote
 * @param {bigint} virtualTokens
 * @param {bigint} tokensIn token wei the seller hands back
 * @returns {{quoteOut: bigint, netTokens: bigint, fee: bigint,
 *            nextVirtualQuote: bigint, nextVirtualTokens: bigint,
 *            executionPrice: bigint}}
 *
 * NOT symmetric to quoteBuy: the contract takes the sell fee off the QUOTE
 * output (not off the input tokens) and the full tokensIn rejoins the pool —
 * see the comment inside for why matching sell()'s ordering matters.
 */
export function quoteSell(virtualQuote, virtualTokens, tokensIn) {
  const vE = BigInt(virtualQuote);
  const vT = BigInt(virtualTokens);
  const in_ = BigInt(tokensIn);
  if (in_ <= 0n || vE <= 0n || vT <= 0n) {
    return {
      quoteOut: 0n, netTokens: 0n, fee: 0n,
      nextVirtualQuote: vE, nextVirtualTokens: vT, executionPrice: 0n,
    };
  }
  // Mirrors the contract's sell() EXACTLY (js/dex/pump-source.js:219): the
  // curve runs on the FULL tokensIn, and the fee is taken off the QUOTE OUTPUT
  // — not off the input tokens. An earlier version subtracted the fee from
  // tokensIn first and priced the net, which over-quoted the seller by up to
  // ~0.42% versus what sell() actually pays (the two orderings are not
  // algebraically equal under floor division, and the gap only widened on
  // larger sells). The on-chain number is the truth; this must match it.
  const gross = (vE * in_) / (vT + in_);          // quoteOut before fee
  const { net, fee } = takeFee(gross, FEE_TOTAL_BPS);  // fee off the output
  const nextVirtualTokens = vT + in_;             // FULL tokens rejoin the pool
  const nextVirtualQuote = vE - net;              // only the payout leaves
  const executionPrice = net > 0n ? (net * WAD) / in_ : 0n;
  return {
    quoteOut: net, netTokens: in_, fee,
    nextVirtualQuote, nextVirtualTokens, executionPrice,
  };
}

/**
 * Graduation progress in basis points, and whether the curve has graduated.
 *
 * @param {bigint} realQuoteReserve wei of real ETH actually held
 * @param {bigint} [threshold] defaults to GRADUATION_QUOTE
 * @returns {{bps: bigint, graduated: boolean}}
 *
 * Capped at 10000 so a reserve past the threshold reads as "done", not as
 * 137% — a progress bar that can overflow is a progress bar that lies.
 */
export function graduationProgress(realQuoteReserve, threshold = GRADUATION_QUOTE) {
  const held = BigInt(realQuoteReserve);
  const cap = BigInt(threshold);
  if (cap <= 0n) return { bps: BPS, graduated: held > 0n };
  const raw = (held * BPS) / cap;
  const bps = raw > BPS ? BPS : raw;
  return { bps, graduated: held >= cap };
}

/**
 * The live price on the curve in token-wei per ETH-wei, scaled by WAD.
 *
 * @param {bigint} virtualQuote
 * @param {bigint} virtualTokens
 * @returns {bigint} tokens per 1 ETH, in WAD (1e18 = 1:1)
 */
export function spotPrice(virtualQuote, virtualTokens) {
  const vE = BigInt(virtualQuote);
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

/**
 * A price, for display only, at a fixed number of SIGNIFICANT digits.
 *
 * A bonding curve starts near 1e-13 quote per token, and `toFixed(4)` renders
 * every price a fresh coin will ever have as "0.0000" — on a page that also
 * shows the real signed trades, that reads as a broken feed rather than a tiny
 * number. `toExponential(4)` replaced the zeros but not the confusion:
 * "1.2345e-13" is developer notation, not a ticker.
 *
 * Significant digits instead of fixed ones keeps the price readable at ANY
 * scale the curve can reach (1e-13 … 1e3) without ever falling back to
 * exponent notation. Nothing here feeds a trade — the contract's own integer
 * maths does — so this is a display helper and says so.
 *
 * @param {number} n
 * @param {number} [sig] significant digits, 1–18
 * @returns {string}
 */
export function fmtPrice(n, sig = 4) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  const s = Math.min(18, Math.max(1, Math.round(Number(sig) || 4)));
  const exp = Math.floor(Math.log10(Math.abs(v)));
  // Strip what we already spent on the integer part (none below 1) and cap at
  // the 18 decimals a wei-denominated price can meaningfully carry.
  const decimals = Math.min(18, Math.max(0, s - 1 - exp));
  const out = v.toLocaleString('en-US', { maximumFractionDigits: decimals });
  // A sub-1 price that still rounds to zero would be worse than the zeros we
  // set out to remove: say so with a bound instead of printing "0".
  if (Number(out.replace(/,/g, '')) === 0) return `<${(10 ** -decimals).toLocaleString('en-US', { maximumFractionDigits: 18 })}`;
  return out;
}
