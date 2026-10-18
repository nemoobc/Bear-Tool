// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/index.js (Dex v2) — the view entry.
//
// The app's standing contract: renderDex(root, opts) with root = #dexRoot;
// app.js switchView → refreshView('dex') calls it. The thin React shell
// (src/views/dex.jsx) carries the static chrome; this module paints and owns
// everything live.
//
// Milestone 1: an honest mounted state — network, wallet, engine gate. Works
// with zero address, like every other view (app doctrine).
//
// Milestone 3: the trade surface. One card, one path: paste a deployed
// pair's address, read it live (token, quote, decimals, reserves — always
// from the chain, never from a constant), quote through the pair's own
// getAmountOut view, and confirm twice — the approve sheet spends the EXACT
// trade amount (the standing allowance returns to zero after every trade),
// the swap sheet shows price, pool fee and the minOut floor nothing can
// widen. What is not built yet (pool discovery, LP, launch, bot) simply is
// not on screen, per the M1 doctrine.
// ═══════════════════════════════════════════════════════════════

import { get, on, off } from '../state.js';
import { getNetworkById } from '../network.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui.js';
import { waitForReceipt, receiptVerdict } from '../safetx.js';
import {
  DEX_CHAIN_ID, dexChainOk,
} from './core.js';
import {
  approveData, isAddress, pairContract, parseAmount, readPair,
  slippageMinOut, swapData, tokenContract,
  SLIP_DEFAULT_BPS, SLIP_MAX_BPS,
} from './swap.js';
import {
  addLiqData, factoryRecall, factoryRemember,
  lpPreviewAdd, lpPreviewRemove, poolState, removeLiqData, scanFactory,
} from './pools.js';

const { ethers } = globalThis;

// The pattern must never crash a paint that ran on a stub root (the M1 test
// hands { innerHTML: '' } straight in): nodes are only bound when the root
// can look them up. This is a guard on OUR plumbing, not on the user's DOM.
const q = (root, sel) => typeof root.querySelector === 'function' ? root.querySelector(sel) : null;

function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}
const Q = 10n ** 18n;

// The single live subscription of the current paint. A stale handler must
// never rewrite a DOM node another view now owns, so every paint re-arms it
// and the handler bails once its root has left the document.
let repaint = null;

// Trade-sheet live state for the current mount. module-local: the view is
// single-instance (one #dexRoot), the state dies with the paint.
let trade = null;

// Rubric rows for the slippage band select. The bands are FIXED data — a
// free-typed custom slippage is exactly where a typo drains a trade; the
// 30% escape hatch exists, as a click.
const SLIP_BANDS = [50, 100, 300, 600, 1500, 3000];

const fmt = (v, d) => {
  try { return ethers.formatUnits(v, d); } catch { return '—'; }
};

// ── the trade card ─────────────────────────────────────────────────────

// The three shapers are exported so the test suite pins DOM structure —
// classes, cancel+confirm dialog pair, absence of emoji — without source-
// text regexes over this file. They are pure string builders.
export function tradeStubHtml() {
  return `
    <div class="dex-card" id="dexTradeCard">
      <div class="dex-card-head">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>${t('dex.trade.h')}</span>
      </div>
      <p class="dex-t-hint">${t('dex.trade.hint')}</p>
      <div class="dex-trade-bar">
        <input id="dexSwapPair" class="dex-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="${t('dex.trade.ph')}" aria-label="${t('dex.trade.aria')}">
        <button id="dexSwapOpen" class="dex-btn" type="button">${t('dex.trade.open')}</button>
      </div>
      <div class="dex-status" id="dexSwapStatus"></div>
      <div id="dexTradeBody"></div>
    </div>`;
}

function esc(s) { return escapeHtml(String(s)); }

// The trade body built once a pair resolves. Everything live (balances,
// quotes, fees) refreshes from the chain; this template only shapes it.
export function tradeBodyHtml(st) {
  const bands = SLIP_BANDS.map((b) => `<option value="${b}" ${b === SLIP_DEFAULT_BPS ? 'selected' : ''}>${b / 100}%</option>`).join('');  return `
    <div class="dex-dir" role="group" aria-label="${t('dex.swap.dir.aria')}">
      <button type="button" class="dex-dir-btn ${st.buy ? 'on' : ''}" id="dexSwapBuy" aria-pressed="${st.buy}">${t('dex.swap.buy')}</button>
      <button type="button" class="dex-dir-btn ${st.buy ? '' : 'on'}" id="dexSwapSell" aria-pressed="${!st.buy}">${t('dex.swap.sell')}</button>
    </div>
    <div class="dex-amtrow">
      <input id="dexSwapAmt" class="dex-input" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
             placeholder="${t('dex.swap.amt.ph')}" aria-label="${t('dex.swap.amt.aria')}">
      <button type="button" id="dexSwapMax" class="dex-btn">${t('dex.swap.max')}</button>
    </div>
    <div class="dex-sliprow">
      <span class="dex-k">${t('dex.swap.slip')}</span>
      <select id="dexSwapSlip" class="dex-input dex-select" aria-label="${t('dex.swap.slip')}">${bands}</select>
    </div>
    <div class="dex-live" id="dexSwapLive" data-dex-live>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.out')}</span><span class="dex-v" data-dex-out>—</span></div>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.minout')}</span><span class="dex-v" data-dex-minout>—</span></div>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.fee')}</span><span class="dex-v">0.30%${st.creatorBps > 0 ? ` ${t('dex.swap.creator').replace('{bps}', String(st.creatorBps))}` : ''}</span></div>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.reserves')}</span><span class="dex-v" data-dex-res>—</span></div>
    </div>
    <div class="dex-actions">
      <button type="button" id="dexSwapGo" class="dex-btn dex-btn-primary">${t('dex.swap.go')}</button>
    </div>`;
}

