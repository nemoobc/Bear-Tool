// Bear Tool — js/dex/swap.js
// The v2 swap ENGINE: quoting and the two transactions a buy or a sell is made
// of. The view that renders it lands with the tab wiring; everything here is
// proven before any pixel is drawn —
//
//   • parseAmount / swapQuote are PURE: same BigInt floor math as BearPair
//     (pool-math.js mirrors the contract wei-for-wei), unit-tested, and the
//     e2e proves a real trade moved the reserves by exactly what the quote
//     said before the transaction.
//   • The tx path rides the shared spine (sendDexTx): bounded broadcast,
//     bounded receipt wait, verdict. An approve is only sent when the
//     allowance actually falls short — the chain is asked, twice, not guessed.
//
// Direction vocabulary: 'buy' = quote in, token out (swapQuoteForToken);
// 'sell' = token in, quote out (swapTokenForQuote).
import { provider, ethersLib, isAddr, get, sendDexTx, needSigner } from './core.js';
import { getAmountOut, minOutWithSlippage } from './pool-math.js';
import { allowanceOf } from './pool-data.js';
import { BEAR_PAIR_ABI, BEAR_TOKEN_ABI } from './bear-source.js';

// 0.5% — one place. The view may offer other values, but the default is here,
// so a quote computed anywhere else in the app agrees with the form.
export const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * A typed amount → base units, EXACTLY. No silent rounding: "1.23456789…"
 * beyond the token's decimals is refused, not trimmed — a swap that quietly
 * drops the tail of the number the user typed is a swap they did not ask for.
 * @returns {{ok:true, value:bigint} | {ok:false, reason}}
 */
export function parseAmount(input, decimals) {
  // Only '.' is a decimal point. A comma is refused rather than guessed at:
  // "1,5" means 1.5 to one user and "1,500" means fifteen hundred to another,
  // and a swap that misreads the number the user typed is a swap they did not
  // ask for. The form's hint says so.
  const s = String(input ?? '').trim().replace(/[\s_]/g, '');
  if (s === '' || s === '.') return { ok: false, reason: 'number' };
  if (!/^\d*(\.\d*)?$/.test(s)) return { ok: false, reason: 'number' };
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return { ok: false, reason: 'decimals' };
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > dec) return { ok: false, reason: 'too many decimals' };
  const value = BigInt((whole || '0') + frac.padEnd(dec, '0'));
  if (value <= 0n) return { ok: false, reason: 'zero' };
  return { ok: true, value };
}

/**
 * The quote for a swap, offchain, with the contract's own floor math (pool-math
 * mirrors BearPair getAmountOut). Pure: no provider, no state — which is what
 * lets the e2e compare it against a real trade afterwards.
 *
 * Mirrors the contract guards too: a swap that would take the WHOLE out-side
 * reserve is refused here the way BearPair refuses it ("deep") — not shown as
 * a price the transaction would never accept.
 *
 * @returns {{ok:true, amountOut:bigint, minOut:bigint} | {ok:false, reason}}
 */
export function swapQuote({ quoteReserve, tokenReserve, direction, amountIn, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const buy = direction === 'buy';
  const q = BigInt(quoteReserve ?? 0);
  const tk = BigInt(tokenReserve ?? 0);
  const amount = BigInt(amountIn ?? 0);
  if (!(amount > 0n)) return { ok: false, reason: 'amount' };
  const inRes = buy ? q : tk;
  const outRes = buy ? tk : q;
  if (!(inRes > 0n) || !(outRes > 0n)) return { ok: false, reason: 'reserves' };
  const amountOut = getAmountOut(amount, inRes, outRes);
  if (amountOut <= 0n) return { ok: false, reason: 'too small' };
  if (amountOut >= outRes) return { ok: false, reason: 'deep' }; // the contract's own line
  const minOut = minOutWithSlippage(amountOut, slippageBps);
  return { ok: true, amountOut, minOut };
}

/**
 * Send the swap. One transaction, through the shared spine; the receipt on
 * success, null when the wallet is locked or the tx does not confirm (the
 * toast has already said which).
 */
export async function swapTx({ pair, direction, amountIn, minOut, signer } = {}) {
  if (!isAddr(pair)) return null;
  if (!(BigInt(amountIn ?? 0) > 0n) || !(BigInt(minOut ?? 0) >= 0n)) return null;
  const s = signer || needSigner();
  if (!s) return null;
  const E = ethersLib();
  if (!E || !provider()) return null;
  const c = new E.Contract(pair, BEAR_PAIR_ABI, s);
  const buy = direction === 'buy';
  const fn = buy
    ? () => c.swapQuoteForToken(BigInt(amountIn), BigInt(minOut))
    : () => c.swapTokenForQuote(BigInt(amountIn), BigInt(minOut));
  return sendDexTx(fn, buy ? 'Buy' : 'Sell');
}

/**
 * Make sure `spender` can take `amount` of `token` from `owner` — asking the
 * chain, not assuming. Approves the EXACT amount (not an infinite grant) and
 * only when the current allowance falls short.
 * @returns {Promise<{ok:true, approved:boolean} | {ok:false, reason}>}
 */
export async function ensureAllowanceTx({ token, spender, amount, owner, signer } = {}) {
  let amt = 0n;
  try { amt = BigInt(amount ?? 0); } catch { amt = 0n; }
  if (!isAddr(token) || !isAddr(spender) || !(amt > 0n)) return { ok: false, reason: 'bad args' };
  const s = signer || needSigner();
  if (!s) return { ok: false, reason: 'no signer' };
  const E = ethersLib();
  if (!E || !provider()) return { ok: false, reason: 'no provider' };
  const o = isAddr(owner) ? owner : String(s.address || get('address') || '');
  if (!isAddr(o)) return { ok: false, reason: 'no owner' };
  const a = await allowanceOf(token, o, spender);
  if (!a.ok) return { ok: false, reason: a.reason };
  if (a.allowance >= amt) return { ok: true, approved: false };
  const c = new E.Contract(token, BEAR_TOKEN_ABI, s);
  const rc = await sendDexTx(() => c.approve(spender, amt), 'Approve');
  return rc ? { ok: true, approved: true } : { ok: false, reason: 'approve failed' };
}
