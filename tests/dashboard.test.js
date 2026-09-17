// Bear Tool — dashboard.test.js
// Invariants for the home dashboard: the portfolio total must be the sum of
// what the user actually holds (amount × unit price) — summing unit prices
// made "$0.99" out of 1 ETH. The token chart must render real 24h history;
// it used to invent a fresh random walk on every open ("chart ga konsisten").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const price = fs.readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');

test('dashboard: total balance = sum of holding value, not sum of unit prices', () => {
  assert.match(
    app,
    /const totalUsd = tokens\.reduce\(\(s, t\) => s \+ holdingUsd\(t\), 0\);/,
    'home total must use holdingUsd (amount × price)'
  );
  assert.match(app, /function holdingUsd\(t\)/, 'holdingUsd helper must exist');
  assert.match(
    app,
    /ethers\.formatUnits\(t\.balance \|\| '0', t\.decimals \?\? 18\)/,
    'holdingUsd must convert wei → decimal amount'
  );
  // the old buggy reduction must be gone
  assert.doesNotMatch(
    app,
    /tokens\.reduce\(\(s, t\) => s \+ \(t\.usd \|\| 0\), 0\)/,
    'unit-price sum must not come back'
  );
});

test('dashboard: asset row shows the user holding value, not the unit price', () => {
  assert.match(
    app,
    /class="usd">\$\{t\.usd \? escapeHtml\(fmtUsd\(holdingUsd\(t\)\)\)/,
    'asset row USD cell must be the holding value'
  );
});

test('dashboard: token modal separates holding value from unit price', () => {
  assert.match(app, /holding = Number\(ethers\.formatUnits\(balance \|\| '0', decimals\)\) \* usd/,
    'modal must compute holding value = amount × unit price');
  assert.match(app, /fmtUsd\(holding\)/, 'modal headline must be the holding value');
  assert.match(app, /@ \$\{escapeHtml\(fmtUsd\(usd\)\)\} \/ \$\{escapeHtml\(symbol\)\}/,
    'modal must label the unit price separately');
});

test('dashboard: mini chart renders real 24h history (no random walk)', () => {
  assert.doesNotMatch(app, /Generate fake price data/, 'random-walk generator must be gone');
  assert.match(app, /async function drawMiniChart\(\{ symbol, address \}\)/);
  assert.match(app, /fetchPriceHistory\(\{ address, chainId \}\)/,
    'chart must source real history');
  assert.match(app, /paintMessage\('No 24h chart data'\)/,
    'must show an honest empty state instead of invented data');
  // and the data source itself is exported by price.js
  assert.match(price, /export async function fetchPriceHistory/);
});

test('dashboard: chart awaits are guarded against a closed/reopened modal', () => {
  assert.match(app, /if \(!canvas\.isConnected \|\| document\.getElementById\('tokenPriceChart'\) !== canvas\) return;/,
    'stale canvas writes must bail out after awaiting history');
});