// One of the two confirm sheets. The legal copy differs by the title:
// approve → EXACT allowance cap; swap → numbers + the minOut floor.
export function sheetHtml(title) {
  return `
    <div class="dex-sheet" data-dex-sheet role="dialog" aria-modal="false" aria-label="${esc(title)}">
      <div class="dex-sheet-title">${esc(title)}</div>
      <div class="dex-sheet-body" data-dex-sheet-body></div>
      <div class="dex-sheet-actions">
        <button type="button" class="dex-btn" data-dex-cancel>${t('dex.swap.cancel')}</button>
        <button type="button" class="dex-btn dex-btn-primary" data-dex-confirm>${t('dex.swap.confirm')}</button>
      </div>
    </div>`;
}

function fmtPairRes(st) {
  return esc(`${fmt(st.reserves[0], st.quote.decimals)} / ${fmt(st.reserves[1], st.token.decimals)} (${esc(st.quote.symbol)} / ${esc(st.token.symbol)})`);
}

// Live quote recompute — ALWAYS through the pair's getAmountOut view.
async function refreshQuote(st, mount) {
  const body = mount.querySelector('#dexTradeBody');
  if (!body) return;
  const outEl = body.querySelector('[data-dex-out]');
  const minEl = body.querySelector('[data-dex-minout]');
  const resEl = body.querySelector('[data-dex-res]');
  const amt = body.querySelector('#dexSwapAmt');
  const slip = body.querySelector('#dexSwapSlip');
  const bps = Number(slip?.value ?? SLIP_DEFAULT_BPS);
  const parsed = parseAmount(amt?.value ?? '', st.buy ? st.quote.decimals : st.token.decimals);
  st.quoteOut = null;
  if (!parsed.ok || !resEl) {
    if (resEl) resEl.textContent = fmtPairRes(st);
    if (outEl) outEl.textContent = '—';
    if (minEl) minEl.textContent = '—';
    return;
  }
  try {
    const outVal = await st.pair.getAmountOut(st.buy, parsed.value); // VIEW mirror — the contract's own math
    const minOut = slippageMinOut(outVal, bps);
    st.quoteOut = outVal;
    st.minOut = minOut;
    st.amountIn = parsed.value;
    const paying = st.buy ? st.quote : st.token;
    const getting = st.buy ? st.token : st.quote;
    if (outEl) outEl.textContent = `${fmt(outVal, getting.decimals)} ${esc(getting.symbol)}`;
    if (minEl) minEl.textContent = `${fmt(minOut, getting.decimals)} ${esc(getting.symbol)} (${t('dex.swap.slip')} ${bps / 100}%)`;
  } catch {
    st.quoteOut = null;
    if (outEl) outEl.textContent = '—';
    if (minEl) minEl.textContent = '—';
  }
}

function setStatus(mount, msg, cls = '', sel = '#dexSwapStatus') {
  const el = mount.querySelector(sel);
  if (el) { el.textContent = msg; el.className = `dex-status ${cls}`.trim(); }
}

// ── the sheets: one dialog per transaction, cancel + confirm ──────────

// hostSel/stateRef keep the sheet machinery generic: the trade card mounts
// its sheets in #dexTradeBody and owns them through `trade`; the pools card
// mounts in #dexPoolList/env and owns them through `pools` (M4). One
// lifecycle, two owners — every call site passes its own ref.
function openSheet(mount, title, bodyHtml, hostSel = '#dexTradeBody', stateRef = null) {
  const host = mount.querySelector(hostSel);
  if (!host) throw new Error('dex/index: no-sheet-host');
  const ref = stateRef;
  const wrap = document.createElement('div');
  wrap.dataset.dexSheetHost = '';
  wrap.innerHTML = sheetHtml(title);
  wrap.querySelector('[data-dex-sheet-body]').innerHTML = bodyHtml;
  host.querySelector('[data-dex-sheet-host]')?.remove();
  host.appendChild(wrap);
  const cancelB = wrap.querySelector('[data-dex-cancel]');
  const confirmB = wrap.querySelector('[data-dex-confirm]');
  cancelB.focus();
  const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
  function onCancel() {
    if (wrap._busy) return; // a send in flight: the cancel door is closed, the tx must land or fail on record
    document.removeEventListener('keydown', onKey);
    wrap.remove();
    if (ref) ref.sheet = null;
  }
  document.addEventListener('keydown', onKey);
  const forceRemove = () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
    if (ref) ref.sheet = null;
  };
  cancelB.addEventListener('click', onCancel);
  return { wrap, confirmB, cancelB, onCancel, forceRemove };
}

function sheetBodyApprove(st, amountIn) {
  const con = st.buy ? st.quote : st.token;
  const conSym = esc(con.symbol);
  return `
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.token')}</span><span class="dex-v">${conSym}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.cap')}</span><span class="dex-v">${fmt(amountIn, con.decimals)} ${conSym}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.spender')}</span><span class="dex-v">${esc(shortAddr(st.pairAddress))}</span></div>
    <p class="dex-t-hint">${t('dex.sheet.a.hint')}</p>`;
}

function sheetBodySwap(st, amountIn, minOut) {
  const pay = st.buy ? st.quote : st.token;
  const get = st.buy ? st.token : st.quote;
  return `
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.s.pay')}</span><span class="dex-v">${fmt(amountIn, pay.decimals)} ${esc(pay.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.swap.out')}</span><span class="dex-v">≈ ${fmt(st.quoteOut ?? 0n, get.decimals)} ${esc(get.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.swap.minout')}</span><span class="dex-v">${fmt(minOut, get.decimals)} ${esc(get.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.swap.fee')}</span><span class="dex-v">0.30%</span></div>`;
}

