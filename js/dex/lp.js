// Bear Tool — js/dex/lp.js
// The Liquidity panel (v2): be the pool's LP.
//
// The pair IS the LP token, so "liquidity" here means exactly three things:
// add both sides and mint shares, burn shares to pull both sides back out,
// and lock shares so the wallet that launched a pool cannot rug it.
//
// The previews (addPreview / removePreview) mirror the contract's mint/burn
// rules to the wei — the anvil e2e pins them against the real pair.
import { provider, ethersLib, get, set, sendDexTx, needSigner, t, escapeHtml, fmtTok, fmtPrice, confirmTx, withTxButton, $, dexChainOk, quoteBy, openEdu } from './core.js';
import { addShares, removeAmounts, minOutWithSlippage } from './pool-math.js';
import { parseAmount, ensureAllowanceTx, DEFAULT_SLIPPAGE_BPS } from './swap.js';
import { discoverPools, fillMeta } from './pools.js';
import { poolState, tokenInfo, lpPosition } from './pool-data.js';
import { pool24h } from './holders.js';
import { BEAR_PAIR_ABI } from './bear-source.js';
import { normalizeAmountInput } from './trade-sheet.js';

const LOCK_CHOICES = [7, 30, 90, 365]; // days — a creator lock, not a yield farm

/**
 * Shares an addLiquidity would mint, with the contract's exact rule (min of
 * the two proportional claims, reserves read BEFORE the deposit) plus the
 * slippage floor. Pure — the panel and the tests share this arithmetic.
 */
