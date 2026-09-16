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