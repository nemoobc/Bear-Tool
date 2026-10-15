// Bear Tool — js/dex/lp.js
// The Liquidity panel (v2): be the pool's LP.
//
// The pair IS the LP token, so "liquidity" here means exactly three things:
// add both sides and mint shares, burn shares to pull both sides back out,
// and lock shares so the wallet that launched a pool cannot rug it.
//
// The previews (addPreview / removePreview) mirror the contract's mint/burn
// rules to the wei — the anvil e2e pins them against the real pair.
import { provider, ethersLib, get, set, sendDexTx, needSigner, t, escapeHtml, fmtTok, $, dexChainOk, quoteBy } from './core.js';
import { addShares, removeAmounts, minOutWithSlippage } from './pool-math.js';
import { parseAmount, ensureAllowanceTx, DEFAULT_SLIPPAGE_BPS } from './swap.js';
import { discoverPools, fillMeta } from './pools.js';
import { poolState, tokenInfo, lpPosition } from './pool-data.js';
import { BEAR_PAIR_ABI } from './bear-source.js';

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
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpPool">${escapeHtml(t('dex.lp.pool'))}</label>
      <select id="dexLpPool" class="input"></select>
      <div class="small mt-8" id="dexLpPosition"></div>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpQuoteIn" id="dexLpQuoteLabel"></label>
      <input id="dexLpQuoteIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <label class="field-label mt-8" for="dexLpTokenIn" id="dexLpTokenLabel"></label>
      <input id="dexLpTokenIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="small mt-8" id="dexLpAddPreview"></div>
      <button type="button" class="btn btn-primary btn-block mt-8" id="dexLpAddGo" disabled>${escapeHtml(t('dex.lp.goAdd'))}</button>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpShares">${escapeHtml(t('dex.lp.sharesIn'))}</label>
      <input id="dexLpShares" class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" id="dexLpMax">${escapeHtml(t('dex.swap.max'))}</button>
      </div>
      <div class="small mt-8" id="dexLpRemovePreview"></div>
      <button type="button" class="btn btn-primary btn-block mt-8" id="dexLpRemoveGo" disabled>${escapeHtml(t('dex.lp.remove'))}</button>
    </div>
    <div class="card mb-8">
      <label class="field-label" for="dexLpLockDur">${escapeHtml(t('dex.lp.lockDur'))}</label>
      <select id="dexLpLockDur" class="input">${lockOpts}</select>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexLpLockGo" disabled>${escapeHtml(t('dex.lp.lockGo'))}</button>
      <div class="small mt-8" id="dexLpNote" role="status"></div>
    </div>`;
}

export async function bindLp(host) {
  const sel = $('#dexLpPool', host);
  const posEl = $('#dexLpPosition', host);
  const quoteIn = $('#dexLpQuoteIn', host);
  const tokenIn = $('#dexLpTokenIn', host);
  const quoteLabel = $('#dexLpQuoteLabel', host);
  const tokenLabel = $('#dexLpTokenLabel', host);
  const addPrevEl = $('#dexLpAddPreview', host);
  const addBtn = $('#dexLpAddGo', host);
  const sharesIn = $('#dexLpShares', host);
  const maxBtn = $('#dexLpMax', host);
  const remPrevEl = $('#dexLpRemovePreview', host);
  const remBtn = $('#dexLpRemoveGo', host);
  const lockDur = $('#dexLpLockDur', host);
  const lockBtn = $('#dexLpLockGo', host);
  const noteEl = $('#dexLpNote', host);
  if (!sel || !posEl || !quoteIn || !tokenIn || !quoteLabel || !tokenLabel || !addPrevEl || !addBtn
    || !sharesIn || !maxBtn || !remPrevEl || !remBtn || !lockDur || !lockBtn || !noteEl) return;

  let pools = [];
  let cur = null;
  const note = (msg) => { noteEl.textContent = msg || ''; };
  const dead = (msg) => {
    cur = null;
    note(msg);
    addBtn.disabled = true;
    remBtn.disabled = true;
    lockBtn.disabled = true;
    addPrevEl.textContent = '';
    remPrevEl.textContent = '';
    posEl.textContent = '';
    sel.disabled = true;
  };

  if (!dexChainOk()) { dead(t('dex.gate.needSepolia')); return; }
  if (!provider()) { dead(t('dex.swap.unreadable')); return; }

  note(t('dex.swap.loading'));
  const out = await discoverPools({ scope: 'all', limit: 50 });
  if (!out.ok) { dead(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.swap.unreadable')); return; }
  if (!out.pools.length) { dead(t('dex.swap.noPools')); return; }
  pools = await fillMeta(out.pools.slice());

  const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  sel.innerHTML = pools.map(() => '<option></option>').join('');
  [...sel.options].forEach((o, i) => {
    const r = pools[i];
    const q = quoteBy(r.quote);
    o.textContent = `${r.symbol || shortOf(r.address)} / ${q ? q.symbol : '…'}`;
  });
  const wanted = String(get('dex.lpToken') || '').toLowerCase();
  const pick = pools.find((r) => r.address.toLowerCase() === wanted) || pools[0];
  sel.value = pick.address;

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
    if (!preview || !preview.ok) {
      addPrevEl.textContent = '';
      addBtn.disabled = true;
      return;
    }
    addPrevEl.textContent = t('dex.lp.previewAdd', {
      shares: fmtTok(preview.shares, 18, 6),
      min: fmtTok(preview.minShares, 18, 6),
    });
    addBtn.disabled = false;
  };

  const refreshRemove = () => {
    if (!cur) return;
    const sp = parseAmount(sharesIn.value, 18);
    const preview = sp.ok
      ? removePreview({ shares: sp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply })
      : null;
    if (!preview || !preview.ok) {
      remPrevEl.textContent = '';
      remBtn.disabled = true;
      return;
    }
    remPrevEl.textContent = t('dex.lp.previewRemove', {
      q: fmtTok(preview.quoteOut, cur.qd, 6),
      qsym: cur.qSym,
      tk: fmtTok(preview.tokenOut, cur.td, 6),
      tsym: cur.tSym,
    });
    remBtn.disabled = false;
  };

  const loadPool = async () => {
    const row = pools.find((r) => r.address === sel.value) || pools[0];
    set('dex.lpToken', row.address);
    note(t('dex.swap.loading'));
    const me = get('address');
    const [ps, ti, qi, lp] = await Promise.all([
      poolState(row.pair),
      tokenInfo(row.address),
      tokenInfo(row.quote),
      lpPosition(row.pair, me),
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
      shares: lp.ok ? lp.shares : 0n,
      lockedUntil: lp.ok ? lp.lockedUntil : 0n,
      quoteShare: lp.ok ? lp.quoteShare : 0n,
      tokenShare: lp.ok ? lp.tokenShare : 0n,
    };
    quoteLabel.textContent = t('dex.lp.youAdd', { sym: cur.qSym });
    tokenLabel.textContent = t('dex.lp.youAdd', { sym: cur.tSym });
    quoteIn.value = '';
    tokenIn.value = '';
    sharesIn.value = '';
    lockBtn.disabled = cur.shares <= 0n; // locking zero shares locks nothing
    note('');
    paintPosition();
    refreshAdd();
    refreshRemove();
  };

  for (const el of [quoteIn, tokenIn]) el.addEventListener('input', refreshAdd);
  sharesIn.addEventListener('input', refreshRemove);
  maxBtn.addEventListener('click', () => {
    if (!cur || cur.shares <= 0n) return;
    const E = ethersLib();
    if (!E) return;
    sharesIn.value = E.formatUnits(cur.shares, 18);
    refreshRemove();
  });
  sel.addEventListener('change', () => { loadPool(); });

  addBtn.addEventListener('click', async () => {
    if (!cur) return;
    const qp = parseAmount(quoteIn.value, cur.qd);
    const tp = parseAmount(tokenIn.value, cur.td);
    if (!qp.ok || !tp.ok) { note(t('dex.swap.pickAmount')); return; }
    const preview = addPreview({ quoteIn: qp.value, tokenIn: tp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply });
    if (!preview.ok) { refreshAdd(); return; }
    const signer = needSigner();
    if (!signer) return;
    addBtn.disabled = true;
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

  remBtn.addEventListener('click', async () => {
    if (!cur) return;
    const sp = parseAmount(sharesIn.value, 18);
    if (!sp.ok) { note(t('dex.swap.pickAmount')); return; }
    const preview = removePreview({ shares: sp.value, quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, supply: cur.ps.supply });
    if (!preview.ok) { refreshRemove(); return; }
    const signer = needSigner();
    if (!signer) return;
    remBtn.disabled = true;
    const rc = await removeLiquidityTx({
      pair: cur.row.pair,
      shares: sp.value,
      minQuote: preview.minQuote,
      minToken: preview.minToken,
      signer,
    });
    if (rc) await loadPool(); else refreshRemove();
  });

  lockBtn.addEventListener('click', async () => {
    if (!cur) return;
    const secs = Number(lockDur.value) || 0;
    const signer = needSigner();
    if (!signer) return;
    lockBtn.disabled = true;
    const rc = await lockSharesTx({ pair: cur.row.pair, durationSecs: secs, signer });
    if (rc) await loadPool(); else lockBtn.disabled = cur.shares <= 0n;
  });

  await loadPool();
}
