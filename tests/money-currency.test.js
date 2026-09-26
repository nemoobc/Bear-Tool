// Choosing a currency used to produce a wrong number wearing the right symbol.
//
// Measured, not assumed: with Indonesian rupiah selected, fetchAllPrices
// returned 48,172,840 — a rupiah figure — and fmtUsd printed "$48,172,840".
// The field it was stored in was called `usd`. The DexScreener fallback made it
// worse rather than better, because that endpoint only quotes USD: one asset
// list could hold rupiah in the CoinGecko rows and dollars in the DexScreener
// rows, and every row looked equally trustworthy.
//
// The fix is a single canonical unit. Everything fetched, cached and stored is
// USD; the conversion happens once, at the edge, in fmtUsd. So the test is not
// "IDR looks about right" — it is that the stored number is byte-identical
// whatever the display currency is, because if it is not, two sources are
// writing two currencies into one list again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMoneyRate, fmtUsd, usdToDisplay, moneyCurrency } from '../js/ui.js';

const price = readFileSync(new URL('../js/price.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('fmtUsd converts and takes the right symbol', () => {
  // Computed, not hand-written. A hardcoded expected figure is a second thing to
  // be wrong, and the first version of this test was: 2688.34 x 17914.08 is
  // 48,159,137.83, not 48,159,150.24, and the code was right.
  const ETH = 2688.34;
  const show = (cur, rate) => { setMoneyRate(cur, rate); return fmtUsd(ETH); };
  assert.equal(show('usd', 1), '$2,688.34');
  assert.equal(show('idr', 17914.08), 'Rp ' + (ETH * 17914.08).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  assert.equal(show('eur', 0.88), '€' + (ETH * 0.88).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  assert.equal(show('cny', 6.71), '¥' + (ETH * 6.71).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  setMoneyRate('usd', 1);
});

test('every currency the Settings picker offers has a symbol', () => {
  // Scope it to the currency select. A bare /<option value="(\w{3})"/ over the
  // whole document also matches token lists and produced a currency called "HOP".
  const sel = settings.slice(settings.indexOf('id="setCurrency"'));
  const offered = [...sel.slice(0, sel.indexOf('</select>')).matchAll(/<option value="(\w{3})"/g)].map((m) => m[1]);
  assert.deepEqual(offered, ['usd', 'eur', 'idr', 'cny']);
  for (const cur of offered) {
    setMoneyRate(cur, 1);
    // A fallback like "JPY 1" is honest; a bare number with no currency at all is
    // the bug this file exists to prevent.
    assert.match(fmtUsd(1), /[^\d.,]\s?1$/, `${cur} must render with a symbol, got "${fmtUsd(1)}"`);
    assert.equal(moneyCurrency().cur, cur);
  }
  setMoneyRate('usd', 1);
});

test('a broken rate shows the right number, never an empty wallet', () => {
  // The tempting failure: a currency lookup fails, the rate is 0 or NaN, and
  // every balance in the app renders as 0.00. A wallet that looks empty is a
  // scarier thing to show someone than money in the wrong currency.
  for (const bad of [0, -5, NaN, Infinity, null, undefined, 'x']) {
    setMoneyRate('idr', bad);
    assert.equal(usdToDisplay(100), 100, `rate ${bad} must fall back to 1:1, not zero`);
    // maximumFractionDigits, not minimum: a whole amount prints as "100", which
    // is what it has always done and is not what this test is about.
    assert.match(fmtUsd(100), /100$/, `rate ${bad} must still show the amount, got "${fmtUsd(100)}"`);
  }
  setMoneyRate('usd', 1);
});

test('an unknown currency still renders, it does not go blank', () => {
  setMoneyRate('jpy', 150);
  assert.match(fmtUsd(1), /150$/, 'an unlisted currency must still convert');
  assert.match(fmtUsd(1), /JPY/, 'and name itself rather than show a wrong symbol');
  setMoneyRate('usd', 1);
});

test('every price request is USD, so the cache means one thing', () => {
  // Not "requests the display currency" — that WAS the bug. If any request still
  // asks for vs_currencies: currency(), that row would come back in rupiah and
  // be stored beside dollar rows from DexScreener.
  assert.equal(price.includes('vs_currencies: cur'), false,
    'no request may ask CoinGecko for the display currency any more');
  assert.equal(price.includes('vs_currency: currency()'), false,
    'nor the chart endpoints');
  assert.equal((price.match(/vs_currencies: 'usd'/g) || []).length, 2,
    'both CoinGecko price calls must ask for usd');
  assert.match(price, /vs_currencies: `usd,\$\{cur\}`/,
    'and the rate comes from a request the app was making anyway, not a new quota');
});

test('the rate is published to the formatter from exactly one place', () => {
  assert.match(price, /function publishRate\(cur, rate\) \{\s*setMoneyRate\(cur, rate\);/,
    'one function owns the handoff');
  // One call site, not two: both branches (usd is 1:1, fetched from cache or
  // from the network) go through publishRate, so there is no second path that
  // can update the formatter without updating the cached rate.
  const publishes = [...price.matchAll(/setMoneyRate\(/g)].length;
  assert.equal(publishes, 1, `setMoneyRate must be called only by publishRate, found ${publishes} call sites`);
  // Four call sites, not two: usd is 1:1, a cached rate, a freshly fetched one,
  // and the fallback when the fetch fails. Every path that can change what the
  // formatter does must go through publishRate, or a branch updates the display
  // without updating the cache and the two disagree on the next reload.
  const calls = [...price.matchAll(/(?<!function )publishRate\(/g)].length;
  assert.equal(calls, 4, `every branch must publish, found ${calls} call sites`);
  // And each one carries a currency, so a rate can never be published for the
  // wrong display currency.
  for (const m of price.matchAll(/publishRate\(([^)]*)\)/g)) {
    assert.ok(/cur|'usd'/.test(m[1]), `publishRate(${m[1]}) must name a currency`);
  }
  assert.match(price, /export async function ensureUsdRate/);
  assert.match(price, /export function clearUsdRate/);
});

test('changing the currency drops the rate, not the price cache', () => {
  // Prices are USD now, so they survive a currency change. Clearing them meant
  // re-asking CoinGecko for every token in the wallet just to respell a number.
  // Cut the block at its own closing "\n  });" — indexOf('});') lands on
  // `set('settings', { ...s });` and truncates the handler before the part
  // under test, which is how the first version of this test reported a missing
  // clearUsdRate that was sitting two lines below it.
  const at = app.indexOf("$('#setCurrency')");
  assert.ok(at > -1, 'the currency handler must exist');
  const end = app.indexOf('\n  });', at);
  const block = app.slice(at, end);
  assert.match(block, /clearUsdRate\(\)/, 'the stale rate must be dropped');
  assert.doesNotMatch(block, /removeItem\('bear\.priceCache'\)/,
    'the USD price cache is still valid and must not be thrown away');
  assert.match(block, /await ensureUsdRate\(\)/, 'and the new one fetched before the redraw');
  assert.match(block, /renderAssets\(/, 'the numbers on screen must change with the control');
});

test('the chart reads in the same currency as the balance beside it', () => {
  // The chart axes are plain numbers with no symbol, so they are converted at
  // fetch time. Miss this and one screen shows two true numbers in two
  // currencies, side by side, with nothing to say so.
  assert.match(price, /usdToDisplay\(c\.open\)/, 'OHLC candles are converted');
  assert.match(price, /usdToDisplay\(raw\[/, 'history points are converted');
  assert.equal((price.match(/usdToDisplay\(/g) || []).length, 5,
    'four conversions plus the definition import — the pseudo-candle fallback must NOT convert twice');
  assert.match(price, /already in display currency[\s\S]{0,120}must not be scaled a second time/,
    'and the fallback that builds candles from history says why it is exempt');
});
