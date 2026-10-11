// Bear Tool — price-storm.test.js
// The endpoint cooldown, pinned. In production a rate-limited host answers
// WITHOUT CORS headers (or the device is simply offline): the browser reports a
// TypeError, never `status === 429`, so a cooldown that only watches the status
// code never fires — dead code — and every page load re-runs the whole failing
// walk (live capture 2026-10-08: console full of ERR_FAILED long after the 429
// logic landed).
//
// The capped source now is GeckoTerminal (30/min, the only keyless chart host
// with a documented cap). DexScreener / Binance / DefiLlama / Frankfurter are
// NOT behind this cooldown — different hosts, different budgets.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPrices, fetchPriceHistory, resetCgCooldown, clearPriceCache } from '../js/price.js';

const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};

const calls = [];
const cappedCalls = () => calls.filter((u) => u.includes('geckoterminal')).length;
const failNetwork = async (url) => {
  calls.push(String(url));
  throw new TypeError('Failed to fetch');   // exactly what a CORS block looks like
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// A GeckoTerminal answer for BOTH calls of the chart walk (pools → ohlcv).
// Order matters: the ohlcv URL also contains "/pools" (…/pools/<addr>/ohlcv/…).
const gtRoutes = (pools, ohlcv) => async (url) => {
  calls.push(String(url));
  if (String(url).includes('/ohlcv/')) return ok({ data: { attributes: { ohlcv_list: ohlcv } } });
  if (String(url).includes('/pools')) return ok({ data: [{ attributes: { address: '0xPOOL' } }] });
  throw new TypeError('Failed to fetch');
};

beforeEach(() => {
  lsStore.clear();
  calls.length = 0;
  resetCgCooldown();
  clearPriceCache();
  globalThis.fetch = failNetwork;
});

test('a network-level failure opens the cooldown — one bad answer, not forty', async () => {
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});
  const after = cappedCalls();
  assert.ok(after >= 1, 'the first call does ask');
  await fetchPriceHistory({ address: '0xbeef', chainId: 1 }).catch(() => {});
  await fetchPriceHistory({ address: '0xcafe', chainId: 1 }).catch(() => {});
  assert.equal(cappedCalls(), after, 'cooldown active: no further capped-source requests');
});

test('the cooldown is written to localStorage — a reload keeps it', async () => {
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});
  const raw = lsStore.get('bear.sourceCooldownUntil');
  assert.ok(raw, 'the endpoint verdict must survive a reload, like the logo miss memory');
  assert.ok(Number(raw) > Date.now(), 'stored value is a future deadline');
});

test('a persisted cooldown suppresses the fetch with fresh module state', async () => {
  resetCgCooldown();                                   // fresh module…
  lsStore.set('bear.sourceCooldownUntil', String(Date.now() + 60_000));
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});
  assert.equal(calls.length, 0, 'storage is the memory a reload keeps');
});

test('an expired cooldown asks again — backoff ends, verdict does not stick', async () => {
  lsStore.set('bear.sourceCooldownUntil', String(Date.now() - 1));
  globalThis.fetch = gtRoutes(null, [[2, '3', '3', '3', '3', '1'], [1, '2', '2', '2', '2', '1']]);
  const data = await fetchPriceHistory({ address: '0xfeed', chainId: 1 });
  assert.ok(calls.length >= 1, 'expired deadline is no deadline');
  assert.ok(data.length >= 2, 'and the data flows again');
});

test('DexScreener is NOT behind the capped-source cooldown — different host, different limit', async () => {
  // Cool the capped source down first (an ERC-20 chart walk fails).
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});
  assert.ok(cappedCalls() > 0, 'cooldown opened');
  const before = calls.length;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('dexscreener')) {
      return ok([{ chainId: 'ethereum', priceUsd: '1.5', liquidity: { usd: 1e6 }, baseToken: { address: '0xabc' } }]);
    }
    return failNetwork(url);
  };
  const prices = await fetchAllPrices([{ address: '0xabc', symbol: 'ABC', decimals: 18 }], 1);
  assert.equal(prices.get('0xabc'), 1.5, 'the wallet price must still flow while the chart host cools down');
  assert.ok(calls.slice(before).some((u) => u.includes('dexscreener')), 'the other host is still tried');
});

test('a native chart (Binance) is never behind the capped-source cooldown', async () => {
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});   // opens cooldown
  const before = calls.length;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return ok([[1, '2', '2', '2', '2', '1'], [2, '3', '3', '3', '3', '1']]);
  };
  const data = await fetchPriceHistory({ address: null, chainId: 1 });
  assert.ok(calls.slice(before).every((u) => u.includes('binance')), 'native charts go to Binance');
  assert.ok(data.length >= 2, 'and are not blocked by an unrelated host cooling down');
});

test('backoff grows per failed probe and resets on success — no periodic storm', async () => {
  // Flat 60s still stormed: capture t=367s showed the cooldown expiring and
  // three fresh errors the same minute. The ladder must grow, and a healthy
  // answer must restart it.
  const deadlines = [];
  for (let i = 0; i < 4; i++) {
    await fetchPriceHistory({ address: '0x' + i.toString().padStart(4, '0'), chainId: 1 }).catch(() => {});
    deadlines.push(Number(lsStore.get('bear.sourceCooldownUntil')));
    // Simulate the cooldown having EXPIRED while keeping the strike count —
    // resetCgCooldown wipes both, which would flatten the ladder to 1 minute.
    const strikes = lsStore.get('bear.sourceCooldownStrikes');
    resetCgCooldown();
    if (strikes) lsStore.set('bear.sourceCooldownStrikes', strikes);
    lsStore.set('bear.sourceCooldownUntil', String(Date.now() - 1));
  }
  const gaps = deadlines.map((d, i) => d - (i ? deadlines[i - 1] : Date.now()));
  assert.ok(gaps[3] > gaps[0] * 2, `ladder grows: ${gaps.map((g) => Math.round(g / 1000))}s`);
  assert.ok(deadlines.every((d) => d > 0), 'every probe filed a future deadline');

  // A success wipes the ladder: next failure starts back at the base minute.
  resetCgCooldown();
  globalThis.fetch = gtRoutes(null, [[2, '3', '3', '3', '3', '1'], [1, '2', '2', '2', '2', '1']]);
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 });
  assert.equal(lsStore.get('bear.sourceCooldownStrikes'), undefined, 'healthy probe forgets the strikes');
});

test('a healthy endpoint is untouched by the cooldown logic', async () => {
  resetCgCooldown();
  clearPriceCache();
  globalThis.fetch = gtRoutes(null, [[2, '103', '103', '103', '103', '1'], [1, '102', '102', '102', '102', '1']]);
  const data = await fetchPriceHistory({ address: '0xfeed', chainId: 1 });
  assert.ok(calls.some((u) => u.includes('/ohlcv/')), 'success path still fetches');
  assert.ok(data.length >= 2, 'and serves the chart');
  assert.equal(lsStore.get('bear.sourceCooldownUntil'), undefined, 'no cooldown for a healthy endpoint');
});
