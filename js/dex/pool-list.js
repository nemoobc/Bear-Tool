// Bear Tool — js/dex/pool-list.js
// The Pools tab: every pool the factory has announced, with reserves and price
// read LIVE from the pair — through the same read layer the Swap tab uses
// (pool-data.js), so the two screens can never disagree about a pool.
//
// Honest states, same discipline as discovery: no provider / no factory /
// nothing found / a row that cannot be read are four different messages. A
// pool that cannot be read is never drawn as a zero pool.
import { t, escapeHtml, fmtTok, $, provider, dexChainOk, quoteBy } from './core.js';
import { discoverPools, fillMeta } from './pools.js';
import { poolState, tokenInfo } from './pool-data.js';

// A feed does not need 10k pools, and every row costs live reads. 24 keeps the
// list honest (newest first) without serializing hundreds of RPC calls.
const LIST_LIMIT = 24;

/**
 * Price of ONE whole token, in quote base units:
 * (quoteReserve × 10^tokenDecimals) / tokenReserve.
 * Format the result with the QUOTE's decimals — fmtTok(price, quoteDec) — and
 * it is the price of one whole token, read from the reserves themselves.
 * Pure, so the row renderer and the tests share the same arithmetic.
 */
export function quotePerToken(quoteReserve, tokenReserve, tokenDecimals) {
  const q = BigInt(quoteReserve || 0);
  const tk = BigInt(tokenReserve || 0);
  const td = Math.max(0, Math.min(36, Number(tokenDecimals) || 0));
  if (q <= 0n || tk <= 0n) return 0n;
  return (q * 10n ** BigInt(td)) / tk;
}

export function poolsHtml() {
  return `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.pools.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.pools.hint'))}</div>
      </div>
    </div>
    <div id="dexPoolsList" class="dex-grid"></div>
    <div id="dexPoolsNote" class="small mt-8" role="status"></div>`;
}

export async function bindPools(host, onOpenSwap) {
  const list = $('#dexPoolsList', host);
  const note = $('#dexPoolsNote', host);
  if (!list || !note) return;
  const say = (m) => { note.textContent = m || ''; };

  if (!dexChainOk()) { say(t('dex.gate.needSepolia')); return; }
  if (!provider()) { say(t('dex.pools.unreadable')); return; }

  say(t('dex.pools.loading'));
  const out = await discoverPools({ scope: 'all', limit: LIST_LIMIT });
  if (!out.ok) {
    say(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.pools.unreadable'));
    return;
  }
  if (!out.pools.length) { say(t('dex.pools.empty')); return; }

  const rows = await fillMeta(out.pools.slice());
  // Bounded parallel: one pool state + one token read per row (LIST_LIMIT
  // rows max). Reserves come live or the row says it cannot be read.
  const live = await Promise.all(rows.map(async (r) => {
    const [ps, ti] = await Promise.all([poolState(r.pair), tokenInfo(r.address)]);
    return { r, ps, ti };
  }));
  list.innerHTML = live.map(rowHtml).join('');
  say(out.more ? t('dex.pools.more', { n: String(rows.length) }) : '');

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dex-pool-open]');
    if (!btn || !onOpenSwap) return;
    onOpenSwap(btn.dataset.dexPoolOpen);
  });
}

function rowHtml({ r, ps, ti }) {
  const qMeta = quoteBy(r.quote);
  const qSym = qMeta ? qMeta.symbol : '…';
  const qDec = qMeta ? qMeta.decimals : 18;
  const sym = r.symbol || `${r.address.slice(0, 6)}…${r.address.slice(-4)}`;
  const name = r.name && r.name !== r.symbol ? ` <span class="small">${escapeHtml(r.name)}</span>` : '';
  const body = ps.ok && ti.ok
    ? `<div class="small">${escapeHtml(t('dex.pools.price'))}: ${escapeHtml(fmtTok(quotePerToken(ps.quoteReserve, ps.tokenReserve, ti.decimals), qDec, 6))} ${escapeHtml(qSym)}</div>
      <div class="small">${escapeHtml(t('dex.pools.reserves'))}: ${escapeHtml(fmtTok(ps.quoteReserve, qDec, 2))} ${escapeHtml(qSym)} · ${escapeHtml(fmtTok(ps.tokenReserve, ti.decimals, 2))} ${escapeHtml(sym)}</div>`
    : `<div class="small">${escapeHtml(t('dex.swap.unreadable'))}</div>`;
  return `
    <div class="card dex-pool-card" data-dex-pool="${escapeHtml(r.address)}">
      <div><strong>${escapeHtml(sym)}</strong>${name}</div>
      ${body}
      <button type="button" class="btn btn-primary mt-8" data-dex-pool-open="${escapeHtml(r.address)}">${escapeHtml(t('dex.pools.open'))}</button>
    </div>`;
}
