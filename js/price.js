// ═══════════════════════════════════════════════════════════════
// Bear Tool — price.js
// USD prices: CoinGecko (keyless) + DexScreener fallback + cache.
// ═══════════════════════════════════════════════════════════════

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
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('CoinGecko ' + res.status);
  const data = await res.json();
  return data[id]?.usd ?? null;
}

async function fetchCoinGeckoTokens(chainId, addresses) {
  const platform = COINGECKO_PLATFORMS[chainId];
  if (!platform || !addresses.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${addresses.join(',')}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('CoinGecko ' + res.status);
  return res.json();
}

async function fetchDexScreener(chainId, address) {
  const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${address}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('DexScreener ' + res.status);
  const data = await res.json();
  const pair = Array.isArray(data) ? data[0] : null;
  return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
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