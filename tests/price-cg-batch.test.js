// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/price-cg-batch.test.js
// CoinGecko's public tier allows ONE contract address per request.
//
// The app used to send the wallet's entire token list in a single call, which
// answers 400 with error_code 10012. That is a hard rejection, not a throttle,
// so every price in the list was lost at once. Verified live against the API:
// one address returns 200, eight return 400.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cgTokenPriceChunks, CG_MAX_ADDRESSES } from '../js/price.js';

const src = readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');

test('the free-tier limit is one address per request', () => {
  assert.equal(CG_MAX_ADDRESSES, 1,
    'this is a fact about the public API, not a preference; if it is wrong the 400 returns');
});

test('a list of eight tokens becomes eight single-address requests', () => {
  const addrs = Array.from({ length: 8 }, (_, i) => '0x' + String(i).repeat(2).padStart(40, '0'));
  const chunks = cgTokenPriceChunks(addrs);
  assert.equal(chunks.length, 8);
  for (const c of chunks) assert.equal(c.length, 1, 'no request may carry two addresses');
});

test('the addresses are preserved across the chunks', () => {
  const addrs = ['0xAAA', '0xBBB', '0xCCC'];
  const flat = cgTokenPriceChunks(addrs).flat();
  assert.deepEqual(flat, ['0xaaa', '0xbbb', '0xccc']);
});

test('duplicates collapse, because a repeated address is a wasted request', () => {
  const chunks = cgTokenPriceChunks(['0xAAA', '0xaaa', '0xAAA', '0xBBB']);
  assert.equal(chunks.flat().length, 2);
});

test('junk entries are dropped rather than sent', () => {
  const chunks = cgTokenPriceChunks(['', null, undefined, '0xAAA']);
  assert.deepEqual(chunks.flat(), ['0xaaa']);
});

test('an empty or missing list produces no requests at all', () => {
  assert.deepEqual(cgTokenPriceChunks([]), []);
  assert.deepEqual(cgTokenPriceChunks(null), []);
  assert.deepEqual(cgTokenPriceChunks(undefined), []);
});

test('a batch size of zero or junk still yields valid single-address chunks', () => {
  // Math.max(1, …) is what stops a mis-set size from producing empty requests.
  for (const bad of [0, -3, NaN, 'x', null]) {
    const chunks = cgTokenPriceChunks(['0xAAA', '0xBBB'], bad);
    for (const c of chunks) assert.ok(c.length >= 1, `empty chunk from size ${bad}`);
  }
});

test('the batching is used, not bypassed by a single joined request', () => {
  // The regression this file exists for: one request carrying every address.
  assert.match(src, /cgTokenPriceChunks\(/, 'fetchCoinGeckoTokens must chunk');
  assert.ok(
    !/contract_addresses: addresses\.join\(','\)/.test(src),
    'the unbounded single request must be gone',
  );
});

test('one failed chunk does not throw away the prices already fetched', () => {
  // The old code threw on !res.ok, so a single 400 voided every price. A partial
  // answer is still a useful answer, and the fallback provider picks up the rest.
  assert.ok(!/if \(!res\.ok\) throw new Error\('CoinGecko ' \+ res\.status\);\s*const data = await res\.json\(\);\s*\/\/ Normalise/.test(src),
    'the throwing path must be gone from the token fetcher');
  assert.match(src, /consecutiveFailures/, 'failures must be counted, not thrown');
});

test('the breaker stops after two consecutive failures, not after one', () => {
  // One failure is noise. Two in a row means the endpoint is unhappy and the
  // remaining twenty-odd requests would only add console noise — the limiter
  // answers with an error page carrying no CORS headers, so the console blames
  // CORS and hides the real cause.
  assert.match(src, /if \(\+\+consecutiveFailures >= 2\) break;/,
    'the loop must break on the SECOND consecutive failure');
  assert.ok(!/if \(consecutiveFailures >= 1\) break;/.test(src),
    'breaking on the first failure would give up too eagerly');
  assert.match(src, /consecutiveFailures = 0;/, 'a success must reset the counter');
});
