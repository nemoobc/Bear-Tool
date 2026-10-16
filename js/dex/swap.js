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
import { provider, ethersLib, isAddr, get, set, sendDexTx, needSigner, t, escapeHtml, $, dexChainOk, quoteBy } from './core.js';
import { getAmountOut, minOutWithSlippage } from './pool-math.js';
import { discoverPools, fillMeta } from './pools.js';
import { allowanceOf } from './pool-data.js';
import { mountTradeSheet } from './trade-sheet.js';
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

// ── the Swap panel ─────────────────────────────────────────────
// Shell first (index.js paints it), then bindSwap wires it: the pool PICKER
// is the panel's own job; everything below it is the shared TradeSheet
// (trade-sheet.js) — the same component the token page mounts, so the two
// screens can never disagree about what buying means. The sheet runs the two
// transactions the e2e proves on anvil: approve-only-if-needed, then swap.

export function swapHtml() {
  return `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.swap.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.swap.hint'))}</div>
      </div>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexSwapPool">${escapeHtml(t('dex.swap.pool'))}</label>
      <select id="dexSwapPool" class="input"></select>
      <div id="dexSwapSheet" class="mt-8"></div>
      <div class="small mt-8" id="dexSwapNote" role="status"></div>
    </div>`;
}

export async function bindSwap(host) {
  const sel = $('#dexSwapPool', host);
  const sheetEl = $('#dexSwapSheet', host);
  const noteEl = $('#dexSwapNote', host);
  if (!sel || !sheetEl || !noteEl) return;

  const note = (msg) => { noteEl.textContent = msg || ''; };
  // The panel-level dead end is only ever about the LIST (chain, factory,
  // pools). Once a pool is picked, the sheet owns every state — and its one
  // failure mode is a visible reason plus a retry, never a silent grey.
  const dead = (msg) => { note(msg); sel.disabled = true; };

  if (!dexChainOk()) { dead(t('dex.gate.needSepolia')); return; }
  if (!provider()) { dead(t('dex.swap.unreadable')); return; }

  note(t('dex.swap.loading'));
  const out = await discoverPools({ scope: 'all', limit: 50 });
  if (!out.ok) { dead(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.swap.unreadable')); return; }
  if (!out.pools.length) { dead(t('dex.swap.noPools')); return; }
  const pools = await fillMeta(out.pools.slice());

  const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const labelOf = (r) => {
    const q = quoteBy(r.quote);
    return `${r.symbol || shortOf(r.address)} / ${q ? q.symbol : '…'}`;
  };
  sel.innerHTML = pools.map(() => '<option></option>').join('');
  [...sel.options].forEach((o, i) => { o.textContent = labelOf(pools[i]); });
  const wanted = String(get('dex.swapToken') || '').toLowerCase();
  const pick = pools.find((r) => r.address.toLowerCase() === wanted) || pools[0];
  sel.value = pick.address;

  // One mount per pick: the sheet is emptied and rebuilt, so there is exactly
  // ONE trade form, always reading the pool the select shows.
  const show = (row) => {
    set('dex.swapToken', row.address);
    note('');
    mountTradeSheet(sheetEl, { address: row.address, pair: row.pair, quote: row.quote, symbol: row.symbol });
  };
  sel.addEventListener('change', () => {
    show(pools.find((r) => r.address === sel.value) || pools[0]);
  });
  show(pick);
}
