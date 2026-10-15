// Bear Tool — tests/dex-lp.test.js
//
// The Liquidity previews must mirror the contract's mint/burn rules to the
// wei, exactly like swapQuote mirrors the pair's swap math. The numbers below
// are hand-computed from the rules, not copied from the implementation:
//
//   mint: shares = min(quoteIn × supply / quoteReserve,
//                      tokenIn × supply / tokenReserve)   [floor]
//   burn: quoteOut = shares × quoteReserve / supply        [floor]
//         tokenOut = shares × tokenReserve / supply        [floor]
//   floors: amountOut × (10000 − bps) / 10000              [floor]
import { test } from 'node:test';
import assert from 'node:assert/strict';

// core.js reads localStorage at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { addPreview, removePreview } = await import('../js/dex/lp.js');

const E18 = 10n ** 18n;
// A launched pool: 500 quote / 800,000 token, supply = sqrt(500e18 × 800000e18)
// = 2e22 shares (the same shape the anvil e2e produces).
const RQ = 500n * E18;
const RT = 800_000n * E18;
const SUPPLY = 2n * 10n ** 22n;

test('addPreview mints the min of the two proportional claims (balanced)', () => {
  // quoteIn 100, tokenIn 160000 — exactly the reserves' ratio (1 : 1600):
  // s1 = 100e18 × 2e22 / 500e18 = 4e21;  s2 = 160000e18 × 2e22 / 800000e18 = 4e21
  const p = addPreview({ quoteIn: 100n * E18, tokenIn: 160_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(p.ok, true);
  assert.equal(p.shares, 4n * 10n ** 21n, 'shares must be the shared proportional claim');
  // floor at 50 bps: 4e21 × 9950 / 10000 = 3.98e21
  assert.equal(p.minShares, 3_980_000_000_000_000_000_000n, 'minShares must be the 0.5% floor');
});

test('addPreview takes the WEAKER side — an unbalanced deposit mints less', () => {
  // tokenIn halved (80000 instead of 160000): s2 = 2e21 < s1 = 4e21
  const p = addPreview({ quoteIn: 100n * E18, tokenIn: 80_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(p.ok, true);
  assert.equal(p.shares, 2n * 10n ** 21n, 'the weaker side is the claim — the rest is a gift to the pool');
});

test('removePreview returns both sides floored, with both minOut floors', () => {
  // shares 1e21 out of supply 2.5e22 back from reserves (600, 800000):
  // quoteOut = 1e21 × 600e18 / 2.5e22 = 2.4e19;  tokenOut = 1e21 × 800000e18 / 2.5e22 = 3.2e22
  const p = removePreview({ shares: 1n * 10n ** 21n, quoteReserve: 600n * E18, tokenReserve: 800_000n * E18, supply: 25n * 10n ** 21n });
  assert.equal(p.ok, true);
  assert.equal(p.quoteOut, 24_000_000_000_000_000_000n);
  assert.equal(p.tokenOut, 32_000_000_000_000_000_000_000n);
  assert.equal(p.minQuote, 23_880_000_000_000_000_000n, 'floor at 50 bps: × 9950 / 10000');
  assert.equal(p.minToken, 31_840_000_000_000_000_000_000n);
});

test('both previews refuse nonsense instead of inventing numbers', () => {
  assert.equal(addPreview({ quoteIn: 0n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'amounts');
  assert.equal(addPreview({ quoteIn: 1n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: 0n }).reason, 'shares');
  assert.equal(removePreview({ shares: 0n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'amounts');
  assert.equal(removePreview({ shares: 1n, quoteReserve: 0n, tokenReserve: RT, supply: SUPPLY }).reason, 'reserves');
  // A deposit too small to mint even one share is refused, not rounded up.
  assert.equal(addPreview({ quoteIn: 1n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'too small');
});
