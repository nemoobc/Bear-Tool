// Bear Tool — js/dex/tokens.js
// The launchpad FEED — the Dex's home screen. In the pure-launchpad rebuild
// (user: "opsi 1") the subject of the whole view is a TOKEN trading on its own
// bonding curve. So this list holds ONLY curve tokens: coins launched here. The
// three preset ERC-20s and the Uniswap V2 pools are gone from the Dex — they
// were the source of its ambiguity (two trading engines, two "ETH", a global
// pair) and a launchpad has neither.
//
// Nothing is a hardcoded feed: it is whatever this wallet actually deployed,
// newest first, with each coin's live graduation progress read from chain.
import { t } from '../i18n.js';
import { get, set } from '../state.js';
import { $, escapeHtml } from '../ui.js';
import { dexChainOk, provider, ethersLib, DEX_CHAIN_ID } from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { graduationProgress, GRADUATION_QUOTE } from './curve.js';

// Where the launched-coin index is KEPT, and why it is not in state.js.
//
// state.set() writes to an in-memory singleton: nothing survives a reload. The
// first version of this feed read the list from there, so every coin the user
// launched vanished on refresh — the contract stayed live, the gas was spent,
// and the feed came back empty with no way back. Found by reloading the page
// after a real launch, which no unit test does.
//
// So the index is persisted here, per chain: Sepolia coins must not appear on
// mainnet just because the same browser ran both. Only what cannot be re-derived
// is stored — address, name, symbol, image. Price, reserve and graduation are
// always read live from the contract, so a stale entry can never show a stale
// price.
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

// Curve tokens this wallet deployed. Newest first. The persisted index is the
// record; the state mirror keeps every existing reader (and the router's
// dex.tokenView lookup) on one path.
export function launchedTokens() {
  const fromStore = readStore();
  const fromState = Array.isArray(get('dex.launched')) ? get('dex.launched') : [];
  // Union, newest first, no duplicates: a coin present in either place is a coin
  // the user owns. Merging rather than preferring one means a write that only
  // reached memory (private mode) is still visible this session.
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
 * The coins the feed shows: what the chain says this wallet launched, unioned
 * with whatever this browser remembers.
 *
 * Chain first in authority, local only for the image (too large to log, and
 * readable from the contract anyway). That inversion is what makes the feed
 * survive losing localStorage — the thing that erased real coins before.
 */
export async function feedCoins(scope = 'all') {
  const { reconcile } = await import('./discover.js');
  const local = launchedTokens();
  const { coins, ok, reason, more } = await reconcile({ scope, local });
  // Scope 'mine' is a filter over the same local list, so it must not be widened
  // by the chain merge: without this, "My coins" would show everyone else's.
  const mine = scope === 'mine'
    ? coins.filter((c) => local.some((x) => x.address.toLowerCase() === c.address.toLowerCase()))
    : coins;
  return { coins: mine, ok, reason, more };
}

export function tokensHtml() {
  const launched = launchedTokens();
  // The instant local paint. refreshFeed() re-renders from the chain right after,
  // so this is only what the user sees for the moment it takes to query.
  const rows = launched.map(rowHtml).join('');

  return `
    <div class="dex-feedhead">
      <div class="dex-tabstrip" role="group" aria-label="${escapeHtml(t('dex.tokens.filter'))}">
        <button type="button" class="dex-tab" data-dex-scope="all" aria-pressed="true">${escapeHtml(t('dex.tokens.all'))}</button>
        <button type="button" class="dex-tab" data-dex-scope="mine" aria-pressed="false">${escapeHtml(t('dex.tokens.mine'))}</button>
      </div>
    </div>
    <div id="dexTokenList" class="dex-grid">${rows}</div>
    <div id="dexFeedStatus" class="small mt-8"></div>
    ${launched.length ? '' : `<div class="dex-empty mt-8">${escapeHtml(t('dex.tokens.none'))}</div>`}`;
}

// One row renderer, shared by the instant local paint and the chain refresh, so
// a coin cannot look different depending on which pass found it.
// One card. Measured against pump.fun's own feed rather than invented: the
// square face is the hero, the name and ticker sit under it, and the bonding
// curve's progress bar is the last thing on the card — because on a launchpad
// that bar is the single fact that matters: how close the coin is to graduating.
function rowHtml(tk) {
  const short = `${tk.address.slice(0, 4)}…${tk.address.slice(-4)}`;
  return `
    <button type="button" class="dex-card" data-dex-token="${escapeHtml(tk.address)}">
      <span class="dex-card-face">
        ${tk.image
          ? `<img src="${escapeHtml(tk.image)}" alt="" loading="lazy">`
          : `<span class="dex-card-face-fallback" aria-hidden="true">${escapeHtml((tk.symbol || '?').slice(0, 2).toUpperCase())}</span>`}
      </span>
      <span class="dex-card-name">${escapeHtml(tk.name)}</span>
      <span class="dex-card-ticker">${escapeHtml(tk.symbol)}</span>
      <span class="dex-card-curve" id="dexProg_${escapeHtml(tk.address.slice(2, 10))}"
            role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
            aria-label="${escapeHtml(t('dex.tokens.progressAria', { name: tk.name || tk.symbol }))}">
        <span class="dex-card-curve-fill"></span>
        <span class="dex-card-curve-text">—</span>
      </span>
    </button>`;
}

// Paints whatever the chain knows, and says so honestly when it could not look.
// The three outcomes are kept apart on purpose:
//   • coins found        → show them
//   • looked, found none → "you have not launched a coin"
//   • could not look     → "could not read the chain", never a silent empty list
export async function refreshFeed(host, scope = 'all') {
  const list = $('#dexTokenList', host);
  const status = $('#dexFeedStatus', host);
  if (!list) return { coins: [], ok: false };

  const { coins, ok, reason, more } = await feedCoins(scope);

  // The grid and the empty box are ONE thing with two states, so both are set on
  // every pass. The first version only replaced the grid when it had coins, so
  // switching to a filter that matched nothing left the previous rows on screen
  // next to an "empty" message — a feed that claimed to be empty while still
  // listing three coins.
  const box = host.querySelector('.dex-empty');

  if (ok) {
    list.innerHTML = coins.map(rowHtml).join('');
    if (box) {
      box.hidden = coins.length > 0;
      if (!coins.length) box.textContent = t('dex.tokens.noneOnChain');
    }
  } else {
    if (status) status.textContent = t('dex.tokens.scanFailed', { err: reason || '' });
    // The local list stays on screen — it is not wrong, just not confirmed.
    return { coins, ok: false };
  }

  if (status) {
    status.textContent = more ? t('dex.tokens.moreOnChain') : '';
  }

  // Graduation progress for each card, live from the chain.
  for (const tk of coins) paintProgress(tk, host);
  return { coins, ok, more };
}

export function bindTokens(host, onOpen) {
  const list = $('#dexTokenList', host);
  // Live graduation progress for each curve token, read from chain.
  for (const tk of launchedTokens()) {
    paintProgress(tk, host);
  }
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-dex-token]');
      if (row && typeof onOpen === 'function') onOpen(row.dataset.dexToken);
    });
  }
}

