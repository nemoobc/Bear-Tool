// Bear Tool — js/dex/trade-sheet.js
//
// The ONE trade UI. The token page mounts it; the Swap panel mounts the same
// component under its pool picker — two screens, one sheet, so they can never
// disagree about what buying means (riset launchpad-ux R1; user: "buy mentok
// … gabisa beli lagi").
//
// The bug class this file is built to make impossible: the old panel greyed
// out every control after ONE failed read and offered no way back — a silent
// dead end that read as "can't buy anymore". Here:
//   • a disabled CTA ALWAYS carries a visible reason (tradeGate is the only
//     thing allowed to decide, and every refusal has a key),
//   • a failed read shows a real retry — never a permanent grey,
//   • a comma from an Indonesian keyboard is normalised IN THE FIELD ITSELF
//     (0,1 → 0.1): what the input shows is exactly what the quote parses,
//     never a silent misread in either direction.
//
// The two transactions are the same pair the anvil e2e proves: approve only
// when the allowance actually falls short (exact amount, never infinite), then
// the swap. The user sees the numbers in confirmTx BEFORE anything is signed.
//
// Import note: this file and swap.js import each other — swap.js owns the
// engine (parseAmount/swapQuote/swapTx), this file owns the sheet UI, and the
// swap PANEL mounts the sheet. Both directions are used only at call time,
// never at module top level, so the cycle is inert (ESM live bindings).
import { t, get, toast, escapeHtml, isAddr, provider, ethersLib, fmtTok, quoteBy, confirmTx, withTxButton, needSigner, openEdu } from './core.js';
import { parseAmount, swapQuote, swapTx, ensureAllowanceTx, DEFAULT_SLIPPAGE_BPS } from './swap.js';
import { priceImpact, SWAP_FEE_BPS } from './pool-math.js';
import { poolState, tokenInfo } from './pool-data.js';

const shortOf = (addr) => {
  const a = String(addr || '');
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
};

// Buy presets are quote amounts (riset R1: preset beli 0,01/0,05/0,1); sell
// presets are percentages of the holding (R1: preset jual 25/50/75/100%).
const TS_BUY_PRESETS = ['0.01', '0.05', '0.1'];
const TS_SELL_PRESETS = [25, 50, 75, 100];

/**
 * A typed amount, before parsing: strip grouping noise, and turn a lone comma
 * into a dot — VISIBLY (the caller writes the result back into the field, so
 * the user sees the number the quote will parse). Two separators of any kind
 * stay refused, not guessed: "1,2,3" is left as-is for parseAmount to reject
 * with a reason, because picking a reading for it would be inventing a number.
 * @returns {{value:string, changed:boolean}}
 */
export function normalizeAmountInput(raw) {
  const s = String(raw ?? '');
  const base = s.replace(/[\s_]/g, '');
  const changedBase = base !== s;
  const dots = (base.match(/\./g) || []).length;
  const commas = (base.match(/,/g) || []).length;
  // ONE comma and no dot: the comma can only be a decimal point. With both
  // present the reading is ambiguous, and an ambiguous swap is refused.
  if (commas === 1 && dots === 0) return { value: base.replace(',', '.'), changed: true };
  return { value: base, changed: changedBase };
}

/**
 * The single gate between the user and the CTA. Pure on purpose: the reason a
 * button is grey is data, and data gets tested. Returns the one reason that
 * matters (first in line wins), or the green light.
 * @returns {{disabled:boolean, reasonKey:string|null, reasonArgs?:object}}
 */
export function tradeGate({ unlocked, raw, parsed, balance, inSym, native, sim } = {}) {
  if (!unlocked) return { disabled: true, reasonKey: 'dex.ts.reason.wallet' };
  if (!String(raw ?? '').trim()) return { disabled: true, reasonKey: 'dex.swap.pickAmount' };
  if (!parsed || !parsed.ok) return { disabled: true, reasonKey: 'dex.ts.reason.invalid' };
  if (balance != null && parsed.value > balance) {
    return { disabled: true, reasonKey: 'dex.trade.insufficient', reasonArgs: { sym: String(inSym || '') } };
  }
  if (native === 0n) return { disabled: true, reasonKey: 'dex.ts.reason.gas' };
  if (!sim) return { disabled: true, reasonKey: 'dex.swap.unreadable' };
  if (!sim.ok) {
    const map = {
      deep: 'dex.ts.reason.deep',
      reserves: 'dex.ts.reason.empty',
      'too small': 'dex.ts.reason.small',
    };
    return { disabled: true, reasonKey: map[sim.reason] || 'dex.ts.reason.invalid' };
  }
  return { disabled: false, reasonKey: null };
}

