// ═══════════════════════════════════════════════════════════════
// Bear Tool — price.js
// Prices: CoinGecko + DexScreener fallback + cache.
// Currency comes from Settings (usd/eur/idr/cny) — it used to be hardcoded to
// USD in every request, which made the Currency picker a control that saved a
// value nothing ever read. An optional CoinGecko key lifts the rate limit; the
// keyless free tier is CORS-blocked in browsers and rate-limited hard.
// ═══════════════════════════════════════════════════════════════

import { get } from './state.js';
import { setMoneyRate, usdToDisplay } from './ui.js';

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

// ── the rate between the canonical unit and the one on screen ──
//
// Every price this module fetches, caches or returns is USD. That is the whole
// point: CoinGecko will quote any currency you ask for, and DexScreener will
// only ever quote USD, so asking each for the display currency produced a list
// where the top row was in the chosen currency and the rest were in dollars.
// The conversion happens once, here, and nowhere else.
//
// The rate comes out of a request the app was making anyway — one id, two
// vs_currencies — so it costs no extra quota and cannot be the reason a price
// fails. USD is 1:1 and is never fetched.
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
  try {
    const res = await cgFetch(cgUrl('simple/price', {
      ids: 'ethereum', vs_currencies: `usd,${cur}`,
    }));
    if (!res.ok) throw new Error('rate ' + res.status);
    const d = await res.json();
    const usd = d?.ethereum?.usd;
    const other = d?.ethereum?.[cur];
    if (!(Number.isFinite(usd) && usd > 0) || !Number.isFinite(other)) throw new Error('rate missing');
    const rate = other / usd;
    saveRate(cur, rate);
    publishRate(cur, rate);
    return rate;
  } catch {
    publishRate(cur, 1);
    return 1;
  }
}

/** Drop the cached rate, so the next read fetches the one now wanted. */
export function clearUsdRate() {
  try { localStorage.removeItem(RATE_KEY); } catch { /* private mode */ }
}

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

// Address keys are case-INSENSITIVE (0xAbC === 0xabc on-chain): one address
// written in checksum case and read in lower case must hit the same entry.
function cacheKey(address) { return address ? String(address).toLowerCase() : 'native'; }

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

// ── CoinGecko rate limit (HTTP 429) ───────────────────────────
// The keyless free tier answers 429 under load — proven by probe 2026-10-04:
// binancecoin/ohlc → {"status":{"error_code":429,"error_message":"You've
// exceeded the Rate Limit"}}. One 429 used to poison every follow-up: the
// pseudo-candle fallback calls the SAME host and dies the same way, so the
// chart collapsed to [] and the modal claimed "No 24h data" about a token
// that may well have a chart.
//
// Now a 429 opens a short cooldown: CoinGecko calls inside it fail fast with
// a NAMED error instead of hammering the API (which only deepens the
// penalty), and the caller can tell "rate-limited" apart from "no data" and
// say so on screen. DexScreener calls keep plain fetchWithTimeout — they are
// a different host with a different limit.
const CG_COOLDOWN_MS = 60_000;
const CG_COOLDOWN_MAX_MS = 15 * 60_000;
const CG_COOLDOWN_STORE = 'bear.cgCooldownUntil';
const CG_COOLDOWN_STRIKES_STORE = 'bear.cgCooldownStrikes';
let cgCooldownUntil = 0;
let cgStrikes = 0;   // consecutive failed probes; grows the backoff

/** The one error that means "the limit, not the token". */
export function rateLimitError() {
  return new Error('CoinGecko rate-limited (HTTP 429) — cooldown active');
}

export function isRateLimit(e) {
  return /rate-limit|429/.test(String((e && e.message) || ''));
}

