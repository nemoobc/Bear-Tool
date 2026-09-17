// Unit tests for js/price.js — DexScreener search fallback (P2 bug).
// Token endpoint /tokens/v1/{chainId}/{address} can return [] for new/unindexed
// tokens; fallback must try /latest/dex/search?q=<address> and pick the first
// pair with priceUsd on the same chain. Empty result → honest null (not 0).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAllPrices,
  getPriceFromCache,
  clearPriceCache
} from '../js/price.js';

// Minimal localStorage shim (Node has none without --experimental-webstorage).
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k)
};

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
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

beforeEach(() => {
  lsStore.clear();
  clearPriceCache();
});

test('price: DexScreener empty token list falls back to search endpoint (same chain)', async () => {
  const calls = installFetch([
    ['api.coingecko.com', jsonResponse({})], // token not listed on CoinGecko
    ['api.dexscreener.com/tokens/v1', jsonResponse([])], // empty pair list
    ['api.dexscreener.com/latest/dex/search', jsonResponse({
      pairs: [
        { chainId: 'bsc', priceUsd: '1.50' },      // wrong chain — must be skipped
        { chainId: 'ethereum', priceUsd: '2.50' }   // matches chainId 1
      ]
    })]
  ]);

  const result = await fetchAllPrices(
    [{ address: '0xabc', symbol: 'ABC', decimals: 18 }],
    1
  );

  assert.equal(result.get('0xabc'), 2.5);
  assert.ok(calls.some(u => u.includes('/latest/dex/search?q=')),
    'search endpoint must be called after empty token list');
  // Result went through the normal cache path too.
  assert.equal(getPriceFromCache('0xabc'), 2.5);
});

test('price: DexScreener search also empty → honest null (not 0)', async () => {
  const calls = installFetch([
    ['api.coingecko.com', jsonResponse({})],
    ['api.dexscreener.com/tokens/v1', jsonResponse([])],
    ['api.dexscreener.com/latest/dex/search', jsonResponse({ pairs: [] })]
  ]);

  const result = await fetchAllPrices(
    [{ address: '0xdef', symbol: 'DEF', decimals: 18 }],
    1
  );

  // No price found anywhere → no entry in result (dashboard renders '—', not 0).
  assert.equal(result.has('0xdef'), false);
  assert.equal(result.get('0xdef'), undefined);
  assert.ok(calls.some(u => u.includes('/latest/dex/search?q=')));
});
// ── 24h price history (mini chart) ──────────────────────────────
// The chart used to render a fresh random walk on every open. These tests
// pin it to real CoinGecko market_chart data with an honest empty state.

import { fetchPriceHistory } from '../js/price.js';

test('price history: native uses CoinGecko market_chart, downsampled + keeps latest', async () => {
  const prices = Array.from({ length: 100 }, (_, i) => [1700000000000 + i * 600000, 2000 + i]);
  const calls = installFetch([['market_chart', jsonResponse({ prices })]]);

  const data = await fetchPriceHistory({ address: null, chainId: 1 });

  assert.ok(calls.some(u => u.includes('/coins/ethereum/market_chart?vs_currency=usd&days=1')),
    'native history must hit the coin market_chart endpoint');
  assert.ok(data.length >= 2 && data.length <= 32, 'downsampled to ~30 points, got ' + data.length);
  assert.equal(data[data.length - 1], 2099, 'last point must be the most recent price');
});

test('price history: ERC-20 uses the contract market_chart endpoint (lowercased)', async () => {
  const calls = installFetch([['market_chart', jsonResponse({ prices: [[1, 1.5], [2, 1.8]] })]]);

  const data = await fetchPriceHistory({ address: '0xAbCdEf', chainId: 1 });

  assert.ok(calls.some(u => u.includes('/coins/ethereum/contract/0xabcdef/market_chart')),
    'token history must lowercase the address');
  assert.deepEqual(data, [1.5, 1.8]);
});

test('price history: empty or unsupported → [] (honest empty state, never invented data)', async () => {
  installFetch([['market_chart', jsonResponse({ prices: [] })]]);
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 1 }), []);
  // chain with no CoinGecko mapping → no request at all
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 99999 }), []);
});

test('price history: fetch failure → [] (never throws into the chart renderer)', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.deepEqual(await fetchPriceHistory({ address: null, chainId: 1 }), []);
});

test('price history: cached within TTL (no second network hit)', async () => {
  const prices = Array.from({ length: 10 }, (_, i) => [i, 100 + i]);
  const calls = installFetch([['market_chart', jsonResponse({ prices })]]);

  const first = await fetchPriceHistory({ address: '0xfeed', chainId: 1 });
  const second = await fetchPriceHistory({ address: '0xfeed', chainId: 1 });

  assert.deepEqual(first, second);
  assert.equal(calls.filter(u => u.includes('market_chart')).length, 1, 'second call must be served from cache');
});
