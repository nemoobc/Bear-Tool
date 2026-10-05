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
    // Looked up by CONTRACT when one is given, so a counterfeit ticker cannot
    // reach the real project's mark. The symbol is still what the generated
    // fallback draws.
    const url = getCachedLogo(logoKeyFor({ address: opt.address, symbol: sym }));
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