/** The one send path — signer + providerOnCurrentChain, per app doctrine. */
async function signerProvider() {
  const signer = get('signer');
  if (!signer || typeof signer.sendTransaction !== 'function') {
    const e = new Error('no-signer'); e.why = 'signer'; throw e;
  }
  let provider = get('provider');
  const chainOk = dexChainOk(Number((await provider?.getNetwork?.())?.chainId ?? NaN));
  if (!chainOk) { const e = new Error('chain'); e.why = 'chain'; throw e; }
  return { signer, provider };
}

// Bounded receipt wait via safetx (the app's send discipline): a dropped tx
// resolves {kind:'pending'} with the hash kept for the explorer instead of an
// unbounded promise, and a revert is an on-chain OUTCOME reported as one.
async function sendTx(st, to, data) {
  const { signer, provider } = await signerProvider();
  const sent = await signer.connect(provider).sendTransaction({ to, data });
  const v = receiptVerdict(await waitForReceipt(sent, { label: 'dex trade' }));
  if (v.kind === 'failed') { const e = new Error('reverted'); e.why = 'revert'; throw e; }
  if (v.kind === 'pending') { const e = new Error('pending'); e.why = 'pending'; e.hash = v.hash; throw e; }
  return v;
}

// ── M4: the pools card — factory discovery + the LP panel ─────────────

const PS = '#dexPoolStatus'; // the pools card's own status slot
const LPSHEET_HOST = '#dexPoolList'; // LP sheets mount inside the list

// Live pools state for the current mount, dies with the paint like `trade`:
// { sheet, factory, quote, rows, st: Map(pair → live state), sel }
let pools = null;

const nowSec = () => Math.floor(Date.now() / 1000);
const lockDate = (un) => {
  try { return new Date(un * 1000).toISOString().slice(0, 16).replace('T', ' '); } catch { return String(un); }
};
const pctOf = (mine, sup) => (sup > 0n ? Number((mine * 10000n) / sup) / 100 : 0);

function debounced(fn, ms = 220) {
  let ti = null;
  return () => { clearTimeout(ti); ti = setTimeout(fn, ms); };
}

export function poolsStubHtml() {
  return `
    <div class="dex-card" id="dexPoolCard">
      <div class="dex-card-head">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7S6 10 6 14a6 6 0 0 0 12 0c0-4-6-11.3-6-11.3z"/></svg>
        <span>${t('dex.pool.h')}</span>
      </div>
      <p class="dex-t-hint">${t('dex.pool.hint')}</p>
      <div class="dex-trade-bar">
        <input id="dexPoolFactory" class="dex-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="${t('dex.pool.ph')}" aria-label="${t('dex.pool.aria')}">
        <button id="dexPoolScan" class="dex-btn" type="button">${t('dex.pool.scan')}</button>
      </div>
      <div class="dex-last" id="dexPoolLast"></div>
      <div class="dex-status" id="dexPoolStatus"></div>
      <div id="dexPoolList" class="dex-pool-list"></div>
    </div>`;
}

const PRICE_PER_TOKEN = (st) => {
  const [rQ, rT] = st.reserves;
  if (rT === 0n) return null;
  // quote-wei per ONE whole token — raw wei ratio, decimals cancel out
  return (rQ * 10n ** BigInt(st.token.decimals)) / rT;
};

export function poolRowHtml(st) {
  const px = PRICE_PER_TOKEN(st);
  const evLock = Number(st.lockUntil); // the launch's own LP lock, straight from the event
  const evLockLive = evLock > nowSec();
  return `
    <div class="dex-pool-row" data-dex-pair="${esc(st.pair)}">
      <div class="dex-pairline">
        <span class="dex-pairname">${esc(st.token.symbol)}/${esc(st.quote.symbol)}</span>
        <span class="dex-pairaddr">${esc(shortAddr(st.pair))}</span>
      </div>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.reserves')}</span><span class="dex-v">${esc(fmt(st.reserves[0], st.quote.decimals))} / ${esc(fmt(st.reserves[1], st.token.decimals))}</span></div>
      <div class="dex-row"><span class="dex-k">${t('dex.pool.price')}</span><span class="dex-v">${px === null ? '—' : `${esc(ethers.formatUnits(px, st.quote.decimals))} ${esc(st.quote.symbol)}`}</span></div>
      <div class="dex-row"><span class="dex-k">${t('dex.swap.fee')}</span><span class="dex-v">0.30%${st.creatorBps > 0 ? ` + ${esc(t('dex.swap.creator').replace('{bps}', String(st.creatorBps)))}` : ''}</span></div>
      ${evLockLive ? `<div class="dex-row"><span class="dex-k">${t('dex.pool.lock.label')}</span><span class="dex-v dex-warn">${esc(t('dex.pool.locked').replace('{until}', lockDate(evLock)))}</span></div>` : ''}
      ${st.myShares > 0n ? `<div class="dex-row"><span class="dex-k">${t('dex.lp.mine')}</span><span class="dex-v">${esc(fmt(st.myShares, 18))} (${pctOf(st.myShares, st.totalSupply)}%)</span></div>` : ''}
      <div class="dex-pool-acts">
        <button type="button" class="dex-btn" data-dex-act="trade">${t('dex.pool.trade')}</button>
        <button type="button" class="dex-btn dex-btn-primary" data-dex-act="lp">${t('dex.lp.open')}</button>
      </div>
    </div>`;
}

