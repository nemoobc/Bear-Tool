// ═══════════════════════════════════════════════════════════════
// Bear Tool — price.js
// Prices: DexScreener (tokens) + Binance (majors) + DefiLlama (fallback),
// FX from Frankfurter, charts from Binance klines / GeckoTerminal.
//
// WHY NOT COINGECKO (replaced 2026-10-11, user: "api coingecko ganti, cari
// yang no limit unlimited"): the keyless CoinGecko tier answers ~10-30 calls
// a minute and, when it throttles, it answers WITHOUT CORS headers — so the
// browser reported a CORS failure, the price was lost, and the console filled
// with noise on every dashboard load. Every source below is KEYLESS and either
// documents a generous limit or none at all:
//   DexScreener   token + pair prices, ~300 req/min documented, CORS-open
//   Binance       spot tickers/klines, weight-based (~6000/min), CORS-open
//   DefiLlama     coins API, keyless, no documented cap, CORS-open
//   Frankfurter   ECB FX reference rates, keyless, no cap
//   GeckoTerminal charts for tokens Binance does not list (30/min, KEYLESS)
//
// Currency comes from Settings (usd/eur/idr/cny) — applied once, at the edge,
// by fmtUsd. Every number this module hands out is USD.
// ═══════════════════════════════════════════════════════════════

import { get } from './state.js';
import { setMoneyRate, usdToDisplay } from './ui.js';

// Selected display currency, e.g. 'usd' | 'eur' | 'idr' | 'cny'.
function currency() {
  const c = (get('settings') || {}).currency;
  return /^[a-z]{3}$/i.test(c || '') ? c.toLowerCase() : 'usd';
}

