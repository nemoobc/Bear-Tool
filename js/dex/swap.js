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
import { provider, ethersLib, isAddr, get, sendDexTx, needSigner, t, escapeHtml, fmtTok, $, dexChainOk, quoteBy } from './core.js';
import { getAmountOut, minOutWithSlippage, priceImpact } from './pool-math.js';
import { discoverPools, fillMeta } from './pools.js';
import { allowanceOf, poolState, tokenInfo } from './pool-data.js';
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
// Shell first (index.js paints it), then bindSwap wires it. Selection and
// quoting are local until the one action button, which runs the same two
// transactions the e2e proves on anvil: approve-only-if-needed, then swap.
// Every read goes through pool-data.js, so the Swap tab and the Pools tab can
// never disagree about a pool.

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
      <div class="mt-8" role="group" aria-label="${escapeHtml(t('dex.swap.dir'))}">
        <button type="button" class="dex-tab" data-dex-swap-dir="buy" aria-pressed="true">${escapeHtml(t('dex.swap.buy'))}</button>
        <button type="button" class="dex-tab" data-dex-swap-dir="sell" aria-pressed="false">${escapeHtml(t('dex.swap.sell'))}</button>
      </div>
      <label class="field-label mt-8" for="dexSwapAmount">${escapeHtml(t('dex.swap.pay'))}</label>
      <input id="dexSwapAmount" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" id="dexSwapMax">${escapeHtml(t('dex.swap.max'))}</button>
      </div>
      <div class="small mt-8" id="dexSwapBal"></div>
      <div class="small mt-8" id="dexSwapQuote" aria-live="polite"></div>
      <button type="button" class="btn btn-primary btn-block mt-8" id="dexSwapGo" disabled>${escapeHtml(t('dex.swap.pickAmount'))}</button>
      <div class="small mt-8" id="dexSwapNote" role="status"></div>
    </div>`;
}

export async function bindSwap(host) {
  const sel = $('#dexSwapPool', host);
  const input = $('#dexSwapAmount', host);
  const maxBtn = $('#dexSwapMax', host);
  const balEl = $('#dexSwapBal', host);
  const quoteEl = $('#dexSwapQuote', host);
  const goBtn = $('#dexSwapGo', host);
  const noteEl = $('#dexSwapNote', host);
  if (!sel || !input || !maxBtn || !balEl || !quoteEl || !goBtn || !noteEl) return;

  let dir = 'buy';
  let pools = [];
  let cur = null;
  const note = (msg) => { noteEl.textContent = msg || ''; };
  const dead = (msg) => {
    cur = null;
    note(msg);
    goBtn.disabled = true;
    quoteEl.textContent = '';
    balEl.textContent = '';
    sel.disabled = true;
    input.disabled = true;
    maxBtn.disabled = true;
  };

  if (!dexChainOk()) { dead(t('dex.gate.needSepolia')); return; }
  if (!provider()) { dead(t('dex.swap.unreadable')); return; }

  note(t('dex.swap.loading'));
  const out = await discoverPools({ scope: 'all', limit: 50 });
  if (!out.ok) { dead(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.swap.unreadable')); return; }
  if (!out.pools.length) { dead(t('dex.swap.noPools')); return; }
  pools = await fillMeta(out.pools.slice());

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

  const loadPool = async () => {
    const row = pools.find((r) => r.address === sel.value) || pools[0];
    set('dex.swapToken', row.address);
    note(t('dex.swap.loading'));
    const [ps, ti, qi] = await Promise.all([
      poolState(row.pair),
      tokenInfo(row.address, get('address')),
      tokenInfo(row.quote, get('address')),
    ]);
    if (!ps.ok) { dead(t('dex.swap.unreadable')); return; }
    const qPreset = quoteBy(row.quote);
    cur = {
      row,
      ps,
      td: ti.ok ? ti.decimals : 18,
      tSym: ti.ok && ti.symbol ? ti.symbol : shortOf(row.address),
      qd: qi.ok ? qi.decimals : (qPreset ? qPreset.decimals : 18),
      qSym: qPreset ? qPreset.symbol : '…',
      tBal: ti.ok ? ti.balance : 0n,
      qBal: qi.ok ? qi.balance : 0n,
    };
    note('');
    refresh();
  };

  const quoteOf = () => {
    if (!cur) return null;
    const parsed = parseAmount(input.value, dir === 'buy' ? cur.qd : cur.td);
    if (!parsed.ok) return null;
    const q = swapQuote({
      quoteReserve: cur.ps.quoteReserve,
      tokenReserve: cur.ps.tokenReserve,
      direction: dir,
      amountIn: parsed.value,
    });
    return q.ok ? { parsed, q } : null;
  };

  const refresh = () => {
    if (!cur) return;
    const inSym = dir === 'buy' ? cur.qSym : cur.tSym;
    const inDec = dir === 'buy' ? cur.qd : cur.td;
    const outSym = dir === 'buy' ? cur.tSym : cur.qSym;
    const outDec = dir === 'buy' ? cur.td : cur.qd;
    const bal = dir === 'buy' ? cur.qBal : cur.tBal;
    balEl.textContent = t('dex.swap.balance', { amt: fmtTok(bal, inDec, 6), sym: inSym });
    const got = quoteOf();
    if (!got) {
      quoteEl.textContent = input.value.trim() ? t('dex.swap.pickAmount') : '';
      goBtn.disabled = true;
    } else {
      const inRes = dir === 'buy' ? cur.ps.quoteReserve : cur.ps.tokenReserve;
      const outRes = dir === 'buy' ? cur.ps.tokenReserve : cur.ps.quoteReserve;
      const impact = priceImpact(got.parsed.value, inRes, outRes);
      quoteEl.innerHTML =
        `<strong>≈ ${escapeHtml(fmtTok(got.q.amountOut, outDec, 6))} ${escapeHtml(outSym)}</strong> · `
        + `${escapeHtml(t('dex.swap.min'))}: ${escapeHtml(fmtTok(got.q.minOut, outDec, 6))} ${escapeHtml(outSym)}`
        + (impact > 0.00005 ? ` · ${escapeHtml(t('dex.swap.impact'))}: ${(impact * 100).toFixed(2)}%` : '');
      goBtn.disabled = false;
    }
    goBtn.textContent = dir === 'buy' ? t('dex.swap.go.buy', { sym: cur.tSym }) : t('dex.swap.go.sell', { sym: cur.tSym });
  };

  for (const btn of host.querySelectorAll('[data-dex-swap-dir]')) {
    btn.addEventListener('click', () => {
      dir = btn.dataset.dexSwapDir === 'sell' ? 'sell' : 'buy';
      for (const b of host.querySelectorAll('[data-dex-swap-dir]')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      input.value = '';
      refresh();
    });
  }
  sel.addEventListener('change', () => { loadPool(); });
  input.addEventListener('input', refresh);
  maxBtn.addEventListener('click', () => {
    if (!cur) return;
    const E = ethersLib();
    if (!E) return;
    const bal = dir === 'buy' ? cur.qBal : cur.tBal;
    if (bal <= 0n) return;
    input.value = E.formatUnits(bal, dir === 'buy' ? cur.qd : cur.td);
    refresh();
  });
  goBtn.addEventListener('click', async () => {
    if (!cur) return;
    const got = quoteOf();
    if (!got) { note(t('dex.swap.pickAmount')); return; }
    const signer = needSigner();
    if (!signer) return;
    goBtn.disabled = true;
    const inAddr = dir === 'buy' ? cur.row.quote : cur.row.address;
    const appr = await ensureAllowanceTx({
      token: inAddr,
      spender: cur.row.pair,
      amount: got.parsed.value,
      owner: signer.address,
      signer,
    });
    if (!appr.ok) { refresh(); return; }
    const rc = await swapTx({
      pair: cur.row.pair,
      direction: dir,
      amountIn: got.parsed.value,
      minOut: got.q.minOut,
      signer,
    });
    if (rc) {
      input.value = '';
      await loadPool(); // reserves and balances moved — re-read, never assume
    } else {
      refresh();
    }
  });

  await loadPool();
}
