// Bear Tool — claim-decimals-honest.test.js
//
// The reported bug: "Could not read token decimals/symbol — assuming 18."
// executeClaim used to swallow the failed read with an info toast and
// CONTINUE, encoding the claim's on-chain minimum with a guessed scale:
//
//   token USDC (6 dp), user types "100":
//     honest minWei = parseUnits('100', 6)  = 100000000
//     guessed minWei = parseUnits('100', 18) = 100000000000000000000
//   the helper's require(bal >= minAmount) then fails CLAIM<MIN — AFTER the
//   transaction was broadcast, so the sponsor's gas is burned and no claim
//   happens. Rescue survives the same failure only because its balance
//   guard (rescueWei > targetBal) refuses BEFORE broadcast; the claim has
//   no such guard, so an unreadable scale must fail CLOSED.
//
// readTokenScale splits the two reads: decimals are REQUIRED (null when
// unreadable → executeClaim stops), symbol is display-only ('?').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { ethers } = await import('ethers');
globalThis.ethers = ethers;
const { readTokenScale } = await import('../js/eip7702-tools.js');

/** Token double: per-method override; a throwing method simulates a node
 *  that cannot read it (non-standard token, wrong chain, rate limit). */
function tokenDouble({ decimals, symbol, throws = [] }) {
  return {
    decimals: async () => {
      if (throws.includes('decimals')) throw new Error('could not decode result data');
      return decimals;
    },
    symbol: async () => {
      if (throws.includes('symbol')) throw new Error('could not decode result data');
      return symbol;
    },
  };
}

test('unreadable decimals = null (the flow must stop, never guess 18)', async () => {
  const r = await readTokenScale(tokenDouble({ decimals: 6n, symbol: 'USDC', throws: ['decimals'] }));
  assert.equal(r.decimals, null, 'a guessed scale is how a doomed claim gets broadcast');
});

test('unreadable symbol does NOT discard a good decimals read', async () => {
  // The old single try/catch let a symbol() throw reset a decimals that had
  // already been read — the minimum encoding lost the one number it needed.
  const r = await readTokenScale(tokenDouble({ decimals: 6n, symbol: 'USDC', throws: ['symbol'] }));
  assert.equal(r.decimals, 6, 'the required number must survive a display-only failure');
  assert.equal(r.symbol, '?');
});

test('out-of-range decimals is unreadable, not usable', async () => {
  const r = await readTokenScale(tokenDouble({ decimals: 999n, symbol: 'X' }));
  assert.equal(r.decimals, null, '999 dp is not a scale the guard can be encoded with');
  const bad = await readTokenScale(tokenDouble({ decimals: -1n, symbol: 'X' }));
  assert.equal(bad.decimals, null);
});

test('zero-decimal tokens stay ZERO, not null (0 != missing)', async () => {
  // `scale.decimals == null` must not swallow a legitimate 0-dp token.
  const r = await readTokenScale(tokenDouble({ decimals: 0n, symbol: 'Z' }));
  assert.equal(r.decimals, 0);
  assert.equal(r.symbol, 'Z');
});

test('a healthy read passes both through (regression)', async () => {
  const r = await readTokenScale(tokenDouble({ decimals: 18n, symbol: 'WETH' }));
  assert.deepEqual(r, { decimals: 18, symbol: 'WETH' });
});

test('executeClaim stops when the scale is unreadable', () => {
  // Source gate: the claim flow consults readTokenScale and returns before
  // parseUnits/confirm when decimals are null — the "assuming 18, continue"
  // shape must not come back. (Rescue still carries its own info toast; it
  // is guarded by the balance check before broadcast and is out of scope.)
  const src = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const claim = src.slice(src.indexOf('async function executeClaim'));
  assert.match(claim, /await readTokenScale\(/, 'the claim flow must read the scale through the tested helper');
  assert.match(claim, /scale\.decimals == null\)/, 'an unreadable scale must stop the claim');
  assert.doesNotMatch(claim, /assuming 18/,
    'the claim must never guess the scale and continue');
});
