// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/liquidity.js
// The pool, on the coin's own page.
//
// The contract has had addLiquidity/removeLiquidity since the pool work landed.
// This file is what makes them reachable — and until it existed they were
// unreachable: the functions were on the contract, the ABI listed them, the
// on-chain gate called them directly and went green, and the app shipped with
// no way to reach any of it. A feature is not its ABI entry.
//
// ── What this panel is, and is not ──────────────────────────────────────
// Adding liquidity here is NOT buying. A buy moves the price and hands you
// tokens; adding liquidity only deepens what the pool holds. You get no tokens
// and no price movement — you get a claim. That difference is the entire point,
// and a panel that let the two blur would turn every deposit into a disguised
// buy dressed up as investment. So the numbers say it outright, every time:
//
//   pool depth      — quote the pool actually holds, minus what is owed
//   your share      — your claim, worth more than you put in once fees accrue
//   your share %    — of the whole pool, so "most of it" is visible, not implied
//
// Removing pays pro-rata against the CURRENT value, so a provider leaves with
// their deposit plus their share of what trading earned while they were in.
// ═══════════════════════════════════════════════════════════════

import { t } from '../i18n.js';
import { $, toast, escapeHtml, confirmTx } from '../ui.js';
import {
  sendDexTx, provider, ethersLib, dexChainOk, needSigner,
  fmtTok, withTxButton, ERC20_ABI, get,
} from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { fmtEth } from './curve.js';

// ── html ─────────────────────────────────────────────────────────────
export function liquidityHtml() {
  return `
    <section class="dex-liq" id="dexLiq">
      <button type="button" class="dex-bot-toggle" id="dexLiqToggle" aria-expanded="false" aria-controls="dexLiqBody">
        <span>${escapeHtml(t('dex.liq.title'))}</span>
        <span class="small">${escapeHtml(t('dex.liq.hint'))}</span>
      </button>

      <div id="dexLiqBody" class="dex-bot-body" hidden>
        <p class="small dex-bot-truth">${escapeHtml(t('dex.liq.truth'))}</p>

        <div class="dex-liq-stats">
          <div class="dex-liq-stat">
            <span class="small">${escapeHtml(t('dex.liq.pool'))}</span>
            <strong id="dexLiqPool">—</strong>
          </div>
          <div class="dex-liq-stat">
            <span class="small">${escapeHtml(t('dex.liq.providers'))}</span>
            <strong id="dexLiqProviders">—</strong>
          </div>
          <div class="dex-liq-stat">
            <span class="small">${escapeHtml(t('dex.liq.yourShare'))}</span>
            <strong id="dexLiqMine">—</strong>
          </div>
          <div class="dex-liq-stat">
            <span class="small">${escapeHtml(t('dex.liq.yourPct'))}</span>
            <strong id="dexLiqPct">—</strong>
          </div>
        </div>

        <div class="dex-swapbox">
          <div class="small">${escapeHtml(t('dex.liq.add'))}</div>
          <div class="dex-swapbox-row">
            <input id="dexLiqAdd" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal"
                   placeholder="0" aria-label="${escapeHtml(t('dex.liq.add'))}">
            <span class="dex-swapbox-token" id="dexLiqAddSym">—</span>
          </div>
          <div class="dex-swapbox-usd small">${escapeHtml(t('dex.liq.balance'))} <span id="dexLiqBal">—</span></div>
          <div class="dex-pctrow">
            ${[25, 50, 75, 100].map((pc) => `<button type="button" class="dex-pct" data-dex-liq-pct="${pc}">${pc === 100 ? escapeHtml(t('dex.trade.max')) : pc + '%'}</button>`).join('')}
          </div>
        </div>
        <button id="dexLiqAddBtn" type="button" class="btn btn-primary btn-block">${escapeHtml(t('dex.liq.addBtn'))}</button>

        <div class="dex-swapbox mt-8">
          <div class="small">${escapeHtml(t('dex.liq.remove'))}</div>
          <div class="dex-swapbox-row">
            <input id="dexLiqRemove" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal"
                   placeholder="0" aria-label="${escapeHtml(t('dex.liq.remove'))}">
            <span class="dex-swapbox-token" id="dexLiqRemoveSym">—</span>
          </div>
          <div class="dex-swapbox-usd small" id="dexLiqRemoveWorth">${escapeHtml(t('dex.liq.worth'))} —</div>
        </div>
        <button id="dexLiqRemoveBtn" type="button" class="btn btn-secondary btn-block">${escapeHtml(t('dex.liq.removeBtn'))}</button>

        <div class="small mt-8" id="dexLiqStatus" role="status" aria-live="polite"></div>
      </div>
    </section>`;
}

