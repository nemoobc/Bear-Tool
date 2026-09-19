// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/opensea-api.test.js
// OpenSea API module: WL check, listings, offers, highest offer
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const apiSrc = readFileSync(new URL('../js/opensea-api.js', import.meta.url), 'utf8');

test('opensea-api: exports checkWL function', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+checkWL/);
});
test('opensea-api: exports getMintEstimate function', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getMintEstimate/);
});
test('opensea-api: exports getListings function', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getListings/);
});
test('opensea-api: exports getOffers function', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getOffers/);
});
test('opensea-api: exports getHighestOffer function', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getHighestOffer/);
});
test('opensea-api: uses OpenSea API v2 base URL', () => {
  assert.match(apiSrc, /api\.opensea\.io\/api\/v2/);
});
test('opensea-api: reads API key from config (not hardcoded)', () => {
  assert.match(apiSrc, /__OPENSEA_API_KEY|getApiKey/);
});
test('opensea-api: checkWL returns eligible boolean', () => {
  assert.match(apiSrc, /eligible.*!wl|eligible.*true|eligible.*false/);
});
test('opensea-api: getMintEstimate returns price + gas + total', () => {
  assert.match(apiSrc, /gasEstimate/);
  assert.match(apiSrc, /total.*price|price.*total/);
});
test('opensea-api: getHighestOffer sorts by price desc', () => {
  assert.match(apiSrc, /sort.*b\.price\s*-\s*a\.price|sort.*price.*desc/);
});
test('opensea-api: no hardcoded secrets (HUKUM 9)', () => {
  const noSecret = !apiSrc.match(/qYSDUOSxp6|sk-[A-Za-z0-9]{20,}|-----BEGIN.*PRIVATE/);
  assert.ok(noSecret, 'API key must NOT be hardcoded in source');
});