// The sheet's markup. No fixed id inside — the CONTAINER carries the id
// (#dexTpTrade on the token page, #dexSwapSheet in the Swap panel), so the
// component can mount anywhere without duplicate-id risk.
export function tradeSheetHtml() {
  return `
    <div class="dex-ts">
      <div class="mt-8" role="group" aria-label="${escapeHtml(t('dex.swap.dir'))}">
        <button type="button" class="dex-tab" data-ts-dir="buy" aria-pressed="true">${escapeHtml(t('dex.swap.buy'))}</button>
        <button type="button" class="dex-tab" data-ts-dir="sell" aria-pressed="false">${escapeHtml(t('dex.swap.sell'))}</button>
      </div>
      <label class="field-label mt-8" for="dexTsAmount">${escapeHtml(t('dex.swap.pay'))}</label>
      <input id="dexTsAmount" data-ts-amount class="input" inputmode="decimal" autocomplete="off" placeholder="0.0">
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" data-ts-max>${escapeHtml(t('dex.swap.max'))}</button>
      </div>
      <div class="dex-ts-presets mt-8" data-ts-presets></div>
      <div class="small mt-8" data-ts-bal></div>
      <div class="small mt-8" data-ts-quote aria-live="polite"></div>
      <div class="dex-ts-inforow small mt-8">
        <div data-ts-info></div>
        <button type="button" class="dex-edu" data-ts-edu aria-label="${escapeHtml(t('dex.edu.impact.title'))}">?</button>
      </div>
      <button type="button" class="btn btn-primary btn-block dex-ts-go mt-8" data-ts-go disabled>${escapeHtml(t('dex.swap.pickAmount'))}</button>
      <div class="small mt-8 dex-ts-reason" data-ts-reason></div>
      <div class="small mt-8" data-ts-note role="status"></div>
      <button type="button" class="btn btn-secondary btn-block dex-ts-retry mt-8" data-ts-retry hidden>${escapeHtml(t('dex.ts.retry'))}</button>
    </div>`;
}

/**
 * Paint the sheet into `container` and wire it. `row`:
 * {address, pair, quote, symbol?} — the pool's coin, its pair, its quote.
 * Re-mounting (pool switch, reload) is just calling this again: the container
 * is emptied first, so exactly one sheet exists at any moment.
 */
