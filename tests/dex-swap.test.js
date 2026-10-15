// Bear Tool — tests/dex-swap.test.js
// The swap engine's pure half: what the user typed becomes base units, and a
// quote is the contract's own floor math — same 997/1000, same reserve ORDER
// (buy pulls the quote side, sell the token side), same minOut. The numbers
// below are computed by hand (one round of long division, pinned):
//   buy 100 quote against (500 quote, 800000 token) → 132999.833249958312489578
//   sell 1000 token against the same reserves       → 0.622349397063909103 quote
// If either direction ever swaps its reserves, both results change and this
// file fails — which is the point. The LIVE proof that these numbers match the
// chain is tests/dex-v2-onchain-e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.ethers = await import('ethers');

const { parseAmount, swapQuote, DEFAULT_SLIPPAGE_BPS } = await import('../js/dex/swap.js');

const E18 = 10n ** 18n;

test('parseAmount is exact: decimals are obeyed, never silently trimmed', () => {
  assert.deepEqual(parseAmount('1', 18), { ok: true, value: E18 });
  assert.deepEqual(parseAmount('1.5', 18), { ok: true, value: 15n * 10n ** 17n });
  assert.deepEqual(parseAmount('.5', 18), { ok: true, value: 5n * 10n ** 17n });
  assert.deepEqual(parseAmount('1.', 18), { ok: true, value: E18 });
  assert.equal(parseAmount('1', 6).value, 1_000_000n, 'decimals are the token’s, not 18 by habit');
  assert.equal(parseAmount('0.000000000000000001', 18).value, 1n, 'one wei is typeable');

  assert.equal(parseAmount('0.0000000000000000001', 18).ok, false, '19th decimal is refused, not trimmed');
  assert.equal(parseAmount('0.0000000000000000001', 18).reason, 'too many decimals');
  assert.equal(parseAmount('1,5', 18).ok, false, 'a comma is ambiguous (1.5 vs 1500) — refused');
  assert.equal(parseAmount('1e3', 18).ok, false);
  assert.equal(parseAmount('abc', 18).ok, false);
  assert.equal(parseAmount('', 18).ok, false);
  assert.equal(parseAmount('0', 18).ok, false, 'zero is not a swap');
  assert.equal(parseAmount('0.0', 18).reason, 'zero');
  assert.equal(parseAmount('1', 37).reason, 'decimals', 'a decimals value that cannot be a token’s is refused');
});

test('swapQuote(buy): quote in, token out — pinned against hand-computed floor', () => {
  const q = swapQuote({
    quoteReserve: 500n * E18,
    tokenReserve: 800_000n * E18,
    direction: 'buy',
    amountIn: 100n * E18,
  });
  assert.equal(q.ok, true);
  assert.equal(q.amountOut, 132_999_833_249_958_312_489_578n,
    'buy must price amountIn against (quoteReserve, tokenReserve) — the quote side is the input');
  assert.equal(q.minOut, 132_334_834_083_708_520_927_130n, 'default slippage is 0.5%');
  assert.equal(DEFAULT_SLIPPAGE_BPS, 50);
});

test('swapQuote(sell): token in, quote out — the reserves swap places, the math does not', () => {
  const q = swapQuote({
    quoteReserve: 500n * E18,
    tokenReserve: 800_000n * E18,
    direction: 'sell',
    amountIn: 1000n * E18,
    slippageBps: 100,
  });
  assert.equal(q.ok, true);
  assert.equal(q.amountOut, 622_349_397_063_909_103n,
    'sell must price amountIn against (tokenReserve, quoteReserve)');
  assert.equal(q.minOut, 616_125_903_093_270_011n, '100 bps of a non-round number, floored');
});

test('swapQuote refuses what the contract would refuse — before any transaction', () => {
  assert.equal(swapQuote({ quoteReserve: 1n, tokenReserve: 1n, direction: 'buy', amountIn: 0n }).reason, 'amount');
  assert.equal(swapQuote({ quoteReserve: 0n, tokenReserve: 1n, direction: 'buy', amountIn: 5n }).reason, 'reserves');
  assert.equal(swapQuote({ quoteReserve: 1n, tokenReserve: 1n, direction: 'sell', amountIn: 5n }).reason,
    'too small', 'a 1-wei-outside pool is a dust pool: the fee floors the output to zero');
  assert.equal(swapQuote({ quoteReserve: 0n, tokenReserve: 5n, direction: 'sell', amountIn: 5n }).reason,
    'reserves', 'an empty quote side is refused for a sell — the out-side is the one that must exist');
  // amount so small the fee eats it entirely: refused as "too small", not quoted as 0.
  assert.equal(swapQuote({ quoteReserve: 10n ** 30n, tokenReserve: 10n ** 30n, direction: 'buy', amountIn: 1n }).reason,
    'too small');
});
