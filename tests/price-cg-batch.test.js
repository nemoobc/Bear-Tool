// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/price-cg-batch.test.js
// BATCHED token price requests (was: CoinGecko's one-address-per-request cap).
//
// CoinGecko's keyless tier rejected multi-address calls (400 error_code 10012)
// so the wallet's token list had to be split into single-address requests.
// DexScreener's /tokens/v1/{chainId}/{addresses} takes a COMMA-SEPARATED list,
// so the same wallet is now ONE request instead of N — that is the limit fix,
// not a preference. This file pins the chunker that keeps a request inside the
// documented batch size.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { tokenPriceChunks, TOKEN_PRICE_BATCH } from '../js/price.js';

const src = readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');

test('the batch size stays inside what DexScreener documents', () => {
  assert.ok(TOKEN_PRICE_BATCH >= 2 && TOKEN_PRICE_BATCH <= 30,
    'DexScreener documents up to 30 addresses per request');
});

test('a list of eight tokens is ONE request, not eight', () => {
  const addrs = Array.from({ length: 8 }, (_, i) => '0x' + String(i).repeat(2).padStart(40, '0'));
  const chunks = tokenPriceChunks(addrs);
  assert.equal(chunks.length, 1, 'the old CoinGecko cap forced one address per call');
  assert.equal(chunks[0].length, 8);
});

test('a list larger than the batch size splits, and only there', () => {
  const addrs = Array.from({ length: 60 }, (_, i) => '0x' + String(i).padStart(40, '0'));
  const chunks = tokenPriceChunks(addrs);
  assert.equal(chunks.length, Math.ceil(60 / TOKEN_PRICE_BATCH));
  for (const c of chunks) assert.ok(c.length <= TOKEN_PRICE_BATCH, `chunk over the cap: ${c.length}`);
  assert.deepEqual(chunks.flat(), addrs.map((a) => a.toLowerCase()), 'no address lost or reordered');
});

test('the addresses are preserved across the chunks (lower-cased)', () => {
  const flat = tokenPriceChunks(['0xAAA', '0xBBB', '0xCCC']).flat();
  assert.deepEqual(flat, ['0xaaa', '0xbbb', '0xccc']);
});

test('duplicates collapse, because a repeated address is a wasted slot', () => {
  const chunks = tokenPriceChunks(['0xAAA', '0xaaa', '0xAAA', '0xBBB']);
  assert.equal(chunks.flat().length, 2);
});

test('junk entries are dropped rather than sent', () => {
  const chunks = tokenPriceChunks(['', null, undefined, '0xAAA']);
  assert.deepEqual(chunks.flat(), ['0xaaa']);
});

test('an empty or missing list produces no requests at all', () => {
  assert.deepEqual(tokenPriceChunks([]), []);
  assert.deepEqual(tokenPriceChunks(null), []);
  assert.deepEqual(tokenPriceChunks(undefined), []);
});

test('a batch size of zero or junk still yields valid non-empty chunks', () => {
  // Math.max(1, …) is what stops a mis-set size from producing empty requests.
  for (const bad of [0, -3, NaN, 'x', null]) {
    const chunks = tokenPriceChunks(['0xAAA', '0xBBB'], bad);
    for (const c of chunks) assert.ok(c.length >= 1, `empty chunk from size ${bad}`);
  }
});

test('the batching is used, not bypassed by a single unbounded request', () => {
  assert.match(src, /tokenPriceChunks\(/, 'fetchTokenPrices must chunk');
  // The join is fine — but it must join a CHUNK. Pin the loop that walks them.
  assert.match(src, /for \(const chunk of tokenPriceChunks\(addresses\)\)/,
    'the request list must come from the chunker, not the raw address list');
});

test('one failed chunk does not throw away the prices already fetched', () => {
  // The old code threw on !res.ok, so a single bad answer voided every price.
  // A partial answer is still a useful answer, and the fallback picks up the rest.
  assert.ok(!/if \(!res\.ok\) throw new Error\('CoinGecko ' \+ res\.status\)/.test(src),
    'the CoinGecko throwing path must be gone');
  assert.match(src, /catch \{ \/\* this chunk goes to the DefiLlama retry below \*\/ \}/,
    'a failing chunk must be collected, not thrown');
});

test('the whole wallet walks DexScreener first, then DefiLlama — two hosts, two budgets', () => {
  assert.match(src, /api\.dexscreener\.com\/tokens\/v1/, 'primary = DexScreener batch');
  assert.match(src, /coins\.llama\.fi\/prices\/current/, 'fallback = DefiLlama coins API');
  // CoinGecko must not be reachable at all from this module any more.
  assert.ok(!/api\.coingecko\.com/.test(src), 'CoinGecko must be fully removed from price.js');
});