// ── chain registry ────────────────────────────────────────────────────────
// ONE row per bundled network: every source's id, the Binance symbol for the
// native gas token (null = not listed there), and the chain's wrapped-native
// contract — the honest proxy for "the native coin's price/chart" on sources
// that only speak contracts.
const CHAINS = {
  1:      { dex: 'ethereum', llama: 'ethereum', gt: 'eth',          binance: 'ETHUSDT',  wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  56:     { dex: 'bsc',      llama: 'bsc',      gt: 'bsc',          binance: 'BNBUSDT',  wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  137:    { dex: 'polygon',  llama: 'polygon',  gt: 'polygon_pos',  binance: 'POLUSDT',  wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
  42161:  { dex: 'arbitrum', llama: 'arbitrum', gt: 'arbitrum',     binance: 'ETHUSDT',  wrapped: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
  10:     { dex: 'optimism', llama: 'optimism', gt: 'optimism',     binance: 'ETHUSDT',  wrapped: '0x4200000000000000000000000000000000000006' },
  8453:   { dex: 'base',     llama: 'base',     gt: 'base',         binance: 'ETHUSDT',  wrapped: '0x4200000000000000000000000000000000000006' },
  43114:  { dex: 'avalanche',llama: 'avax',     gt: 'avax',         binance: 'AVAXUSDT', wrapped: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' },
  100:    { dex: 'gnosis',   llama: 'xdai',     gt: 'xdai',         binance: null,       wrapped: '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d' },
  59144:  { dex: 'linea',    llama: 'linea',    gt: 'linea',        binance: 'ETHUSDT',  wrapped: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f' },
  534352: { dex: 'scroll',   llama: 'scroll',   gt: 'scroll',       binance: 'ETHUSDT',  wrapped: '0x5300000000000000000000000000000000000004' },
  81457:  { dex: 'blast',    llama: 'blast',    gt: 'blast',        binance: 'ETHUSDT',  wrapped: '0x4300000000000000000000000000000000000004' },
  324:    { dex: 'zksync',   llama: 'era',      gt: 'zksync',       binance: 'ETHUSDT',  wrapped: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91' },
  42220:  { dex: 'celo',     llama: 'celo',     gt: 'celo',         binance: 'CELOUSDT', wrapped: '0x471ece3750da237f93b8e339c536989b8978a438' },
  146:    { dex: 'sonic',    llama: 'sonic',    gt: 'sonic',        binance: null,       wrapped: '0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38' },
  5000:   { dex: 'mantle',   llama: 'mantle',   gt: 'mantle',       binance: 'MNTUSDT',  wrapped: '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8' }
};

const chainMeta = (chainId) => CHAINS[Number(chainId)] || null;

/**
 * The DexScreener chain slug for a chain id, or null for a chain DexScreener
 * does not index. Exported because the token-image lookup (js/token-logo.js)
 * speaks to the same host: one registry, not a second copy that drifts.
 */
export function dexChainSlug(chainId) {
  const meta = chainMeta(chainId);
  return meta ? meta.dex : null;
}

// ── the rate between the canonical unit and the one on screen ──
//
// Every price this module fetches, caches or returns is USD. The conversion
// happens once, here, and nowhere else — asking each source for the display
// currency produced a list whose top row was in rupiah and whose rest were in
// dollars. USD is 1:1 and is never fetched.
const RATE_KEY = 'bear.usdRate';
const RATE_TTL = 30 * 60_000;

/** Push the rate into the formatter so every `fmtUsd` in the app agrees. */
function publishRate(cur, rate) {
  setMoneyRate(cur, rate);
}

function cachedRate(cur) {
  try {
    const e = JSON.parse(localStorage.getItem(RATE_KEY) || 'null');
    if (e && e.cur === cur && Number.isFinite(e.rate) && e.rate > 0
        && Date.now() - e.ts < RATE_TTL) return e.rate;
  } catch { /* private mode */ }
  return null;
}

function saveRate(cur, rate) {
  try { localStorage.setItem(RATE_KEY, JSON.stringify({ cur, rate, ts: Date.now() })); }
  catch { /* private mode */ }
}

// Frankfurter publishes the ECB's reference rates: keyless, no cap, CORS-open.
// open.er-api.com is the fallback — another keyless, cap-free host.
async function fetchUsdRateFromFrankfurter(cur) {
  const res = await fetchWithTimeout(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${cur.toUpperCase()}`, 8000);
  if (!res.ok) throw new Error('frankfurter ' + res.status);
  const d = await res.json();
  const rate = Number(d?.rates?.[cur.toUpperCase()]);
  if (!(Number.isFinite(rate) && rate > 0)) throw new Error('frankfurter rate missing');
  return rate;
}

async function fetchUsdRateFromErApi(cur) {
  const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD', 8000);
  if (!res.ok) throw new Error('er-api ' + res.status);
  const d = await res.json();
  const rate = Number(d?.rates?.[cur.toUpperCase()]);
  if (!(Number.isFinite(rate) && rate > 0)) throw new Error('er-api rate missing');
  return rate;
}

/**
 * Make sure the formatter knows how to turn USD into the selected currency.
 * Never throws and never blocks: a failed lookup leaves 1:1, which shows the
 * right number with the wrong currency rather than an empty wallet.
 */
export async function ensureUsdRate() {
  const cur = currency();
  if (cur === 'usd') { publishRate('usd', 1); return 1; }
  const hit = cachedRate(cur);
  if (hit !== null) { publishRate(cur, hit); return hit; }
  for (const source of [fetchUsdRateFromFrankfurter, fetchUsdRateFromErApi]) {
    try {
      const rate = await source(cur);
      saveRate(cur, rate);
      publishRate(cur, rate);
      return rate;
    } catch { /* try the next keyless host */ }
  }
  publishRate(cur, 1);
  return 1;
}

/** Drop the cached rate, so the next read fetches the one now wanted. */
export function clearUsdRate() {
  try { localStorage.removeItem(RATE_KEY); } catch { /* private mode */ }
}

const CACHE_KEY = 'bear.priceCache';
const MEM_TTL = 60_000;          // in-memory TTL
const LS_MAX_AGE = 5 * 60_000;   // localStorage max age

const memCache = new Map(); // key -> { price, ts }
const historyCache = new Map(); // key -> { data, ts } (chart data)

function loadLsCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function saveLsCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// Address keys are case-INSENSITIVE (0xAbC === 0xabc on-chain): one address
// written in checksum case and read in lower case must hit the same entry.
// The native coin has NO address, and its price differs per chain (BNB is not
// ETH) — so the native entry is namespaced by chainId. It used to be a single
// "native" slot, which meant the first chain to answer priced every other
// chain's gas token.
function cacheKey(address, chainId) {
  if (address) return String(address).toLowerCase();
  return `native:${Number(chainId) || 0}`;
}

export function getPriceFromCache(address, chainId) {
  const key = cacheKey(address, chainId);
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

function cachePrice(address, price, chainId) {
  const key = cacheKey(address, chainId);
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

// ── source cooldown (HTTP 429) ───────────────────────────────────────────
// GeckoTerminal is the only KEYLESS source here with a documented cap
// (30 calls/min). A 429 must not poison the next request — and it must stay
// distinguishable from "this token has no chart", or the modal lies about
// someone's coin exactly when the data does exist.
const COOLDOWN_MS = 60_000;
const COOLDOWN_MAX_MS = 15 * 60_000;
const COOLDOWN_STORE = 'bear.sourceCooldownUntil';
const COOLDOWN_STRIKES_STORE = 'bear.sourceCooldownStrikes';
let cooldownUntil = 0;
let strikes = 0;   // consecutive failed probes; grows the backoff

/** The one error that means "the limit, not the token". */
export function rateLimitError() {
  return new Error('Price source rate-limited (HTTP 429) — cooldown active');
}

export function isRateLimit(e) {
  return /rate-limit|429/.test(String((e && e.message) || ''));
}

// The cooldown check reads PERSISTED state too: a reload drops the module
// variable, and without this the very next boot re-ran the whole failing
// batch. A cooldown is a fact about the ENDPOINT, not about the page.
// The backoff GROWS per failed probe (1m → 2m → … → 15m cap): a probe that
// fails twice in a row is unlikely to succeed a minute later; a probe that
// SUCCEEDS resets the ladder.
function cooldownActive() {
  if (Date.now() < cooldownUntil) return true;
  try {
    const until = Number(localStorage.getItem(COOLDOWN_STORE) || 0);
    if (until > Date.now()) { cooldownUntil = until; return true; }
  } catch { /* private mode — in-memory only */ }
  return false;
}

function openCooldown() {
  strikes += 1;
  const step = Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * (2 ** (strikes - 1)));
  cooldownUntil = Date.now() + step;
  try {
    localStorage.setItem(COOLDOWN_STORE, String(cooldownUntil));
    localStorage.setItem(COOLDOWN_STRIKES_STORE, String(strikes));
  } catch { /* private mode — in-memory still covers this session */ }
}

function noteSuccess() {
  if (!strikes) return;
  strikes = 0;                     // healthy again: the ladder starts over
  try { localStorage.removeItem(COOLDOWN_STRIKES_STORE); } catch { /* private mode */ }
}

// Strikes must survive a reload too, or every boot restarts at 1 minute.
function strikeCount() {
  if (strikes) return strikes;
  try {
    const n = Number(localStorage.getItem(COOLDOWN_STRIKES_STORE) || 0);
    if (Number.isFinite(n) && n > 0) strikes = n;
  } catch { /* private mode */ }
  return strikes;
}

/** Test hook: forget the endpoint cooldown (tests reset between cases). */
export function resetCgCooldown() {
  cooldownUntil = 0;
  strikes = 0;
  try {
    localStorage.removeItem(COOLDOWN_STORE);
    localStorage.removeItem(COOLDOWN_STRIKES_STORE);
  } catch { /* private mode */ }
}

/** A capped source (GeckoTerminal): honours the cooldown and opens one on 429. */
async function cappedFetch(url, timeoutMs = 10000) {
  if (cooldownActive()) throw rateLimitError();
  strikeCount();                     // hydrate the persisted ladder before judging
  let res;
  try {
    res = await fetchWithTimeout(url, timeoutMs);
  } catch (e) {
    openCooldown();
    throw e;
  }
  if (res.status === 429) {
    openCooldown();
    throw rateLimitError();
  }
  noteSuccess();
  return res;
}

// ── native gas token ────────────────────────────────────────────────────
// Binance quotes every major in USDT (≈USD) in ONE batch request; DefiLlama's
// coins API prices the chain's wrapped-native contract when Binance does not
// list the coin (or refuses the caller's region: api.binance.com answers 451
// in some countries).
async function fetchNativeFromBinance(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error('Binance ' + res.status);
  const d = await res.json();
  const p = Number(d?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
}

async function fetchFromDefiLlama(keys) {
  if (!keys.length) return {};
  // The colon is the API's own separator ("ethereum:0xabc") — it must stay
  // literal in the path. Encoding the whole key turned it into %3A, which the
  // documented shape does not use.
  const path = keys.map((k) => String(k).split(':').map(encodeURIComponent).join(':')).join(',');
  const url = `https://coins.llama.fi/prices/current/${path}`;
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error('DefiLlama ' + res.status);
  const d = await res.json();
  const out = {};
  for (const [id, v] of Object.entries(d?.coins || {})) {
    const p = Number(v?.price);
    if (Number.isFinite(p) && p > 0) out[id] = p;
  }
  return out;
}

async function fetchNativePrice(chainId) {
  const meta = chainMeta(chainId);
  if (!meta) return null;
  if (meta.binance) {
    try {
      const p = await fetchNativeFromBinance(meta.binance);
      if (p !== null) return p;
    } catch { /* Binance blocked/absent — the keyless fallback is next */ }
  }
  try {
    const llama = await fetchFromDefiLlama([`${meta.llama}:${meta.wrapped}`]);
    return llama[`${meta.llama}:${meta.wrapped}`] ?? null;
  } catch {
    return null;
  }
}

// ── ERC-20 token prices ─────────────────────────────────────────────────
// DexScreener's /tokens/v1/{chainId}/{addresses} takes a COMMA-SEPARATED list
// (up to 30) and answers every pair for those tokens — one request for the
// whole wallet instead of one per token. Each pair carries priceUsd and
// liquidity; the deepest pool is the honest price (a dust pool can be
// manipulated to any number).
export const TOKEN_PRICE_BATCH = 25;   // DexScreener documents up to 30; 25 keeps the URL sane

/** Split addresses into request-sized chunks, de-duplicated and lower-cased. */
export function tokenPriceChunks(addresses, size = TOKEN_PRICE_BATCH) {
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

// Pick the best pair per token: the deepest pool wins. `tokens/v1` answers
// newest-first, which is NOT the same thing as "the real market".
function bestPricesFromPairs(pairs, chainId) {
  const meta = chainMeta(chainId);
  const out = {};
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const addr = String(p?.baseToken?.address || '').toLowerCase();
    const price = Number(p?.priceUsd);
    if (!addr || !Number.isFinite(price) || price <= 0) continue;
    if (meta && p?.chainId && String(p.chainId) !== meta.dex) continue;   // same chain only
    const liq = Number(p?.liquidity?.usd) || 0;
    const prev = out[addr];
    if (!prev || liq > prev.liq) out[addr] = { price, liq };
  }
  const flat = {};
  for (const [addr, v] of Object.entries(out)) flat[addr] = v.price;
  return flat;
}

async function fetchDexScreenerBatch(chainId, addresses) {
  const meta = chainMeta(chainId);
  if (!meta || !addresses.length) return {};
  const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${addresses.join(',')}`;
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) throw new Error('DexScreener ' + res.status);
  const data = await res.json();
  return bestPricesFromPairs(data, chainId);
}

// Fallback for tokens whose /tokens/v1 pair list is empty (new / not yet
// indexed): search returns { pairs: [...] } — take the deepest pair on chain.
async function fetchDexScreenerSearch(chainId, address) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('DexScreener search ' + res.status);
  const data = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const meta = chainMeta(chainId);
  const hit = pairs
    .filter((p) => p && p.priceUsd && (!meta || p.chainId === meta.dex))
    .sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
  const p = Number(hit?.priceUsd);
  return Number.isFinite(p) && p > 0 ? p : null;
}

async function fetchTokenPrices(chainId, addresses) {
  const meta = chainMeta(chainId);
  if (!meta || !addresses.length) return {};
  const out = {};
  for (const chunk of tokenPriceChunks(addresses)) {
    try {
      const prices = await fetchDexScreenerBatch(chainId, chunk);
      for (const [addr, price] of Object.entries(prices)) out[addr] = price;
    } catch { /* this chunk goes to the DefiLlama retry below */ }
  }
  const missing = addresses
    .map((a) => String(a).toLowerCase())
    .filter((a) => out[a] === undefined);
  // DefiLlama is a different host with its own (uncapped) budget — worth one
  // batched shot for everything DexScreener did not price.
  if (missing.length) {
    try {
      const keys = missing.map((a) => `${meta.llama}:${a}`);
      const llama = await fetchFromDefiLlama(keys);
      for (const a of missing) {
        const p = llama[`${meta.llama}:${a}`];
        if (p !== undefined) out[a] = p;
      }
    } catch { /* honest nulls below */ }
  }
  return out;
}

// tokens: [{address, symbol, decimals}] — address null = native
// Returns Map<address|'native', number|null>
export async function fetchAllPrices(tokens, chainId) {
  const result = new Map();
  const native = tokens.find(t => !t.address);
  const erc20s = tokens.filter(t => t.address);
  // Before the prices, the rate that turns them into money the user reads. It
  // usually comes from cache, so this is not an extra request per refresh.
  await ensureUsdRate();

  // native gas token
  if (native) {
    const cached = getPriceFromCache(null, chainId);
    if (cached !== null) {
      result.set('native', cached);
    } else {
      try {
        const p = await fetchNativePrice(chainId);
        if (p !== null) { result.set('native', p); cachePrice(null, p, chainId); }
      } catch { /* fall through — usd stays null */ }
    }
  }

  // ERC-20: cache first, then the batched sources
  const missing = [];
  for (const t of erc20s) {
    const cached = getPriceFromCache(t.address, chainId);
    if (cached !== null) result.set(t.address, cached);
    else missing.push(t);
  }

  if (missing.length) {
    const prices = await fetchTokenPrices(chainId, missing.map(t => t.address));
    for (const t of missing) {
      const p = prices[String(t.address).toLowerCase()];
      if (typeof p === 'number' && Number.isFinite(p)) {
        result.set(t.address, p);
        cachePrice(t.address, p, chainId);
      }
    }
  }

  // Still nothing: the search endpoint, one token at a time (a new token can
  // be absent from the batched pair list while its pool is already indexed).
  const stillMissing = erc20s.filter(t => !result.has(t.address));
  await Promise.allSettled(stillMissing.map(async (t) => {
    try {
      const p = await fetchDexScreenerSearch(chainId, t.address);
      if (p !== null) { result.set(t.address, p); cachePrice(t.address, p, chainId); }
    } catch { /* keep null */ }
  }));

  return result;
}

// Merge OHLC candles down to ≤max WITHOUT throwing data away. The chart's
// old stride filter (keep every step-th index) silently dropped each
// skipped candle's open/high/low — a "24h" picture drawn from every other
// 30-min bar. Pairwise merge: open of the first, close of the last,
// max/min across both — same range, fewer candles, zero data loss
// (user, 2026-10-06: "candle nya sama semua" era fix).
export function fitCandles(candles, max = 60) {
  let list = Array.isArray(candles) ? candles : [];
  while (list.length > max) {
    const out = [];
    for (let i = 0; i < list.length; i += 2) {
      const a = list[i];
      const b = list[i + 1];
      if (!b) { out.push(a); break; }   // odd tail rides along untouched
      out.push({
        time: a.time,
        open: a.open,
        close: b.close,
        high: Math.max(a.high, b.high),
        low: Math.min(a.low, b.low),
      });
    }
    list = out;
  }
  return list;
}

// ── chart series ────────────────────────────────────────────────────────
// Two keyless sources, both able to distinguish the four ranges the chart
// offers (24h / 7d / 30d / 1y):
//   Binance klines    native gas tokens (ETH/BNB/POL/AVAX/MNT/CELO…)
//   GeckoTerminal     tokens Binance does not list, by pool
// The old CoinGecko series could not tell 5m from 1h (all four buttons fetched
// days=1 — user, 2026-10-06: "chart time itu ga akurat candle nya sama
// semua"), so the ranges here are chosen to differ by construction.
const HISTORY_TTL = 5 * 60_000;

// 24h→30m, 7d→4h, 30d→12h, 1y→1w: same shape the chart had before, but the
// granularity is now requested explicitly instead of inferred from a cliff.
function binanceInterval(days) {
  if (days <= 1) return { interval: '30m', limit: 48 };
  if (days <= 7) return { interval: '4h', limit: 48 };
  if (days <= 30) return { interval: '12h', limit: 60 };
  return { interval: '1w', limit: 53 };
}

function gtTimeframe(days) {
  if (days <= 1) return { timeframe: 'hour', limit: 24 };
  if (days <= 7) return { timeframe: 'hour', limit: 168 };
  if (days <= 30) return { timeframe: 'day', limit: 30 };
  return { timeframe: 'day', limit: 365 };
}

async function binanceKlines(symbol, days) {
  const { interval, limit } = binanceInterval(days);
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error('Binance klines ' + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }))
    .filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0));
}

// GeckoTerminal needs a POOL id for OHLCV, so a token lookup is two calls:
// /tokens/{address}/pools (deepest first) then /pools/{pool}/ohlcv. Both
// keyless; only the capped one (ohlcv) rides the cooldown.
async function geckoTerminalKlines(chainId, address, days) {
  const meta = chainMeta(chainId);
  if (!meta || !address) return [];
  // BOTH GeckoTerminal calls ride the capped path: the whole host is limited
  // (30/min), and a network failure here must open the cooldown or every
  // page load re-runs the failing walk (the storm this module was built for).
  const poolsRes = await cappedFetch(
    `https://api.geckoterminal.com/api/v2/networks/${meta.gt}/tokens/${encodeURIComponent(String(address).toLowerCase())}/pools?page=1`, 10000);
  if (!poolsRes.ok) throw new Error('GeckoTerminal pools ' + poolsRes.status);
  const poolsJson = await poolsRes.json();
  const pool = (poolsJson?.data || [])[0];
  const poolAddress = pool?.attributes?.address || String(pool?.id || '').split('_').slice(1).join('_');
  if (!poolAddress) return [];
  const { timeframe, limit } = gtTimeframe(days);
  const ohlcvRes = await cappedFetch(
    `https://api.geckoterminal.com/api/v2/networks/${meta.gt}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}?aggregate=1&limit=${limit}&currency=usd&token=base`, 12000);
  if (!ohlcvRes.ok) throw new Error('GeckoTerminal ohlcv ' + ohlcvRes.status);
  const ohlcvJson = await ohlcvRes.json();
  const list = ohlcvJson?.data?.attributes?.ohlcv_list;
  // GeckoTerminal answers NEWEST FIRST — the chart reads oldest → newest.
  return (Array.isArray(list) ? list : [])
    .map((k) => ({ time: Number(k[0]) * 1000, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }))
    .filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0))
    .reverse();
}

// USD candles for a native coin or a token. [] = honest "no chart here".
async function marketCandles({ address, chainId, days = 1 }) {
  const meta = chainMeta(chainId);
  if (!meta) return [];
  if (!address) {
    if (!meta.binance) return [];
    try { return await binanceKlines(meta.binance, days); } catch { return []; }
  }
  try { return await geckoTerminalKlines(chainId, address, days); } catch (e) {
    if (isRateLimit(e)) throw e;      // the caller says "rate-limited", not "no data"
    return [];
  }
}

// ── OHLC candlestick data for the token chart ───────────────────────────
// Returns [{ time, open, high, low, close }] in the DISPLAY currency, or [].
export async function fetchOHLC({ address, chainId, days = 1 }) {
  await ensureUsdRate();
  const key = `ohlc:${address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`}:${days}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  const raw = await marketCandles({ address, chainId, days });
  if (raw.length < 2) return [];
  // Chart axes are plain numbers with no symbol, so the conversion has to
  // happen here or the chart would read in dollars while the balance beside it
  // reads in rupiah — two true numbers on one screen meaning different things.
  const shown = raw.map((c) => ({
    ...c,
    open: usdToDisplay(c.open),
    high: usdToDisplay(c.high),
    low: usdToDisplay(c.low),
    close: usdToDisplay(c.close)
  }));
  historyCache.set(key, { data: shown, ts: Date.now() });
  return shown;
}

// ── price history for the mini-chart ────────────────────────────────────
// The closes of the same keyless series, downsampled to ~30 points. Returns a
// number[] (oldest → newest) already in the display currency, or [].
export async function fetchPriceHistory({ address, chainId, days = 1 }) {
  await ensureUsdRate();
  const key = `hist:${address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`}:${days}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  const raw = await marketCandles({ address, chainId, days });
  const closes = raw.map((c) => c.close).filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 2) return [];
  // evenly spaced sample (~30 points), always keeping first + latest
  const target = Math.min(30, closes.length);
  const sampled = Array.from({ length: target }, (_, k) =>
    usdToDisplay(closes[Math.round(k * (closes.length - 1) / (target - 1))]));
  historyCache.set(key, { data: sampled, ts: Date.now() });
  return sampled;
}