// One panel under the row list: my position + add + remove, one band select
// governing both floors. Lock truth is LIVE here (pair.lockOf(me)), not the
// event's launch-day stamp.
export function lpBodyHtml(st) {
  const bands = SLIP_BANDS.map((b) => `<option value="${b}" ${b === SLIP_DEFAULT_BPS ? 'selected' : ''}>${b / 100}%</option>`).join('');
  const lockedNow = st.lockUntil > nowSec();
  return `
    <div id="dexLpPanel" data-dex-lp-panel>
      <div class="dex-lp-head">
        <span class="dex-lp-title">${t('dex.lp.h')} <strong>${esc(st.token.symbol)}</strong></span>
        <button type="button" class="dex-btn dex-btn-sm" data-dex-lpclose aria-label="${t('dex.lp.close')}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="dex-live">
        <div class="dex-row"><span class="dex-k">${t('dex.lp.mine')}</span><span class="dex-v">${esc(fmt(st.myShares, 18))} (${pctOf(st.myShares, st.totalSupply)}%)</span></div>
        <div class="dex-row"><span class="dex-k">${t('dex.lp.sup')}</span><span class="dex-v">${esc(fmt(st.totalSupply, 18))}</span></div>
        <div class="dex-row"><span class="dex-k">${t('dex.pool.lock.label')}</span><span class="dex-v ${lockedNow ? 'dex-warn' : ''}">${lockedNow ? esc(t('dex.lp.locknow').replace('{until}', lockDate(st.lockUntil))) : esc(t('dex.lp.opennow'))}</span></div>
      </div>
      <div class="dex-sliprow">
        <span class="dex-k">${t('dex.swap.slip')}</span>
        <select id="dexLpSlip" class="dex-input dex-select" aria-label="${t('dex.swap.slip')}">${bands}</select>
      </div>
      <div class="dex-lp-block">
        <div class="dex-lp-title">${t('dex.lp.add')}</div>
        <div class="dex-amtrow">
          <input id="dexLpAddQ" class="dex-input" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
                 placeholder="${esc(t('dex.lp.in').replace('{sym}', st.quote.symbol))}" aria-label="${esc(t('dex.lp.in').replace('{sym}', st.quote.symbol))}">
          <button type="button" id="dexLpAddQMax" class="dex-btn">${t('dex.swap.max')}</button>
        </div>
        <div class="dex-amtrow">
          <input id="dexLpAddT" class="dex-input" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
                 placeholder="${esc(t('dex.lp.in').replace('{sym}', st.token.symbol))}" aria-label="${esc(t('dex.lp.in').replace('{sym}', st.token.symbol))}">
          <button type="button" id="dexLpAddTMax" class="dex-btn">${t('dex.swap.max')}</button>
        </div>
        <div class="dex-row"><span class="dex-k">${t('dex.lp.est')}</span><span class="dex-v" data-dex-lp-made>—</span></div>
        <div class="dex-row"><span class="dex-k">${t('dex.lp.minsym')}</span><span class="dex-v" data-dex-lp-min>—</span></div>
        <p class="dex-warn" data-dex-lp-lwarn></p>
        <div class="dex-actions">
          <button type="button" id="dexLpAddGo" class="dex-btn dex-btn-primary" disabled>${t('dex.lp.gadd')}</button>
        </div>
      </div>
      <div class="dex-lp-block">
        <div class="dex-lp-title">${t('dex.lp.rm')}</div>
        <div class="dex-amtrow">
          <input id="dexLpRmS" class="dex-input" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
                 placeholder="${esc(t('dex.lp.saria'))}" aria-label="${esc(t('dex.lp.saria'))}">
          <button type="button" id="dexLpRmSMax" class="dex-btn">${t('dex.swap.max')}</button>
        </div>
        <div class="dex-row"><span class="dex-k">${t('dex.lp.out')}</span><span class="dex-v" data-dex-lp-out>—</span></div>
        <div class="dex-row"><span class="dex-k">${t('dex.lp.minsym')}</span><span class="dex-v" data-dex-lp-min2>—</span></div>
        <p class="dex-warn" data-dex-lp-rwarn></p>
        <div class="dex-actions">
          <button type="button" id="dexLpRmGo" class="dex-btn dex-btn-primary" disabled>${t('dex.lp.grm')}</button>
        </div>
      </div>
    </div>`;
}

// ── scan + list paint ──────────────────────────────────────────────────

function rowsFor() {
  return Array.from(pools.st.values()).map(poolRowHtml).join('');
}

function paintPoolList(mount) {
  const listEl = mount.querySelector('#dexPoolList');
  if (!listEl || !pools) return;
  if (!pools.st.size) {
    listEl.innerHTML = `<div class="dex-empty">${esc(t('dex.pool.empty'))}</div>`;
    return;
  }
  listEl.innerHTML = rowsFor() + `<div id="dexLpBody"></div>`;
  if (pools.sel && pools.st.has(pools.sel)) openLp(mount, pools.sel);
}

async function scanPools(mount, raw) {
  const v = String(raw || '').trim();
  if (!isAddress(v)) { setStatus(mount, t('dex.pool.bad'), 'err', PS); return; }
  const provider = get('provider');
  if (!provider) { setStatus(mount, t('dex.engine.off'), 'err', PS); return; }
  setStatus(mount, t('dex.pool.busy'), 'busy', PS);
  try {
    const scan = await scanFactory(provider, v);
    const me = get('address') || null;
    const states = await Promise.all(
      scan.pools.map((row) => poolState(provider, row, scan.quote, me)),
    );
    pools = {
      sheet: null, factory: v, quote: scan.quote, sel: null,
      rows: scan.pools,
      st: new Map(states.map((st) => [st.pair, st])),
    };
    const chainId = getNetworkById(get('networkId'))?.chainId;
    if (chainId) factoryRemember(chainId, v);
    paintPoolList(mount);
    setPoolLastUsed(mount);
    setStatus(mount, t('dex.pool.n').replace('{n}', String(states.length)), states.length ? 'ok' : '', PS);
  } catch (e) {
    const whyText = {
      bad: t('dex.pool.bad'),
      contract: t('dex.pool.contract'),
    }[e.why] || `${t('dex.pool.err')} ${esc(String(e.shortMessage || e.message || 'error').slice(0, 120))}`;
    setStatus(mount, whyText, 'err', PS);
  }
}