export async function mountTradeSheet(container, row = {}) {
  if (!container) return;
  container.innerHTML = tradeSheetHtml();
  const q = (sel) => container.querySelector(sel);
  const amountEl = q('[data-ts-amount]');
  const maxBtn = q('[data-ts-max]');
  const presetsEl = q('[data-ts-presets]');
  const balEl = q('[data-ts-bal]');
  const quoteEl = q('[data-ts-quote]');
  const infoEl = q('[data-ts-info]');
  const goBtn = q('[data-ts-go]');
  const reasonEl = q('[data-ts-reason]');
  const noteEl = q('[data-ts-note]');
  const retryBtn = q('[data-ts-retry]');
  const eduBtn = q('[data-ts-edu]');
  if (!amountEl || !maxBtn || !presetsEl || !balEl || !quoteEl || !infoEl
    || !goBtn || !reasonEl || !noteEl || !retryBtn || !eduBtn) return;

  let dir = 'buy';
  let cur = null; // everything a quote needs, or null while the read is dead
  const sym = row.symbol || shortOf(row.address);

  const note = (msg) => { noteEl.textContent = msg || ''; };
  const showReason = (key, args) => { reasonEl.textContent = key ? t(key, args || {}) : ''; };
  const goSym = () => (cur ? cur.tSym : sym);
  const goText = () => (dir === 'buy'
    ? t('dex.swap.go.buy', { sym: goSym() })
    : t('dex.swap.go.sell', { sym: goSym() }));

  // The failure state, singular: a visible reason AND a reachable retry. There
  // is no code path that disables the CTA without leaving one of the two on.
  const stall = (key) => {
    cur = null;
    retryBtn.hidden = false;
    goBtn.disabled = true;
    goBtn.textContent = goText();
    showReason(key);
    quoteEl.textContent = '';
    balEl.textContent = '';
    note('');
  };

  const paintPresets = () => {
    presetsEl.innerHTML = dir === 'buy'
      ? TS_BUY_PRESETS.map((v) => `<button type="button" class="dex-ts-preset" data-ts-preset="${v}">${v}</button>`).join('')
      : TS_SELL_PRESETS.map((v) => `<button type="button" class="dex-ts-preset" data-ts-preset="${v}">${v}%</button>`).join('');
  };

  const infoLine = () => `${t('dex.ts.slippage')} ${(DEFAULT_SLIPPAGE_BPS / 100)}% · ${t('dex.ts.fee')} ${(SWAP_FEE_BPS / 100)}%`;

  const refresh = () => {
    // While cur is null the stall state owns the reason line — a keystroke
    // during a dead read must not wipe the explanation.
    if (!cur) return;
    const inDec = dir === 'buy' ? cur.qd : cur.td;
    const inSym = dir === 'buy' ? cur.qSym : cur.tSym;
    const outSym = dir === 'buy' ? cur.tSym : cur.qSym;
    const outDec = dir === 'buy' ? cur.td : cur.qd;
    const bal = dir === 'buy' ? cur.qBal : cur.tBal;
    balEl.textContent = t('dex.swap.balance', { amt: fmtTok(bal, inDec, 6), sym: inSym });
    const parsed = amountEl.value.trim() ? parseAmount(amountEl.value, inDec) : null;
    const sim = parsed && parsed.ok
      ? swapQuote({ quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, direction: dir, amountIn: parsed.value })
      : null;
    const g = tradeGate({ unlocked: !!get('unlocked'), raw: amountEl.value, parsed, balance: bal, inSym, native: cur.native, sim });
    goBtn.disabled = g.disabled;
    showReason(g.disabled ? g.reasonKey : null, g.reasonArgs);
    goBtn.textContent = goText();
    if (sim && sim.ok) {
      const inRes = dir === 'buy' ? cur.ps.quoteReserve : cur.ps.tokenReserve;
      const outRes = dir === 'buy' ? cur.ps.tokenReserve : cur.ps.quoteReserve;
      const impact = priceImpact(parsed.value, inRes, outRes);
      quoteEl.innerHTML = `<strong>≈ ${escapeHtml(fmtTok(sim.amountOut, outDec, 6))} ${escapeHtml(outSym)}</strong> · `
        + `${escapeHtml(t('dex.swap.min'))}: ${escapeHtml(fmtTok(sim.minOut, outDec, 6))} ${escapeHtml(outSym)}`;
      infoEl.textContent = `${infoLine()} · ${t('dex.swap.impact')} ${(impact * 100).toFixed(2)}%`;
    } else {
      quoteEl.textContent = '';
      infoEl.textContent = infoLine();
    }
  };

  const readNative = async () => {
    const p = provider();
    const me = String(get('address') || '');
    if (!p || !isAddr(me)) return null;
    try { return BigInt(await p.getBalance(me)); } catch { return null; }
  };

  const load = async () => {
    note(t('dex.swap.loading'));
    retryBtn.hidden = true;
    if (!provider() || !ethersLib()) { stall(t('dex.swap.unreadable')); return; }
    const me = String(get('address') || '');
    const [ps, ti, qi, native] = await Promise.all([
      poolState(row.pair),
      tokenInfo(row.address, me),
      tokenInfo(row.quote, me),
      readNative(),
    ]);
    if (!ps.ok) { stall(t('dex.swap.unreadable')); return; }
    const qPreset = quoteBy(row.quote);
    cur = {
      ps,
      td: ti.ok ? ti.decimals : 18,
      tSym: ti.ok && ti.symbol ? ti.symbol : sym,
      qd: qi.ok ? qi.decimals : (qPreset ? qPreset.decimals : 18),
      qSym: qPreset ? qPreset.symbol : '…',
      tBal: ti.ok ? ti.balance : 0n,
      qBal: qi.ok ? qi.balance : 0n,
      native,
    };
    note('');
    refresh();
  };

  for (const btn of container.querySelectorAll('[data-ts-dir]')) {
    btn.addEventListener('click', () => {
      dir = btn.dataset.tsDir === 'sell' ? 'sell' : 'buy';
      for (const b of container.querySelectorAll('[data-ts-dir]')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      amountEl.value = '';
      paintPresets();
      refresh();
    });
  }

  amountEl.addEventListener('input', () => {
    // The field itself is corrected, so screen and quote never disagree.
    const norm = normalizeAmountInput(amountEl.value);
    if (norm.changed) amountEl.value = norm.value;
    refresh();
  });

  maxBtn.addEventListener('click', () => {
    if (!cur) return;
    const E = ethersLib();
    if (!E) return;
    const bal = dir === 'buy' ? cur.qBal : cur.tBal;
    if (bal <= 0n) return;
    amountEl.value = E.formatUnits(bal, dir === 'buy' ? cur.qd : cur.td);
    refresh();
  });

  presetsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ts-preset]');
    if (!b) return;
    if (dir === 'buy') {
      amountEl.value = b.dataset.tsPreset;
      refresh();
      return;
    }
    const pc = Number(b.dataset.tsPreset);
    if (!cur || cur.tBal <= 0n || !(pc > 0)) return;
    const E = ethersLib();
    if (!E) return;
    amountEl.value = E.formatUnits((cur.tBal * BigInt(pc)) / 100n, cur.td);
    refresh();
  });

  eduBtn.addEventListener('click', () => openEdu('impact'));

  retryBtn.addEventListener('click', () => { load(); });

  goBtn.addEventListener('click', async () => {
    await withTxButton(goBtn, t('dex.trade.sending'), async () => {
      if (!cur) return;
      const norm = normalizeAmountInput(amountEl.value);
      if (norm.changed) amountEl.value = norm.value;
      const inDec = dir === 'buy' ? cur.qd : cur.td;
      const inSym = dir === 'buy' ? cur.qSym : cur.tSym;
      const outDec = dir === 'buy' ? cur.td : cur.qd;
      const outSym = dir === 'buy' ? cur.tSym : cur.qSym;
      const parsed = parseAmount(norm.value, inDec);
      if (!parsed.ok) return;
      const q1 = swapQuote({ quoteReserve: cur.ps.quoteReserve, tokenReserve: cur.ps.tokenReserve, direction: dir, amountIn: parsed.value });
      if (!q1.ok) return;
      const signer = needSigner();
      if (!signer) return;
      const inRes = dir === 'buy' ? cur.ps.quoteReserve : cur.ps.tokenReserve;
      const outRes = dir === 'buy' ? cur.ps.tokenReserve : cur.ps.quoteReserve;
      const impact = priceImpact(parsed.value, inRes, outRes);
      // Numbers first, signature second: the modal is the last exit before
      // anything is granted or sent.
      const ok = await confirmTx({
        title: dir === 'buy' ? t('dex.trade.buyTitle', { sym: cur.tSym }) : t('dex.trade.sellTitle', { sym: cur.tSym }),
        rows: [
          { k: t('dex.swap.pay'), v: `${norm.value} ${inSym}` },
          { k: t('dex.trade.youGet'), v: `≈ ${fmtTok(q1.amountOut, outDec, 6)} ${outSym}` },
          { k: t('dex.swap.min'), v: `${fmtTok(q1.minOut, outDec, 6)} ${outSym}` },
          { k: t('dex.swap.impact'), v: `${(impact * 100).toFixed(2)}%` },
          { k: t('dex.ts.ratio'), v: `${fmtTok(cur.ps.quoteReserve, cur.qd, 2)} ${cur.qSym} / ${fmtTok(cur.ps.tokenReserve, cur.td, 2)} ${cur.tSym}` },
        ],
        confirmText: goText(),
        danger: impact > 0.05, // >5%: the confirm turns red before a wallet ever opens
      });
      if (!ok) return;
      note(t('dex.trade.approving', { sym: inSym }));
      const inAddr = dir === 'buy' ? row.quote : row.address;
      const appr = await ensureAllowanceTx({ token: inAddr, spender: row.pair, amount: parsed.value, owner: String(signer.address || ''), signer });
      if (!appr.ok) return;
      note(t('dex.trade.sending'));
      const rc = await swapTx({ pair: row.pair, direction: dir, amountIn: parsed.value, minOut: q1.minOut, signer });
      if (!rc) return;
      toast(dir === 'buy' ? t('dex.trade.bought', { sym: cur.tSym }) : t('dex.trade.sold', { sym: cur.tSym }), 'success');
      amountEl.value = '';
      await load(); // reserves and balances moved — re-read, never assume
    });
    // setBtnDots restores "enabled" on the way out — but only the gate may
    // decide. Re-apply it so a cleared or failed form never looks ready.
    if (cur) refresh(); else stall(t('dex.swap.unreadable'));
  });

  paintPresets();
  await load();
}
