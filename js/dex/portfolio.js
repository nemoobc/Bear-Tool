// Bear Tool — js/dex/portfolio.js
// The Portfolio tab (v2): what this wallet actually holds in the Dex.
//
// Two lists, both read live from the chains of discovered pools:
//   LP positions — shares + both sides + lock status (the pair is the LP token)
//   Tokens       — token balances above zero
// Positions that are empty are not drawn; a position that cannot be read says
// so (same honest-states rule as discovery). Nothing here is computed or
// remembered locally — this tab is a mirror, not a ledger.
import { t, escapeHtml, fmtTok, $, get, provider, dexChainOk, quoteBy } from './core.js';
import { discoverPools, fillMeta } from './pools.js';
import { lpPosition, tokenInfo } from './pool-data.js';

const LIST_LIMIT = 24;

const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export function portfolioHtml() {
  return `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.pf.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.pf.hint'))}</div>
      </div>
    </div>
    <div class="small" id="dexPfLpHdr"></div>
    <div id="dexPfLp" class="dex-grid"></div>
    <div class="small mt-8" id="dexPfTokenHdr"></div>
    <div id="dexPfTokens" class="dex-grid"></div>
    <div class="small mt-8" id="dexPfNote" role="status"></div>`;
}

export async function bindPortfolio(host, { onManageLp, onSwap } = {}) {
  const lpHdr = $('#dexPfLpHdr', host);
  const lpBox = $('#dexPfLp', host);
  const tkHdr = $('#dexPfTokenHdr', host);
  const tkBox = $('#dexPfTokens', host);
  const note = $('#dexPfNote', host);
  if (!lpHdr || !lpBox || !tkHdr || !tkBox || !note) return;
  const say = (m) => { note.textContent = m || ''; };

  if (!dexChainOk()) { say(t('dex.gate.needSepolia')); return; }
  if (!provider()) { say(t('dex.pools.unreadable')); return; }
  const me = get('address');
  if (!me) { say(t('dex.needWallet')); return; }

  say(t('dex.pools.loading'));
  const out = await discoverPools({ scope: 'all', limit: LIST_LIMIT });
  if (!out.ok) {
    say(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.pools.unreadable'));
    return;
  }
  if (!out.pools.length) { say(t('dex.pools.empty')); return; }

  const rows = await fillMeta(out.pools.slice());
  const read = await Promise.all(rows.map(async (r) => {
    const [lp, ti] = await Promise.all([lpPosition(r.pair, me), tokenInfo(r.address, me)]);
    return { r, lp, ti };
  }));
  const lpRows = read.filter((x) => x.lp.ok && x.lp.shares > 0n);
  const tkRows = read.filter((x) => x.ti.ok && x.ti.balance > 0n);

  lpHdr.textContent = lpRows.length ? t('dex.pf.lp') : '';
  tkHdr.textContent = tkRows.length ? t('dex.pf.tokens') : '';
  lpBox.innerHTML = lpRows.map(lpCard).join('');
  tkBox.innerHTML = tkRows.map(tkCard).join('');
  if (!lpRows.length && !tkRows.length) say(t('dex.pf.empty'));
  else say(out.more ? t('dex.pools.more', { n: String(rows.length) }) : '');

  lpBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dex-pf-manage]');
    if (!btn || !onManageLp) return;
    onManageLp(btn.dataset.dexPfManage);
  });
  tkBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dex-pf-swap]');
    if (!btn || !onSwap) return;
    onSwap(btn.dataset.dexPfSwap);
  });
}

function lpCard({ r, lp, ti }) {
  const qMeta = quoteBy(r.quote);
  const qSym = qMeta ? qMeta.symbol : '…';
  const qDec = qMeta ? qMeta.decimals : 18;
  const sym = r.symbol || shortOf(r.address);
  const now = Math.floor(Date.now() / 1000);
  const locked = lp.lockedUntil > BigInt(now);
  const lockLine = locked
    ? t('dex.lp.locked', { date: new Date(Number(lp.lockedUntil) * 1000).toISOString().slice(0, 10) })
    : t('dex.lp.unlocked');
  return `
    <div class="card dex-pool-card" data-dex-pf-lp="${escapeHtml(r.address)}">
      <div><strong>${escapeHtml(sym)}</strong> <span class="small">${escapeHtml(qSym)}</span></div>
      <div class="small">${escapeHtml(t('dex.lp.shares', { n: fmtTok(lp.shares, 18, 6) }))}</div>
      <div class="small">${escapeHtml(fmtTok(lp.quoteShare, qDec, 6))} ${escapeHtml(qSym)} + ${escapeHtml(fmtTok(lp.tokenShare, ti.ok ? ti.decimals : 18, 6))} ${escapeHtml(sym)}</div>
      <div class="small">${escapeHtml(lockLine)}</div>
      <button type="button" class="btn btn-primary mt-8" data-dex-pf-manage="${escapeHtml(r.address)}">${escapeHtml(t('dex.pf.manage'))}</button>
    </div>`;
}

function tkCard({ r, ti }) {
  const sym = ti.symbol || r.symbol || shortOf(r.address);
  return `
    <div class="card dex-pool-card" data-dex-pf-token="${escapeHtml(r.address)}">
      <div><strong>${escapeHtml(sym)}</strong></div>
      <div class="small">${escapeHtml(fmtTok(ti.balance, ti.decimals, 6))}</div>
      <button type="button" class="btn btn-primary mt-8" data-dex-pf-swap="${escapeHtml(r.address)}">${escapeHtml(t('dex.pf.swap'))}</button>
    </div>`;
}