function setPoolLastUsed(mount) {
  const lastEl = mount.querySelector('#dexPoolLast');
  if (!lastEl) return;
  const chainId = getNetworkById(get('networkId'))?.chainId;
  const saved = chainId ? factoryRecall(chainId) : '';
  if (!saved) { lastEl.innerHTML = ''; return; }
  lastEl.innerHTML = `
    <span>${esc(t('dex.pool.last'))} ${esc(shortAddr(saved))}</span>
    <button type="button" id="dexPoolUseLast" class="dex-btn dex-btn-sm" aria-label="${esc(t('dex.pool.use'))} ${esc(saved)}">${esc(t('dex.pool.use'))}</button>`;
  mount.querySelector('#dexPoolUseLast')?.addEventListener('click', () => {
    const facIn = mount.querySelector('#dexPoolFactory');
    if (facIn) facIn.value = saved;
    scanPools(mount, saved);
  });
}

// ── the LP panel ───────────────────────────────────────────────────────

function openLp(mount, pair) {
  const st = pools?.st.get(pair);
  if (!st) return;
  pools.sel = pair;
  mount.querySelectorAll('#dexPoolList [data-dex-pair]').forEach((el) => {
    el.classList.toggle('dex-on', el.getAttribute('data-dex-pair') === pair);
  });
  const body = mount.querySelector('#dexLpBody');
  if (!body) return;
  body.innerHTML = lpBodyHtml(st);
  bindLpBody(mount, st);
}

function closeLp(mount) {
  if (pools) pools.sel = null;
  mount.querySelectorAll('#dexPoolList [data-dex-pair]')
    .forEach((el) => el.classList.remove('dex-on'));
  const body = mount.querySelector('#dexLpBody');
  if (body) body.innerHTML = '';
}

function bindLpBody(mount, st) {
  const body = mount.querySelector('#dexLpPanel');
  if (!body) return;
  const qd = st.quote.decimals;
  const td = st.token.decimals;
  const slip = body.querySelector('#dexLpSlip');
  const qIn = body.querySelector('#dexLpAddQ');
  const tIn = body.querySelector('#dexLpAddT');
  const sIn = body.querySelector('#dexLpRmS');
  const bpsOf = () => Number(slip?.value ?? SLIP_DEFAULT_BPS);
  const [rQ, rT] = st.reserves;

  const refreshAdd = () => {
    const qv = qIn.value.trim();
    const tv = tIn.value.trim();
    let bq = parseAmount(qv, qd);
    let bt = parseAmount(tv, td);
    // the ratio helper: one leg filled, its mate empty → suggest the pool ratio
    if (bt.ok && tv !== '' && qv === '') {
      qIn.value = ethers.formatUnits(bt.value * rQ / rT, qd);
      bq = parseAmount(qIn.value, qd);
    } else if (bq.ok && qv !== '' && tv === '') {
      tIn.value = ethers.formatUnits(bq.value * rT / rQ, td);
      bt = parseAmount(tIn.value, td);
    }
    const ok = bq.ok && bt.ok;
    const pv = ok ? lpPreviewAdd(st, bq.value, bt.value) : null;
    const madeEl = body.querySelector('[data-dex-lp-made]');
    const minEl = body.querySelector('[data-dex-lp-min]');
    const warnEl = body.querySelector('[data-dex-lp-lwarn]');
    if (madeEl) madeEl.textContent = pv ? `${fmt(pv.made, 18)}` : '—';
    if (minEl) minEl.textContent = pv ? fmt(slippageMinOut(pv.made, bpsOf()), 18) : '—';
    if (warnEl) warnEl.textContent = pv?.lopsided ? t('dex.lp.lwarn') : '';
    const goEl = body.querySelector('#dexLpAddGo');
    if (goEl) goEl.disabled = !(pv && pv.made > 0n && pv.why === 'ok');
  };

  const refreshRm = () => {
    const lockedNow = st.lockUntil > nowSec();
    const bs = parseAmount(sIn.value.trim(), 18);
    const outEl = body.querySelector('[data-dex-lp-out]');
    const minEl = body.querySelector('[data-dex-lp-min2]');
    const warnEl = body.querySelector('[data-dex-lp-rwarn]');
    const out = bs.ok ? lpPreviewRemove(st, bs.value) : null;
    if (outEl) outEl.textContent = out
      ? `${fmt(out.outQuote, qd)} ${esc(st.quote.symbol)} + ${fmt(out.outToken, td)} ${esc(st.token.symbol)}`
      : '—';
    if (minEl) minEl.textContent = out
      ? `${fmt(slippageMinOut(out.outQuote, bpsOf()), qd)} + ${fmt(slippageMinOut(out.outToken, bpsOf()), td)}`
      : '—';
    if (warnEl) {
      warnEl.textContent = !bs.ok ? ''
        : bs.value > st.myShares ? t('dex.lp.toomuch')
        : lockedNow ? t('dex.lp.locknow').replace('{until}', lockDate(st.lockUntil))
        : '';
    }
    const goEl = body.querySelector('#dexLpRmGo');
    if (goEl) goEl.disabled = !(bs.ok && bs.value > 0n && !lockedNow && bs.value <= st.myShares);
  };

  const setMax = async (input, dec, addr) => {
    try {
      const bal = await tokenContract(addr, get('provider')).balanceOf(get('address') || '');
      input.value = fmt(bal, dec);
    } catch { /* a dead rpc must not crash the input */ }
  };
  body.querySelector('#dexLpAddQMax')?.addEventListener('click', async () => setMax(qIn, qd, st.quote.address));
  body.querySelector('#dexLpAddTMax')?.addEventListener('click', async () => setMax(tIn, td, st.token.address));
  body.querySelector('#dexLpRmSMax')?.addEventListener('click', () => {
    sIn.value = fmt(st.myShares, 18);
    refreshRm();
  });
  qIn.addEventListener('input', debounced(refreshAdd));
  tIn.addEventListener('input', debounced(refreshAdd));
  sIn.addEventListener('input', debounced(refreshRm));
  slip.addEventListener('change', () => { refreshAdd(); refreshRm(); });
  body.querySelector('#dexLpAddGo')?.addEventListener('click', () => startLpAdd(mount, st));
  body.querySelector('#dexLpRmGo')?.addEventListener('click', () => startLpRm(mount, st));
  body.querySelector('[data-dex-lpclose]')?.addEventListener('click', () => closeLp(mount));
  refreshAdd();
  refreshRm();
}

