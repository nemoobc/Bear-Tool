// Bear Tool — js/dex/token-page.js
// The v2 token page: one pool token, everything read live.
//
// The page owns no state of its own. It asks the factory which pair belongs
// to this token (poolOf), then reads that pool and the token through the
// shared seams (pool-data.js) — the same reads the Swap / Pools / Liquidity
// tabs use, so no two screens can disagree about the same pool.
//
// The router keeps last say: only tokens the factory actually knows get this
// page. Anything else falls back to the legacy coin view — never a half-made
// v2 page over a token that has no pool.
import { t, escapeHtml, fmtTok, $, get, provider, ethersLib, isAddr, dexChainOk, quoteBy } from './core.js';
import { poolState, tokenInfo, lpPosition } from './pool-data.js';
import { quotePerToken } from './pool-list.js';
import { BEAR_TOKEN_ABI, BEAR_FACTORY_ABI } from './bear-source.js';
import { factoryAddress } from './factory.js';

const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/**
 * Is this token one of ours? Answers with the pair address when the factory
 * has a pool for it, null for everything else (unknown token, no factory, no
 * provider, wrong chain). Never guesses, never throws.
 */
export async function poolOf(token) {
  if (!isAddr(token)) return null;
  if (!dexChainOk()) return null;
  const f = factoryAddress();
  if (!isAddr(f) || !provider()) return null;
  try {
    const E = ethersLib();
    const c = new E.Contract(f, BEAR_FACTORY_ABI, provider());
    const p = await c.pairFor(token);
    return isAddr(p) && p !== '0x0000000000000000000000000000000000000000' ? p : null;
  } catch {
    return null;
  }
}

export function tokenPageHtml() {
  return `
    <button type="button" class="btn btn-secondary btn-block mb-8" id="dexTpBack">← ${escapeHtml(t('dex.tokens.title'))}</button>
    <div class="card mb-8">
      <div class="dex-create-top">
        <div class="dex-create-preview">
          <img id="dexTpImg" alt="" hidden />
          <div id="dexTpImgEmpty" class="small">${escapeHtml(t('dex.create.noImage'))}</div>
        </div>
        <div class="dex-create-fields">
          <div class="field-label" id="dexTpName"></div>
          <div class="small" id="dexTpDesc"></div>
        </div>
      </div>
    </div>
    <div class="card mb-8">
      <div class="small" id="dexTpPrice"></div>
      <div class="small" id="dexTpReserves"></div>
      <div class="small mt-8" id="dexTpMy"></div>
      <div class="mt-8">
        <button type="button" class="btn btn-primary" id="dexTpSwap"></button>
        <button type="button" class="btn btn-secondary" id="dexTpLp"></button>
      </div>
      <div class="small mt-8" id="dexTpNote" role="status"></div>
    </div>`;
}

export async function bindTokenPage(host, token, pair, { onBack, onSwap, onLp } = {}) {
  const el = (id) => $(`#${id}`, host);
  const backBtn = el('dexTpBack');
  const swapBtn = el('dexTpSwap');
  const lpBtn = el('dexTpLp');
  const noteEl = el('dexTpNote');
  if (!backBtn || !swapBtn || !lpBtn || !noteEl) return;

  if (onBack) backBtn.addEventListener('click', onBack);
  swapBtn.textContent = t('dex.pf.swap');
  lpBtn.textContent = t('dex.pf.manage');
  if (onSwap) swapBtn.addEventListener('click', () => onSwap(token));
  if (onLp) lpBtn.addEventListener('click', () => onLp(token));

  noteEl.textContent = t('dex.pools.loading');
  const E = ethersLib();
  if (!E || !provider()) { noteEl.textContent = t('dex.pools.unreadable'); return; }

  const me = get('address');
  const tc = new E.Contract(token, BEAR_TOKEN_ABI, provider());
  const [ti, face, desc, ps, lp] = await Promise.all([
    tokenInfo(token, me),
    tc.image().catch(() => ''),
    tc.description().catch(() => ''),
    poolState(pair),
    lpPosition(pair, me),
  ]);

  const sym = ti.ok && ti.symbol ? ti.symbol : shortOf(token);
  const name = ti.ok && ti.name ? ti.name : sym;
  const nameEl = el('dexTpName');
  const descEl = el('dexTpDesc');
  const img = el('dexTpImg');
  const imgEmpty = el('dexTpImgEmpty');
  if (nameEl) nameEl.textContent = `${name} (${sym}) · ${shortOf(token)}`;
  if (descEl) descEl.textContent = String(desc || '');
  if (img && /^data:image\//.test(String(face || ''))) {
    img.src = String(face);
    img.hidden = false;
    if (imgEmpty) imgEmpty.hidden = true;
  }

  if (!ps.ok) { noteEl.textContent = t('dex.swap.unreadable'); return; }
  noteEl.textContent = '';

  const qMeta = quoteBy(ps.quote);
  const qSym = qMeta ? qMeta.symbol : '…';
  const qd = qMeta ? qMeta.decimals : 18;
  const td = ti.ok ? ti.decimals : 18;
  const priceEl = el('dexTpPrice');
  const resEl = el('dexTpReserves');
  const myEl = el('dexTpMy');
  if (priceEl) {
    priceEl.textContent = `${t('dex.pools.price')}: ${fmtTok(quotePerToken(ps.quoteReserve, ps.tokenReserve, td), qd, 6)} ${qSym}`;
  }
  if (resEl) {
    resEl.textContent = `${t('dex.pools.reserves')}: ${fmtTok(ps.quoteReserve, qd, 2)} ${qSym} · ${fmtTok(ps.tokenReserve, td, 2)} ${sym}`;
  }
  if (myEl) {
    const bits = [];
    if (ti.ok) bits.push(`${t('dex.tp.you')}: ${fmtTok(ti.balance, td, 6)} ${sym}`);
    if (lp.ok && lp.shares > 0n) {
      bits.push(t('dex.lp.shares', { n: fmtTok(lp.shares, 18, 6) }));
      const now = Math.floor(Date.now() / 1000);
      const locked = lp.lockedUntil > BigInt(now);
      bits.push(locked
        ? t('dex.lp.locked', { date: new Date(Number(lp.lockedUntil) * 1000).toISOString().slice(0, 10) })
        : t('dex.lp.unlocked'));
    }
    myEl.textContent = bits.join(' · ');
  }
}
