// Unit tests for js/price.js — the KEYLESS source stack (2026-10-11).
//
// CoinGecko was removed (user: "api coingecko ganti, cari yang no limit
// unlimited"): its keyless tier throttles at ~10-30 calls/min and answers a
// throttle WITHOUT CORS headers, so the browser blamed CORS and the price was
// lost. The sources now are DexScreener (tokens, ~300/min), Binance (majors,
// weight-based), DefiLlama (fallback, uncapped) and GeckoTerminal (charts for
// tokens Binance does not list, 30/min).
//
// What this file pins: the source order per asset class, the honest-null
// contract (missing price → NO entry, never 0), same-chain filtering, the
// deepest-pool rule, the batched request, and the cache path.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAllPrices,
  fetchPriceHistory,
  getPriceFromCache,
  clearPriceCache,
  resetCgCooldown
} from '../js/price.js';

// Minimal localStorage shim (Node has none without --experimental-webstorage).
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k)
};

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) return resp;
    }
    throw new Error('Unexpected fetch: ' + url);
  };
  return calls;
}

const pair = (address, priceUsd, { chainId = 'ethereum', liq = 1000 } = {}) => ({
  chainId, priceUsd, liquidity: { usd: liq }, baseToken: { address }
});

beforeEach(() => {
  lsStore.clear();
  clearPriceCache();
  resetCgCooldown();
});

// ── token prices: DexScreener batch → Deepest pool ───────────────────────

test('price: the DEEPEST pool wins — a dust pool cannot set the price', async () => {
  const calls = installFetch([
    ['api.dexscreener.com/tokens/v1', jsonResponse([
      pair('0xabc', '1.00', { liq: 100 }),          // shallow, manipulated
      pair('0xabc', '2.50', { liq: 9_000_000 }),    // real market
      pair('0xabc', '9.99', { chainId: 'bsc' })     // wrong chain — skipped
    ])]
  ]);

  const result = await fetchAllPrices([{ address: '0xabc', symbol: 'ABC', decimals: 18 }], 1);

  assert.equal(result.get('0xabc'), 2.5);
  assert.ok(calls.some((u) => u.includes('/tokens/v1/1/0xabc')), 'batched token endpoint');
  assert.equal(getPriceFromCache('0xabc'), 2.5, 'price lands in cache too');
});

test('price: the batch is ONE request for many tokens (comma-joined)', async () => {
  const calls = installFetch([
    ['api.dexscreener.com/tokens/v1', jsonResponse([
      pair('0xaaa', '1'), pair('0xbbb', '2'), pair('0xccc', '3')
    ])]
  ]);

  const result = await fetchAllPrices([
    { address: '0xAAA', symbol: 'A', decimals: 18 },
    { address: '0xBBB', symbol: 'B', decimals: 18 },
    { address: '0xCCC', symbol: 'C', decimals: 18 }
  ], 1);

  const batched = calls.filter((u) => u.includes('/tokens/v1/'));
  assert.equal(batched.length, 1, 'three tokens, one request');
  assert.ok(batched[0].includes('0xaaa,0xbbb,0xccc'));
  // The result map is keyed by the ORIGINAL-cased address passed in.
  assert.equal(result.get('0xAAA'), 1);
  assert.equal(result.get('0xCCC'), 3);
});

test('price: DexScreener empty → DefiLlama fallback prices the rest', async () => {
  const calls = installFetch([
    ['api.dexscreener.com/tokens/v1', jsonResponse([])],
    ['coins.llama.fi', jsonResponse({ coins: { 'ethereum:0xabc': { price: 0.999868 } } })],
    ['api.dexscreener.com/latest/dex/search', jsonResponse({ pairs: [] })]
  ]);

  const result = await fetchAllPrices([{ address: '0xabc', symbol: 'USDT', decimals: 6 }], 1);

  assert.equal(result.get('0xabc'), 0.999868, 'DefiLlama answer must be consumed');
  assert.ok(calls.some((u) => u.includes('coins.llama.fi/prices/current/ethereum:0xabc')));
});

