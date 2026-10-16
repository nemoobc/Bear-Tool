// Bear Tool — js/dex/portfolio.js
// The Portfolio tab (v2): what this wallet actually holds in the Dex.
//
// Two lists, both read live from the chains of discovered pools:
//   LP positions — shares + both sides + lock status (the pair is the LP token)
//   Tokens       — token balances above zero
// Positions that are empty are not drawn; a position that cannot be read says
// so (same honest-states rule as discovery). Nothing here is computed or
// remembered locally — this tab is a mirror, not a ledger.
import { t, escapeHtml, fmtTok, fmtPrice, $, get, provider, ethersLib, dexChainOk, quoteBy } from './core.js';
import { discoverPools, fillMeta } from './pools.js';
import { lpPosition, tokenInfo, poolState } from './pool-data.js';
import { quotePerToken } from './pool-list.js';
import { chunkedGetLogs } from './holders.js';

const LIST_LIMIT = 24;

const SWAP_TOPIC = 'Swap(address,bool,uint256,uint256)';

const shortOf = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

// ── the simple P&L, from this wallet's own Swap events ─────────
// Cost basis is the wallet's real buys in the pair, not a remembered number:
// spent/bought give the average price, and value + received − spent gives the
// net result. Every helper below is pure — the tests feed them legs and
// numbers directly, no chain involved.

/** Decode one Swap log into the sides a P&L needs: which direction, how much
 *  quote moved, how many tokens moved. Null when the data cannot be read —
 *  an unreadable log is skipped, never guessed. */
export function swapLegs(E, log) {
  try {
    const [quoteIn, amountIn, amountOut] = E.AbiCoder.defaultAbiCoder()
      .decode(['bool', 'uint256', 'uint256'], log.data);
    return quoteIn
      ? { quoteIn: true, quote: amountIn, tokens: amountOut } // buy: quote in, tokens out
      : { quoteIn: false, quote: amountOut, tokens: amountIn }; // sell: tokens in, quote out
  } catch {
    return null;
  }
}

/** Fold the wallet's swaps into what the simple P&L needs: quote spent and
 *  tokens bought on the way in, quote received and tokens sold on the way
 *  out. Pure — tests feed it legs directly. */
export function foldMySwaps(legs) {
  const out = { spent: 0n, bought: 0n, received: 0n, sold: 0n };
  for (const l of legs) {
    if (!l) continue;
    if (l.quoteIn) {
      out.spent += l.quote;
      out.bought += l.tokens;
    } else {
      out.received += l.quote;
      out.sold += l.tokens;
    }
  }
  return out;
}

/** What a holding is worth right now: balance (token base units) priced at
 *  the pool's spot, in quote base units. Pure. */
export function holdValue(balance, spotPerToken, tokenDecimals) {
  const td = Math.max(0, Math.min(36, Number(tokenDecimals) || 0));
  if (balance <= 0n || spotPerToken <= 0n) return 0n;
  return (balance * spotPerToken) / 10n ** BigInt(td);
}

/** The simple P&L: what the holding is worth plus what was sold, minus what
 *  was spent. Returns { pnl, bps } signed, or null when nothing was ever
 *  bought — a P&L against a zero cost basis would be a made-up number. bps
 *  is truncated toward zero (display only). */
