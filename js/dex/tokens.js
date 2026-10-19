// Bear Tool — js/dex/tokens.js
// M6: the FEED — the launchpad's home list (DEX-V2 §2.2 #8).
//
// The rows come from the factory's own logs (pools.js scan) and the pool
// states the pools card already keeps. This module renders them and carries
// the tombstone rule (list.js): what the user deleted stays deleted. It has
// no RPC of its own — an honest empty feed costs nothing.
//
// A feed row is the 12-line version of the token page: symbol, price, the two
// reserves, one door to the token page, one door to delete. The delete is
// LOCAL and permanent — chain truth stays; the user's feed is theirs.

import { escapeHtml } from '../ui.js';
import { t } from '../i18n.js';

const esc = (x) => escapeHtml(String(x));
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

/** Price of one token in quote, as a plain Number (6 dp) from the pool's own
 *  reserves — the same spot the token page reads. null = not drawable. */
export function feedPrice(st) {
  if (!st?.reserves) return null;
  const [q, t] = st.reserves;
  const tb = BigInt(t);
  if (tb === 0n) return null;
  return Number((BigInt(q) * 10n ** 6n) / tb) / 1e6;
}

const fmtN = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(1).replace(/\.0$/, '');
  if (n >= 1) return String(Math.round(n * 100) / 100);
  if (n === 0) return '0';
  return n.toPrecision(3);
};

/** One feed row. Tap = token page; × = tombstone (list.js). */
export function feedRowHtml(st, pair) {
  const price = feedPrice(st);
  const tok = st?.token ?? {};
  return `
    <div class="dex-feed-row" data-dex-feed-row="${esc(pair)}">
      <button type="button" class="dex-feed-open" data-dex-feed-open="${esc(pair)}" aria-label="${esc(t('dex.feed.open'))} ${esc(tok.symbol ?? '')}">
        <span class="dex-feed-sym">${esc(tok.symbol ?? '—')}</span>
        <span class="dex-feed-name small">${esc(tok.name ?? short(pair))}</span>
        <span class="dex-feed-price small">${esc(t('dex.feed.price'))} ${price == null ? '—' : esc(fmtN(price))}</span>
      </button>
      <button type="button" class="dex-feed-del" data-dex-feed-del="${esc(pair)}" aria-label="${esc(t('dex.feed.delAria'))}">✕</button>
    </div>`;
}

/** The feed card body. ss: [[pair, st]] entries, filtered by the caller.
 *  opts: { q, sort } — search text (symbol/name/pair substring) and a sort
 *  key ('sym', 'price-asc', 'price-desc', 'vol'). Pure given the rows. */
export function feedFilter(ss, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return ss || [];
  return (ss || []).filter(([pair, st]) =>
    String(st?.token?.symbol ?? '').toLowerCase().includes(s)
    || String(st?.token?.name ?? '').toLowerCase().includes(s)
    || String(pair ?? '').toLowerCase().includes(s));
}

export function feedSort(ss, mode = '') {
  const rows = [...(ss || [])];
  const cmp = {
    sym: (a, b) => String(a[1]?.token?.symbol ?? '').localeCompare(String(b[1]?.token?.symbol ?? '')),
    'price-asc': (a, b) => (feedPrice(a[1]) ?? Infinity) - (feedPrice(b[1]) ?? Infinity),
    'price-desc': (a, b) => (feedPrice(b[1]) ?? -Infinity) - (feedPrice(a[1]) ?? -Infinity),
    vol: (a, b) => ((b[1]?.vol24 ?? 0) - (a[1]?.vol24 ?? 0)),
  }[mode];
  if (!cmp) return rows;
  return rows.sort(cmp);
}

export function feedHtml(ss, opts = {}) {
  const shown = feedSort(feedFilter(ss, opts.q), opts.sort);
  const items = shown.map(([pair, st]) => feedRowHtml(st, String(pair ?? '').trim().toLowerCase()));
  if (items.length === 0) {
    return `<p class="dex-t-hint">${esc(t('dex.feed.empty'))}</p>`;
  }
  return `<div class="dex-feed">${items.join('')}</div>`;
}

/** The stub that lives in the static paint — filled in after the scan. */
export function feedStubHtml() {
  return `
    <section class="dex-card" id="dexFeed">
      <h3 class="dex-card-h">${esc(t('dex.feed.title'))}</h3>
      <p class="dex-t-hint small">${esc(t('dex.feed.hint'))}</p>
      <div class="dex-feed-tools">
        <input id="dexFeedQ" class="dex-input" type="search" spellcheck="false"
               placeholder="${esc(t('dex.feed.search'))}" aria-label="${esc(t('dex.feed.search'))}">
        <select id="dexFeedSort" class="dex-input" aria-label="${esc(t('dex.feed.sort'))}">
          <option value="">${esc(t('dex.feed.sortNew'))}</option>
          <option value="sym">${esc(t('dex.feed.sortSym'))}</option>
          <option value="price-asc">${esc(t('dex.feed.sortLo'))}</option>
          <option value="price-desc">${esc(t('dex.feed.sortHi'))}</option>
        </select>
      </div>
      <div id="dexFeedBody">${esc(t('dex.feed.empty'))}</div>
    </section>`;
}

export const FEED_SORTS = ['', 'sym', 'price-asc', 'price-desc', 'vol'];
