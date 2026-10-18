// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/swap.js (Dex v2) — the trade engine, M3.
//
// Built from zero on the M2 contract trio. The ONE machine holds: this
// module NEVER re-derives the x*y=k math in JS — the quote always comes
// from the pair's own getAmountOut view (the M2 fork suite proved the
// view and the execution agree on every coin), so UI and chain cannot
// disagree by a wei.
//
// Money-floor law: parsed amounts FLOOR (never round up) — a parse that
// mints value out of nowhere is a bug, parsed extra fractional digits
// beyond the token's decimals are dropped, and a zero amount never
// leaves this module as a trade.
//
// Allowance law (user order: "approval ber-cap"): approvals are the
// EXACT trade amount, never a hard MAX. Spent allowance after every
// trade returns to zero, so the pool can never carry a standing claim
// on the wallet.
//
// ethers comes off globalThis (app doctrine; bare imports break under
// node --test — see js/max-ui.js for the long version of the story).
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;
import { BEAR_PAIR_ABI } from './abi.js';

// Re-exported so the encoded calldata can be decoded in tests against the
// same table the UI encodes with — one truth, never a test-side copy.
export { BEAR_PAIR_ABI };

const PAIR_I = new ethers.Interface(BEAR_PAIR_ABI);

// ERC-20 approve, the six fields every token answers, shaped here once so
// the dex UI shares one encoding with the tests.
export const ERC20_ABI = [
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 value) returns (bool)',
];
const ERC20_I = new ethers.Interface(ERC20_ABI);

// Slippage: DEFAULT 100 bps = 1% (spec: default slippage, never 0), hard
// cap 3000 bps = 30% — beyond that the trade is not a trade, it is a
// donation with extra steps.
export const SLIP_DEFAULT_BPS = 100;
export const SLIP_MAX_BPS = 3000;

/**
 * Parse a human amount into base units. Exact in spirit: commas become
 * dots once ("1,5"), exponents and signs are refused outright (a trade
 * sheet is not a calculator), more fractional digits than the token
 * carries are FLOORED away, and the result must be > 0.
 * @returns {{ok:true, value:bigint}|{ok:false, why:string}} why ∈
 *   'empty' | 'bad' | 'digits' | 'zeros'
 */
export function parseAmount(raw, decimals = 18) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return { ok: false, why: 'bad' };
  if (typeof raw !== 'string') return { ok: false, why: 'empty' };
  const text = raw.trim().replace(/,/g, '.');
  if (!text) return { ok: false, why: 'empty' };
  if (/[eE]/.test(text) || /[+-]/.test(text) || /[^0-9.]/.test(text) || (text.match(/\./g) || []).length > 1) {
    return { ok: false, why: 'bad' };
  }
  const [intPart, fracPart = ''] = text.split('.');
  if (intPart.length > 64) return { ok: false, why: 'big' };
  const frac = fracPart.slice(0, decimals); // floor, never round up
  let value;
  try {
    value = ethers.parseUnits(`${intPart || '0'}${frac ? '.' + frac : ''}`, decimals);
  } catch {
    return { ok: false, why: 'bad' };
  }
  return value === 0n ? { ok: false, why: 'zeros' } : { ok: true, value };
}

/**
 * The slippage floor for an expected out-amount: minOut = out ×
 * (10000 − bps) / 10000, floored. bps must be an integer 1..3000 — a 0 bps
 * minOut (no protection) and anything above the cap are refused, the
 * caller cannot "fix" the number by passing a string.
 */
export function slippageMinOut(out, bps = SLIP_DEFAULT_BPS) {
  if (typeof out !== 'bigint' || out < 0n) throw new Error('dex/minout: out must be a non-negative bigint');
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 1 || bps > SLIP_MAX_BPS) {
    throw new Error('dex/minout: bps must be an integer 1..3000');
  }
  return (out * BigInt(10000 - bps)) / 10000n;
}

/** Calldata for an EXACT-amount ERC-20 approve. Never MAX. */
export function approveData(token, spender, amountIn) {
  if (!isAddress(token) || !isAddress(spender)) throw new Error('dex/approve: address');
  return ERC20_I.encodeFunctionData('approve', [spender, amountIn]);
}

/**
 * Calldata for the trade itself. buy=true → pay quote, get token
 * (swapQuoteForToken); buy=false → pay token, get quote
 * (swapTokenForQuote). minOut travels verbatim to the contract — the UI
 * never widens a user's protection, only the slip-band math above does.
 */
export function swapData(buy, amountIn, minOut, to) {
  if (typeof to !== 'string') throw new Error('dex/swap: to');
  return buy
    ? PAIR_I.encodeFunctionData('swapQuoteForToken', [amountIn, minOut, to])
    : PAIR_I.encodeFunctionData('swapTokenForQuote', [amountIn, minOut, to]);
}

/** The pair contract at `pair`, bound for reads (provider-like). */
export function pairContract(pair, providerLike) {
  return new ethers.Contract(pair, BEAR_PAIR_ABI, providerLike);
}

/** ERC-20 token contract bound for reads/writes as given. */
export function tokenContract(token, providerLike) {
  return new ethers.Contract(token, ERC20_ABI, providerLike);
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function isAddress(a) {
  return typeof a === 'string' && ADDR_RE.test(a);
}

/**
 * Resolve a pasted pair address into a readable trade surface: both coin
 * addresses AND their real decimals (read from the live tokens — BearToken
 * pins uint8=18, but the quote coin is whatever the factory pinned, and a
 * 6-decimal quote must not be parsed as 18; the sheet follows the chain).
 * Throws with `e.why = 'bad'` on a non-address; RPC failures carry the
 * provider's own message.
 */
export async function readPair(providerLike, pairAddress) {
  if (!isAddress(pairAddress)) {
    const e = new Error('dex/pair: not-an-address'); e.why = 'bad'; throw e;
  }
  const pair = pairContract(pairAddress, providerLike);
  const token = await pair.token();
  const quote = await pair.quote();
  const traded = tokenContract(token, providerLike);
  const paying = tokenContract(quote, providerLike);
  const [tokenDecimals, quoteDecimals] = await Promise.all([traded.decimals(), paying.decimals()]);
  return {
    pair,
    token: { address: token, decimals: Number(tokenDecimals), contract: traded },
    quote: { address: quote, decimals: Number(quoteDecimals), contract: paying },
  };
}
