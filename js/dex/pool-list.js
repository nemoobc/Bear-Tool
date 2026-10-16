// Bear Tool — js/dex/pool-list.js
// The Pools tab: every pool the factory has announced, with reserves and price
// read LIVE from the pair — through the same read layer the Swap tab uses
// (pool-data.js), so the two screens can never disagree about a pool.
//
// Honest states, same discipline as discovery: no provider / no factory /
// nothing found / a row that cannot be read are four different messages. A
// pool that cannot be read is never drawn as a zero pool.
import { t, escapeHtml, fmtTok, $, provider, dexChainOk, quoteBy, get, toast, confirmTx, openModal, closeModal, DEX_CHAIN_ID, QUOTE_PRESETS, ethersLib, sendDexTx, needSigner, isAddr } from './core.js';
import { parseAmount, ensureAllowanceTx } from './swap.js';
import { factoryAddress } from './factory.js';
import { BEAR_FACTORY_ABI } from './bear-source.js';
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

// ── deleted pools ────────────────────────────────────────────────
// A pool the user takes out of the list is only hidden LOCALLY: the pool
// still lives on the chain and discovery finds it again on every render, so
// the tombstone is re-applied at render time — the same discipline the
// feed's deleted coins use (list.js).
const POOLS_DELETED_KEY = 'bear.dex.deletedPools';

function deletedPools() {
  try {
    const raw = JSON.parse(localStorage.getItem(`${POOLS_DELETED_KEY}.${DEX_CHAIN_ID}`) || '[]');
    return Array.isArray(raw) ? raw.map((x) => String(x).toLowerCase()) : [];
  } catch { return []; }
}

export function isPoolDeleted(pair) {
  return deletedPools().includes(String(pair || '').toLowerCase());
}

export function deletePool(pair) {
  const a = String(pair || '').toLowerCase();
  if (!isAddr(a) || isPoolDeleted(a)) return false;
  try {
    localStorage.setItem(`${POOLS_DELETED_KEY}.${DEX_CHAIN_ID}`, JSON.stringify([...deletedPools(), a]));
    return true;
  } catch { return false; }
}

export function poolsHtml() {
  return `
    <div class="dex-launchbar">
      <div class="dex-launchbar-txt">
        <div class="dex-launchbar-title">${escapeHtml(t('dex.pools.title'))}</div>
        <div class="dex-launchbar-sub">${escapeHtml(t('dex.pools.hint'))}</div>
      </div>
      <button type="button" class="btn btn-sm" id="dexPoolsAdd">${escapeHtml(t('dex.addpool.title'))}</button>
    </div>
    <div id="dexPoolsList" class="dex-grid"></div>
    <div id="dexPoolsNote" class="small mt-8" role="status"></div>`;
}

