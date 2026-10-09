// ═══════════════════════════════════════════════════════════════
// token-logo.js — ONE renderer for token marks, shared by every surface.
//
// This used to live inline inside renderAssets() in app.js, so only the
// dashboard had real marks. The Swap/Bridge pickers had to grow their own and
// ended up as plain CSS circles with a letter, which is why the token lists did
// not look like the dashboard. Extracting it means a mark looks the same
// everywhere by construction.
//
// Marks are inline SVG rather than remote images on purpose: CoinGecko image
// URLs 404 and expire, and a wallet list that shows broken icons is worse than
// one showing a crisp generated mark. A cached CoinGecko URL is still used when
// one exists, with an onerror fallback back to the generated mark.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml } from './ui.js';

const CACHE_KEY = 'bear.logoCache';
const TTL = 24 * 60 * 60 * 1000;

// Symbols with a hand-tuned mark. Everything else falls back to the cache, then
// to the default disc.
const MARKS = {
  eth:    ['#627EEA', '#8B9FE8', 'Ξ',  14],
  // Native coins of every bundled network (item 11: all must render their own
  // mark, not the generic peach disc): BNB/tBNB = BSC mainnet/testnet,
  // POL = Polygon + Amoy (MATIC = the legacy ticker, same mark).
  bnb:    ['#F0B90B', '#F3BA2F', '⬡',  13],
  tbnb:   ['#F0B90B', '#F3BA2F', 't⬡', 10],
  pol:    ['#8247E5', '#9D71F1', 'P',  13],
  matic:  ['#8247E5', '#9D71F1', 'P',  13],
  usdc:   ['#2775CA', '#4A9AE8', '$',  11],
  usdt:   ['#26A17B', '#3DD68C', '₮',  12],
  dai:    ['#F5AC37', '#F8C967', 'D',  12],
  wbtc:   ['#F7931A', '#F8B34A', 'B',  12],
  link:   ['#2A5ADA', '#5B8DEF', '⬡', 13],
  uni:    ['#FF007A', '#FF4DA6', 'U',  13],
  aave:   ['#B6509E', '#2EBAC6', 'AA', 12],
  reth:   ['#E84142', '#FF6B6B', 'rΞ', 11],
  cbeth:  ['#0052FF', '#4D8BFF', 'cb', 11],
  wsteth: ['#00A3FF', '#66C2FF', 'wΞ', 10],
  frax:   ['#000000', '#333333', 'FX', 11],
  // Native coins of the 2026-10-05 network growth (4 L1 + 7 L2). Linea/Scroll/
  // Blast/zkSync/Unichain/World Chain ride on ETH above; these five are the new
  // native tickers — without an entry each one wears the fallback peach disc
  // (native-coin-marks.test.js pins the exact set).
  avax:   ['#E84142', '#FF6B6B', '▲',  12],
  xdai:   ['#04795B', '#0A9E6E', 'G',  13],
  celo:   ['#FCFF52', '#D4E04A', 'C',  12],
  s:      ['#F2A72B', '#FFB13C', 'S',  13],
  mnt:    ['#65B3AE', '#8CD8D2', 'M',  13],
};

export function readLogoCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { return {}; }
}

/**
 * What a mark is filed under.
 *
 * A token's identity is its CONTRACT. The ticker is a label on it, and thousands
 * of contracts share one — a counterfeit "USDC" is among the most common things a
 * wallet turns up. The cache used to be keyed by ticker, so every one of those
 * contracts was drawn with Circle's actual mark.
 *
 * That matters more here than in an ordinary app. The wallet already ships an
 * address-poisoning guard, and it compares ADDRESSES: it cannot see a borrowed
 * mark. So a fake token wearing the genuine logo passed the one check that
 * existed, and the mark is precisely what a user scans the list for.
 *
 * A native coin has no contract, so its symbol is the only identity there is —
 * namespaced as `sym:` so it can never collide with an address-shaped key.
 */
export function logoKeyFor(token) {
  const address = String(token?.address || '').trim();
  if (address) return address.toLowerCase();
  return 'sym:' + String(token?.symbol || '').toLowerCase();
}

export function getCachedLogo(key) {
  const e = readLogoCache()[String(key || '').toLowerCase()];
  return e && Date.now() - e.ts < TTL ? e.url : null;
}

