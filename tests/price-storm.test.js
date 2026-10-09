// Bear Tool — price-storm.test.js
// The browser-hidden 429, pinned. In production a rate-limited CoinGecko
// answers WITHOUT CORS headers: the browser reports a TypeError, never
// `status === 429`, so the original cooldown check never fired — dead code —
// and every page load re-ran the whole failing batch (live capture
// 2026-10-08: console full of ERR_FAILED long after the 429 logic landed).
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
const cgCalls = () => calls.filter(u => u.includes('coingecko')).length;
const failNetwork = async (url) => {
  calls.push(String(url));
  throw new TypeError('Failed to fetch');   // exactly what a CORS block looks like
};
const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  lsStore.clear();
  calls.length = 0;
  resetCgCooldown();
  clearPriceCache();
  globalThis.fetch = failNetwork;
});

test('a network-level failure opens the cooldown — one bad answer, not forty', async () => {
  await fetchPriceHistory({ address: null, chainId: 1 }).catch(() => {});
  const after = cgCalls();
  assert.ok(after >= 1, 'the first call does ask');
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 }).catch(() => {});
  await fetchPriceHistory({ address: '0xbeef', chainId: 1 }).catch(() => {});
  assert.equal(cgCalls(), after, 'cooldown active: no further CoinGecko requests');
});

test('the cooldown is written to localStorage — a reload keeps it', async () => {
  await fetchPriceHistory({ address: null, chainId: 1 }).catch(() => {});
  const raw = lsStore.get('bear.cgCooldownUntil');
  assert.ok(raw, 'the endpoint verdict must survive a reload, like the logo miss memory');
  assert.ok(Number(raw) > Date.now(), 'stored value is a future deadline');
});

test('a persisted cooldown suppresses the fetch with fresh module state', async () => {
  resetCgCooldown();                                   // fresh module…
  lsStore.set('bear.cgCooldownUntil', String(Date.now() + 60_000));
  await fetchPriceHistory({ address: null, chainId: 1 }).catch(() => {});
  assert.equal(calls.length, 0, 'storage is the memory a reload keeps');
});

test('an expired cooldown asks again — backoff ends, verdict does not stick', async () => {
  lsStore.set('bear.cgCooldownUntil', String(Date.now() - 1));
  globalThis.fetch = async (url) => { calls.push(String(url)); return ok({ prices: [[1, 2], [2, 3]] }); };
  const data = await fetchPriceHistory({ address: null, chainId: 1 });
  assert.ok(calls.length >= 1, 'expired deadline is no deadline');
  assert.ok(data.length >= 2, 'and the data flows again');
});

test('DexScreener is NOT behind the CoinGecko cooldown — different host, different limit', async () => {
  await fetchPriceHistory({ address: null, chainId: 1 }).catch(() => {});   // opens cooldown
  const cgCalls = calls.length;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('dexscreener')) return ok({ tokens: [{ price: '1.5' }] });
    return failNetwork(url);
  };
  await fetchPriceHistory({ address: '0xabc', chainId: 1 }).catch(() => {});
  assert.ok(calls.slice(cgCalls).some(u => u.includes('dexscreener')),
    'the fallback host must still be tried while CoinGecko cools down');
});

test('backoff grows per failed probe and resets on success — no periodic storm', async () => {
  // Flat 60s still stormed: capture t=367s showed the cooldown expiring and
  // three fresh errors the same minute. The ladder must grow, and a healthy
  // answer must restart it.
  const deadlines = [];
  for (let i = 0; i < 4; i++) {
    await fetchPriceHistory({ address: '0x' + i.toString().padStart(4, '0'), chainId: 1 }).catch(() => {});
    deadlines.push(Number(lsStore.get('bear.cgCooldownUntil')));
    // Simulate the cooldown having EXPIRED while keeping the strike count —
    // resetCgCooldown wipes both, which would flatten the ladder to 1 minute.
    const strikes = lsStore.get('bear.cgCooldownStrikes');
    resetCgCooldown();
    if (strikes) lsStore.set('bear.cgCooldownStrikes', strikes);
    lsStore.set('bear.cgCooldownUntil', String(Date.now() - 1));
  }
  const gaps = deadlines.map((d, i) => d - (i ? deadlines[i - 1] : Date.now()));
  // Probe 4 fails → its window must be wider than probe 1's (real growth).
  assert.ok(gaps[3] > gaps[0] * 2, `ladder grows: ${gaps.map(g => Math.round(g / 1000))}s`);
  assert.ok(deadlines.every(d => d > 0), 'every probe filed a future deadline');

  // A success wipes the ladder: next failure starts back at the base minute.
  resetCgCooldown();
  globalThis.fetch = async (url) => { calls.push(String(url)); return ok({ prices: [[1, 2], [2, 3]] }); };
  await fetchPriceHistory({ address: '0xfeed', chainId: 1 });
  assert.equal(lsStore.get('bear.cgCooldownStrikes'), undefined, 'healthy probe forgets the strikes');
});

test('a healthy endpoint is untouched by the cooldown logic', async () => {
  resetCgCooldown();
  clearPriceCache();
  const prices = Array.from({ length: 10 }, (_, i) => [i, 100 + i]);
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('coingecko')) return ok({ prices });
    throw new TypeError('Failed to fetch');
  };
  const data = await fetchPriceHistory({ address: '0xfeed', chainId: 1, days: 2 });
  assert.ok(calls.some(u => u.includes('market_chart')), 'success path still fetches');
  assert.ok(data.length >= 2, 'and serves the chart');
  assert.equal(lsStore.get('bear.cgCooldownUntil'), undefined, 'no cooldown for a healthy endpoint');
});