// Approve one leg of an add (mirror of the trade's EXACT-cap sheet).
function legApproveBody(con, pairAddress, amt) {
  return `
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.token')}</span><span class="dex-v">${esc(con.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.cap')}</span><span class="dex-v">${esc(fmt(amt, con.decimals))} ${esc(con.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.a.spender')}</span><span class="dex-v">${esc(shortAddr(pairAddress))}</span></div>
    <p class="dex-t-hint">${t('dex.sheet.a.hint')}</p>`;
}

function sheetBodyAdd(st, qAmt, tAmt, made, minMade, bps) {
  return `
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.l.pay')}</span><span class="dex-v">${esc(fmt(qAmt, st.quote.decimals))} ${esc(st.quote.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.l.pay')}</span><span class="dex-v">${esc(fmt(tAmt, st.token.decimals))} ${esc(st.token.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.lp.est')}</span><span class="dex-v">${esc(fmt(made, 18))}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.lp.minsym')} (${bps / 100}%)</span><span class="dex-v">${esc(fmt(minMade, 18))}</span></div>`;
}

function sheetBodyRm(st, shares, outQ, outT, minQ, minT, bps) {
  return `
    <div class="dex-row"><span class="dex-k">${t('dex.sheet.l.burn')}</span><span class="dex-v">${esc(fmt(shares, 18))}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.lp.out')}</span><span class="dex-v">${esc(fmt(outQ, st.quote.decimals))} ${esc(st.quote.symbol)} + ${esc(fmt(outT, st.token.decimals))} ${esc(st.token.symbol)}</span></div>
    <div class="dex-row"><span class="dex-k">${t('dex.lp.minsym')} (${bps / 100}%)</span><span class="dex-v">${esc(fmt(minQ, st.quote.decimals))} + ${esc(fmt(minT, st.token.decimals))}</span></div>`;
}

function lpErrText(e) {
  return {
    signer: t('dex.wallet.none'),
    chain: t('dex.engine.off'),
    revert: t('dex.lp.failm'),
    pending: `${t('dex.lp.pending')} ${esc(e.hash ? shortAddr(e.hash) : '')}`,
  }[e.why] || `${t('dex.pool.err')} ${esc(String(e.shortMessage || e.message || 'error').slice(0, 120))}`;
}

async function startLpAdd(mount, st) {
  const body = mount.querySelector('#dexLpPanel');
  if (!body) return;
  const bq = parseAmount(body.querySelector('#dexLpAddQ')?.value ?? '', st.quote.decimals);
  const bt = parseAmount(body.querySelector('#dexLpAddT')?.value ?? '', st.token.decimals);
  if (!bq.ok || !bt.ok) { setStatus(mount, t('dex.lp.needboth'), 'err', PS); return; }
  const pv = lpPreviewAdd(st, bq.value, bt.value);
  if (pv.made === 0n) { setStatus(mount, t('dex.lp.zeromade'), 'err', PS); return; }
  const bps = Number(body.querySelector('#dexLpSlip')?.value ?? SLIP_DEFAULT_BPS);
  const minMade = slippageMinOut(pv.made, bps);
  const addr = get('address');
  try {
    for (const leg of [st.quote, st.token]) {
      const amt = leg.address === st.quote.address ? bq.value : bt.value;
      const allow = await tokenContract(leg.address, get('provider')).allowance(addr, st.pair);
      if (allow < amt) {
        const s = openSheet(mount, t('dex.sheet.a.title'), legApproveBody(leg, st.pair, amt), LPSHEET_HOST, pools);
        const ok = await runSheetSend(s, () => sendTx(st, leg.address, approveData(leg.address, st.pair, amt)));
        if (!ok) return;
      }
    }
    const s2 = openSheet(mount, t('dex.lp.add'), sheetBodyAdd(st, bq.value, bt.value, pv.made, minMade, bps), LPSHEET_HOST, pools);
    await runSheetSend(s2, () => sendTx(st, st.pair, addLiqData(bq.value, bt.value, minMade)));
    setStatus(mount, t('dex.lp.done'), 'ok', PS);
    await refreshPool(mount, st.pair);
  } catch (e) {
    setStatus(mount, lpErrText(e), e.why === 'signer' ? '' : 'err', PS);
  }
}

