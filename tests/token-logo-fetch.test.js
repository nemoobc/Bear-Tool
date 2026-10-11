// Bear Tool — token-logo-fetch.test.js
// HOW a missing mark is looked up is a security decision, not a detail.
//
// The pre-fix lookup was a symbol search for every token: the first
// exact-symbol coin won and its image was cached under the contract. Live
// report 2026-10-08: "deploy token malah kedetect logo lain tapi ticker sama"
// — the wallet fetched a stranger's logo because the ticker matched.
//
// 2026-10-11: CoinGecko is gone. The lookup is DexScreener's batched token
// endpoint — ONE keyless request for a comma-separated address list — and an
// image is filed under the CONTRACT it was returned FOR. The ticker never
// drives a fetch. A native coin (no contract) is never looked up at all: it
// wears the local mark. Unknown chain → no request.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });

const REAL_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNLISTED = '0x1111111111111111111111111111111111111111';
const USDC_IMG = 'https://dd.dexscreener.com/ds-data/tokens/ethereum/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png';

const calls = [];
// Answer the batched endpoint with a pair for whichever known address is in the
// request. Anything else the wallet asked about is simply not in the answer —
// exactly what a real "not indexed" token looks like.
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (!u.includes('api.dexscreener.com/tokens/v1/')) {
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const pairs = [];
  if (u.toLowerCase().includes(REAL_USDC.toLowerCase())) {
    pairs.push({ chainId: 'ethereum', baseToken: { address: REAL_USDC }, info: { imageUrl: USDC_IMG } });
  }
  return { ok: true, status: 200, json: async () => pairs };
};

const { ensureTokenLogos, getCachedLogo, logoKeyFor, resetLogoMisses } = await import('../js/token-logo.js');

const reset = () => { store.clear(); calls.length = 0; resetLogoMisses(); };

test('a contract token is looked up BY CONTRACT — the ticker never drives the fetch', async () => {
  reset();
  const token = { address: REAL_USDC, symbol: 'USDC' };
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, 1, 'exactly one batched request for the whole list');
  assert.match(calls[0], /api\.dexscreener\.com\/tokens\/v1\/1\//, 'batched token endpoint, chain in the path');
  assert.match(calls[0].toLowerCase(), /0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/);
  assert.doesNotMatch(calls[0], /coingecko|\/search|query=/, 'no per-ticker guess, and CoinGecko is gone');
  assert.equal(getCachedLogo(logoKeyFor(token)), USDC_IMG, 'the contract-keyed cache holds the proven image');
});

test('the whole list is ONE request — not one request per token', async () => {
  reset();
  const many = Array.from({ length: 10 }, (_, i) => ({
    address: '0x' + String(i + 2).repeat(40).slice(0, 40), symbol: 'T' + i,
  }));
  many.push({ address: REAL_USDC, symbol: 'USDC' });
  await ensureTokenLogos(many, 1);
  assert.equal(calls.length, 1, '11 tokens, one batched request');
  assert.equal(getCachedLogo(logoKeyFor({ address: REAL_USDC })), USDC_IMG);
});

test('a contract the batch does not answer leaves no cache — and no refetch storm', async () => {
  reset();
  const token = { address: UNLISTED, symbol: 'USDC' };   // famous ticker, unindexed contract
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, 1, 'still asks — by contract');
  assert.doesNotMatch(calls[0], /query=/, 'and never falls back to a ticker guess');
  assert.equal(getCachedLogo(logoKeyFor(token)), null, 'no image: the generated disc stands');
  // The unanswered contract is a MISS, so the next render does not re-ask.
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, 1, 'a short answer is remembered, not retried every render');
});

test('an unknown chain performs no lookup — there is no truthful answer', async () => {
  reset();
  await ensureTokenLogos([{ address: UNLISTED, symbol: 'X' }], 999999);
  assert.equal(calls.length, 0, 'no chain slug, no request, no wrong logo');
  assert.equal(getCachedLogo(logoKeyFor({ address: UNLISTED, symbol: 'X' })), null);
});

test('a native coin is never looked up — its mark is local, not a ticker guess', async () => {
  reset();
  await ensureTokenLogos([{ symbol: 'COOL' }], 1);
  assert.equal(calls.length, 0, 'a native coin has no contract to look up');
  assert.equal(getCachedLogo('sym:cool'), null, 'nothing invented for a native ticker');
});

test('native tickers with a local hand-tuned mark fetch nothing', async () => {
  reset();
  await ensureTokenLogos([{ symbol: 'ETH' }, { symbol: 'USDC' }], 1);
  assert.equal(calls.length, 0, 'the local brand is already the answer — no network, no lookup');
});

test('a token with a fresh cache is never refetched', async () => {
  reset();
  const token = { address: REAL_USDC, symbol: 'USDC' };
  await ensureTokenLogos([token], 1);
  const after = calls.length;
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, after, '24h cache stands between the list and the network');
});

test('only an https image may be cached — a hostile answer cannot reach the DOM', async () => {
  reset();
  const EVIL = '0x2222222222222222222222222222222222222222';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => [
      { baseToken: { address: EVIL }, info: { imageUrl: 'javascript:alert(1)' } },
      { baseToken: { address: EVIL }, info: { imageUrl: 'data:image/svg+xml,<svg/>' } },
    ] };
  };
  await ensureTokenLogos([{ address: EVIL, symbol: 'EVIL' }], 1);
  assert.equal(getCachedLogo(logoKeyFor({ address: EVIL })), null,
    'a non-https src must never be rendered into the wallet');
});

test('a failed batch is remembered — every render does not restart the storm', async () => {
  // An outage used to be retried on every dashboard load: a burst of fetches,
  // each refused without CORS headers, console full of ERR_FAILED, zero logos.
  // The miss now has a short memory of its own; resetLogoMisses() is how tests
  // (and only tests) forget it.
  reset();
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('Failed to fetch'); };
  const token = { address: UNLISTED, symbol: 'ZZZ' };
  await ensureTokenLogos([token], 1);
  const first = calls.length;
  assert.equal(first, 1, 'the first attempt does ask');
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, first, 'no refetch while the miss is fresh');
  resetLogoMisses();
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, first + 1, 'forgetting the miss lets it ask again');
});