// The cooldown check reads PERSISTED state too: a reload drops the module
// variable, and without this the very next boot re-ran the whole failing
// batch (console capture 2026-10-08: 4 CORS errors after the logo fix, all
// from this path). A cooldown survives a reload the same way the logo miss
// memory does — for the same reason: it is a fact about the endpoint, not
// about the page.
//
// The backoff GROWS per failed probe (1m → 2m → … → 15m cap) because a flat
// 60s still produced a periodic storm: capture at t=367s shows the cooldown
// expiring and three fresh errors landing the same minute. A probe that
// fails twice in a row is unlikely to succeed a minute later; a probe that
// SUCCEEDS resets the ladder (see cgFetch).
function cgCooldownActive() {
  if (Date.now() < cgCooldownUntil) return true;
  try {
    const until = Number(localStorage.getItem(CG_COOLDOWN_STORE) || 0);
    if (until > Date.now()) { cgCooldownUntil = until; return true; }
  } catch { /* private mode — in-memory only */ }
  return false;
}

function openCgCooldown() {
  cgStrikes += 1;
  const step = Math.min(CG_COOLDOWN_MAX_MS, CG_COOLDOWN_MS * (2 ** (cgStrikes - 1)));
  cgCooldownUntil = Date.now() + step;
  try {
    localStorage.setItem(CG_COOLDOWN_STORE, String(cgCooldownUntil));
    localStorage.setItem(CG_COOLDOWN_STRIKES_STORE, String(cgStrikes));
  } catch { /* private mode — in-memory still covers this session */ }
}

function noteCgSuccess() {
  if (!cgStrikes) return;
  cgStrikes = 0;                     // healthy again: the ladder starts over
  try { localStorage.removeItem(CG_COOLDOWN_STRIKES_STORE); } catch { /* private mode */ }
}

// Strikes must survive a reload too, or every boot restarts at 1 minute.
function cgStrikeCount() {
  if (cgStrikes) return cgStrikes;
  try {
    const n = Number(localStorage.getItem(CG_COOLDOWN_STRIKES_STORE) || 0);
    if (Number.isFinite(n) && n > 0) cgStrikes = n;
  } catch { /* private mode */ }
  return cgStrikes;
}

/** Test hook: forget the endpoint cooldown (tests reset between cases). */
export function resetCgCooldown() {
  cgCooldownUntil = 0;
  cgStrikes = 0;
  try {
    localStorage.removeItem(CG_COOLDOWN_STORE);
    localStorage.removeItem(CG_COOLDOWN_STRIKES_STORE);
  } catch { /* private mode */ }
}

async function cgFetch(url, timeoutMs = 10000) {
  if (cgCooldownActive()) throw rateLimitError();
  cgStrikeCount();                   // hydrate the persisted ladder before judging
  let res;
  try {
    res = await fetchWithTimeout(url, timeoutMs);
  } catch (e) {
    // In a browser a rate-limited CoinGecko answers WITHOUT CORS headers, so
    // the 429 status is invisible — the fetch just throws a TypeError and the
    // `status === 429` check below never fires. That is why the cooldown was
    // dead code in production while the console kept filling up. An endpoint
    // that cannot deliver a response is the same verdict as one that answers
    // 429: back off.
    openCgCooldown();
    throw e;
  }
  if (res.status === 429) {
    openCgCooldown();
    throw rateLimitError();
  }
  noteCgSuccess();
  return res;
}