// Reads realQuoteReserve + graduated from the live contract. Any failure is
// reported as "unread", never as a made-up progress number.
async function readProgress(tk) {
  const p = provider();
  if (!p || !dexChainOk()) return null;
  try {
    const E = ethersLib();
    const c = new E.Contract(tk.address, PUMP_ABI, p);
    const [reserve, graduated] = await Promise.all([c.realQuoteReserve(), c.graduated()]);
    if (graduated) return t('dex.tokens.graduated');
    const { bps } = graduationProgress(reserve, GRADUATION_QUOTE);
    return t('dex.tokens.progress', { pct: String(Math.round(Number(bps) / 100)) });
  } catch {
    return t('dex.tokens.unread');
  }
}

// Paints one card's curve bar from the chain: the fill width, the percentage,
// and the ARIA value a screen reader announces. Three surfaces from one read, so
// they cannot disagree.
export function paintProgress(tk, host) {
  const wrap = $(`#dexProg_${tk.address.slice(2, 10)}`, host);
  if (!wrap) return Promise.resolve(null);
  const fill = wrap.querySelector('.dex-card-curve-fill');
  const text = wrap.querySelector('.dex-card-curve-text');
  return readProgress(tk).then((label) => {
    if (text) text.textContent = label;
    // The label reads "42% to graduation", so the percentage is a LEADING number,
    // not the whole string. Anchoring the regex at the end (the first version
    // wanted exactly "42%") meant every real label failed to parse and every bar
    // sat empty at 0% — which looks like a chain that never sold a coin.
    const pct = /^(\d+)%/.exec(String(label));
    const n = pct ? Math.max(0, Math.min(100, Number(pct[1]))) : null;
    if (fill) fill.style.width = n === null ? '0%' : n + '%';
    wrap.classList.toggle('is-done', label === t('dex.tokens.graduated'));
    wrap.classList.toggle('is-unread', n === null);
    if (n !== null) wrap.setAttribute('aria-valuenow', String(n));
    return n;
  });
}
