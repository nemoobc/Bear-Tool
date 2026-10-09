// Bear Tool — token-logo-fetch.test.js
// HOW a missing mark is looked up is a security decision, not a detail.
//
// The pre-fix lookup was CoinGecko /search by symbol for every token: the
// first exact-symbol coin won and its image was cached under the contract.
// Live report 2026-10-08: "deploy token malah kedetect logo lain tapi ticker
// sama" — the wallet fetched a stranger's logo because the ticker matched.
//
// Contract identity → /coins/{platform}/contract/{address} (keyed by the
// contract; a404 means "not listed", never "some other project").
// Native coin (no contract) → the old symbol search, kept because a native
// coin's ticker IS its identity. Unknown chain → no lookup at all.
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
const USDC_CG = 'https://assets.coingecko.com/coins/images/6319/usdc.png';
const COOL_CG = 'https://assets.coingecko.com/coins/images/9999/cool.png';

const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes(`/contract/${REAL_USDC}`)) {
    return { ok: true, json: async () => ({ image: { large: USDC_CG } }) };
  }
  if (u.includes('/search?query=COOL')) {
    return { ok: true, json: async () => ({ coins: [{ id: 'cool', symbol: 'COOL', large: COOL_CG }] }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
};

const { ensureTokenLogos, getCachedLogo, logoKeyFor, resetLogoMisses } = await import('../js/token-logo.js');

const reset = () => { store.clear(); calls.length = 0; resetLogoMisses(); };

test('a contract token is looked up BY CONTRACT — the ticker never drives the fetch', async () => {
  reset();
  const token = { address: REAL_USDC, symbol: 'USDC' };
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, 1, 'exactly one lookup for a listed contract');
  assert.match(calls[0], /\/api\/v3\/coins\/ethereum\/contract\/0xA0b8/, 'platform + contract endpoint');
  assert.doesNotMatch(calls[0], /\/search/, 'symbol search for a contract is the counterfeit-logo hole');
  assert.equal(getCachedLogo(logoKeyFor(token)), USDC_CG, 'the contract-keyed cache holds the proven image');
});

test('a contract CoinGecko does not know leaves no cache at all', async () => {
  reset();
  const token = { address: UNLISTED, symbol: 'USDC' };   // famous ticker, unlisted contract
  await ensureTokenLogos([token], 1);
  assert.equal(calls.length, 1, 'still asks — by contract');
  assert.doesNotMatch(calls[0], /\/search/, 'and refuses to fall back to a ticker guess');
  assert.equal(getCachedLogo(logoKeyFor(token)), null, 'no image: the generated disc stands');
});

test('an unknown chain performs no lookup — there is no truthful answer', async () => {
  reset();
  await ensureTokenLogos([{ address: UNLISTED, symbol: 'X' }], 999999);
  assert.equal(calls.length, 0, 'no platform mapping, no request, no wrong logo');
  assert.equal(getCachedLogo(logoKeyFor({ address: UNLISTED, symbol: 'X' })), null);
});

test('a native coin still resolves by symbol, under its own namespaced key', async () => {
  reset();
  await ensureTokenLogos([{ symbol: 'COOL' }], 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/search\?query=COOL/, 'native = no contract: ticker is the only identity');
  assert.equal(getCachedLogo(logoKeyFor({ symbol: 'COOL' })), COOL_CG);
  assert.equal(getCachedLogo('sym:cool'), COOL_CG, 'namespaced, so it can never collide with an address key');
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
  assert.equal(calls.length, after, '24h cache stands between the list and CoinGecko');
});

test('a failed lookup is remembered — every render does not restart the storm', async () => {
  // Rate-limited/unknown lookups used to be retried on every dashboard load:
  // a parallel burst of contract fetches, each refused without CORS headers,
  // console full of ERR_FAILED, quota burned, zero logos. The miss now has a
  // short memory of its own; resetLogoMisses() is how tests (and only tests)
  // forget it.
  reset();
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
