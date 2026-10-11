// Bear Tool — token-logo-storm.test.js
// The console storm, pinned: a boot whose logo lookups all fail with
// CORS/network errors fired 46 paced requests anyway (live capture
// 2026-10-08: 50 console errors, 46 of them logo fetches), because
// (a) nothing told the batch the endpoint was sick, and (b) the miss memory
// lived only in the module, so every reload started the storm over.
//
// 2026-10-11: the lookup is now ONE batched DexScreener request for the whole
// wallet, so "46 requests" cannot even be built. The miss memory and the
// two-strike breaker stay — a batched outage must still not be retried on
// every render, and both must survive a reload.
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

const calls = [];
// Network-level failure: the browser hides the 429 body behind a CORS error,
// so the app sees a throw, not a status. That is what the live storm looked like.
globalThis.fetch = async (url) => {
  calls.push(String(url));
  throw new TypeError('Failed to fetch');
};

const { ensureTokenLogos, getCachedLogo, logoKeyFor, resetLogoMisses } = await import('../js/token-logo.js');

const reset = () => { store.clear(); calls.length = 0; resetLogoMisses(); };

const tok = (i) => ({ address: '0x' + String(i).repeat(40).slice(0, 40), symbol: 'T' + i });

test('two consecutive network failures stop the batch — the storm never reaches 46', async () => {
  reset();
  const tokens = Array.from({ length: 46 }, (_, i) => tok(i));
  await ensureTokenLogos(tokens, 1);
  assert.ok(calls.length <= 2,
    `endpoint declared sick after 2 failures; fired ${calls.length}`);
});

test('the tokens the breaker skipped are remembered too — no refetch on the next render', async () => {
  reset();
  const tokens = Array.from({ length: 10 }, (_, i) => tok(i));
  await ensureTokenLogos(tokens, 1);
  const after = calls.length;
  assert.ok(after <= 2, `first pass fires at most 2, fired ${after}`);
  await ensureTokenLogos(tokens, 1);
  assert.equal(calls.length, after, 'second render asks nothing new');
  for (const t of tokens) assert.equal(getCachedLogo(logoKeyFor(t)), null);
});

test('miss memory is written to localStorage — it survives a reload', async () => {
  reset();
  await ensureTokenLogos([tok(7)], 1);
  const raw = store.get('bear.logoMisses');
  assert.ok(raw, 'a miss must live outside the module: a reload drops module state');
  const parsed = JSON.parse(raw);
  const key = logoKeyFor(tok(7));
  assert.ok(parsed[key] > 0, `miss filed under the token key (${key})`);
});

test('a stored miss suppresses the fetch even with fresh module state', async () => {
  // Simulates the reload path exactly: a fresh module (empty Map — what a
  // reload gives you) whose localStorage still holds the miss.
  reset();
  const key = logoKeyFor(tok(9));
  store.set('bear.logoMisses', JSON.stringify({ [key]: Date.now() }));
  await ensureTokenLogos([tok(9)], 1);
  assert.equal(calls.length, 0, 'storage memory is what gates the fetch');
  store.clear();                   // expiry/GC path: no memory anywhere
  resetLogoMisses();
  await ensureTokenLogos([tok(9)], 1);
  assert.equal(calls.length, 1, 'no memory at all = a fair retry');
});

test('a healthy batch serves every token at once — the breaker is not a wall', async () => {
  reset();
  const GOOD = '0x' + 'a'.repeat(40);
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url).toLowerCase();
    if (!u.includes('tokens/v1/')) return { ok: false, status: 404, json: async () => ({}) };
    const pairs = [];
    if (u.includes(GOOD)) pairs.push({ baseToken: { address: GOOD }, info: { imageUrl: 'https://cdn.example/x.png' } });
    return { ok: true, status: 200, json: async () => pairs };
  };
  try {
    const tokens = [{ address: GOOD, symbol: 'G' }, tok(1), tok(2)];
    await ensureTokenLogos(tokens, 1);
    assert.equal(calls.length, 1, 'three tokens, ONE healthy request');
    assert.equal(getCachedLogo(logoKeyFor(tokens[0])), 'https://cdn.example/x.png');
    // The two the batch did not answer are MISSES (an answer, not an outage):
    // the next batch still runs — the breaker never tripped.
    const later = { address: '0x' + 'b'.repeat(40), symbol: 'L' };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => [
        { baseToken: { address: later.address }, info: { imageUrl: 'https://cdn.example/l.png' } },
      ] };
    };
    await ensureTokenLogos([later], 1);
    assert.equal(getCachedLogo(logoKeyFor(later)), 'https://cdn.example/l.png',
      'a short answer must not poison the next batch');
  } finally {
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('Failed to fetch'); };
  }
});
