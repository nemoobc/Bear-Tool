// Bear Tool — token modal fidelity: the modal must show the SAME logo the list
// showed, and an empty chart must not pretend the token has no data when the
// real cause is CoinGecko's rate limit.
//
// Reported bug (2026-10-04): "beberapa list coin di luar ada logo pas dipencet
// logo ilang + chartnya ilang".
//
// Two independent causes, both proven:
//   1. LOGO — the list renders through tokenLogoHTML (MARKS table + cached
//      CoinGecko image by contract); the modal rendered through its own
//      getLogoSVG map with only 13 hardcoded symbols. Any token outside that
//      map (BNB, POL, ARB, any cached remote logo) showed a peach initial
//      disc in the modal while the list showed the real mark — the logo
//      "disappeared" the moment the modal opened.
//   2. CHART — fetchOHLC hits CoinGecko with zero 429 handling (node probe:
//      binancecoin/ohlc → {"error_code":429}); the pseudo-candle fallback
//      goes to the SAME host and dies the same way → [] → the modal painted
//      "No 24h data", i.e. "this token has no chart", when the truth was
//      "the rate limit is on".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const price = readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');

const modalBlock = app.slice(
  app.indexOf('function showTokenActions('),
  app.indexOf('function showReceiveModal(')
);

test('token modal: the header logo comes from the list renderer (tokenLogoHTML)', () => {
  assert.match(modalBlock, /token-modal-icon[^>]*>\$\{tokenLogoHTML\(symbol, 48, \{ address \}\)\}/,
    'the modal must render the logo through tokenLogoHTML with the contract, ' +
    'so it shows the same mark (cached image / MARKS entry) the list showed');
  assert.ok(!modalBlock.includes('getLogoSVG('),
    'the modal must not render through a second, private logo map');
});

test('token modal: the generated mark fallback is guarded (dead remote image → mark)', () => {
  // tokenLogoHTML can emit a cached remote <img>; without guardTokenLogos a
  // stale URL degrades to a broken-image icon inside the modal.
  assert.match(modalBlock, /guardTokenLogos\(/,
    'the modal must attach the onerror guard to its rendered logos');
});

test('app.js: getLogoSVG is gone — one renderer for list and modal', () => {
  assert.ok(!app.includes('function getLogoSVG('),
    'a second logo map is exactly how list and modal drifted apart');
});

test('chart: a 429 enters a cooldown instead of hammering the price host', () => {
  assert.match(price, /status === 429/,
    'fetch must detect the rate limit');
  assert.match(price, /cooldownUntil/,
    'a hard 429 must start a cooldown so retries do not deepen the penalty');
  assert.match(price, /429 retry|retry once|Rate-limited|rate-limited/i,
    'the rate limit must be named in the thrown error so callers can tell it apart');
});

test('chart: fetchOHLC surfaces a rate limit instead of swallowing it to []', () => {
  // Returning [] silently is what made the modal say "No data" about a token
  // that may well have a chart — the wrong claim about someone's coin.
  assert.match(price, /export async function fetchOHLC/);
  const fn = price.slice(price.indexOf('export async function fetchOHLC'),
    price.indexOf('export async function fetchPriceHistory'));
  assert.ok(!/catch\s*\(?\w*\)?\s*\{/.test(fn),
    'fetchOHLC must not swallow the error');
  // The rate-limit distinction lives in marketCandles: it RETHROWS the named
  // error and only returns [] for a genuine "no chart here".
  assert.match(price, /if \(isRateLimit\(e\)\) throw e;/,
    'a rate limit is rethrown, not collapsed into an empty chart');
  assert.match(price, /throw rateLimitError\(\)/,
    'and the named error is what reaches the caller');
});

test('chart: drawMiniChart says rate-limited, not "no data", when that is the cause', () => {
  const start = app.indexOf('async function drawMiniChart(');
  const end = app.indexOf('function getLogoSVG(', start) > -1
    ? app.indexOf('function getLogoSVG(', start)
    : app.indexOf('function showReceiveModal(', start);
  const fn = app.slice(start, end > start ? end : start + 6000);
  assert.match(fn, /rateLimited|rate-limited|Rate-limited/,
    'the painter must distinguish the rate limit from a genuine lack of data');
  assert.match(fn, /paintMessage\(rateLimited \? [`'"][^`'"]*[Rr]ate-limited[^`'"]*[`'"] : `No \$\{timeframe\} data`\)/,
    'the ternary must keep the honest "no data" message for the genuine case');
});
