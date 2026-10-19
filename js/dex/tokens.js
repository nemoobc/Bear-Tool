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

/** The feed card body. rows: [{pair, token...}] with tombstones applied by
 *  the caller (tokens.js stays dumb about storage). */
export function feedHtml(ss) {
  const items = (ss || []).map(([pair, st]) => feedRowHtml(st, pair.trim().toLowerCase()));
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
      <div id="dexFeedBody">${esc(t('dex.feed.empty'))}</div>
    </section>`;
}
