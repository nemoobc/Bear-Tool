// Bear Tool — js/dex/tokens.js
// The FEED — the Dex's home screen. In the pool rebuild the subject of the
// whole view is a TOKEN with its own real-reserve pool; the feed is the list of
// pools the factory has opened, newest first, with each row's live price read
// straight from its pair.
//
// Nothing is a hardcoded feed: the chain (factory logs, via pools.js) is the
// authority, and the local index below is only what cannot be re-derived fast —
// the tokens this browser launched, painted the moment the feed opens so it is
// never blank while the first scan runs. Price is ALWAYS read live, so a stale
// local entry can never show a stale price.
import { withoutDeleted } from './list.js';
import { t } from '../i18n.js';
import { get, set } from '../state.js';
import { $, escapeHtml } from '../ui.js';
import { quoteBy, fmtTok, DEX_CHAIN_ID } from './core.js';
import { discoverPools, fillMeta } from './pools.js';
import { poolState } from './pool-data.js';
import { quotePerToken } from './pool-list.js';

// Where the launched-token index is KEPT, and why it is not in state.js.
//
// state.set() writes to an in-memory singleton: nothing survives a reload. The
// first version of this feed read the list from there, so every coin the user
// launched vanished on refresh — the contract stayed live, the gas was spent,
// and the feed came back empty with no way back.
//
// So the index is persisted here, per chain: Sepolia tokens must not appear on
// mainnet just because the same browser ran both. Only what cannot be re-derived
// is stored — address, name, symbol, image. Price is always read live from the
// pair, so a stale entry can never show a stale price.
const LAUNCHED_KEY = 'bear.dex.launched';

function storeKey() {
  return `${LAUNCHED_KEY}.${DEX_CHAIN_ID}`;
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x) => x && typeof x.address === 'string' && x.address);
  } catch {
    return [];
  }
}

function writeStore(list) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(list));
  } catch {
    // Private mode / quota. The in-memory copy still serves this session, so the
    // feed keeps working — it just will not survive a reload, and saying so is
    // better than pretending otherwise.
  }
}

// Tokens this wallet launched from this browser. Newest first. The persisted
// index is the record; the state mirror keeps every existing reader (and the
// router's dex.tokenView lookup) on one path.
export function launchedTokens() {
  const fromStore = readStore();
  const fromState = Array.isArray(get('dex.launched')) ? get('dex.launched') : [];
  // Union, newest first, no duplicates: a token present in either place is a
  // token this browser launched. Merging rather than preferring one means a
  // write that only reached memory (private mode) is still visible this
  // session.
  const seen = new Set();
  const out = [];
  for (const x of [...fromState, ...fromStore]) {
    const a = String(x.address).toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(x);
  }
  return out;
}

export function rememberLaunchedToken(entry) {
  const list = launchedTokens().filter((x) => x.address.toLowerCase() !== entry.address.toLowerCase());
  list.unshift(entry);
  const capped = list.slice(0, 100); // a sane cap; newest first
  set('dex.launched', capped);
  writeStore(capped);
}

/**
 * Drop a token from the local launched index — the app's own record of it.
 *
 * Called together with list.js deleteCoin(): the index forgets the token and
 * the tombstone keeps it off the grid. The chain itself is untouched — the
 * contract, the pool and the price stay exactly where they were.
 */
export function forgetLaunchedToken(address) {
  const a = String(address || '').toLowerCase();
  const kept = launchedTokens().filter((x) => String(x.address).toLowerCase() !== a);
  set('dex.launched', kept);
  writeStore(kept);
  return kept.length;
}

export function tokensHtml() {
  const launched = launchedTokens();
  // The instant local paint. refreshFeed() re-renders from the chain right
  // after, so this is only what the user sees for the moment it takes to
  // query. It is filtered too: a deleted token must not flash back for even
  // that moment, and a row with no price yet says so with a dash instead of
  // inventing a number.
  const rows = withoutDeleted(launched).map(rowHtml).join('');

  return `
    <div class="dex-feedhead">
      <div class="dex-tabstrip" role="group" aria-label="${escapeHtml(t('dex.tokens.filter'))}">
        <button type="button" class="dex-tab" data-dex-scope="all" aria-pressed="true">${escapeHtml(t('dex.tokens.all'))}</button>
        <button type="button" class="dex-tab" data-dex-scope="mine" aria-pressed="false">${escapeHtml(t('dex.tokens.mine'))}</button>
      </div>
    </div>
    <div id="dexTokenList" class="dex-grid">${rows}</div>
    <div id="dexFeedStatus" class="small mt-8"></div>
    <div class="dex-empty mt-8" ${rows ? 'hidden' : ''}>
      <span class="dex-empty-ic" aria-hidden="true">◎</span>
      <strong class="dex-empty-title">${escapeHtml(t('dex.tokens.emptyTitle'))}</strong>
      <p class="dex-empty-msg">${escapeHtml(t('dex.tokens.none'))}</p>
      <p class="dex-empty-hint">${escapeHtml(t('dex.tokens.emptyHint'))}</p>
    </div>`;
}