test('price: DexScreener + DefiLlama empty → search endpoint (same chain only)', async () => {
  const calls = installFetch([
    ['api.dexscreener.com/tokens/v1', jsonResponse([])],
    ['coins.llama.fi', jsonResponse({ coins: {} })],
    ['api.dexscreener.com/latest/dex/search', jsonResponse({
      pairs: [
        { chainId: 'bsc', priceUsd: '1.50', liquidity: { usd: 9e9 } },     // wrong chain + deepest → still skipped
        { chainId: 'ethereum', priceUsd: '2.50', liquidity: { usd: 10 } }
      ]
    })]
  ]);

  const result = await fetchAllPrices([{ address: '0xabc', symbol: 'ABC', decimals: 18 }], 1);

  assert.equal(result.get('0xabc'), 2.5, 'chain filter beats liquidity');
  assert.ok(calls.some((u) => u.includes('/latest/dex/search?q=')));
});

test('price: every source empty → honest null (no entry, never 0)', async () => {
  installFetch([
    ['api.dexscreener.com/tokens/v1', jsonResponse([])],
    ['coins.llama.fi', jsonResponse({ coins: {} })],
    ['api.dexscreener.com/latest/dex/search', jsonResponse({ pairs: [] })]
  ]);

  const result = await fetchAllPrices([{ address: '0xdef', symbol: 'DEF', decimals: 18 }], 1);

  assert.equal(result.has('0xdef'), false);
  assert.equal(result.get('0xdef'), undefined);
});

// ── native gas token: Binance → DefiLlama (wrapped) ─────────────────────

test('price: native uses the Binance spot ticker for the chain', async () => {
  const calls = installFetch([['api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', jsonResponse({ symbol: 'ETHUSDT', price: '2000.5' })]]);

  const result = await fetchAllPrices([{ address: null, symbol: 'ETH', decimals: 18 }], 1);

  assert.equal(result.get('native'), 2000.5);
  assert.ok(calls.some((u) => u.includes('symbol=ETHUSDT')), 'chain 1 native = ETHUSDT');
  assert.equal(getPriceFromCache(null, 1), 2000.5);
});

test('price: BSC asks BNBUSDT, not ETHUSDT — the native slot is per chain', async () => {
  const calls = installFetch([['api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', jsonResponse({ symbol: 'BNBUSDT', price: '300' })]]);

  const result = await fetchAllPrices([{ address: null, symbol: 'BNB', decimals: 18 }], 56);

  assert.equal(result.get('native'), 300);
  assert.equal(getPriceFromCache(null, 1), null, 'the BSC answer must NOT price chain 1');
  assert.equal(getPriceFromCache(null, 56), 300);
  assert.ok(calls.every((u) => !u.includes('ETHUSDT')), 'no cross-chain symbol');
});

test('price: native Binance blocked → DefiLlama wrapped-native fallback', async () => {
  const calls = installFetch([
    ['api.binance.com', jsonResponse({}, false)],   // 451 / region block
    ['coins.llama.fi', jsonResponse({ coins: { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { price: 1999 } } })]
  ]);

  const result = await fetchAllPrices([{ address: null, symbol: 'ETH', decimals: 18 }], 1);

  assert.equal(result.get('native'), 1999);
  assert.ok(calls.some((u) => u.includes('coins.llama.fi/prices/current/ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')),
    'the chain wrapped-native contract is the honest proxy');
});

// ── price history / OHLC (mini chart) ───────────────────────────────────
// The chart used to render a fresh random walk on every open. It is now pinned
// to real keyless series with an honest empty state.

const klines = (n, start = 100) => Array.from({ length: n }, (_, i) => [
  1700000000000 + i * 1800000, String(start + i), String(start + i + 1), String(start + i - 1), String(start + i), '10'
]);

