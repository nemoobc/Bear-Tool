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
};

export function readLogoCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { return {}; }
}

export function getCachedLogo(sym) {
  const e = readLogoCache()[(sym || '').toLowerCase()];
  return e && Date.now() - e.ts < TTL ? e.url : null;
}

export function cacheLogo(sym, url) {
  try {
    const c = readLogoCache();
    c[(sym || '').toLowerCase()] = { url, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* private mode / quota — the mark fallback covers it */ }
}

// `uid` must differ per rendered instance: the marks use SVG <linearGradient>
// ids, and two marks sharing an id on one page makes the first definition win
// for both, so a row of tokens ends up tinted with the wrong colour.
let counter = 0;
const nextUid = () => `tk${(++counter).toString(36)}${Math.floor(performance.now() % 1e6).toString(36)}`;

function markSvg(sym, size) {
  const s = (sym || '').toLowerCase();
  const m = MARKS[s];
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
  if (remote) {
    const url = getCachedLogo(sym);
    if (url) {
      // Falls back to the generated mark if the cached image is dead, so a
      // stale URL degrades instead of showing a broken-image icon.
      return `<img class="token-logo-img token-mark" data-mark-fallback="${escapeHtml(sym || '')}" src="${escapeHtml(url)}" `
        + `alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
    }
  }
  return markSvg(sym, size);
}

/** Attach the onerror fallback to every rendered logo inside a root. */
export function guardTokenLogos(root) {
  if (!root) return;
  root.querySelectorAll('img.token-logo-img').forEach((img) => {
    if (img.dataset.guarded) return;
    img.dataset.guarded = '1';
    img.addEventListener('error', () => {
      img.outerHTML = markSvg(img.dataset.markFallback || '', Number(img.getAttribute('width')) || 24);
    }, { once: true });
  });
}

export { markSvg as tokenMarkSvg };