// ── bind ─────────────────────────────────────────────────────────────
export function bindLiquidity(host, token) {
  const toggle = $('#dexLiqToggle', host);
  const body = $('#dexLiqBody', host);
  const addEl = $('#dexLiqAdd', host);
  const removeEl = $('#dexLiqRemove', host);
  const addBtn = $('#dexLiqAddBtn', host);
  const removeBtn = $('#dexLiqRemoveBtn', host);
  const statusEl = $('#dexLiqStatus', host);

  toggle?.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) refresh().catch(() => say(t('dex.liq.unreadable'), 'is-error'));
  });

  const say = (msg, kind = '') => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'small mt-8' + (kind ? ' ' + kind : '');
  };

  // ── read ──────────────────────────────────────────────────────────
  // Every field the guards below read is present from the start. The initial value
// used to omit qbal, so `snap.qbal !== undefined && amount > snap.qbal` was
// false exactly when the first refresh had failed — the balance check silently
// switched itself off in the one case where it mattered.
let snap = { quoteAddr: null, pool: 0n, shares: 0n, total: 0n, value: 0n, dec: 18, sym: '', qbal: 0n, signedIn: false };

  async function refresh() {
    // Even a fast RPC is a wait on a slow WebView — say what is happening
    // instead of leaving the last figures unlabelled while new ones are read.
    say(t('dex.swap.loading'));
    const E = ethersLib();
    const cs = new E.Contract(token.address, PUMP_ABI, provider());
    const me = get('address');

    // positionOf() and balanceOf() take a reader. With no address yet — a
    // signed-out reader opening a coin — calling them with undefined asks the
    // chain about nobody, and whatever came back was painted as "your share".
    // The pool figures are public and still read; only the personal ones wait.
    const [quoteAddr, pool, total] = await Promise.all([
      cs.quoteToken(),
      cs.lpValue(),
      cs.totalLpShares(),
    ]);
    const shares = me ? await cs.lpShares(me) : 0n;
    const pos = me ? await cs.positionOf(me) : null;
    const value = pos ? pos[1] : 0n;

    const qc = new E.Contract(quoteAddr, ERC20_ABI, provider());
    const [dec, sym, qbal] = await Promise.all([
      qc.decimals().catch(() => 18),
      qc.symbol().catch(() => ''),
      me ? qc.balanceOf(me) : Promise.resolve(0n),
    ]);
    snap = { quoteAddr, pool, total, shares, value, dec, sym, qbal, signedIn: Boolean(me) };

    const set = (id, v) => { const el = $('#' + id, host); if (el) el.textContent = v; };
    set('dexLiqPool', fmtEth(pool, 4));
    set('dexLiqProviders', total === 0n ? t('dex.liq.none') : fmtTok(total, dec, 2));
    set('dexLiqMine', snap.signedIn ? fmtTok(snap.value, dec, 4) : t('dex.liq.signIn'));
    // The percentage is what makes "the pool is mostly mine" visible rather than
    // something the user has to divide two numbers to discover.
    const pct = total === 0n ? 0n : (shares * 10_000n) / total;
    set('dexLiqPct', (Number(pct) / 100).toFixed(2) + '%');
    set('dexLiqBal', snap.signedIn ? fmtEth(qbal, 4) : t('dex.liq.signIn'));
    for (const id of ['dexLiqAddSym', 'dexLiqRemoveSym']) set(id, sym || '—');
    // Clear the error line on a successful read. Nothing else wrote to it, so
    // after one dropped RPC the panel showed live figures with a permanent red
    // "could not read" underneath — both true at once, neither believable.
    say('');
    worth();
    return snap;
  }

  function worth() {
    const el = $('#dexLiqRemoveWorth', host);
    if (!el) return;
    const raw = (removeEl.value || '').trim();
    if (!raw || snap.total === 0n) { el.textContent = t('dex.liq.worth') + ' —'; return; }
    let sh; try { sh = ethersLib().parseUnits(raw, snap.dec); } catch { el.textContent = t('dex.liq.worth') + ' —'; return; }
    if (sh > snap.shares) sh = snap.shares;
    const out = (snap.pool * sh) / snap.total;
    el.textContent = `${t('dex.liq.worth')} ${fmtEth(out, 4)}`;
  }
  removeEl?.addEventListener('input', worth);

  for (const b of host.querySelectorAll('[data-dex-liq-pct]')) {
    b.addEventListener('click', () => {
      if (!snap.qbal || snap.qbal <= 0n) return toast(t('dex.liq.noBalance'), 'error');
      // "Max" is the whole balance: this is a DEPOSIT, not a sale, so there is no
      // fee to keep back the way a sell would need one.
      const pct = Number(b.dataset.dexLiqPct);
      // formatUnits straight to string. The round trip through Number() switched
      // to exponential notation below 1e-6 ("2.5e-7"), and parseUnits rejects
      // that outright — so on a dust balance every quick-fill produced a box
      // the Add button then refused as "not a number". It also silently lost
      // precision past 18 significant digits.
      addEl.value = ethersLib().formatUnits((snap.qbal * BigInt(pct)) / 100n, snap.dec);
    });
  }

  // ── add ───────────────────────────────────────────────────────────
  addBtn?.addEventListener('click', () => withTxButton(addBtn, t('dex.liq.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    if (!dexChainOk()) return toast(t('dex.liq.wrongChain'), 'error');
    const raw = (addEl.value || '').trim();
    if (!raw) return toast(t('dex.liq.needAmount'), 'error');
    const E = ethersLib();
    let amount; try { amount = E.parseUnits(raw, snap.dec || 18); } catch { return toast(t('dex.liq.needAmount'), 'error'); }
    if (amount <= 0n) return toast(t('dex.liq.needAmount'), 'error');
    if (snap.qbal !== undefined && amount > snap.qbal) return toast(t('dex.liq.insufficient'), 'error');

    const ok = await confirmTx({
      title: t('dex.liq.addTitle'),
      rows: [
        { k: t('dex.liq.add'), v: `${raw} ${snap.sym}` },
        { k: t('dex.liq.poolAfter'), v: fmtEth(snap.pool + amount, 4) },
        { k: t('dex.liq.noTokens'), v: t('dex.liq.yes') },
        { k: t('dex.liq.noMove'), v: t('dex.liq.yes') },
      ],
      confirmText: t('dex.liq.addBtn'),
      danger: true,
      valueWei: 0n,
    });
    if (!ok) return;

    const quote = new E.Contract(snap.quoteAddr, ERC20_ABI, signer);
    const allowed = await quote.allowance(await signer.getAddress(), token.address).catch(() => 0n);
    // Exactly this deposit, never an unlimited approval.
    if (allowed < amount) {
      const approved = await sendDexTx(() => quote.approve(token.address, amount), t('dex.liq.approving'));
      if (!approved) return;
    }
    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const sent = await sendDexTx(() => cs.addLiquidity(amount), t('dex.liq.addBtn'));
    if (!sent) return;
    toast(t('dex.liq.added', { amt: raw, sym: snap.sym }), 'success');
    addEl.value = '';
    await refresh();
  }));

  // ── remove ────────────────────────────────────────────────────────
  removeBtn?.addEventListener('click', () => withTxButton(removeBtn, t('dex.liq.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    if (!dexChainOk()) return toast(t('dex.liq.wrongChain'), 'error');
    if (snap.total === 0n || snap.shares === 0n) return toast(t('dex.liq.noPosition'), 'error');
    const raw = (removeEl.value || '').trim();
    if (!raw) return toast(t('dex.liq.needShares'), 'error');
    const E = ethersLib();
    let shares; try { shares = E.parseUnits(raw, snap.dec || 18); } catch { return toast(t('dex.liq.needShares'), 'error'); }
    if (shares <= 0n) return toast(t('dex.liq.needShares'), 'error');
    if (shares > snap.shares) return toast(t('dex.liq.tooMuch'), 'error');

    const out = (snap.pool * shares) / snap.total;
    const ok = await confirmTx({
      title: t('dex.liq.removeTitle'),
      rows: [
        { k: t('dex.liq.remove'), v: fmtTok(shares, snap.dec, 4) },
        { k: t('dex.liq.worth'), v: fmtEth(out, 4) + ' ' + snap.sym },
      ],
      confirmText: t('dex.liq.removeBtn'),
      danger: false,
      valueWei: 0n,
    });
    if (!ok) return;

    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const sent = await sendDexTx(() => cs.removeLiquidity(shares), t('dex.liq.removeBtn'));
    if (!sent) return;
    toast(t('dex.liq.removed', { amt: fmtEth(out, 4) }), 'success');
    removeEl.value = '';
    await refresh();
  }));

  return { refresh };
}