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
import { t, escapeHtml, fmtTok, fmtPrice, $, get, provider, ethersLib, isAddr, dexChainOk, quoteBy, confirmTx, toast } from './core.js';
import { poolState, tokenInfo, lpPosition } from './pool-data.js';
import { quotePerToken } from './pool-list.js';
import { BEAR_TOKEN_ABI, BEAR_FACTORY_ABI, BEAR_PAIR_ABI } from './bear-source.js';
import { factoryAddress } from './factory.js';
import { loadPoolHistory, poolCandles, tradesHtml } from './history.js';
import { drawCandles } from './chart.js';
import { deleteCoin } from './list.js';
import { forgetLaunchedToken } from './tokens.js';
import { mountTradeSheet } from './trade-sheet.js';
import { scanHolders, holderRows, topShareBps, pool24h, chunkedGetLogs, ZERO_ADDR } from './holders.js';

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
      <div class="small mt-8" id="dexTpStats" role="status"></div>
      <div class="mt-8">
        <button type="button" class="btn btn-secondary" id="dexTpLp"></button>
      </div>
      <div class="small mt-8" id="dexTpNote" role="status"></div>
    </div>
    <div class="card mb-8">
      <div class="field-label">${escapeHtml(t('dex.hold.title'))}</div>
      <div class="small" id="dexTpHoldersLock"></div>
      <div class="small mt-8" id="dexTpHoldersNote" role="status"></div>
      <div class="dex-holds" id="dexTpHoldersList"></div>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexTpHoldersMore" hidden></button>
    </div>
    <div class="card mb-8" id="dexTpTrade"></div>
    <div class="card mb-8">
      <div class="field-label">${escapeHtml(t('dex.tp.chart'))}</div>
      <div id="dexTpChart" class="dex-chart-host" role="img" aria-label="${escapeHtml(t('dex.tp.chart'))}"></div>
      <div class="small" id="dexTpChartNote" role="status"></div>
    </div>
    <div class="card mb-8">
      <div class="field-label">${escapeHtml(t('dex.trades.title'))}</div>
      <div id="dexTpTape"></div>
    </div>
    <button type="button" class="btn btn-danger btn-block mt-8" id="dexTpDelete">${escapeHtml(t('dex.list.delete'))}</button>
    <div class="small" id="dexTpDeleteNote">${escapeHtml(t('dex.list.deleteNote'))}</div>`;
}

export async function bindTokenPage(host, token, pair, { onBack, onLp } = {}) {
  const el = (id) => $(`#${id}`, host);
  const backBtn = el('dexTpBack');
  const lpBtn = el('dexTpLp');
  const noteEl = el('dexTpNote');
  if (!backBtn || !lpBtn || !noteEl) return;

  if (onBack) backBtn.addEventListener('click', onBack);
  lpBtn.textContent = t('dex.pf.manage');
  if (onLp) lpBtn.addEventListener('click', () => onLp(token));

  // Delete first, so it works even when every read below fails: the tombstone
  // forgets the token for THIS wallet's feed (list.js) and the launched index
  // drops it (tokens.js) — the same two stores the legacy coin page uses. The
  // contract stays on chain, which is why the copy says "from my feed".
  const delBtn = el('dexTpDelete');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const nameEl = el('dexTpName');
      const ok = await confirmTx({
        title: t('dex.list.deleteConfirmTitle'),
        rows: [{ k: t('dex.list.deleteRowCoin'), v: (nameEl && nameEl.textContent) || shortOf(token) }],
        confirmText: t('dex.list.deleteConfirmCta'),
        danger: true,
      });
      if (!ok) return;
      forgetLaunchedToken(token);
      deleteCoin(token);
      toast(t('dex.list.deletedToast'), 'success');
      // The feed is the token's only home now that it is out of it — go back.
      if (typeof onBack === 'function') onBack();
    });
  }

  noteEl.textContent = t('dex.pools.loading');
  const E = ethersLib();
  if (!E || !provider()) { noteEl.textContent = t('dex.pools.unreadable'); return; }

  const me = get('address');
  const tc = new E.Contract(token, BEAR_TOKEN_ABI, provider());
  const [ti, face, desc, ps, lp, supplyRaw] = await Promise.all([
    tokenInfo(token, me),
    tc.image().catch(() => ''),
    tc.description().catch(() => ''),
    poolState(pair),
    lpPosition(pair, me),
    tc.totalSupply().catch(() => null),
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

  if (!ps.ok) {
    noteEl.textContent = t('dex.swap.unreadable');
    const tradeEl = el('dexTpTrade');
    if (tradeEl) tradeEl.innerHTML = `<div class="small">${escapeHtml(t('dex.swap.unreadable'))}</div>`;
    return;
  }
  noteEl.textContent = '';

  // Trade right here: the ONE sheet (trade-sheet.js) — the same component the
  // Swap panel mounts, so the two screens cannot disagree about what buying
  // means. The header above is already painted; the sheet reads the pool
  // fresh for itself before anything can be signed.
  const tradeEl = el('dexTpTrade');
  if (tradeEl) mountTradeSheet(tradeEl, { address: token, pair, quote: ps.quote, symbol: sym });

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

  // ── the pool's own tape ─────────────────────────────────────────
  // The chart and the tape read the pair's Swap logs through the same history
  // seam the curve page uses — one row shape, one chart, one tape, so the two
  // pages can never disagree about what a trade is. Loaded AFTER the header
  // paints: identity and price first, the series fills in under them.
  const chartHost = el('dexTpChart');
  const chartNote = el('dexTpChartNote');
  const tapeEl = el('dexTpTape');
  if (chartNote) chartNote.textContent = t('dex.pools.loading');
  let chartTearDown = null;
  try {
    const pc = new E.Contract(pair, BEAR_PAIR_ABI, provider());
    const hist = await loadPoolHistory(pc, provider());
    // Left while reading? Do not paint into a page that is already gone — the
    // same guard the router uses before it binds.
    if (get('dex.tokenView') !== token) return;
    if (tapeEl) {
      tapeEl.innerHTML = hist.ok
        ? tradesHtml(hist.trades, sym, qSym) + (hist.partial ? `<div class="small">${escapeHtml(t('dex.trades.partial'))}</div>` : '')
        : `<div class="small">${escapeHtml(hist.reason || t('dex.swap.unreadable'))}</div>`;
    }
    let candles = [];
    if (hist.ok) {
      // A cut window is stated on the chart too: fewer candles than the window
      // claims is exactly the kind of silent half-truth this page must not do.
      if (chartNote) chartNote.textContent = hist.partial ? t('dex.trades.partial') : '';
      candles = await poolCandles(hist.trades);
    } else if (chartNote) {
      // A node that cannot serve logs must not blank the page: the header is
      // already painted, and the reason rides under the empty frame.
      chartNote.textContent = hist.reason || t('dex.swap.unreadable');
    }
    if (chartHost) {
      chartTearDown = await drawCandles(chartHost, candles, {
        height: 220,
        theme: 'light',
        fmt: (v) => fmtPrice(v, 4),
        empty: t('dex.tp.noTrades'),
      });
      host.addEventListener('dex:teardown', () => {
        if (chartTearDown) { try { chartTearDown(); } catch { /* already gone */ } }
      }, { once: true });
    }
  } catch (e) {
    // The header is already read and painted; a chart that cannot draw must
    // not take the page down with it — say so under the frame.
    if (chartNote) chartNote.textContent = (e && (e.shortMessage || e.message)) || String(e);
  }

  // ── statistics & holders (M8) ────────────────────────────────────
  // Two honest reads after the page is already usable: the day's volume from
  // the pair's own Swap logs, and the holder list from the token's whole
  // Transfer history. Both fail into words, never into a number that was not
  // actually seen; and both stop the moment the user leaves this page.
  const gone = () => get('dex.tokenView') !== token;
  const statsEl = el('dexTpStats');
  const holdList = el('dexTpHoldersList');
  const holdNote = el('dexTpHoldersNote');
  const holdMore = el('dexTpHoldersMore');
  const holdLock = el('dexTpHoldersLock');
  const supply = supplyRaw != null ? BigInt(supplyRaw) : null;

  const day = await pool24h({ E, provider: provider(), pair, shouldStop: gone });
  if (gone()) return;
  if (statsEl) {
    const bits = [];
    if (supply != null) {
      const priced = quotePerToken(ps.quoteReserve, ps.tokenReserve, td);
      if (priced > 0n) bits.push(t('dex.tp.mcap', { v: fmtTok((supply * priced) / 10n ** BigInt(td), qd, 4), sym: qSym }));
    }
    if (day.ok) bits.push(t('dex.tp.vol24', { v: fmtTok(day.volQuote, qd, 4), sym: qSym, n: String(day.trades) }));
    statsEl.textContent = bits.join(' · ');
  }

  // The creator's own lock — read from the pair, the creator found in the
  // factory's own event. No creator found = no claim made (an empty line,
  // never a guessed "locked").
  if (holdLock) {
    try {
      const f = factoryAddress();
      const p = provider();
      if (isAddr(f) && p) {
        const latest = await p.getBlockNumber();
        const sigs = [E.id('Launched(address,address,address,address)'), E.id('PoolCreated(address,address,address,address)')];
        const found = await chunkedGetLogs({
          getLogs: (lo, hi) => p.getLogs({ address: f, fromBlock: lo, toBlock: hi, topics: [sigs, null, E.zeroPadValue(token, 32)] }),
          fromBlock: Math.max(0, latest - 54000),
          toBlock: latest,
          stopAfter: 1,
        });
        if (found.length && !gone()) {
          const creator = E.getAddress('0x' + String(found[0].topics[1] || '').slice(-40));
          const pc = new E.Contract(pair, BEAR_PAIR_ABI, provider());
          const until = Number(await pc.lockedUntil(creator));
          if (!gone() && until > 0) {
            const date = new Date(until * 1000).toISOString().slice(0, 10);
            const now = Math.floor(Date.now() / 1000);
            holdLock.textContent = until > now ? t('dex.hold.lockUntil', { date }) : t('dex.hold.lockFree');
          }
        }
      }
    } catch { /* no creator read = no lock claim */ }
  }

  // The holder list: the whole Transfer history, or the honest reason why the
  // list cannot be claimed. Balances render ONLY on `done` — anything less is
  // a sentence, because a partial window's sums are wrong by construction.
  const paintHolders = (scan) => {
    if (!holdNote || gone()) return;
    const skip = [pair, ZERO_ADDR];
    if (scan.done) {
      const { rows, count } = holderRows(scan.balances, supply, { exclude: skip, limit: 50 });
      const top10 = topShareBps(scan.balances, supply, { top: 10, exclude: skip });
      holdNote.textContent = `${t('dex.hold.summary', { n: String(count), pct: (top10 / 100).toFixed(1) })} · ${t('dex.hold.note')}`;
      if (holdList) {
        holdList.innerHTML = rows.map((r, i) => `
          <button type="button" class="dex-hold" data-addr="${r.addr}">
            <span class="dex-hold-rank">${i + 1}</span>
            <span class="dex-hold-addr mono">${shortOf(r.addr)}</span>
            <span class="dex-hold-amt mono">${fmtTok(r.amount, td, 4)}</span>
            <span class="dex-hold-pct mono">${(r.pctBps / 100).toFixed(2)}%</span>
          </button>`).join('');
      }
      if (holdMore) holdMore.hidden = true;
    } else if (scan.pruned) {
      holdNote.textContent = t('dex.hold.pruned');
      if (holdMore) { holdMore.hidden = false; holdMore.textContent = t('dex.ts.retry'); }
    } else if (scan.reason) {
      holdNote.textContent = t('dex.hold.failed', { reason: escapeHtml(scan.reason) });
      if (holdMore) { holdMore.hidden = false; holdMore.textContent = t('dex.ts.retry'); }
    } else if (scan.mintSeen) {
      holdNote.textContent = t('dex.hold.incomplete');
      if (holdMore) holdMore.hidden = true;
    } else {
      holdNote.textContent = t('dex.hold.scanning', { block: String(scan.low) });
      if (holdMore) { holdMore.hidden = false; holdMore.textContent = t('dex.hold.more'); }
    }
  };

  if (holdList) {
    holdList.addEventListener('click', (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest('.dex-hold') : null;
      if (!row) return;
      const addr = row.getAttribute('data-addr') || '';
      if (!addr) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(addr);
          toast(t('dex.hold.copied'), 'success');
        } else {
          toast(shortOf(addr));
        }
      } catch {
        toast(shortOf(addr));
      }
    });
  }

  const runScan = async () => {
    if (holdMore) holdMore.disabled = true;
    const scan = await scanHolders({ E, provider: provider(), token, supply, shouldStop: gone });
    if (holdMore) holdMore.disabled = false;
    paintHolders(scan);
  };
  if (holdMore) holdMore.addEventListener('click', () => { runScan(); });
  if (holdNote) {
    if (supply == null) {
      holdNote.textContent = t('dex.hold.nosupply');
    } else {
      holdNote.textContent = t('dex.pools.loading');
      await runScan();
    }
  }
}