export async function bindPools(host, onOpenSwap) {
  const list = $('#dexPoolsList', host);
  const note = $('#dexPoolsNote', host);
  if (!list || !note) return;
  const say = (m) => { note.textContent = m || ''; };

  // Wired before the gates on purpose: the button stays alive even when the
  // list cannot load, and openAddPool answers the gate question itself.
  const addBtn = $('#dexPoolsAdd', host);
  if (addBtn) addBtn.onclick = () => openAddPool(host, onOpenSwap);

  if (!dexChainOk()) { say(t('dex.gate.needSepolia')); return; }
  if (!provider()) { say(t('dex.pools.unreadable')); return; }

  say(t('dex.pools.loading'));
  const out = await discoverPools({ scope: 'all', limit: LIST_LIMIT });
  if (!out.ok) {
    say(out.reason === 'no factory' ? t('dex.swap.noFactory') : t('dex.pools.unreadable'));
    return;
  }
  if (!out.pools.length) { say(t('dex.pools.empty')); return; }

  // A pool the user deleted stays out: discovery finds it again on every
  // render, so the tombstone is re-applied here (deletePool below).
  const rows = (await fillMeta(out.pools.slice())).filter((r) => !isPoolDeleted(r.pair));
  if (!rows.length) { say(t('dex.pools.empty')); return; }
  // Bounded parallel: one pool state + one token read per row (LIST_LIMIT
  // rows max). Reserves come live or the row says it cannot be read.
  const live = await Promise.all(rows.map(async (r) => {
    const [ps, ti] = await Promise.all([poolState(r.pair), tokenInfo(r.address)]);
    return { r, ps, ti };
  }));
  list.innerHTML = live.map(rowHtml).join('');
  say(out.more ? t('dex.pools.more', { n: String(rows.length) }) : '');

  // onclick, not addEventListener: creating or deleting re-binds this panel in
  // place, and a listener stack would double-fire the handlers.
  list.onclick = async (e) => {
    const del = e.target.closest('[data-dex-pool-del]');
    if (del) {
      const pair = del.dataset.dexPoolDel;
      const card = del.closest('.dex-pool-card');
      const label = (card && card.dataset.dexPoolSym) || pair;
      const ok = await confirmTx({
        title: t('dex.pools.deleteConfirmTitle'),
        rows: [{ k: t('dex.pools.deleteRowPool'), v: label }],
        confirmText: t('dex.pools.deleteConfirmCta'),
        danger: true,
      });
      if (!ok) return;
      deletePool(pair);
      if (card) card.remove();
      say(t('dex.pools.deletedToast'));
      return;
    }
    const btn = e.target.closest('[data-dex-pool-open]');
    if (!btn || !onOpenSwap) return;
    onOpenSwap(btn.dataset.dexPoolOpen);
  };
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
    <div class="card dex-pool-card" data-dex-pool="${escapeHtml(r.address)}" data-dex-pool-sym="${escapeHtml(sym)}">
      <div><strong>${escapeHtml(sym)}</strong>${name}</div>
      ${body}
      <div class="dex-pool-actions">
        <button type="button" class="btn btn-primary btn-sm" data-dex-pool-open="${escapeHtml(r.address)}">${escapeHtml(t('dex.pools.open'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-dex-pool-del="${escapeHtml(r.pair)}">${escapeHtml(t('dex.pools.delete'))}</button>
      </div>
    </div>`;
}

/**
 * Open a pool for an existing ERC-20: the factory pulls both sides itself
 * (createPool transfers from msg.sender), so both tokens are approved to the
 * FACTORY first — approve-only-if-needed through the same helper every trade
 * uses — then one createPool call opens the pool and mints the LP shares to
 * the caller. The pool address comes out of the PoolCreated event, never
 * assumed. Returns { ok, pool }; ok:false when the wallet is locked, the
 * registry says the token already has a pool, or a transaction does not
 * confirm (sendDexTx has already said why on screen by then).
 */
export async function createPoolTx({ token, quote, tokensForPool, quoteForPool, tokenSym = '', quoteSym = '', signer, say } = {}) {
  const s = signer || needSigner();
  if (!s) return { ok: false, pool: '' };
  const E = ethersLib();
  const f = factoryAddress();
  if (!E || !provider() || !isAddr(f) || !isAddr(token) || !isAddr(quote)) return { ok: false, pool: '' };
  let tSeed = 0n;
  let qSeed = 0n;
  try { tSeed = BigInt(tokensForPool ?? 0); qSeed = BigInt(quoteForPool ?? 0); } catch { return { ok: false, pool: '' }; }
  if (!(tSeed > 0n) || !(qSeed > 0n)) return { ok: false, pool: '' };
  const c = new E.Contract(f, BEAR_FACTORY_ABI, s);
  // One pool per token per factory (pairFor IS the registry) — read it first
  // so a used token is refused in words, not in a wasted revert.
  try {
    const existing = await c.pairFor(token);
    if (existing && existing !== '0x0000000000000000000000000000000000000000') {
      if (say) say(t('dex.addpool.exists'));
      return { ok: false, pool: '' };
    }
  } catch { /* an unreadable registry lets the contract decide */ }
  if (say) say(t('dex.addpool.approving', { sym: tokenSym || 'token' }));
  const a1 = await ensureAllowanceTx({ token, spender: f, amount: tSeed, owner: s.address, signer: s });
  if (!a1.ok) return { ok: false, pool: '' };
  if (say) say(t('dex.addpool.approving', { sym: quoteSym || 'quote' }));
  const a2 = await ensureAllowanceTx({ token: quote, spender: f, amount: qSeed, owner: s.address, signer: s });
  if (!a2.ok) return { ok: false, pool: '' };
  if (say) say(t('dex.addpool.creating'));
  const rc = await sendDexTx(() => c.createPool(token, quote, tSeed, qSeed), t('dex.addpool.cta'));
  if (!rc) return { ok: false, pool: '' };
  let pool = '';
  for (const log of rc.logs || []) {
    try {
      const parsed = c.interface.parseLog(log);
      if (parsed && parsed.name === 'PoolCreated') { pool = parsed.args[2]; break; }
    } catch { /* not ours */ }
  }
  return { ok: true, pool };
}

/**
 * The Add-pool sheet: pick a pair, seed both sides, one tx. Only ERC-20s the
 * wallet already lists are offered — symbol and decimals come from the list,
 * so the amounts are parsed against known decimals, never a guess.
 */
export function openAddPool(host, onOpenSwap) {
  if (!dexChainOk()) { toast(t('dex.gate.needSepolia'), 'error'); return; }
  const tokens = (get('tokens') || []).filter((x) => x && isAddr(x.address) && Number.isInteger(x.decimals));
  const quoteOpts = QUOTE_PRESETS
    .map((p, i) => `<option value="${escapeHtml(p.address)}"${i === 0 ? ' selected' : ''}>${escapeHtml(p.symbol)} — ${escapeHtml(p.name)}</option>`)
    .join('');
  const tokenOpts = tokens
    .map((x) => `<option value="${escapeHtml(x.address)}">${escapeHtml(x.symbol || 'TOKEN')} — ${escapeHtml(String(x.address).slice(0, 6))}…${escapeHtml(String(x.address).slice(-4))}</option>`)
    .join('');
  openModal(`
    <h2>${escapeHtml(t('dex.addpool.title'))}</h2>
    <p class="small dim">${escapeHtml(t('dex.addpool.hint'))}</p>
    <div class="field">
      <label for="dexApToken">${escapeHtml(t('dex.addpool.token'))}</label>
      <select class="input" id="dexApToken"${tokens.length ? '' : ' disabled'}>${tokenOpts}</select>
    </div>
    <div class="field">
      <label for="dexApQuote">${escapeHtml(t('dex.addpool.quote'))}</label>
      <select class="input" id="dexApQuote">${quoteOpts}</select>
    </div>
    <div class="field">
      <label for="dexApTokens">${escapeHtml(t('dex.addpool.tokensAmt'))}</label>
      <input class="input" id="dexApTokens" inputmode="decimal" autocomplete="off" placeholder="0">
    </div>
    <div class="field">
      <label for="dexApQuoteAmt">${escapeHtml(t('dex.addpool.quoteAmt'))}</label>
      <input class="input" id="dexApQuoteAmt" inputmode="decimal" autocomplete="off" placeholder="0">
    </div>
    <button class="btn btn-primary btn-block" id="dexApGo" type="button"${tokens.length ? '' : ' disabled'}>${escapeHtml(t('dex.addpool.cta'))}</button>
    <button class="btn btn-ghost btn-block mt-8" type="button" data-close-modal>${escapeHtml(t('cf.cancel'))}</button>
    <div id="dexApMsg" class="small mt-8" role="status" aria-live="polite">${tokens.length ? '' : escapeHtml(t('dex.addpool.noToken'))}</div>
  `);
  const msg = document.getElementById('dexApMsg');
  const go = document.getElementById('dexApGo');
  const say = (m) => { if (msg) msg.textContent = m || ''; };
  if (!go || !tokens.length) return;
  go.onclick = async () => {
    const tokenSel = document.getElementById('dexApToken');
    const quoteSel = document.getElementById('dexApQuote');
    const token = tokenSel ? tokenSel.value : '';
    const quote = quoteSel ? quoteSel.value : '';
    const tMeta = tokens.find((x) => String(x.address).toLowerCase() === String(token).toLowerCase());
    const qMeta = quoteBy(quote);
    if (!tMeta || !qMeta) { say(t('dex.addpool.noToken')); return; }
    const tAmt = parseAmount(document.getElementById('dexApTokens')?.value, tMeta.decimals);
    const qAmt = parseAmount(document.getElementById('dexApQuoteAmt')?.value, qMeta.decimals);
    if (!tAmt.ok || !qAmt.ok) { say(t('dex.addpool.needAmount')); return; }
    go.disabled = true;
    try {
      const res = await createPoolTx({
        token: tMeta.address,
        quote,
        tokensForPool: tAmt.value,
        quoteForPool: qAmt.value,
        tokenSym: tMeta.symbol || '',
        quoteSym: qMeta.symbol || '',
        say,
      });
      if (res.ok) {
        const short = res.pool ? `${res.pool.slice(0, 6)}…${res.pool.slice(-4)}` : '—';
        toast(t('dex.addpool.done', { pool: short }), 'success');
        closeModal();
        if (host) bindPools(host, onOpenSwap);
      }
    } finally { go.disabled = false; }
  };
}