async function startLpRm(mount, st) {
  const body = mount.querySelector('#dexLpPanel');
  if (!body) return;
  const bs = parseAmount(body.querySelector('#dexLpRmS')?.value ?? '', 18);
  if (!bs.ok || bs.value === 0n) { setStatus(mount, t('dex.lp.needs'), 'err', PS); return; }
  if (bs.value > st.myShares) { setStatus(mount, t('dex.lp.toomuch'), 'err', PS); return; }
  if (st.lockUntil > nowSec()) { setStatus(mount, t('dex.lp.locknow').replace('{until}', lockDate(st.lockUntil)), 'err', PS); return; }
  const bps = Number(body.querySelector('#dexLpSlip')?.value ?? SLIP_DEFAULT_BPS);
  const out = lpPreviewRemove(st, bs.value);
  const minQ = slippageMinOut(out.outQuote, bps);
  const minT = slippageMinOut(out.outToken, bps);
  try {
    const s = openSheet(mount, t('dex.lp.rm'), sheetBodyRm(st, bs.value, out.outQuote, out.outToken, minQ, minT, bps), LPSHEET_HOST, pools);
    await runSheetSend(s, () => sendTx(st, st.pair, removeLiqData(bs.value, minQ, minT)));
    setStatus(mount, t('dex.lp.done'), 'ok', PS);
    await refreshPool(mount, st.pair);
  } catch (e) {
    setStatus(mount, lpErrText(e), e.why === 'signer' ? '' : 'err', PS);
  }
}

// Post-tx truth: re-read the one pool touched and repaint list + panel.
async function refreshPool(mount, pair) {
  if (!pools?.st.has(pair)) return;
  const provider = get('provider');
  if (!provider) return;
  const me = get('address') || null;
  const fresh = await poolState(provider, pools.st.get(pair), pools.quote, me);
  pools.st.set(pair, fresh);
  paintPoolList(mount);
}

// ── bind the card once a pair address resolves ────────────────────────

async function openTradePanel(mount, pairAddress) {
  const body = mount.querySelector('#dexTradeBody');
  if (!body) return;
  setStatus(mount, t('dex.trade.opening'), 'busy');
  const addr = get('address') || '';
  if (!addr) { setStatus(mount, t('dex.wallet.none'), 'err'); return; }
  let provider = get('provider');
  if (!provider) { setStatus(mount, t('dex.engine.off'), 'err'); return; }
  try {
    const surface = await readPair(provider, pairAddress.trim());
    const [tokSym, quoteSym, reserves, creatorBps] = await Promise.all([
      surface.token.contract.symbol(), surface.quote.contract.symbol(),
      surface.pair.reserves(), surface.pair.creatorFeeBps(),
    ]);
    trade = {
      sheet: null,
      pairAddress: pairAddress.trim(),
      pair: surface.pair,
      token: { ...surface.token, symbol: tokSym },
      quote: { ...surface.quote, symbol: quoteSym },
      reserves, creatorBps: Number(creatorBps),
      buy: true, amountIn: null, minOut: null, quoteOut: null,
    };
    setStatus(mount, '');
    body.innerHTML = tradeBodyHtml(trade);
    const q = body.querySelector('#dexSwapAmt');
    q.addEventListener('input', () => { clearTimeout(trade.t); trade.t = setTimeout(() => refreshQuote(trade, mount), 220); });
    body.querySelector('#dexSwapSlip').addEventListener('change', () => refreshQuote(trade, mount));
    const dirBtn = (id, val) => body.querySelector(id).addEventListener('click', () => {
      trade.buy = val;
      body.querySelector('#dexSwapBuy').classList.toggle('on', val);
      body.querySelector('#dexSwapSell').classList.toggle('on', !val);
      body.querySelector('#dexSwapBuy').setAttribute('aria-pressed', String(val));
      body.querySelector('#dexSwapSell').setAttribute('aria-pressed', String(!val));
      refreshQuote(trade, mount);
    });
    dirBtn('#dexSwapBuy', true);
    dirBtn('#dexSwapSell', false);
    body.querySelector('#dexSwapMax').addEventListener('click', async () => {
      const pay = trade.buy ? trade.quote : trade.token;
      const bal = await (trade.buy ? trade.quote.contract : trade.token.contract).balanceOf(addr);
      q.value = fmt(bal, pay.decimals);
      refreshQuote(trade, mount);
    });
    body.querySelector('#dexSwapGo').addEventListener('click', () => startTrade(mount, trade));
    refreshQuote(trade, mount);
    trade.repaintRes = setInterval(async () => {
      try {
        trade.reserves = await trade.pair.reserves();
        const resEl = body.querySelector('[data-dex-res]');
        if (resEl) resEl.textContent = fmtPairRes(trade);
      } catch { /* a dead rpc must not snowball the view */ }
    }, 15000);
  } catch (e) {
    setStatus(mount, e.why === 'bad' ? t('dex.trade.bad') : `${t('dex.trade.fail')} ${esc(e.shortMessage || e.message || '').slice(0, 140)}`, 'err');
  }
}

// The confirm → sheet A (approve, exact) → sheet B (swap). Each sheet is its
// own transaction with its own cancel; nothing chains silently.
async function startTrade(mount, st) {
  const body = mount.querySelector('#dexTradeBody');
  if (!body || !st?.quoteOut || !st.amountIn || !st.minOut) { setStatus(mount, t('dex.swap.needamt'), 'err'); return; }
  const addr = get('address');
  try {
    const me = addr;
    const payer = st.buy ? st.quote : st.token;
    const allowance = await payer.contract.allowance(me, st.pairAddress);
    if (allowance < st.amountIn) {
      const s = openSheet(mount, t('dex.sheet.a.title'), sheetBodyApprove(st, st.amountIn), '#dexTradeBody', trade);
      const ok = await runSheetSend(s, () => sendTx(st, payer.address, approveData(payer.address, st.pairAddress, st.amountIn)));
      if (!ok) return;
    }
    const s2 = openSheet(mount, t('dex.sheet.s.title'), sheetBodySwap(st, st.amountIn, st.minOut), '#dexTradeBody', trade);
    await runSheetSend(s2, () =>
      sendTx(st, st.pairAddress, swapData(st.buy, st.amountIn, st.minOut, me)));
    setStatus(mount, t('dex.swap.done'), 'ok');
    body.querySelector('[data-dex-sheet-host]')?.remove();
    st.amountIn = null;
  } catch (e) {
    const whyText = {
      signer: t('dex.wallet.none'), chain: t('dex.engine.off'), revert: t('dex.swap.failm'),
      pending: `${t('dex.swap.pending')} ${esc(e.hash ? `${e.hash.slice(0, 10)}…${e.hash.slice(-4)}` : '')}`,
    }[e.why] || `${t('dex.swap.fail')} ${esc(e.shortMessage || e.message || '').slice(0, 120)}`;
    setStatus(mount, whyText, e.why === 'signer' ? '' : 'err');
  }
}