// One row renderer, shared by the instant local paint and the chain refresh, so
// a token cannot look different depending on which pass found it.
//
// The row is a MARKET row: a square face, name over ticker over address, and
// the pool price under it — live from the pair on every chain pass, a dash in
// the moment before the chain has answered.
function rowHtml(tk) {
  const short = `${tk.address.slice(0, 4)}…${tk.address.slice(-4)}`;
  const price = tk.price ? `${String(tk.price)} ${String(tk.qSym || '')}`.trim() : '—';
  return `
    <button type="button" class="dex-card" data-dex-token="${escapeHtml(tk.address)}">
      <span class="dex-card-face">
        ${tk.image
          ? `<img src="${escapeHtml(tk.image)}" alt="" loading="lazy">`
          : `<span class="dex-card-face-fallback" aria-hidden="true">${escapeHtml((tk.symbol || '?').slice(0, 2).toUpperCase())}</span>`}
      </span>
      <span class="dex-card-id">
        <span class="dex-card-name">${escapeHtml(tk.name || '')}</span>
        <span class="dex-card-ticker">${escapeHtml(tk.symbol || '')}</span>
        <span class="dex-card-addr">${escapeHtml(short)}</span>
      </span>
      <span class="dex-card-price">${escapeHtml(price)}</span>
      <span class="dex-card-go" aria-hidden="true">›</span>
    </button>`;
}

// Paints whatever the chain knows, and says so honestly when it could not look.
// The three outcomes are kept apart on purpose:
//   • pools found        → show them, each priced from its own pair
//   • looked, found none → "none on chain yet"
//   • could not look     → "could not read the chain", never a silent empty grid
export async function refreshFeed(host, scope = 'all') {
  const list = $('#dexTokenList', host);
  const status = $('#dexFeedStatus', host);
  if (!list) return { coins: [], ok: false };

  const out = await discoverPools({ scope: scope === 'mine' ? 'mine' : 'all', limit: 24 });

  // Deleted tokens never come back: the filter drops them from chain rows and
  // the local paint alike, so a re-scan cannot resurrect one. There is no
  // hidden tab and no restore path; that design was rejected.
  const rows = out.ok ? withoutDeleted(await fillMeta(out.pools.slice())) : [];

  const box = host.querySelector('.dex-empty');
  const msg = box ? box.querySelector('.dex-empty-msg') : null;
  const say = (text) => { if (msg) msg.textContent = text; };

  if (!out.ok) {
    // The empty box is cleared HERE too: it is pre-rendered, so a stale "no
    // coins yet" next to "could not read the chain" is two claims, one of them
    // a lie. The local paint stays on screen — it is not wrong, just not
    // confirmed.
    if (box) box.hidden = true;
    if (status) {
      status.textContent = out.reason === 'no factory'
        ? t('dex.swap.noFactory')
        : t('dex.tokens.scanFailed', { err: out.reason || '' });
    }
    return { coins: [], ok: false };
  }

  // Price per row, read from each pair: the number this token actually trades
  // at right now. A row whose read fails shows a dash — never a guessed price.
  const priced = await Promise.all(rows.map(async (r) => {
    const ps = await poolState(r.pair);
    if (!ps.ok) return { ...r, price: '' };
    const q = quoteBy(r.quote);
    // Factory tokens are BearTokens: always 18 decimals. The quote side uses
    // its preset's decimals, or the displayed unit would be wrong.
    return {
      ...r,
      price: fmtTok(quotePerToken(ps.quoteReserve, ps.tokenReserve, 18), q ? q.decimals : 18, 6),
      qSym: q ? q.symbol : '',
    };
  }));

  list.innerHTML = priced.map(rowHtml).join('');
  if (box) {
    box.hidden = priced.length > 0;
    if (!priced.length) say(t('dex.tokens.noneOnChain'));
  }
  if (status) status.textContent = out.more ? t('dex.tokens.moreOnChain') : '';
  return { coins: priced, ok: true, more: out.more };
}

export function bindTokens(host, onOpen) {
  const list = $('#dexTokenList', host);
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-dex-token]');
      if (row && typeof onOpen === 'function') onOpen(row.dataset.dexToken);
    });
  }
}