export function addPreview({ quoteIn, tokenIn, quoteReserve, tokenReserve, supply, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  if (quoteIn <= 0n || tokenIn <= 0n) return { ok: false, reason: 'amounts' };
  if (quoteReserve <= 0n || tokenReserve <= 0n) return { ok: false, reason: 'reserves' };
  if (supply <= 0n) return { ok: false, reason: 'shares' };
  const shares = addShares(quoteIn, tokenIn, quoteReserve, tokenReserve, supply);
  if (shares <= 0n) return { ok: false, reason: 'too small' };
  return { ok: true, shares, minShares: minOutWithSlippage(shares, slippageBps) };
}

/**
 * Amounts a burn of `shares` would return (floor per side), plus the floors
 * the tx must carry. Pure, same contract rule as removeLiquidity.
 */
export function removePreview({ shares, quoteReserve, tokenReserve, supply, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  if (shares <= 0n) return { ok: false, reason: 'amounts' };
  if (quoteReserve <= 0n || tokenReserve <= 0n) return { ok: false, reason: 'reserves' };
  if (supply <= 0n) return { ok: false, reason: 'shares' };
  const { quoteOut, tokenOut } = removeAmounts(shares, quoteReserve, tokenReserve, supply);
  if (quoteOut <= 0n && tokenOut <= 0n) return { ok: false, reason: 'too small' };
  return {
    ok: true,
    quoteOut,
    tokenOut,
    minQuote: minOutWithSlippage(quoteOut, slippageBps),
    minToken: minOutWithSlippage(tokenOut, slippageBps),
  };
}

// ── the clarity helpers (riset R10: "add liquidity bikin bingung") ────
// The contract mints min(quote claim, token claim): a lopsided deposit does
// not fail, it silently wastes the stronger side. These pure helpers are how
// the panel teaches the ratio loop instead of letting users lose value to
// discover it — Auto-fill follows the reserves, the preview says what the
// share actually becomes, the imbalance is named in money.

/** The other side of a balanced deposit: amountIn × reserveOut / reserveIn (floor). */
export function otherSideFromRatio(amountIn, reserveIn, reserveOut) {
  if (typeof amountIn !== 'bigint' || typeof reserveIn !== 'bigint' || typeof reserveOut !== 'bigint') return { ok: false };
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return { ok: false };
  const value = (amountIn * reserveOut) / reserveIn;
  if (value <= 0n) return { ok: false };
  return { ok: true, value };
}

/**
 * "Your share: a% → b%" in exact bigint basis points — the two numbers the
 * user reads are the two numbers the chain will produce (no float drift).
 * `delta` is the shares about to be minted (+) or burned (−); one formula,
 * because minting and burning move shares and supply together.
 */
export function sharePctShift({ currentShares, delta, supply } = {}) {
  if (typeof supply !== 'bigint' || typeof delta !== 'bigint' || typeof currentShares !== 'bigint') return null;
  if (supply <= 0n || delta === 0n) return null;
  const cur = currentShares > 0n ? currentShares : 0n;
  const next = cur + delta;
  const nextSupply = supply + delta;
  if (next < 0n || nextSupply <= 0n) return null;
  return { beforeBps: (cur * 10000n) / supply, afterBps: (next * 10000n) / nextSupply };
}

/**
 * How lopsided an add is, in money: the weaker side sets the mint and the
 * stronger side's excess buys nothing. Returns the amount that would have
 * matched. The CTA still allows the tx (the chain accepts it — the user's
 * money is their call), but the warning is never silent.
 */
export function imbalance({ quoteIn, tokenIn, quoteReserve, tokenReserve, supply } = {}) {
  const all = [quoteIn, tokenIn, quoteReserve, tokenReserve, supply];
  if (!all.every((v) => typeof v === 'bigint')) return null;
  if (quoteIn <= 0n || tokenIn <= 0n || quoteReserve <= 0n || tokenReserve <= 0n || supply <= 0n) return null;
  const qClaim = (quoteIn * supply) / quoteReserve;
  const tClaim = (tokenIn * supply) / tokenReserve;
  if (qClaim === tClaim) return { balanced: true, side: null, excess: 0n };
  if (qClaim > tClaim) {
    const needed = (tClaim * quoteReserve) / supply;
    const excess = quoteIn - needed;
    return excess > 0n ? { balanced: false, side: 'quote', excess } : { balanced: true, side: null, excess: 0n };
  }
  const needed = (qClaim * tokenReserve) / supply;
  const excess = tokenIn - needed;
  return excess > 0n ? { balanced: false, side: 'token', excess } : { balanced: true, side: null, excess: 0n };
}

/**
 * The smallest excess worth showing: at 6 displayed decimals anything below
 * 10^(dec−6) base units reads as "~0", and a "~0" warning on a balanced
 * deposit (Auto's floor leaves ±1 wei) would be a scare line, not a fact.
 */
export function visibleExcess(excess, dec) {
  if (typeof excess !== 'bigint' || excess <= 0n) return 0n;
  const d = Number(dec);
  const min = Number.isInteger(d) && d > 6 ? 10n ** BigInt(d - 6) : 1n;
  return excess >= min ? excess : 0n;
}

/**
 * R10: annualised LP fee yield from the window that was actually read —
 * (quote volume × the LP's slice of the fee × 365) over TVL, in bigint bps of
 * percent (10000 = 100%/yr, so 365 = 3.65%). The LP's slice is the whole 0.3%
 * swap fee MINUS the creator's cut — the same split the pair books on every
 * swap. TVL is 2× the quote reserve: a constant-product pool always holds
 * equal value in each side by construction. null = nothing honest to divide
 * by; 0n = the window truly was quiet.
 */
export function feeAprBps({ volQuote, quoteReserve, creatorFeeBps = 0, feeBps = 30 } = {}) {
  if (typeof volQuote !== 'bigint' || typeof quoteReserve !== 'bigint') return null;
  if (quoteReserve <= 0n) return null;
  const total = Math.floor(Number(feeBps));
  const cut = Math.floor(Number(creatorFeeBps));
  if (!Number.isFinite(total) || !Number.isFinite(cut)) return null;
  const lpBps = BigInt(Math.max(0, total - Math.max(0, cut)));
  if (lpBps === 0n || volQuote <= 0n) return 0n;
  return (volQuote * lpBps * 365n) / (2n * quoteReserve);
}

/**
 * Every way the add CTA can be disabled, each with its reason key — checked in
 * order: wallet, amounts, validity, balance (quote then token), mint. The CTA
 * is disabled ONLY with a reason on screen; "grey and silent" is the bug class
 * this panel was rewritten to kill (riset R7, pelajaran M6).
 */
export function addGate({ unlocked, qRaw, tRaw, qParsed, tParsed, qBal, tBal, qSym, tSym, preview } = {}) {
  if (!unlocked) return { disabled: true, reasonKey: 'dex.ts.reason.wallet' };
  if (!String(qRaw ?? '').trim() || !String(tRaw ?? '').trim()) return { disabled: true, reasonKey: 'dex.swap.pickAmount' };
  if (!qParsed?.ok || !tParsed?.ok) return { disabled: true, reasonKey: 'dex.ts.reason.invalid' };
  if (qParsed.value > qBal) return { disabled: true, reasonKey: 'dex.trade.insufficient', reasonArgs: { sym: qSym } };
  if (tParsed.value > tBal) return { disabled: true, reasonKey: 'dex.trade.insufficient', reasonArgs: { sym: tSym } };
  if (!preview || !preview.ok) {
    return { disabled: true, reasonKey: preview?.reason === 'too small' ? 'dex.ts.reason.small' : 'dex.ts.reason.empty' };
  }
  return { disabled: false, reasonKey: null };
}

// ── the three transactions, app path (approve-only-if-needed, then the call)

export async function addLiquidityTx({ pair, quoteToken, token, quoteAmount, tokenAmount, minShares, signer }) {
  const s = signer || needSigner();
  if (!s) return null;
  const E = ethersLib();
  if (!E) return null;
  const a1 = await ensureAllowanceTx({ token: quoteToken, spender: pair, amount: quoteAmount, owner: s.address, signer: s });
  if (!a1.ok) return null;
  const a2 = await ensureAllowanceTx({ token, spender: pair, amount: tokenAmount, owner: s.address, signer: s });
  if (!a2.ok) return null;
  const c = new E.Contract(pair, BEAR_PAIR_ABI, s);
  return sendDexTx(() => c.addLiquidity(quoteAmount, tokenAmount, minShares), 'Add liquidity');
}

export async function removeLiquidityTx({ pair, shares, minQuote, minToken, signer }) {
  const s = signer || needSigner();
  if (!s) return null;
  const E = ethersLib();
  if (!E) return null;
  const c = new E.Contract(pair, BEAR_PAIR_ABI, s);
  return sendDexTx(() => c.removeLiquidity(shares, minQuote, minToken), 'Remove liquidity');
}

export async function lockSharesTx({ pair, durationSecs, signer }) {
  const s = signer || needSigner();
  if (!s) return null;
  if (!(Number(durationSecs) > 0)) return null;
  const E = ethersLib();
  if (!E) return null;
  const c = new E.Contract(pair, BEAR_PAIR_ABI, s);
  return sendDexTx(() => c.lockShares(durationSecs), 'Lock shares');
}

// ── the panel ──────────────────────────────────────────────────

export function lpHtml() {
  const lockOpts = LOCK_CHOICES
    .map((days) => `<option value="${days * 86400}">${escapeHtml(t('dex.lp.lockDays', { n: String(days) }))}</option>`)
    .join('');
  return `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.lp.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.lp.hint'))}</div>
      </div>
      <button type="button" class="dex-edu" id="dexLpEdu" aria-label="${escapeHtml(t('dex.edu.lp.title'))}">?</button>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpPool">${escapeHtml(t('dex.lp.pool'))}</label>
      <select id="dexLpPool" class="input"></select>
      <div class="small mt-8" id="dexLpPosition"></div>
      <div class="small mt-8" id="dexLpRate"></div>
      <div class="small mt-8" id="dexLpApr"></div>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpQuoteIn" id="dexLpQuoteLabel"></label>
      <input id="dexLpQuoteIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <label class="field-label mt-8" for="dexLpTokenIn" id="dexLpTokenLabel"></label>
      <input id="dexLpTokenIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" id="dexLpAuto">${escapeHtml(t('dex.lp.auto'))}</button>
      </div>
      <div class="small mt-8" id="dexLpAddPreview"></div>
      <div class="small mt-8" id="dexLpAddReason" role="status"></div>
      <button type="button" class="btn btn-primary btn-block mt-8" id="dexLpAddGo" disabled>${escapeHtml(t('dex.lp.goAdd'))}</button>
      <div class="small mt-8" id="dexLpApproveNote"></div>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpShares">${escapeHtml(t('dex.lp.sharesIn'))}</label>
      <input id="dexLpShares" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" id="dexLpMax">${escapeHtml(t('dex.swap.max'))}</button>
      </div>
      <div class="small mt-8" id="dexLpRemovePreview"></div>
      <div class="small mt-8" id="dexLpRemoveReason" role="status"></div>
      <button type="button" class="btn btn-primary btn-block mt-8" id="dexLpRemoveGo" disabled>${escapeHtml(t('dex.lp.remove'))}</button>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpLockDur">${escapeHtml(t('dex.lp.lockDur'))}</label>
      <select id="dexLpLockDur" class="input">${lockOpts}</select>
      <div class="small mt-8" id="dexLpLockReason" role="status"></div>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexLpLockGo" disabled>${escapeHtml(t('dex.lp.lockGo'))}</button>
      <div class="small mt-8" id="dexLpNote" role="status"></div>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexLpRetry" hidden>${escapeHtml(t('dex.ts.retry'))}</button>
    </div>`;
}

export async function bindLp(host) {
  const sel = $('#dexLpPool', host);
  const posEl = $('#dexLpPosition', host);
  const rateEl = $('#dexLpRate', host);
  const aprEl = $('#dexLpApr', host);
  const approveNoteEl = $('#dexLpApproveNote', host);
  const quoteIn = $('#dexLpQuoteIn', host);
  const tokenIn = $('#dexLpTokenIn', host);
  const quoteLabel = $('#dexLpQuoteLabel', host);
  const tokenLabel = $('#dexLpTokenLabel', host);
  const autoBtn = $('#dexLpAuto', host);
  const addPrevEl = $('#dexLpAddPreview', host);
  const addReasonEl = $('#dexLpAddReason', host);
  const addBtn = $('#dexLpAddGo', host);

  $('#dexLpEdu', host)?.addEventListener('click', () => openEdu('lp'));
  const sharesIn = $('#dexLpShares', host);
  const maxBtn = $('#dexLpMax', host);
  const remPrevEl = $('#dexLpRemovePreview', host);
  const remReasonEl = $('#dexLpRemoveReason', host);
  const remBtn = $('#dexLpRemoveGo', host);
  const lockDur = $('#dexLpLockDur', host);
  const lockReasonEl = $('#dexLpLockReason', host);
  const lockBtn = $('#dexLpLockGo', host);
  const noteEl = $('#dexLpNote', host);
  const retryBtn = $('#dexLpRetry', host);
  if (!sel || !posEl || !rateEl || !aprEl || !approveNoteEl || !quoteIn || !tokenIn || !quoteLabel || !tokenLabel || !autoBtn
    || !addPrevEl || !addReasonEl || !addBtn || !sharesIn || !maxBtn || !remPrevEl || !remReasonEl
    || !remBtn || !lockDur || !lockReasonEl || !lockBtn || !noteEl || !retryBtn) return;

  let pools = [];
  let cur = null;
  let lastSide = 'quote'; // which field the user touched last — the Auto anchor
  const note = (msg) => { noteEl.textContent = msg || ''; };
  const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  // Every dead end leads BACK: a reason on screen and a retry that re-asks.
  // (The old panel could disable everything after one failed read — forever.)
  const dead = (msg) => {
    cur = null;
    note(msg);
    retryBtn.hidden = false;
    addBtn.disabled = true;
    remBtn.disabled = true;
    lockBtn.disabled = true;
    addPrevEl.textContent = '';
    remPrevEl.textContent = '';
    addReasonEl.textContent = '';
    remReasonEl.textContent = '';
    lockReasonEl.textContent = '';
    posEl.textContent = '';
    rateEl.textContent = '';
    aprEl.textContent = '';
    approveNoteEl.textContent = '';
    sel.disabled = true;
  };
  const fmt2 = (bps) => (Number(bps) / 100).toFixed(2);
  const trimNum = (s) => {
    const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    return t === '' ? '0' : t;
  };

  const paintPosition = () => {
    if (!cur) return;
    const now = Math.floor(Date.now() / 1000);
    const locked = cur.lockedUntil > BigInt(now);
    posEl.textContent = [
      t('dex.lp.shares', { n: fmtTok(cur.shares, 18, 6) }),
      `${fmtTok(cur.quoteShare, cur.qd, 6)} ${cur.qSym} + ${fmtTok(cur.tokenShare, cur.td, 6)} ${cur.tSym}`,
      locked ? t('dex.lp.locked', { date: new Date(Number(cur.lockedUntil) * 1000).toISOString().slice(0, 10) }) : t('dex.lp.unlocked'),
    ].join(' — ');
  };

  const refreshAdd = () => {
    if (!cur) return;
    const qp = parseAmount(quoteIn.value, cur.qd);
    const tp = parseAmount(tokenIn.value, cur.td);
    const preview = qp.ok && tp.ok
      ? addPreview({ quoteIn: qp.value, tokenIn: tp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply })
      : null;
    const g = addGate({
      unlocked: !!get('unlocked'),
      qRaw: quoteIn.value,
      tRaw: tokenIn.value,
      qParsed: qp,
      tParsed: tp,
      qBal: cur.qBal,
      tBal: cur.tBal,
      qSym: cur.qSym,
      tSym: cur.tSym,
      preview,
    });
    addBtn.disabled = g.disabled;
    addReasonEl.textContent = g.reasonKey ? t(g.reasonKey, g.reasonArgs || {}) : '';
    if (!preview || !preview.ok) { addPrevEl.textContent = ''; return; }
    const pct = sharePctShift({ currentShares: cur.shares, delta: preview.shares, supply: cur.ps.supply });
    const imb = imbalance({ quoteIn: qp.value, tokenIn: tp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply });
    let line = t('dex.lp.previewAdd', { shares: fmtTok(preview.shares, 18, 6), min: fmtTok(preview.minShares, 18, 6) });
    if (pct) line += ` · ${t('dex.lp.shareShift', { a: fmt2(pct.beforeBps), b: fmt2(pct.afterBps) })}`;
    if (imb && !imb.balanced) {
      const sideDec = imb.side === 'quote' ? cur.qd : cur.td;
      const sideSym = imb.side === 'quote' ? cur.qSym : cur.tSym;
      // Dust from the floor never deserves a warning: below the displayed
      // precision the "excess" reads as ~0, and that scare line would be a
      // lie in the other direction.
      const excess = visibleExcess(imb.excess, sideDec);
      if (excess > 0n) line += ` · ${t('dex.lp.unbalanced', { amt: fmtTok(excess, sideDec, 6), sym: sideSym })}`;
    }
    addPrevEl.textContent = line;
  };

  const refreshRemove = () => {
    if (!cur) return;
    const sp = parseAmount(sharesIn.value, 18);
    const preview = sp.ok
      ? removePreview({ shares: sp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply })
      : null;
    let reasonKey = null;
    let reasonArgs = null;
    if (!String(sharesIn.value ?? '').trim()) reasonKey = 'dex.swap.pickAmount';
    else if (!sp.ok) reasonKey = 'dex.ts.reason.invalid';
    else if (sp.value > cur.shares) { reasonKey = 'dex.lp.overShares'; reasonArgs = { n: fmtTok(cur.shares, 18, 6) }; }
    else if (!preview || !preview.ok) reasonKey = preview?.reason === 'too small' ? 'dex.ts.reason.small' : 'dex.ts.reason.empty';
    remBtn.disabled = Boolean(reasonKey);
    remReasonEl.textContent = reasonKey ? t(reasonKey, reasonArgs || {}) : '';
    if (reasonKey || !preview || !preview.ok) { remPrevEl.textContent = ''; return; }
    const pct = sharePctShift({ currentShares: cur.shares, delta: -sp.value, supply: cur.ps.supply });
    let line = t('dex.lp.previewRemove', {
      q: fmtTok(preview.quoteOut, cur.qd, 6),
      qsym: cur.qSym,
      tk: fmtTok(preview.tokenOut, cur.td, 6),
      tsym: cur.tSym,
    });
    if (pct) line += ` · ${t('dex.lp.shareShift', { a: fmt2(pct.beforeBps), b: fmt2(pct.afterBps) })}`;
    remPrevEl.textContent = line;
  };

  const loadPool = async () => {
    const row = pools.find((r) => r.address === sel.value) || pools[0];
    set('dex.lpToken', row.address);
    note(t('dex.swap.loading'));
    const me = get('address');
    // The select can move while these reads fly: a late answer for a pool the
    // user already left must not paint over the one they are looking at.
    const want = row.address;
    const [ps, ti, qi, lp, day, fnBps] = await Promise.all([
      poolState(row.pair),
      tokenInfo(row.address),
      tokenInfo(row.quote),
      lpPosition(row.pair, me),
      // R10: the fee-yield estimate reads the same 24h Swap window the token
      // page shows. `!ok` hides the APR line — never a zero that was not seen.
      pool24h({ E: ethersLib(), provider: provider(), pair: row.pair }),
      // The creator's slice of the 0.3% fee (0..30 bps). A pair from before
      // R6 has no getter and truly charges 0 — the catch says so, and the
      // estimate then credits the LP with the whole fee, which is correct.
      (async () => {
        try {
          const pb = new (ethersLib()).Contract(row.pair, BEAR_PAIR_ABI, provider());
          return Number(await pb.creatorFeeBps()) || 0;
        } catch { return 0; }
      })(),
    ]);
    if (sel.value !== want) return;
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
      shares: lp.ok ? lp.shares : 0n,
      lockedUntil: lp.ok ? lp.lockedUntil : 0n,
      quoteShare: lp.ok ? lp.quoteShare : 0n,
      tokenShare: lp.ok ? lp.tokenShare : 0n,
    };
    // The ratio the deposit must follow, in the user's units (riset R10).
    const rate = Number(ps.quoteReserve) / Number(ps.tokenReserve);
    rateEl.textContent = Number.isFinite(rate) && rate > 0
      ? t('dex.lp.rate', { t: cur.tSym, p: fmtPrice(rate), q: cur.qSym })
      : '';
    quoteLabel.textContent = t('dex.lp.youAdd', { sym: cur.qSym });
    tokenLabel.textContent = t('dex.lp.youAdd', { sym: cur.tSym });
    // R10: the two clarity pieces the panel was missing — the approve order
    // named for THIS pool's coins, and the fee-yield estimate from the 24h
    // window. Both say only what was read: a failed volume read hides the
    // APR line instead of printing a zero nobody saw.
    approveNoteEl.textContent = t('dex.lp.approveNote', { q: cur.qSym, t: cur.tSym });
    const aprBps = day.ok
      ? feeAprBps({ volQuote: day.volQuote, quoteReserve: ps.quoteReserve, creatorFeeBps: fnBps })
      : null;
    aprEl.textContent = aprBps == null ? '' : t('dex.lp.apr', {
      p: (Number(aprBps) / 100).toFixed(2),
      v: fmtTok(day.volQuote, cur.qd, 4),
      q: cur.qSym,
    });
    quoteIn.value = '';
    tokenIn.value = '';
    sharesIn.value = '';
    lockBtn.disabled = cur.shares <= 0n; // locking zero shares locks nothing
    lockReasonEl.textContent = cur.shares <= 0n ? t('dex.lp.noShares') : '';
    note('');
    retryBtn.hidden = true;
    paintPosition();
    refreshAdd();
    refreshRemove();
  };

  // The way back: chain gate → discovery → pick → live pool. Re-runnable —
  // the retry button below re-enters HERE, not into a fresh half-bound panel.
  const bootstrap = async () => {
    if (!dexChainOk()) { dead(t('dex.gate.needSepolia')); return; }
    if (!provider()) { dead(t('dex.swap.unreadable')); return; }
    note(t('dex.swap.loading'));
    retryBtn.hidden = true;
    const out = await discoverPools({ scope: 'all', limit: 50 });
    if (!out.ok) { dead(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.swap.unreadable')); return; }
    if (!out.pools.length) { dead(t('dex.swap.noPools')); return; }
    pools = await fillMeta(out.pools.slice());
    sel.disabled = false;
    sel.innerHTML = pools.map(() => '<option></option>').join('');
    [...sel.options].forEach((o, i) => {
      const r = pools[i];
      const q = quoteBy(r.quote);
      // The address IS the value: without it an <option> answers with its
      // label, the find in loadPool misses every time, and switching pools
      // silently kept loading the first one (R10).
      o.value = r.address;
      o.textContent = `${r.symbol || shortOf(r.address)} / ${q ? q.symbol : '…'}`;
    });
    const wanted = String(get('dex.lpToken') || '').toLowerCase();
    const pick = pools.find((r) => r.address.toLowerCase() === wanted) || pools[0];
    sel.value = pick.address;
    await loadPool();
  };

  // One Auto button, anchored to the side the user touched last (R10: "auto
  // isi sisi lain"). It follows the reserves' ratio, and what it writes is
  // exactly what the preview then parses — no hidden numbers anywhere.
  autoBtn.addEventListener('click', () => {
    if (!cur) return;
    const qp = parseAmount(quoteIn.value, cur.qd);
    const tp = parseAmount(tokenIn.value, cur.td);
    let side = lastSide;
    if (side === 'quote' && !qp.ok && tp.ok) side = 'token';
    if (side === 'token' && !tp.ok && qp.ok) side = 'quote';
    const src = side === 'quote' ? qp : tp;
    if (!src.ok) { note(t('dex.swap.pickAmount')); return; }
    const res = side === 'quote'
      ? otherSideFromRatio(src.value, cur.ps.quoteReserve, cur.ps.tokenReserve)
      : otherSideFromRatio(src.value, cur.ps.tokenReserve, cur.ps.quoteReserve);
    if (!res.ok) { note(t('dex.ts.reason.small')); return; }
    const E = ethersLib();
    if (!E) return;
    if (side === 'quote') tokenIn.value = trimNum(E.formatUnits(res.value, cur.td));
    else quoteIn.value = trimNum(E.formatUnits(res.value, cur.qd));
    note('');
    refreshAdd();
  });

  for (const [el, side] of [[quoteIn, 'quote'], [tokenIn, 'token']]) {
    el.addEventListener('input', () => {
      lastSide = side;
      const n = normalizeAmountInput(el.value);
      if (n.changed) el.value = n.value;
      refreshAdd();
    });
  }
  sharesIn.addEventListener('input', () => {
    const n = normalizeAmountInput(sharesIn.value);
    if (n.changed) sharesIn.value = n.value;
    refreshRemove();
  });
  maxBtn.addEventListener('click', () => {
    if (!cur || cur.shares <= 0n) return;
    const E = ethersLib();
    if (!E) return;
    sharesIn.value = E.formatUnits(cur.shares, 18);
    refreshRemove();
  });
  sel.addEventListener('change', () => { loadPool(); });

  addBtn.addEventListener('click', async () => {
    await withTxButton(addBtn, t('dex.liq.sending'), async () => {
      if (!cur) return;
      const qp = parseAmount(quoteIn.value, cur.qd);
      const tp = parseAmount(tokenIn.value, cur.td);
      if (!qp.ok || !tp.ok) { note(t('dex.swap.pickAmount')); return; }
      const preview = addPreview({ quoteIn: qp.value, tokenIn: tp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply });
      if (!preview.ok) { refreshAdd(); return; }
      const pct = sharePctShift({ currentShares: cur.shares, delta: preview.shares, supply: cur.ps.supply });
      const rows = [
        { k: t('dex.lp.youAdd', { sym: cur.qSym }), v: `${quoteIn.value.trim()} ${cur.qSym}` },
        { k: t('dex.lp.youAdd', { sym: cur.tSym }), v: `${tokenIn.value.trim()} ${cur.tSym}` },
        { k: t('dex.lp.sharesGet'), v: `≈ ${fmtTok(preview.shares, 18, 6)} (min ${fmtTok(preview.minShares, 18, 6)})` },
      ];
      if (pct) rows.push({ k: t('dex.lp.shareLabel'), v: `${fmt2(pct.beforeBps)}% → ${fmt2(pct.afterBps)}%` });
      // The approve order, spelled out at the moment money is committed (R10).
      rows.push({ k: t('dex.lp.stepsLabel'), v: t('dex.lp.approveSteps', { q: cur.qSym, t: cur.tSym }) });
      const ok = await confirmTx({ title: t('dex.lp.confirmAdd'), rows, confirmText: t('dex.lp.goAdd') });
      if (!ok) return;
      const signer = needSigner();
      if (!signer) return;
      const rc = await addLiquidityTx({
        pair: cur.row.pair,
        quoteToken: cur.row.quote,
        token: cur.row.address,
        quoteAmount: qp.value,
        tokenAmount: tp.value,
        minShares: preview.minShares,
        signer,
      });
      if (rc) await loadPool(); else refreshAdd();
    });
    // setBtnDots restores "enabled" blindly — only the gate may decide.
    // Re-apply it so a failed or cleared form never looks ready.
    if (cur) refreshAdd(); else addBtn.disabled = true;
  });

  remBtn.addEventListener('click', async () => {
    await withTxButton(remBtn, t('dex.liq.sending'), async () => {
      if (!cur) return;
      const sp = parseAmount(sharesIn.value, 18);
      if (!sp.ok) { note(t('dex.swap.pickAmount')); return; }
      const preview = removePreview({ shares: sp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply });
      if (!preview.ok) { refreshRemove(); return; }
      const pct = sharePctShift({ currentShares: cur.shares, delta: -sp.value, supply: cur.ps.supply });
      const rows = [
        { k: t('dex.lp.sharesIn'), v: sharesIn.value.trim() },
        { k: t('dex.trade.youGet'), v: `≈ ${fmtTok(preview.quoteOut, cur.qd, 6)} ${cur.qSym} + ${fmtTok(preview.tokenOut, cur.td, 6)} ${cur.tSym}` },
      ];
      if (pct) rows.push({ k: t('dex.lp.shareLabel'), v: `${fmt2(pct.beforeBps)}% → ${fmt2(pct.afterBps)}%` });
      const ok = await confirmTx({
        title: t('dex.lp.confirmRemove'),
        rows,
        confirmText: t('dex.lp.remove'),
        danger: sp.value === cur.shares, // a full exit turns the sheet red
      });
      if (!ok) return;
      const signer = needSigner();
      if (!signer) return;
      const rc = await removeLiquidityTx({
        pair: cur.row.pair,
        shares: sp.value,
        minQuote: preview.minQuote,
        minToken: preview.minToken,
        signer,
      });
      if (rc) await loadPool(); else refreshRemove();
    });
    // Same discipline as the trade sheet: the gate owns the button, not the
    // last setBtnDots restore.
    if (cur) refreshRemove(); else remBtn.disabled = true;
  });

  lockBtn.addEventListener('click', async () => {
    await withTxButton(lockBtn, t('dex.liq.sending'), async () => {
      if (!cur) return;
      const secs = Number(lockDur.value) || 0;
      const signer = needSigner();
      if (!signer) return;
      const rc = await lockSharesTx({ pair: cur.row.pair, durationSecs: secs, signer });
      if (rc) await loadPool();
    });
    // Same discipline as the trade sheet: the gate owns the button, not the
    // last setBtnDots restore.
    if (cur) {
      lockBtn.disabled = cur.shares <= 0n;
      lockReasonEl.textContent = cur.shares <= 0n ? t('dex.lp.noShares') : '';
    } else {
      lockBtn.disabled = true;
    }
  });

  retryBtn.addEventListener('click', () => { bootstrap(); });

  await bootstrap();
}