// One send-button lifecycle: confirm → busy (send) → settle. Rejecting the
// confirm (cancel) resolves false and the chain never starts.
function runSheetSend(sheet, send) {
  return new Promise(async (resolve) => {
    let done = false;
    sheet.confirmB.addEventListener('click', async () => {
      if (done) return;
      done = true;
      sheet.wrap._busy = true; // ESC/cancel stops while the tx is on the wire
      sheet.confirmB.disabled = true;
      sheet.cancelB.disabled = true;
      const body = sheet.wrap.querySelector('[data-dex-sheet-body]');
      if (body) body.innerHTML = `<div class="dex-sending">${t('dex.swap.send')}</div>`;
      try {
        await send();
        sheet.forceRemove();
        resolve(true);
      } catch (e) {
        sheet.wrap._busy = false; // the caller may cancel the error sheet
        const body2 = sheet.wrap.querySelector('[data-dex-sheet-body]');
        if (body2) body2.innerHTML = `<div class="dex-sending dex-err">${escapeHtml(String(e.shortMessage || e.message || 'error').slice(0, 150))}</div>`;
        sheet.confirmB.disabled = false;
        sheet.cancelB.disabled = false;
        done = false;
      }
    });
    sheet.cancelB.addEventListener('click', () => { if (!done) resolve(false); });
  });
}

// ── paint ──────────────────────────────────────────────────────────────

export function renderDex(root, opts = {}) {
  if (!root) return { ok: false, reason: 'no-root' };

  const net = getNetworkById(get('networkId')) || {};
  const chainOk = dexChainOk(net.chainId);
  const addr = get('address') || '';

  root.innerHTML = `
    <p class="small" id="dexHint">${t('dex.hint')}</p>
    <div class="dex-state" id="dexState">
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.net')}</span>
        <span class="dex-v">${chainOk ? '● ' : '○ '}${escapeHtml(net.name || '—')}</span>
      </div>
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.wallet')}</span>
        <span class="dex-v">${addr ? escapeHtml(shortAddr(addr)) : t('dex.wallet.none')}</span>
      </div>
      <div class="dex-row" data-dex-row>
        <span class="dex-k">${t('dex.row.engine')}</span>
        <span class="dex-v" id="dexEngineState">${chainOk ? t('dex.engine.on') : t('dex.engine.off')}</span>
      </div>
    </div>
    ${chainOk ? tradeStubHtml() + poolsStubHtml() : ''}`;

  // A network switch while the view is open repaints the truth. Off before on:
  // re-arming the same key must never stack handlers.
  if (repaint) {
    try { off('networkId', repaint); } catch { /* first paint has none */ }
  }
  if (trade?.repaintRes) { clearInterval(trade.repaintRes); trade = null; }
  pools = null; // scan/list state dies with the paint — no intervals live here
  repaint = () => {
    if (typeof root.isConnected !== 'undefined' && !root.isConnected) {
      if (repaint) { try { off('networkId', repaint); } catch { /* already gone */ } }
      if (trade?.repaintRes) clearInterval(trade.repaintRes);
      repaint = null;
      return;
    }
    renderDex(root, opts);
  };
  on('networkId', repaint);

  if (!chainOk) return { ok: true, chainOk, wallet: Boolean(addr) };

  const openBtn = q(root, '#dexSwapOpen');
  const pairIn = q(root, '#dexSwapPair');
  if (openBtn && pairIn) {
    openBtn.addEventListener('click', () => {
      const v = (pairIn.value || '').trim();
      if (!isAddress(v)) { setStatus(root, t('dex.trade.bad'), 'err'); return; }
      openTradePanel(root, v);
    });
    pairIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openBtn.click();
    });
  }

  // pools card: scan on click/Enter, the remembered factory as an explicit Use
  const scanBtn = q(root, '#dexPoolScan');
  const facIn = q(root, '#dexPoolFactory');
  if (scanBtn && facIn) {
    scanBtn.addEventListener('click', () => scanPools(root, facIn.value));
    facIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') scanBtn.click();
    });
  }
  const listEl = q(root, '#dexPoolList');
  if (listEl && !listEl.dataset.dexBound) {
    listEl.dataset.dexBound = '1';
    listEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-dex-lpclose]')) { closeLp(root); return; }
      const row = e.target.closest('[data-dex-pair]');
      if (!row) return;
      const pair = row.getAttribute('data-dex-pair');
      const act = e.target.closest('[data-dex-act]')?.getAttribute('data-dex-act');
      if (act === 'trade') {
        if (pairIn) pairIn.value = pair;
        openTradePanel(root, pair);
      } else if (act === 'lp') {
        openLp(root, pair);
      }
    });
  }
  setPoolLastUsed(root);

  return { ok: true, chainOk, wallet: Boolean(addr) };
}
