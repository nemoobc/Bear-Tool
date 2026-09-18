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

// ── Home coin list + duplicate address + Swap/Bridge nav ──────────────────
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const swap = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');

test('dashboard: home shows popular coins even with a 0 balance', () => {
  const load = app.slice(app.indexOf('async function loadDashboard'), app.indexOf('async function loadDashboard') + 4000);
  // every popular token is pushed, not only the ones with bal > 0
  assert.doesNotMatch(load, /if \(bal > 0n\)/, 'zero-balance tokens must still be listed');
  assert.match(load, /results\.forEach\(\(r, i\) =>/, 'settled results must all be added');
  assert.match(load, /balance: '0', usd: null/, 'failed balance reads fall back to 0');
});

test('dashboard: swap offers popular tokens, not only the ones the user holds', () => {
  assert.match(swap, /for \(const p of \(POPULAR_TOKENS\[net\?\.chainId\] \|\| \[\]\)\)/,
    'swap list must fall back to the chain popular tokens');
  assert.match(swap, /tokens\.unshift\(\{/, 'native gas token must always be selectable');
});

test('swap: change-listeners are rebound, not stacked, on every view switch', () => {
  assert.match(swap, /if \(from\._bearBalanceHandler\) from\.removeEventListener\('change', from\._bearBalanceHandler\);/,
    'previous handler must be removed before adding a new one');
  assert.match(swap, /to\._bearBalanceHandler = updateBalance;/);
});

test('home: the wallet address is shown once, not twice', () => {
  assert.match(app, /\$\('#balanceSub'\)\.textContent = net\.name;/,
    'balanceSub must be the network name only');
  assert.doesNotMatch(app, /balanceSub'\)\.textContent = `\$\{net\.name\} · \$\{/,
    'address must not be duplicated into balanceSub');
});

test('nav: Bridge shares the Swap button (one entry, second click chooses)', () => {
  assert.doesNotMatch(html, /class="nav-item[^"]*" data-view="bridge"/,
    'separate Bridge sidebar item must be gone');
  assert.match(html, /class="nav-item nav-item-highlight" data-view="swap"/, 'Swap item stays');
  assert.match(html, /id="view-bridge"/, 'Bridge view must still exist');
  assert.match(app, /if \(view === 'swap' && \$\('#view-swap'\)\?\.classList\.contains\('active'\)\) \{\s*showSwapBridgeChooser\(\);/,
    're-clicking Swap must open the chooser');
  assert.match(app, /function showSwapBridgeChooser\(\)/);
  assert.match(app, /const navView = view === 'bridge' \? 'swap' : view;/,
    'Swap stays highlighted while Bridge is open');
});

test('password fields span the full width of their field', () => {
  const block = css.slice(css.indexOf('.password-wrap .input'), css.indexOf('.password-wrap .input') + 400);
  assert.match(block, /width: 100%/, 'password input must be full width');
  assert.match(block, /flex: 1 1 100%/, 'must not be shrinkable by the toggle button');
  assert.doesNotMatch(block, /font-size: 0\.85rem/, 'password text must match other inputs');
});
