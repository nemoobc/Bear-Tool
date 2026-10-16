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
//
// Discovery sits ON TOP of that list, not beside it (riset launchpad-ux R3,
// user: "fitur launchpad kurang lengkap"): one search box that takes a name, a
// ticker OR a contract address — a name can be copied, an address cannot — one
// sort that only claims what this feed actually knows, and two badges that are
// FACTS with a source: "New" dies with its freshness window, "LP locked" exists
// because the pair's own lockedUntil says so. Nothing here is decoration.
import { withoutDeleted } from './list.js';
import { t } from '../i18n.js';
import { get, set } from '../state.js';
import { $, escapeHtml } from '../ui.js';
import { quoteBy, fmtTok, provider, ethersLib, isAddr, DEX_CHAIN_ID } from './core.js';
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

// ── the freshness window & the view maths ────────────────────────────
//
// "New" is a CLAIM, and a claim needs a window: 7 200 blocks ≈ 24h at
// Sepolia's ~12s. Outside the window the badge would be a lie, so it dies.
export const FRESH_BLOCKS = 7_200;

/** Is a pool's birth block within the window of the tip the scan saw?
 *  No tip or no block means NO claim — a badge on a guess is a small lie. */
export function isFresh(block, latest) {
  const b = Number(block);
  const l = Number(latest);
  return Number.isFinite(b) && Number.isFinite(l) && b > 0 && l >= b && l - b <= FRESH_BLOCKS;
}

/** Has the pair's lockedUntil(creator) not expired yet? The expiry second
 *  itself is already over — a lock you can exit this block is not a lock. */
export function isLocked(until, now) {
  const u = Number(until);
  return Number.isFinite(u) && u > Number(now);
}

/** The feed's VIEW: filter by q (name / ticker / contract address) and order
 *  by sort. Pure — returns a new array and never touches the caller's rows, so
 *  a repaint can never corrupt what the chain said. The sorts are honest about
 *  what the feed knows: 'liq' is the pair's quote reserve (BigInt — wei does
 *  not fit a Number), 'name' needs no chain at all. */
