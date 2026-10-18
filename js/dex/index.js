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

function setStatus(mount, msg, cls = '') {
  const el = mount.querySelector('#dexSwapStatus');
  if (el) { el.textContent = msg; el.className = `dex-status ${cls}`.trim(); }
}

// ── the sheets: one dialog per transaction, cancel + confirm ──────────

function openSheet(mount, title, bodyHtml) {
  const host = mount.querySelector('#dexTradeBody');
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
    trade.sheet = null;
  }
  document.addEventListener('keydown', onKey);
  const forceRemove = () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
    trade.sheet = null;
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
      const s = openSheet(mount, t('dex.sheet.a.title'), sheetBodyApprove(st, st.amountIn));
      const ok = await runSheetSend(s, () => sendTx(st, payer.address, approveData(payer.address, st.pairAddress, st.amountIn)));
      if (!ok) return;
    }
    const s2 = openSheet(mount, t('dex.sheet.s.title'), sheetBodySwap(st, st.amountIn, st.minOut));
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
    ${chainOk ? tradeStubHtml() : ''}`;

  // A network switch while the view is open repaints the truth. Off before on:
  // re-arming the same key must never stack handlers.
  if (repaint) {
    try { off('networkId', repaint); } catch { /* first paint has none */ }
  }
  if (trade?.repaintRes) { clearInterval(trade.repaintRes); trade = null; }
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

  return { ok: true, chainOk, wallet: Boolean(addr) };
}
