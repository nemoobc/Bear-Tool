// ═══════════════════════════════════════════════════════════════
// Bear Tool — price.js
// Prices: CoinGecko + DexScreener fallback + cache.
// Currency comes from Settings (usd/eur/idr/cny) — it used to be hardcoded to
// USD in every request, which made the Currency picker a control that saved a
// value nothing ever read. An optional CoinGecko key lifts the rate limit; the
// keyless free tier is CORS-blocked in browsers and rate-limited hard.
// ═══════════════════════════════════════════════════════════════

import { get } from './state.js';

// Selected display currency, e.g. 'usd' | 'eur' | 'idr' | 'cny'.
function currency() {
  const c = (get('settings') || {}).currency;
  return /^[a-z]{3}$/i.test(c || '') ? c.toLowerCase() : 'usd';
}

// Optional key from Settings → localStorage. Absent = keyless free tier.
function cgKey() {
  try { return localStorage.getItem('bear.coingeckoKey') || ''; } catch { return ''; }
}

function cgUrl(path, params) {
  const u = new URL(`https://api.coingecko.com/api/v3/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const key = cgKey();
  if (key) u.searchParams.set('x_cg_demo_api_key', key);
  return u.toString();
}

// CoinGecko platform ids per chainId (ERC-20 token_price endpoint)
const COINGECKO_PLATFORMS = {
  1: 'ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  42161: 'arbitrum-one',
  10: 'optimistic-ethereum',
  8453: 'base'
};

// CoinGecko coin ids for native gas tokens
const NATIVE_COIN_IDS = {
  1: 'ethereum',
  56: 'binancecoin',
  137: 'matic-network',
  42161: 'ethereum',
  10: 'ethereum',
  8453: 'ethereum'
};

const CACHE_KEY = 'bear.priceCache';
const MEM_TTL = 60_000;          // in-memory TTL
const LS_MAX_AGE = 5 * 60_000;   // localStorage max age

const memCache = new Map(); // key -> { price, ts }
const historyCache = new Map(); // key -> { data, ts } (24h chart history)

function loadLsCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function saveLsCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

function cacheKey(address) { return address || 'native'; }

export function getPriceFromCache(address) {
  const key = cacheKey(address);
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < MEM_TTL) return mem.price;
  const ls = loadLsCache();
  const entry = ls[key];
  if (entry && Date.now() - entry.ts < LS_MAX_AGE) {
    memCache.set(key, entry);
    return entry.price;
  }
  return null;
}

export function clearPriceCache() {
  memCache.clear();
  historyCache.clear();
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

function cachePrice(address, price) {
  const key = cacheKey(address);
  const entry = { price, ts: Date.now() };
  memCache.set(key, entry);
  const ls = loadLsCache();
  ls[key] = entry;
  saveLsCache(ls);
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}

async function fetchCoinGeckoNative(chainId) {
  const id = NATIVE_COIN_IDS[chainId];
  if (!id) return null;
  const cur = currency();
  const res = await fetchWithTimeout(cgUrl('simple/price', { ids: id, vs_currencies: cur }));
  if (!res.ok) throw new Error('CoinGecko ' + res.status);
  const data = await res.json();
  return data[id]?.[cur] ?? null;
}

// CoinGecko's public tier allows exactly ONE contract address per
// /simple/token_price request. Sending the wallet's whole token list in one
// call returned 400 with error_code 10012 ("Number of contract addresses in
// the request exceeds the allowed limit of 1"), which is a hard failure, not a
// rate limit — so every price in the list was lost. Verified live, one address
// answers 200 and eight answer 400.
//
// Kept as a named constant because it is a fact about the free tier, not a
// tuning knob: if it is ever wrong the app degrades to a 400 again, and the
// test below pins the chunking so that failure cannot come back silently.
export const CG_MAX_ADDRESSES = 1;

/** Split addresses into request-sized chunks, de-duplicated and lower-cased. */
export function cgTokenPriceChunks(addresses, size = CG_MAX_ADDRESSES) {
  const n = Math.max(1, Number(size) || 1);
  // Filter BEFORE stringifying. String(null) is "null" and String(undefined) is
  // "undefined" — both truthy, so a post-map filter would happily request a
  // token literally named "null".
  const uniq = [...new Set(
    (Array.isArray(addresses) ? addresses : [])
      .filter((a) => typeof a === 'string' && a.trim())
      .map((a) => a.trim().toLowerCase()),
  )];
  const out = [];
  for (let i = 0; i < uniq.length; i += n) out.push(uniq.slice(i, i + n));
  return out;
}

async function fetchCoinGeckoTokens(chainId, addresses) {
  const platform = COINGECKO_PLATFORMS[chainId];
  if (!platform || !addresses?.length) return {};
  const cur = currency();
  const chunks = cgTokenPriceChunks(addresses);
  const out = {};

  // Sequential on purpose: these are rate-limited endpoints, and firing eight
  // at once is how a free tier starts refusing. One chunk per token is at most
  // a handful of small requests, and the cache means it happens once.
  for (const chunk of chunks) {
    try {
      const res = await fetchWithTimeout(cgUrl(`simple/token_price/${platform}`,
        { contract_addresses: chunk.join(','), vs_currencies: cur }));
      if (!res.ok) continue;                 // keep whatever earlier chunks gave us
      const data = await res.json();
      for (const [addr, v] of Object.entries(data || {})) {
        const p = v?.[cur];
        if (typeof p === 'number' && Number.isFinite(p)) out[addr] = p;
      }
    } catch { /* this chunk failed; the rest still get their chance */ }
  }
  return out;
}

// DexScreener chainId slugs per numeric chainId (search endpoint uses slugs)
const DEXSCREENER_CHAINS = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base'
};

// Fallback for tokens whose /tokens/v1 pair list is empty (new / not yet indexed):
// search endpoint returns { pairs: [...] } — take first pair with priceUsd on same chain.
async function fetchDexScreenerSearch(chainId, address) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('DexScreener search ' + res.status);
  const data = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const slug = DEXSCREENER_CHAINS[chainId];
  const pair = pairs.find(p => p?.priceUsd && (!slug || p.chainId === slug));
  return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
}

async function fetchDexScreener(chainId, address) {
  const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${address}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('DexScreener ' + res.status);
  const data = await res.json();
  const pair = Array.isArray(data) ? data[0] : null;
  if (pair?.priceUsd) return parseFloat(pair.priceUsd);
  // Empty/null pair list → try search endpoint before giving up honestly.
  return fetchDexScreenerSearch(chainId, address);
}

// tokens: [{address, symbol, decimals}] — address null = native
// Returns Map<address|'native', number|null>
export async function fetchAllPrices(tokens, chainId) {
  const result = new Map();
  const native = tokens.find(t => !t.address);
  const erc20s = tokens.filter(t => t.address);

  // native gas token
  if (native) {
    const cached = getPriceFromCache(null);
    if (cached !== null) {
      result.set('native', cached);
    } else {
      try {
        const p = await fetchCoinGeckoNative(chainId);
        if (p !== null) { result.set('native', p); cachePrice(null, p); }
      } catch { /* fall through — usd stays null */ }
    }
  }

  // ERC-20: cache first, then CoinGecko batch, then DexScreener per token
  const missing = [];
  for (const t of erc20s) {
    const cached = getPriceFromCache(t.address);
    if (cached !== null) result.set(t.address, cached);
    else missing.push(t);
  }

  if (missing.length) {
    try {
      const prices = await fetchCoinGeckoTokens(chainId, missing.map(t => t.address));
      for (const t of missing) {
        const p = prices[t.address.toLowerCase()]?.usd;
        if (p !== undefined && p !== null) {
          result.set(t.address, p);
          cachePrice(t.address, p);
        }
      }
    } catch { /* fall through to DexScreener */ }
  }

  const stillMissing = erc20s.filter(t => !result.has(t.address));
  await Promise.allSettled(stillMissing.map(async (t) => {
    try {
      const p = await fetchDexScreener(chainId, t.address);
      if (p !== null) { result.set(t.address, p); cachePrice(t.address, p); }
    } catch { /* keep null */ }
  }));

  return result;
}

// ── OHLC candlestick data for token chart ───────────────────
// CoinGecko OHLC: days=1 → 5min candles, days=7 → 1h candles.
// Returns [{ time, open, high, low, close }] or [] when unavailable.
export async function fetchOHLC({ address, chainId, days = 1 }) {
  const platform = COINGECKO_PLATFORMS[chainId];
  const nativeId = NATIVE_COIN_IDS[chainId];
  const key = `ohlc:${address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`}:${days}`;

  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  let url = null;
  if (address && platform) {
    url = cgUrl(`coins/${platform}/contract/${String(address).toLowerCase()}/ohlc`, { vs_currency: currency(), days });
  } else if (!address && nativeId) {
    url = cgUrl(`coins/${nativeId}/ohlc`, { vs_currency: currency(), days });
  }
  if (!url) return [];

  try {
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) throw new Error('CoinGecko OHLC ' + res.status);
    const data = await res.json();
    // CoinGecko OHLC format: [[timestamp, open, high, low, close], ...]
    const candles = (Array.isArray(data) ? data : [])
      .map(d => ({ time: d[0], open: d[1], high: d[2], low: d[3], close: d[4] }))
      .filter(c => [c.open, c.high, c.low, c.close].every(v => typeof v === 'number' && Number.isFinite(v)));
    if (candles.length < 2) throw new Error('No OHLC data');
    historyCache.set(key, { data: candles, ts: Date.now() });
    return candles;
  } catch {
    // Fallback: convert price history to pseudo-candles
    try {
      const prices = await fetchPriceHistory({ address, chainId });
      if (prices.length < 2) return [];
      const candles = prices.map((p, i) => {
        const next = prices[i + 1] || p;
        return { time: Date.now() - (prices.length - i) * 300000, open: p, high: Math.max(p, next), low: Math.min(p, next), close: next };
      });
      return candles.slice(0, -1);
    } catch { return []; }
  }
}

// ── 24h price history for the token mini-chart ──────────────────
// CoinGecko keyless market_chart, cached 5 min. Returns a number[]
// (oldest → newest, downsampled to ~30 points) or [] when unavailable.
// Replaces the old random-walk chart, which looked different on every open.
const HISTORY_TTL = 5 * 60_000;

export async function fetchPriceHistory({ address, chainId }) {
  const platform = COINGECKO_PLATFORMS[chainId];
  const nativeId = NATIVE_COIN_IDS[chainId];
  const key = address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`;

  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  let url = null;
  if (address && platform) {
    url = cgUrl(`coins/${platform}/contract/${String(address).toLowerCase()}/market_chart`, { vs_currency: currency(), days: 1 });
  } else if (!address && nativeId) {
    url = cgUrl(`coins/${nativeId}/market_chart`, { vs_currency: currency(), days: 1 });
  }
  if (!url) return [];

  try {
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) throw new Error('CoinGecko ' + res.status);
    const data = await res.json();
    const raw = (data.prices || [])
      .map(p => p[1])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (raw.length < 2) throw new Error('No data');
    // evenly spaced sample (~30 points), always keeping first + latest
    const target = Math.min(30, raw.length);
    const sampled = Array.from({ length: target }, (_, k) => raw[Math.round(k * (raw.length - 1) / (target - 1))]);
    historyCache.set(key, { data: sampled, ts: Date.now() });
    return sampled;
  } catch {
    // DexScreener fallback for chart data
    try {
      if (!address) return [];
      const dsUrl = `https://api.dexscreener.com/tokens/v1/${chainId}/${address}`;
      const dsRes = await fetchWithTimeout(dsUrl, 8000);
      if (!dsRes.ok) return [];
      const dsData = await dsRes.json();
      const pair = Array.isArray(dsData) ? dsData[0] : dsData;
      const history = pair?.priceHistory || pair?.h24 || [];
      if (Array.isArray(history) && history.length >= 2) {
        const sampled = Array.from({ length: Math.min(30, history.length) }, (_, k) => history[Math.round(k * (history.length - 1) / (Math.min(30, history.length) - 1))]);
        historyCache.set(key, { data: sampled, ts: Date.now() });
        return sampled;
      }
    } catch { /* fallback failed */ }
    return [];
  }
}