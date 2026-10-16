// Bear Tool — tests/dex-pf-pnl.test.js
// R12: the Portfolio's simple P&L — average buy price and net result, built
// ONLY from this wallet's own Swap events in the pair. The rules under test:
// cost basis is folded from real events (never remembered locally), a window
// that could not be read whole never becomes a number, and the sign lives in
// the number rather than in the colour alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ethers: E } = await import('ethers');
const { swapLegs, foldMySwaps, holdValue, pnlOf } = await import('../js/dex/portfolio.js');
const { quotePerToken } = await import('../js/dex/pool-list.js');
const { t, setLang } = await import('../js/i18n.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const data = (quoteIn, aIn, aOut) => E.AbiCoder.defaultAbiCoder()
  .encode(['bool', 'uint256', 'uint256'], [quoteIn, aIn, aOut]);

test('swapLegs reads both directions and refuses to guess', () => {
  assert.deepEqual(swapLegs(E, { data: data(true, 111n, 222n) }), { quoteIn: true, quote: 111n, tokens: 222n });
  assert.deepEqual(swapLegs(E, { data: data(false, 333n, 444n) }), { quoteIn: false, quote: 444n, tokens: 333n });
  assert.equal(swapLegs(E, { data: '0xdead' }), null, 'unreadable data is skipped, never guessed');
});

test('foldMySwaps adds the right side of every leg', () => {
  const legs = [
    { quoteIn: true, quote: 100n, tokens: 1000n },
    { quoteIn: true, quote: 50n, tokens: 400n },
    { quoteIn: false, quote: 80n, tokens: 500n },
  ];
  assert.deepEqual(foldMySwaps(legs), { spent: 150n, bought: 1400n, received: 80n, sold: 500n });
  assert.deepEqual(foldMySwaps([]), { spent: 0n, bought: 0n, received: 0n, sold: 0n });
});

test('average buy price and holding value use the pool’s own math', () => {
  // Two buys of 30 quote-wei total for 60 token base units (18 decimals):
  // 30 * 10^18 / 60 = 0.5 quote-wei per whole token.
  assert.equal(quotePerToken(30n, 60n, 18), 500000000000000000n);
  // 60 base units at 0.5/whole → 30 quote-wei back.
  assert.equal(holdValue(60n, 500000000000000000n, 18), 30n);
  assert.equal(holdValue(0n, 500000000000000000n, 18), 0n, 'no balance, no value');
});

test('pnlOf is value + sold − spent with a signed bps, and refuses a zero basis', () => {
  assert.deepEqual(pnlOf({ spent: 100n, received: 20n, value: 130n }), { pnl: 50n, bps: 5000n });
  assert.deepEqual(pnlOf({ spent: 100n, received: 0n, value: 80n }), { pnl: -20n, bps: -2000n });
  assert.equal(pnlOf({ spent: 0n, received: 5n, value: 5n }), null,
    'a P&L against a zero cost basis would be a made-up number');
});

test('the tab reads only this wallet’s swaps, whole-window-only', () => {
  const src = read('../js/dex/portfolio.js');
  assert.match(src, /topics: \[E\.id\(SWAP_TOPIC\), E\.zeroPadValue\(String\(me\)\.toLowerCase\(\), 32\)\]/,
    'the topic filter is the wallet’s own address — nobody else’s trades enter a cost basis');
  assert.match(src, /chunkedGetLogs/, 'the scan goes through the one chunked reader');
  assert.match(src, /lenient: true/, 'a partial window must be detectable');
  assert.match(src, /if \(!read \|\| read\.partial \|\| read\.reason\) return \{ ok: false \};/,
    'a partial or refused read never becomes a number');
  assert.match(src, /data-dex-pf-pnl/, 'the token card carries a slot for the line');
  assert.match(src, /isConnected/, 'a scan that lands after navigation writes to nobody');
});

test('the line exists in both languages — all six states translated', () => {
  const keys = ['dex.pf.pnlReading', 'dex.pf.avg', 'dex.pf.pnl', 'dex.pf.noBuys', 'dex.pf.noSpot', 'dex.pf.pnlUnread'];
  for (const lang of ['en', 'id']) {
    setLang(lang);
    for (const k of keys) assert.ok(t(k) !== k, `${k} must be translated (${lang})`);
  }
  setLang('en');
  assert.match(t('dex.pf.avg'), /\{\{v\}\}/, 'avg takes the price in the double-brace format __() replaces');
  assert.match(t('dex.pf.avg'), /\{\{q\}\}/, 'avg takes the quote symbol');
  assert.match(t('dex.pf.pnl'), /\{\{v\}\}/);
  assert.match(t('dex.pf.pnl'), /\{\{p\}\}/, 'pnl takes the percent');
  setLang('en');
});

test('up and down read differently, and the sign is in the number', () => {
  const css = read('../css/dex.css');
  assert.match(css, /\.dex-pf-up\b/, 'the up tone has a rule');
  assert.match(css, /\.dex-pf-down\b/, 'the down tone has a rule');
  const src = read('../js/dex/portfolio.js');
  assert.match(src, /neg \? '-' : '\+'/, 'the number itself carries the sign, not just the tone');
});