export function cacheLogo(key, url) {
  try {
    const c = readLogoCache();
    c[String(key || '').toLowerCase()] = { url, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* private mode / quota — the mark fallback covers it */ }
}

// `uid` must differ per rendered instance: the marks use SVG <linearGradient>
// ids, and two marks sharing an id on one page makes the first definition win
// for both, so a row of tokens ends up tinted with the wrong colour.
let counter = 0;
const nextUid = () => `tk${(++counter).toString(36)}${Math.floor(performance.now() % 1e6).toString(36)}`;

function markSvg(sym, size, opt = {}) {
  const s = (sym || '').toLowerCase();
  // A CONTRACT token never wears the hand-tuned brands: those marks belong to
  // the native coin / listed project with that ticker, and a freshly deployed
  // "USDC" wearing Circle's $ disc is exactly the counterfeit-mark bug
  // (user report 2026-10-08: "deploy token malah kedetect logo lain tapi
  // ticker sama"). opt.contract suppresses the brand; the peach initial disc
  // stands until a contract-keyed CoinGecko image proves the identity.
  const m = opt.contract === true ? null : MARKS[s];
  const uid = nextUid();
  if (m) {
    const [c1, c2, glyph, fs] = m;
    return `<svg class="token-mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
      + `<defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>`
      + `<circle cx="16" cy="16" r="16" fill="url(#${uid})"/>`
      + `<text x="16" y="21" text-anchor="middle" fill="white" font-size="${fs}" font-weight="800" font-family="Arial">${glyph}</text>`
      + `</svg>`;
  }
  const initial = escapeHtml((sym || '?').slice(0, 2).toUpperCase());
  return `<svg class="token-mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<circle cx="16" cy="16" r="16" fill="#FFD9C0"/>`
    + `<text x="16" y="21" text-anchor="middle" fill="#2D2A32" font-size="11" font-weight="800" font-family="Arial">${initial}</text>`
    + `</svg>`;
}

/**
 * @param {string} sym  token symbol
 * @param {number} size pixel size of the square
 * @param {object} [opt]
 * @param {boolean} [opt.remote=true] allow a cached CoinGecko image first
 */
export function tokenLogoHTML(sym, size = 32, opt = {}) {
  const remote = opt.remote !== false;
  const address = String(opt.address || '').trim();
  if (remote) {
    // Looked up by CONTRACT when one is given, so a counterfeit ticker cannot
    // reach the real project's mark. The symbol is still what the generated
    // fallback draws.
    const url = getCachedLogo(logoKeyFor({ address, symbol: sym }));
    if (url) {
      // Falls back to the generated mark if the cached image is dead, so a
      // stale URL degrades instead of showing a broken-image icon.
      return `<img class="token-logo-img token-mark" data-mark-fallback="${escapeHtml(sym || '')}" `
        + (address ? `data-mark-contract="1" ` : '')
        + `src="${escapeHtml(url)}" `
        + `alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
    }
  }
  // No cache: a contract token must not reach the branded MARKS either (see
  // markSvg) — an own/deployed token whose ticker matches a listed project
  // used to render that project's brand right here, no network needed.
  return markSvg(sym, size, { contract: Boolean(address) });
}

/** Attach the onerror fallback to every rendered logo inside a root. */
export function guardTokenLogos(root) {
  if (!root) return;
  root.querySelectorAll('img.token-logo-img').forEach((img) => {
    if (img.dataset.guarded) return;
    img.dataset.guarded = '1';
    img.addEventListener('error', () => {
      img.outerHTML = markSvg(img.dataset.markFallback || '', Number(img.getAttribute('width')) || 24,
        { contract: img.dataset.markContract === '1' });
    }, { once: true });
  });
}

export { markSvg as tokenMarkSvg };

// ── CoinGecko auto-detect (fetch once per token, cache 24h) ──────────────
// Two lookups that answer DIFFERENT identities:
//
// 1. CONTRACT lookup — `/coins/{platform}/contract/{address}` — the only
//    correct one for a token with an address: it is keyed by the contract,
//    so it cannot borrow another project's image. Unknown chain → no
//    platform → no fetch (the initial disc stands).
// 2. SYMBOL search — the old `fetchCoinGeckoLogo(sym)` — kept ONLY for native
//    coins (no contract, ticker IS the identity). It used to run for contract
//    tokens too: the first exact-symbol coin won, so a freshly deployed token
//    "detected" a stranger's logo while showing its own ticker (live report
//    2026-10-08). Never again for contracts.
export const COINGECKO_PLATFORMS = {
  1: 'ethereum', 56: 'bsc', 137: 'polygon-pos', 42161: 'arbitrum-one',
  10: 'optimistic-ethereum', 8453: 'base', 43114: 'avalanche', 100: 'gnosis',
  59144: 'linea', 534352: 'scroll', 81457: 'blast', 324: 'zksync-era',
  42220: 'celo', 146: 'sonic', 5000: 'mantle',
};

// Native tickers whose hand-tuned mark is already local — no fetch, ever.
// (Moved from app.js MANUAL_LOGO_SYMS: the skip was applied to contract
// tokens as well, which kept a counterfeit ticker wearing the brand mark.)
const MANUAL_NATIVE_SYMS = new Set([
  'eth', 'ether', 'usdc', 'usdt', 'dai', 'wbtc', 'link', 'uni', 'aave',
  'reth', 'cbeth', 'wsteth', 'frax',
]);

// Distinguishes an ANSWER from an OUTAGE: {data} = the endpoint replied
// (a 404 says "not listed"), {failed} = the network/CORS/rate-limit case
// where no verdict about the token exists. Only failures count toward the
// breaker below — a run of unlisted tokens must not shut the batch down.
async function cgFetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429 || res.status >= 500) return { failed: true };
    if (!res.ok) return { data: null };
    return { data: await res.json() };
  } catch { return { failed: true }; }
  finally { clearTimeout(timer); }
}

async function fetchContractLogo(address, platform) {
  const r = await cgFetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(address)}`);
  return { url: r?.data?.image?.large || null, failed: Boolean(r?.failed) };
}

async function fetchSymbolLogo(sym) {
  const r = await cgFetchJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`);
  const coins = Array.isArray(r?.data?.coins) ? r.data.coins : [];
  const hit = coins.find(c => (c.symbol || '').toLowerCase() === String(sym).toLowerCase() && c.large);
  return { url: hit?.large || null, failed: Boolean(r?.failed) };
}

// Fetch + cache logos for tokens not covered by a local mark.
// Never throws — logo failures just leave the default mark in place.
//
// Paced, one lookup at a time with a gap: a parallel burst of a dozen
// contract requests trips CoinGecko's rate limit. The throttled answers
// arrive WITHOUT CORS headers (the console fills with ERR_FAILED and the
// browser reports a policy block) and nothing gets cached — so every
// dashboard load repeated the whole storm. A failed lookup is remembered
// for a few minutes instead of being retried on each render.
//
// TWO holes closed after the 2026-10-08 boot capture (46 /contract/ errors
// in one load):
// 1. The memory was a module-level Map — a RELOAD dropped it and the whole
//    storm ran again. Misses are mirrored to localStorage, which a reload
//    keeps; the Map stays as the fast path.
// 2. Nothing declared the endpoint sick: the batch paced through all 46
//    tokens while every single answer was a network failure. Two
//    CONSECUTIVE network failures (throw, or 5xx/429) open a cooldown —
//    the rest of the batch is remembered as misses without a request. A
//    404 is an ANSWER ("not listed"), not an outage, so it never counts.
const LOGO_MISS_TTL = 5 * 60 * 1000;
const LOGO_MISS_STORE = 'bear.logoMisses';
const logoMisses = new Map();               // logo key → epoch ms of the miss
let logoQueue = Promise.resolve();          // one paced queue for the whole app
let cgSickUntil = 0;                        // endpoint cooldown (epoch ms)

function readStoredMisses() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOGO_MISS_STORE) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeStoredMisses(misses) {
  try { localStorage.setItem(LOGO_MISS_STORE, JSON.stringify(misses)); }
  catch { /* private mode / quota — the in-memory copy still gates this session */ }
}

function recordMiss(key) {
  const at = Date.now();
  logoMisses.set(key, at);
  const stored = readStoredMisses();
  stored[key] = at;
  writeStoredMisses(stored);
}

function missedRecently(key) {
  let at = logoMisses.get(key);
  if (at === undefined) {
    at = readStoredMisses()[key];           // the memory a reload keeps
    if (typeof at === 'number') logoMisses.set(key, at);
  }
  if (!at) return false;
  if (Date.now() - at > LOGO_MISS_TTL) {
    logoMisses.delete(key);
    const stored = readStoredMisses();
    if (stored[key]) { delete stored[key]; writeStoredMisses(stored); }
    return false;
  }
  return true;
}

/** Test hook: forget the short-lived miss memory (tests reset the rest). */
export function resetLogoMisses() {
  logoMisses.clear();
  cgSickUntil = 0;
  try { localStorage.removeItem(LOGO_MISS_STORE); } catch { /* private mode */ }
}

export function ensureTokenLogos(tokens, chainId) {
  const platform = COINGECKO_PLATFORMS[Number(chainId)] || null;
  const missing = (tokens || []).filter((t) => t && t.symbol
    && !getCachedLogo(logoKeyFor(t)) && !missedRecently(logoKeyFor(t)));
  if (!missing.length) return Promise.resolve();
  const job = logoQueue.then(async () => {
    try {
      let consecutiveFailures = 0;
      for (let i = 0; i < missing.length; i++) {
        const t = missing[i];
        // Endpoint declared sick (or still cooling down): remember the rest
        // as misses instead of asking — the storm stop.
        if (consecutiveFailures >= 2 || Date.now() < cgSickUntil) {
          recordMiss(logoKeyFor(t));
          continue;
        }
        const address = String(t.address || '').trim();
        let url = null;
        let failed = false;
        if (address) {
          if (platform) { // unknown chain: no truthful lookup
            const r = await fetchContractLogo(address, platform);
            url = r.url; failed = r.failed;
          }
        } else if (!MANUAL_NATIVE_SYMS.has(String(t.symbol).toLowerCase())) {
          const r = await fetchSymbolLogo(t.symbol);
          url = r.url; failed = r.failed;
        }
        const key = logoKeyFor(t);
        if (url) { cacheLogo(key, url); logoMisses.delete(key); consecutiveFailures = 0; }
        else {
          recordMiss(key);
          if (failed) {
            if (++consecutiveFailures >= 2) cgSickUntil = Date.now() + LOGO_MISS_TTL;
          } else consecutiveFailures = 0;   // a 404 is an answer, not an outage
        }
        if (i < missing.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
    } catch { /* never throws — a stray storage error leaves the default mark */ }
  });
  logoQueue = job.catch(() => { /* one bad batch must not wedge the queue */ });
  return job;
}

// ── network SVG logos ──
// Extracted from app.js so the network modal and every network picker render
// the SAME brand marks — the Bridge chain pickers showed the raw emoji
// .icon field instead, which never matched the list. One renderer, by construction.
export function getNetworkLogo(name, size = 24) {
  const n = (name || '').toLowerCase();
  // Ethereum — blue diamond
  if (n === 'ethereum' || n === 'eth') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L5 12l7 10 7-10z" fill="#627EEA"/><path d="M12 2L5 12l7 10" fill="#8B9FE8" opacity="0.7"/></svg>`;
  }
  // Sepolia — blue diamond with S
  if (n === 'sepolia') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L5 12l7 10 7-10z" fill="#627EEA"/><path d="M12 2L5 12l7 10" fill="#8B9FE8" opacity="0.7"/><text x="12" y="15" text-anchor="middle" fill="white" font-size="8" font-weight="800" font-family="Arial">S</text></svg>`;
  }
  // Arbitrum — blue circle with A chevron
  if (n.includes('arbitrum')) {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#28A0F0"/><path d="M8 16l4-10 4 10" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 13h5" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round"/>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Optimism — red circle with OP
  if (n.includes('optimism') || n === 'op mainnet' || n === 'op sepolia') {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#FF0420"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="8" font-weight="800" font-family="Arial">OP</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Base — blue circle with B
  if (n === 'base' || n === 'base sepolia') {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#0052FF"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="9" font-weight="800" font-family="Arial">B</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Polygon — purple hexagon
  if (n.includes('polygon') || n === 'amoy') {
    const isTest = n.includes('amoy');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="12,1 21,6.5 21,17.5 12,23 3,17.5 3,6.5" fill="#8247E5"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="7" font-weight="800" font-family="Arial">POL</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // BSC — yellow diamond
  if (n.includes('bnb') || n.includes('bsc')) {
    const isTest = n.includes('testnet');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L2 12l10 10 10-10z" fill="#F0B90B"/><path d="M8 9h8l-4 6z" fill="#2D2A32"/><path d="M8 9l4-4 4 4" fill="none" stroke="#2D2A32" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 15l4 4 4-4" fill="none" stroke="#2D2A32" stroke-width="1.5" stroke-linejoin="round"/>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Avalanche — red triangle
  if (n.includes('avalanche')) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="12,2 2,22 22,22" fill="#E84142"/><text x="12" y="18" text-anchor="middle" fill="white" font-size="7" font-weight="800" font-family="Arial">AVAX</text></svg>`;
  }
  // Custom / unknown — satellite icon
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="10" fill="#9B5DE5"/><circle cx="12" cy="12" r="4" fill="white"/><line x1="12" y1="2" x2="12" y2="6" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="18" x2="12" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="2" y1="12" x2="6" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="18" y1="12" x2="22" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}
