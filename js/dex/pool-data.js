// Bear Tool — js/dex/pool-data.js
// The v2 surfaces (Swap, Pools, Liquidity, Portfolio, token page) all read a
// pool the same way — through here, so no view invents its own numbers.
//
// Three facts, deliberately:
//   • Reserves are the pool's ACTUAL balances (quote first, then token —
//     the contract's own order), read live. A pool that cannot be read says
//     so; it never renders as a zero pool.
//   • Decimals are READ from each contract, never assumed. The quote coins
//     are the user's own ERC-20s and one of them may not be 18-decimal; a UI
//     that hardcodes 18 misprices an amount by a factor of a trillion.
//   • LP shares are the pair's ERC-20 balance. The pair IS the LP token; a
//     position is balanceOf, and its lock is lockedUntil — both asked of the
//     chain, not remembered from the launch form.
//
// Every function returns { ok: true, … } or { ok: false, reason } — the same
// found / found-none / could-not-look discipline as discovery (pools.js).
import { provider, ethersLib, isAddr } from './core.js';
import { BEAR_PAIR_ABI, BEAR_TOKEN_ABI } from './bear-source.js';

function chain() {
  const p = provider();
  const E = ethersLib();
  if (!p || !E) return null;
  return { p, E };
}

/**
 * One pool's live state.
 * @returns {Promise<{ok:true, quote, token, quoteReserve, tokenReserve, supply}
 *   | {ok:false, reason}>} — reserves in the contract's order (quote first),
 *   supply = LP total supply (the pair's own ERC-20).
 */
export async function poolState(pair) {
  const a = String(pair || '').trim();
  if (!isAddr(a)) return { ok: false, reason: 'bad address' };
  const c = chain();
  if (!c) return { ok: false, reason: 'no provider' };
  try {
    const pairC = new c.E.Contract(a, BEAR_PAIR_ABI, c.p);
    const [quote, token, reserves, supply] = await Promise.all([
      pairC.quote(), pairC.token(), pairC.reserves(), pairC.totalSupply(),
    ]);
    return {
      ok: true,
      quote,
      token,
      quoteReserve: BigInt(reserves[0]),
      tokenReserve: BigInt(reserves[1]),
      supply: BigInt(supply),
    };
  } catch (e) {
    return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
  }
}

/**
 * A token's identity and (when an owner is given) the owner's balance.
 * @param {string} addr
 * @param {string} [owner]  optional; no owner = balance stays 0n
 * @returns {Promise<{ok:true, name, symbol, decimals, balance} | {ok:false, reason}>}
 */
export async function tokenInfo(addr, owner) {
  const a = String(addr || '').trim();
  if (!isAddr(a)) return { ok: false, reason: 'bad address' };
  const c = chain();
  if (!c) return { ok: false, reason: 'no provider' };
  try {
    const t = new c.E.Contract(a, BEAR_TOKEN_ABI, c.p);
    const [name, symbol, dec] = await Promise.all([t.name(), t.symbol(), t.decimals()]);
    let balance = 0n;
    if (isAddr(owner)) balance = BigInt(await t.balanceOf(owner));
    return { ok: true, name: String(name), symbol: String(symbol), decimals: Number(dec), balance };
  } catch (e) {
    return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
  }
}

/**
 * The wallet's position in one pool: shares (the pair's ERC-20 balance), the
 * lock the owner carries, and what the shares are worth right now — computed
 * floor, the same way removeLiquidity pays out, so the display never promises
 * a wei the contract will not send.
 * @returns {Promise<{ok:true, shares, lockedUntil, quoteShare, tokenShare}
 *   | {ok:false, reason}>}
 */
export async function lpPosition(pair, owner) {
  const a = String(pair || '').trim();
  if (!isAddr(a)) return { ok: false, reason: 'bad address' };
  if (!isAddr(owner)) return { ok: false, reason: 'no owner' };
  const c = chain();
  if (!c) return { ok: false, reason: 'no provider' };
  try {
    const pairC = new c.E.Contract(a, BEAR_PAIR_ABI, c.p);
    const [shares, lockedUntil, reserves, supply] = await Promise.all([
      pairC.balanceOf(owner), pairC.lockedUntil(owner), pairC.reserves(), pairC.totalSupply(),
    ]);
    const s = BigInt(shares);
    const total = BigInt(supply);
    const qRes = BigInt(reserves[0]);
    const tRes = BigInt(reserves[1]);
    const quoteShare = s > 0n && total > 0n ? (s * qRes) / total : 0n;
    const tokenShare = s > 0n && total > 0n ? (s * tRes) / total : 0n;
    return { ok: true, shares: s, lockedUntil: BigInt(lockedUntil), quoteShare, tokenShare };
  } catch (e) {
    return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
  }
}

/**
 * ERC-20 allowance, asked before any spend that needs one. The swap flow uses
 * this to decide approve-then-swap vs swap alone; showing "approve" when the
 * allowance is already there is a second sheet the user did not need.
 * @returns {Promise<{ok:true, allowance} | {ok:false, reason}>}
 */
export async function allowanceOf(token, owner, spender) {
  const a = String(token || '').trim();
  if (!isAddr(a) || !isAddr(owner) || !isAddr(spender)) return { ok: false, reason: 'bad address' };
  const c = chain();
  if (!c) return { ok: false, reason: 'no provider' };
  try {
    const t = new c.E.Contract(a, BEAR_TOKEN_ABI, c.p);
    return { ok: true, allowance: BigInt(await t.allowance(owner, spender)) };
  } catch (e) {
    return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
  }
}