export function pnlOf({ spent, received, value }) {
  if (spent <= 0n) return null;
  const pnl = value + received - spent;
  return { pnl, bps: (pnl * 10000n) / spent };
}

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

  // The P&L is a second pass on purpose: the balances paint immediately, and
  // each card's history line fills in when its own scan lands. A scan that
  // cannot read its window says so on the card — it never blocks the tab,
  // and it never becomes a number it cannot stand behind.
  if (tkRows.length) {
    const p = provider();
    const tip = p ? await p.getBlockNumber().catch(() => null) : null;
    for (const x of tkRows) {
      tokenPnl(x.r, x.ti, me, tip)
        .catch(() => ({ ok: false }))
        .then((st) => {
          if (!tkBox.isConnected) return; // navigated away: nobody left to tell
          const slot = tkBox.querySelector(`[data-dex-pf-pnl="${x.r.address}"]`);
          if (!slot) return;
          const line = pnlText(x.r, st);
          slot.textContent = line.txt;
          slot.classList.toggle('dex-pf-up', line.cls === 'dex-pf-up');
          slot.classList.toggle('dex-pf-down', line.cls === 'dex-pf-down');
        });
    }
  }
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
      <div class="small" data-dex-pf-pnl>${escapeHtml(t('dex.pf.pnlReading'))}</div>
      <button type="button" class="btn btn-primary mt-8" data-dex-pf-swap="${escapeHtml(r.address)}">${escapeHtml(t('dex.pf.swap'))}</button>
    </div>`;
}

/** This wallet's own swaps in one pair, read from the pair's launch block
 *  forward. Lenient on purpose: a window the node would not serve whole comes
 *  back flagged, and a partial window is NOT usable as a cost basis — it must
 *  be said out loud, never averaged. */
async function readMySwaps(r, me, tip) {
  const p = provider();
  const E = ethersLib();
  const from = Number(r.block || 0);
  if (!p || !E || !Number.isFinite(tip) || !(from > 0)) return { ok: false };
  let read;
  try {
    read = await chunkedGetLogs({
      getLogs: (lo, hi) => p.getLogs({
        address: r.pair,
        topics: [E.id(SWAP_TOPIC), E.zeroPadValue(String(me).toLowerCase(), 32)],
        fromBlock: lo,
        toBlock: hi,
      }),
      fromBlock: from,
      toBlock: tip,
      lenient: true,
    });
  } catch {
    return { ok: false };
  }
  // Read nothing and got a reason, or read some and hit the prune line —
  // both mean the window is not whole, so it is not a basis. Skip, don't guess.
  if (!read || read.partial || read.reason) return { ok: false };
  const legs = [];
  for (const log of read.logs || []) {
    const leg = swapLegs(E, log);
    if (leg) legs.push(leg);
  }
  return { ok: true, ...foldMySwaps(legs) };
}

/** The whole story for one held-token card: average buy price from the
 *  wallet's events, spot from the pool right now, and the simple P&L between
 *  them. Every unreadable path returns a state the card knows how to say. */
async function tokenPnl(r, ti, me, tip) {
  const st = await readMySwaps(r, me, tip);
  if (!st.ok) return { ok: false };
  if (st.bought === 0n || st.spent === 0n) return { ok: true, avgPerToken: null, pnl: null };
  const avgPerToken = quotePerToken(st.spent, st.bought, ti.decimals);
  const pool = await poolState(r.pair);
  if (!pool.ok) return { ok: true, avgPerToken, pnl: null };
  const spot = quotePerToken(pool.quoteReserve, pool.tokenReserve, ti.decimals);
  const value = holdValue(ti.balance, spot, ti.decimals);
  return { ok: true, avgPerToken, pnl: pnlOf({ spent: st.spent, received: st.received, value }) };
}

/** The card line: what was said, and which tone it wears. The sign is IN the
 *  number — the colour is second, never the only signal. */
function pnlText(r, st) {
  const qMeta = quoteBy(r.quote);
  const qSym = qMeta ? qMeta.symbol : '…';
  const qDec = qMeta ? qMeta.decimals : 18;
  if (!st || st.ok === false) return { txt: t('dex.pf.pnlUnread'), cls: '' };
  if (!st.avgPerToken) return { txt: t('dex.pf.noBuys'), cls: '' };
  const avg = t('dex.pf.avg', { v: fmtPrice(st.avgPerToken), q: qSym });
  if (!st.pnl) return { txt: `${avg} · ${t('dex.pf.noSpot')}`, cls: '' };
  const neg = st.pnl.pnl < 0n;
  const abs = neg ? -st.pnl.pnl : st.pnl.pnl;
  const absBps = neg ? -st.pnl.bps : st.pnl.bps;
  const money = `${neg ? '-' : '+'}${fmtTok(abs, qDec, 4)} ${qSym}`;
  const pct = `${neg ? '-' : '+'}${(Number(absBps) / 100).toFixed(2)}%`;
  return { txt: `${avg} · ${t('dex.pf.pnl', { v: money, p: pct })}`, cls: neg ? 'dex-pf-down' : 'dex-pf-up' };
}