export function feedView(rows, { q = '', sort = 'new' } = {}) {
  if (!Array.isArray(rows)) return [];
  const needle = String(q).trim().toLowerCase();
  const out = needle
    ? rows.filter((r) => `${r.name || ''} ${r.symbol || ''} ${r.address || ''}`.toLowerCase().includes(needle))
    : [...rows];
  const byNew = (a, b) => (Number(b.block) || 0) - (Number(a.block) || 0)
    || String(a.address || '').localeCompare(String(b.address || ''));
  if (sort === 'liq') {
    const liqOf = (r) => { try { return BigInt(r.liq ?? 0); } catch { return 0n; } };
    out.sort((a, b) => {
      const x = liqOf(a); const y = liqOf(b);
      return x === y ? byNew(a, b) : (x > y ? -1 : 1);
    });
  } else if (sort === 'name') {
    const nameOf = (r) => String(r.name || r.symbol || r.address || '').toLowerCase();
    out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || byNew(a, b));
  } else {
    out.sort(byNew);
  }
  return out;
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
      <div class="dex-feedtools">
        <input id="dexFeedSearch" class="dex-search" type="search" autocomplete="off"
          placeholder="${escapeHtml(t('dex.feed.search'))}" aria-label="${escapeHtml(t('dex.feed.search'))}">
        <select id="dexFeedSort" class="dex-sort" aria-label="${escapeHtml(t('dex.feed.sortAria'))}">
          <option value="new">${escapeHtml(t('dex.feed.sortNew'))}</option>
          <option value="liq">${escapeHtml(t('dex.feed.sortLiq'))}</option>
          <option value="name">${escapeHtml(t('dex.feed.sortName'))}</option>
        </select>
      </div>
    </div>
    <div id="dexFeedMatch" hidden></div>
    <div id="dexTokenList" class="dex-grid">${rows}</div>
    <div id="dexFeedStatus" class="small mt-8" role="status"></div>
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
// the moment before the chain has answered. Badges are facts with a source:
// "New" rides the pinned freshness window against the scan's tip, "LP locked"
// rides the pair's own lockedUntil(creator). A fact that is not there = no
// badge, never a guess.
function rowHtml(tk) {
  const short = `${tk.address.slice(0, 4)}…${tk.address.slice(-4)}`;
  const price = tk.price ? `${String(tk.price)} ${String(tk.qSym || '')}`.trim() : '—';
  const badges = [
    tk.fresh ? `<span class="dex-badge dex-badge-new">${escapeHtml(t('dex.feed.badgeNew'))}</span>` : '',
    isLocked(tk.lockedUntil, Math.floor(Date.now() / 1000))
      ? `<span class="dex-badge dex-badge-lock" title="${escapeHtml(t('dex.feed.lockUntil', { date: dateOf(tk.lockedUntil) }))}">${escapeHtml(t('dex.feed.badgeLock'))}</span>`
      : '',
  ].join('');
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
        ${badges}
        <span class="dex-card-addr">${escapeHtml(short)}</span>
      </span>
      <span class="dex-card-price">${escapeHtml(price)}</span>
      <span class="dex-card-go" aria-hidden="true">›</span>
    </button>`;
}

/** A lock's expiry as a plain ISO day — a title string must not depend on the
 *  viewer's locale to avoid being wrong. */
function dateOf(until) {
  const d = new Date(Number(until) * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

// The pair's own lockedUntil(creator) — the ONE honest source for the locked
// badge. One read per row, beside the price read, and a pair that will not
// answer simply gets no badge instead of a guessed one.
const LOCK_ABI = ['function lockedUntil(address) view returns (uint256)'];
async function readLock(pair, creator) {
  const p = provider();
  const E = ethersLib();
  if (!p || !E || !isAddr(pair) || !isAddr(creator)) return 0;
  try {
    const c = new E.Contract(pair, LOCK_ABI, p);
    return Number(await c.lockedUntil(creator));
  } catch {
    return 0;
  }
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
  // The same pass reads the pair's lockedUntil for its creator; freshness rides
  // the tip the scan just reported. Both feed badges, neither is invented.
  const priced = await Promise.all(rows.map(async (r) => {
    const [ps, lockedUntil] = await Promise.all([poolState(r.pair), readLock(r.pair, r.creator)]);
    if (!ps.ok) return { ...r, price: '', lockedUntil };
    const q = quoteBy(r.quote);
    // Factory tokens are BearTokens: always 18 decimals. The quote side uses
    // its preset's decimals, or the displayed unit would be wrong.
    return {
      ...r,
      price: fmtTok(quotePerToken(ps.quoteReserve, ps.tokenReserve, 18), q ? q.decimals : 18, 6),
      qSym: q ? q.symbol : '',
      liq: ps.quoteReserve,
      lockedUntil,
      fresh: isFresh(r.block, out.latest),
    };
  }));

  // The view state lives on the module: search and sort must repaint from the
  // LAST chain-verified rows without re-scanning (typing must never cost an
  // RPC pass), and the chain paint and the filter paint share one renderer so
  // the screen can never show two different feeds.
  feedState.rows = priced;
  feedState.status = out.more ? t('dex.tokens.moreOnChain') : '';
  if (box) {
    box.hidden = priced.length > 0;
    if (!priced.length) say(t('dex.tokens.noneOnChain'));
  }
  applyView(host);
  return { coins: priced, ok: true, more: out.more };
}

// The feed view state: the last rows the chain verified, plus the status line
// the chain path set. Search and sort read the LIVE controls and re-render from
// here — nothing to reset on the 20s refresh, because the controls are state.
const feedState = { rows: [], status: '' };

function viewControls(host) {
  const search = $('#dexFeedSearch', host);
  const sort = $('#dexFeedSort', host);
  return {
    q: search && typeof search.value === 'string' ? search.value : '',
    sort: sort && sort.value ? sort.value : 'new',
  };
}

/** Paint the list + status + the open-a-contract affordance from the last
 *  verified rows. THE one paint path: the chain refresh and every keystroke
 *  both land here. */
function applyView(host) {
  const list = $('#dexTokenList', host);
  if (!list || !feedState.rows.length) return;
  const status = $('#dexFeedStatus', host);
  const match = $('#dexFeedMatch', host);
  const { q, sort } = viewControls(host);
  const shown = feedView(feedState.rows, { q, sort });
  list.innerHTML = shown.map(rowHtml).join('');

  // A full contract address that is NOT in the window is not a dead end: the
  // factory can resolve it (pairFor), so offer the way in. Below a full
  // address the honest answer is "nothing matches", not a wild guess.
  const raw = String(q || '').trim();
  const canOpen = shown.length === 0 && isAddr(raw);
  if (match) {
    match.hidden = !canOpen;
    match.innerHTML = canOpen
      ? `<button type="button" class="dex-open" data-dex-open="${escapeHtml(raw.toLowerCase())}">${escapeHtml(t('dex.feed.openAddr'))} — ${escapeHtml(`${raw.slice(0, 6)}…${raw.slice(-4)}`)}</button>`
      : '';
  }

  // Status speaks for the VIEW: a search that matched nothing is not an empty
  // feed, and it is not a failed scan either. The three claims stay separate.
  if (status) {
    status.textContent = raw && shown.length === 0
      ? t('dex.feed.noMatch', { q: raw })
      : feedState.status;
  }
}

export function bindTokens(host, onOpen) {
  const list = $('#dexTokenList', host);
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-dex-token]');
      if (row && typeof onOpen === 'function') onOpen(row.dataset.dexToken);
    });
  }

  // Search and sort repaint from the last verified rows — typing must never
  // fire a chain scan (on a public RPC it never could afford one).
  const search = $('#dexFeedSearch', host);
  const sort = $('#dexFeedSort', host);
  if (search) search.addEventListener('input', () => applyView(host));
  if (sort) sort.addEventListener('change', () => applyView(host));

  // The not-in-window address goes to the same door as a card tap: the token
  // page resolves the pool itself (pairFor) and refuses politely when there is
  // none.
  const match = $('#dexFeedMatch', host);
  if (match) {
    match.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dex-open]');
      if (b && typeof onOpen === 'function') onOpen(b.dataset.dexOpen);
    });
  }
}