async function fetchCoinGeckoNative(chainId) {
  const id = NATIVE_COIN_IDS[chainId];
  if (!id) return null;
  // usd, always. See the rate block above — the display currency is applied once,
  // at the edge, by fmtUsd.
  const res = await cgFetch(cgUrl('simple/price', { ids: id, vs_currencies: 'usd' }));
  if (!res.ok) throw new Error('CoinGecko ' + res.status);
  const data = await res.json();
  return data[id]?.usd ?? null;
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
  const chunks = cgTokenPriceChunks(addresses);
  const out = {};

  // Sequential on purpose, with a circuit breaker. One request per token means
  // a wallet holding twenty tokens asks twenty questions of a free tier, and the
  // limiter answers some of them with an error page that carries no CORS
  // headers — which the console then reports as a CORS failure, burying the
  // real cause. Two consecutive failures is enough to conclude the endpoint is
  // unhappy right now; the rest are left to DexScreener, which is one call per
  // token anyway and does not share this quota.
  let consecutiveFailures = 0;
  for (const chunk of chunks) {
    try {
      const res = await cgFetch(cgUrl(`simple/token_price/${platform}`,
        { contract_addresses: chunk.join(','), vs_currencies: 'usd' }));
      if (!res.ok) {
        if (++consecutiveFailures >= 2) break;
        continue;
      }
      const data = await res.json();
      consecutiveFailures = 0;
      for (const [addr, v] of Object.entries(data || {})) {
        const p = v?.usd;
        if (typeof p === 'number' && Number.isFinite(p)) out[addr] = p;
      }
    } catch {
      if (++consecutiveFailures >= 2) break;
    }
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
  // Before the prices, the rate that turns them into money the user reads. It
  // usually comes from cache, so this is not an extra request per refresh.
  await ensureUsdRate();

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
        // fetchCoinGeckoTokens returns a FLAT map addr → number (it already
        // unwraps v.usd and filters non-finite values). Reading `.usd` here
        // always yielded undefined, so every CoinGecko-listed token fell
        // through to DexScreener — whose /tokens/v1 answers [] for the majors
        // — and rendered "—" even when CoinGecko had the price.
        const raw = prices[t.address.toLowerCase()];
        const p = typeof raw === 'number' ? raw : raw?.usd;
        if (p !== undefined && p !== null && Number.isFinite(Number(p))) {
          const n = Number(p);
          result.set(t.address, n);
          cachePrice(t.address, n);
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

// ── OHLC candlestick data for token chart ───────────────────
// CoinGecko keyless granularity — MEASURED 2026-10-06 (ETH/BTC/DOGE):
// days=1 → 30min (n=48), 7 → 4h (n=42), 30 → 4h (n=180), 90/365 → 4d
// (n=23/92). There is no keyless 5m/1h series: the old 5m/1h buttons all
// fetched days=1 and showed identical candles (user, 2026-10-06: "chart
// time itu ga akurat candle nya sama semua"). The wizard now offers the
// ranges the API can actually distinguish.
// Returns [{ time, open, high, low, close }] or [] when unavailable.
export async function fetchOHLC({ address, chainId, days = 1 }) {
  await ensureUsdRate();
  const platform = COINGECKO_PLATFORMS[chainId];
  const nativeId = NATIVE_COIN_IDS[chainId];
  const key = `ohlc:${address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`}:${days}`;

  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  let url = null;
  if (address && platform) {
    url = cgUrl(`coins/${platform}/contract/${String(address).toLowerCase()}/ohlc`, { vs_currency: 'usd', days });
  } else if (!address && nativeId) {
    url = cgUrl(`coins/${nativeId}/ohlc`, { vs_currency: 'usd', days });
  }
  if (!url) return [];

  try {
    const res = await cgFetch(url, 12000);
    if (!res.ok) throw new Error('CoinGecko OHLC ' + res.status);
    const data = await res.json();
    // CoinGecko OHLC format: [[timestamp, open, high, low, close], ...]
    const candles = (Array.isArray(data) ? data : [])
      .map(d => ({ time: d[0], open: d[1], high: d[2], low: d[3], close: d[4] }))
      .filter(c => [c.open, c.high, c.low, c.close].every(v => typeof v === 'number' && Number.isFinite(v)));
    if (candles.length < 2) throw new Error('No OHLC data');
    // Chart axes are plain numbers with no symbol, so the conversion has to
    // happen here or the chart would read in dollars while the balance beside it
    // reads in rupiah — two true numbers on one screen meaning different things.
    const shown = candles.map((c) => ({ ...c, open: usdToDisplay(c.open), high: usdToDisplay(c.high), low: usdToDisplay(c.low), close: usdToDisplay(c.close) }));
    historyCache.set(key, { data: shown, ts: Date.now() });
    return shown;
  } catch (e) {
    // Rate-limited: the pseudo-candle fallback below calls the SAME host and
    // the cooldown would just fail it again — surface the named error now so
    // the modal can say "rate-limited" instead of "this coin has no data".
    if (isRateLimit(e)) throw rateLimitError();
    // Fallback: convert price history to pseudo-candles
    try {
      const prices = await fetchPriceHistory({ address, chainId, days });
      if (prices.length < 2) return [];
      // prices is already in display currency (fetchPriceHistory converts), so
      // these pseudo-candles must not be scaled a second time. Spacing follows
      // the REQUESTED range — a hardcoded 5-min step drew every 7d/1y series
      // as a wall of tiny steps on a wrong timeline.
      const stepMs = (days * 86400000) / prices.length;
      const candles = prices.map((p, i) => {
        const next = prices[i + 1] || p;
        return { time: Date.now() - (prices.length - i) * stepMs, open: p, high: Math.max(p, next), low: Math.min(p, next), close: next };
      });
      return candles.slice(0, -1);
    } catch (e2) {
      if (isRateLimit(e2)) throw rateLimitError();
      return [];
    }
  }
}

// ── 24h price history for the token mini-chart ──────────────────
// CoinGecko keyless market_chart, cached 5 min. Returns a number[]
// (oldest → newest, downsampled to ~30 points) or [] when unavailable.
// Replaces the old random-walk chart, which looked different on every open.
const HISTORY_TTL = 5 * 60_000;

export async function fetchPriceHistory({ address, chainId, days = 1 }) {
  await ensureUsdRate();
  const platform = COINGECKO_PLATFORMS[chainId];
  const nativeId = NATIVE_COIN_IDS[chainId];
  // Range in the cache key: a 24h hit must never answer a 1y request (the
  // old key had no range, so the first fill poisoned every other button).
  const key = `hist:${address ? `${chainId}:${String(address).toLowerCase()}` : `${chainId}:native`}:${days}`;

  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.ts < HISTORY_TTL) return hit.data;

  let url = null;
  if (address && platform) {
    url = cgUrl(`coins/${platform}/contract/${String(address).toLowerCase()}/market_chart`, { vs_currency: 'usd', days });
  } else if (!address && nativeId) {
    url = cgUrl(`coins/${nativeId}/market_chart`, { vs_currency: 'usd', days });
  }
  if (!url) return [];

  try {
    const res = await cgFetch(url, 12000);
    if (!res.ok) throw new Error('CoinGecko ' + res.status);
    const data = await res.json();
    const raw = (data.prices || [])
      .map(p => p[1])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (raw.length < 2) throw new Error('No data');
    // evenly spaced sample (~30 points), always keeping first + latest
    const target = Math.min(30, raw.length);
    const sampled = Array.from({ length: target }, (_, k) => usdToDisplay(raw[Math.round(k * (raw.length - 1) / (target - 1))]));
    historyCache.set(key, { data: sampled, ts: Date.now() });
    return sampled;
  } catch (e) {
    // DexScreener fallback for chart data — a DIFFERENT host, so it is still
    // worth one shot even while CoinGecko is cooling down.
    try {
      if (address) {
        const dsUrl = `https://api.dexscreener.com/tokens/v1/${chainId}/${address}`;
        const dsRes = await fetchWithTimeout(dsUrl, 8000);
        if (dsRes.ok) {
          const dsData = await dsRes.json();
          const pair = Array.isArray(dsData) ? dsData[0] : dsData;
          const history = pair?.priceHistory || pair?.h24 || [];
          if (Array.isArray(history) && history.length >= 2) {
            const sampled = Array.from({ length: Math.min(30, history.length) }, (_, k) => history[Math.round(k * (history.length - 1) / (Math.min(30, history.length) - 1))]);
            historyCache.set(key, { data: sampled, ts: Date.now() });
            return sampled;
          }
        }
      }
    } catch { /* fallback failed */ }
    // The limit was the cause → say so; a genuine gap in the data stays [].
    if (isRateLimit(e)) throw rateLimitError();
    return [];
  }
}