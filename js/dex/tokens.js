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
import { graduationProgress, GRADUATION_ETH } from './curve.js';

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

export function tokensHtml() {
  const launched = launchedTokens();
  const rows = launched.map((tk) => `
    <button type="button" class="dex-token-row" data-dex-token="${escapeHtml(tk.address)}">
      <span class="dex-token-face">
        ${tk.image ? `<img src="${escapeHtml(tk.image)}" alt="">` : ''}
      </span>
      <span class="dex-token-meta">
        <strong>${escapeHtml(tk.name)}</strong>
        <span class="small">${escapeHtml(tk.symbol)} · <span class="mono">${escapeHtml(tk.address.slice(0, 6))}…${escapeHtml(tk.address.slice(-4))}</span></span>
        <span class="dex-token-bar" id="dexProg_${escapeHtml(tk.address.slice(2, 10))}"></span>
      </span>
      <span class="dex-token-tag small dex-token-tag--curve">${escapeHtml(t('dex.tokens.curve'))}</span>
    </button>`).join('');

  return `
    <div class="field-label">${escapeHtml(t('dex.tokens.title'))}</div>
    <div class="small mb-8">${escapeHtml(t('dex.tokens.hint'))}</div>
    <div id="dexTokenList">${rows}</div>
    ${launched.length ? '' : `<div class="dex-empty mt-8">${escapeHtml(t('dex.tokens.none'))}</div>`}`;
}

export function bindTokens(host, onOpen) {
  const list = $('#dexTokenList', host);
  // Live graduation progress for each curve token, read from chain.
  for (const tk of launchedTokens()) {
    readProgress(tk).then((pct) => {
      const bar = $(`#dexProg_${tk.address.slice(2, 10)}`, host);
      if (bar) bar.textContent = pct;
    });
  }
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-dex-token]');
      if (row && typeof onOpen === 'function') onOpen(row.dataset.dexToken);
    });
  }
}

// Reads realEthReserve + graduated from the live contract. Any failure is
// reported as "unread", never as a made-up progress number.
async function readProgress(tk) {
  const p = provider();
  if (!p || !dexChainOk()) return null;
  try {
    const E = ethersLib();
    const c = new E.Contract(tk.address, PUMP_ABI, p);
    const [reserve, graduated] = await Promise.all([c.realEthReserve(), c.graduated()]);
    if (graduated) return t('dex.tokens.graduated');
    const { bps } = graduationProgress(reserve, GRADUATION_ETH);
    return t('dex.tokens.progress', { pct: String(Math.round(Number(bps) / 100)) });
  } catch {
    return t('dex.tokens.unread');
  }
}