test('price history: native uses Binance klines, downsampled, latest kept', async () => {
  const calls = installFetch([['api.binance.com/api/v3/klines', jsonResponse(klines(100, 2000))]]);

  const data = await fetchPriceHistory({ address: null, chainId: 1 });

  assert.ok(calls.some((u) => u.includes('/api/v3/klines?symbol=ETHUSDT&interval=30m&limit=48')),
    '24h → 30m klines, 48 candles');
  assert.ok(data.length >= 2 && data.length <= 30, 'downsampled to ≤30 points, got ' + data.length);
  assert.equal(data[data.length - 1], 2099, 'last point must be the most recent close');
});

test('price history: the four ranges request DIFFERENT granularity', async () => {
  const calls = installFetch([['api.binance.com/api/v3/klines', jsonResponse(klines(50, 100))]]);

  for (const days of [1, 7, 30, 365]) {
    clearPriceCache();
    await fetchPriceHistory({ address: null, chainId: 1, days });
  }

  const intervals = calls.map((u) => (u.match(/interval=([^&]+)/) || [])[1]);
  assert.deepEqual(intervals, ['30m', '4h', '12h', '1w'],
    'a 1y chart must not be 24 one-day candles — the old CoinGecko path drew them all identically');
});

test('price history: ERC-20 uses GeckoTerminal (pool lookup, lowercased address)', async () => {
  const calls = installFetch([
    ['/tokens/0xabcdef/pools', jsonResponse({ data: [{ id: 'eth_0xPOOL', attributes: { address: '0xPOOL' } }] })],
    ['/ohlcv/', jsonResponse({ data: { attributes: { ohlcv_list: [
      [3, '1.8', '1.9', '1.7', '1.8', '1'],   // newest first — must be reversed
      [2, '1.5', '1.6', '1.4', '1.5', '1'],
      [1, '1.2', '1.3', '1.1', '1.2', '1']
    ] } } })]
  ]);

  const data = await fetchPriceHistory({ address: '0xAbCdEf', chainId: 1 });

  assert.ok(calls.some((u) => u.includes('api.geckoterminal.com/api/v2/networks/eth/tokens/0xabcdef/pools')),
    'pool lookup must lowercase the address and use the chain network id');
  assert.ok(calls.some((u) => u.includes('/ohlcv/hour?')), '24h → hourly candles');
  assert.deepEqual(data, [1.2, 1.5, 1.8], 'oldest → newest');
});

test('price history: empty / unsupported → [] (honest empty state, never invented data)', async () => {
  installFetch([['api.binance.com/api/v3/klines', jsonResponse([])]]);
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 1 }), []);
  // chain with no registry row → no request at all
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 99999 }), []);
  assert.deepEqual(await fetchPriceHistory({ address: '0xdead', chainId: 99999 }), []);
});

test('price history: fetch failure → [] (never throws into the chart renderer)', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 1 }), []);
});

test('price history: cached within TTL (no second network hit)', async () => {
  const calls = installFetch([['api.binance.com/api/v3/klines', jsonResponse(klines(10, 100))]]);

  const first = await fetchPriceHistory({ address: null, chainId: 1 });
  const second = await fetchPriceHistory({ address: null, chainId: 1 });

  assert.deepEqual(first, second);
  assert.equal(calls.filter((u) => u.includes('klines')).length, 1, 'second call must be served from cache');
});

test('price: a cached price is returned without ANY network call', async () => {
  installFetch([['api.binance.com/api/v3/klines', jsonResponse([])], ['Unexpected', jsonResponse(null)]]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('binance')) return jsonResponse({ symbol: 'ETHUSDT', price: '2000' });
    throw new Error('Unexpected fetch: ' + url);
  };
  await fetchAllPrices([{ address: null, symbol: 'ETH', decimals: 18 }], 1);

  let hits = 0;
  globalThis.fetch = async (url) => { hits += 1; throw new Error('no network expected: ' + url); };
  const result = await fetchAllPrices([{ address: null, symbol: 'ETH', decimals: 18 }], 1);

  assert.equal(result.get('native'), 2000);
  assert.equal(hits, 0, 'a hot cache must not touch the network');
});
