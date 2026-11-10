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
const { readTokenScale, readTokenScaleResilient, isTransportError, scaleFailureMessage } = await import('../js/eip7702-tools.js');

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
  assert.match(claim, /await readTokenScale(Resilient)?\(/, 'the claim flow must read the scale through the tested helpers');
  assert.match(claim, /scale\.decimals == null\)/, 'an unreadable scale must stop the claim');
  assert.doesNotMatch(claim, /assuming 18/,
    'the claim must never guess the scale and continue');
});

// ── Failure classification (round 2): a flaky RPC must not be reported as a
// ── wrong address, and a contract that answered must not be retried. ─────────

const TRANSPORT_MSG = 'missing response for request';
const DECODE_MSG = 'could not decode function result';

test('isTransportError separates a silent endpoint from an answered contract', () => {
  assert.equal(isTransportError({ message: TRANSPORT_MSG }), true, 'dropped response = transport');
  assert.equal(isTransportError({ shortMessage: 'timeout' }), true, 'timeout = transport');
  assert.equal(isTransportError({ message: '429 Too Many Requests' }), true, 'rate limit = transport');
  assert.equal(isTransportError({ message: 'fetch failed' }), true, 'fetch failure = transport');
  assert.equal(isTransportError({ message: DECODE_MSG }), false, 'decode failure = the node answered');
  assert.equal(isTransportError({ message: 'execution reverted' }), false, 'revert = answered');
  assert.equal(isTransportError({ message: 'decimals out of range' }), false, 'nonsense value = answered');
  assert.equal(isTransportError(null), false, 'no error is not a transport error');
});

test('readTokenScaleResilient retries a transport failure once and recovers', async () => {
  let calls = 0;
  const tc = {
    decimals: async () => { calls++; if (calls === 1) throw new Error(TRANSPORT_MSG); return 6; },
    symbol: async () => 'USDC',
  };
  const scale = await readTokenScaleResilient(tc, { sleep: async () => {} });
  assert.equal(scale.decimals, 6, 'the retry must recover the scale');
  assert.equal(scale.symbol, 'USDC');
  assert.equal(calls, 2, 'exactly one retry — unbounded retries would hang the claim');
});

test('readTokenScaleResilient does NOT retry an answered contract', async () => {
  let calls = 0;
  const tc = {
    decimals: async () => { calls++; throw new Error(DECODE_MSG); },
    symbol: async () => 'NOPE',
  };
  const scale = await readTokenScaleResilient(tc, { sleep: async () => {} });
  assert.equal(scale.decimals, null, 'the claim still fails closed');
  assert.equal(calls, 1, 'a node that answered must not be asked again');
  assert.ok(scale.error, 'the underlying error must reach the message builder');
});

test('readTokenScale keeps the error only on failure (healthy read shape unchanged)', async () => {
  const ok = await readTokenScale({ decimals: async () => 18, symbol: async () => 'WETH' });
  assert.deepEqual(ok, { decimals: 18, symbol: 'WETH' }, 'no error key on success');
  const bad = await readTokenScale({ decimals: async () => { throw new Error(TRANSPORT_MSG); }, symbol: async () => 'X' });
  assert.equal(bad.decimals, null);
  assert.match(String(bad.error?.message), /missing response/, 'the cause survives for classification');
});

test('scaleFailureMessage: three failures, three honest next steps', () => {
  const net = { name: 'Ethereum' };
  const transport = scaleFailureMessage('transport', new Error('missing response for request'), net);
  assert.match(transport, /RPC endpoint did not answer/, 'a dead endpoint must be named as such');
  assert.match(transport, /missing response/, "the node's own reason must be quoted");
  assert.match(transport, /Try again|Network settings/, 'transport must suggest retry / another RPC');

  const noContract = scaleFailureMessage('no-contract', new Error('could not decode'), net);
  assert.match(noContract, /No contract at that address on Ethereum/, 'a wrong-chain address must say so');
  assert.match(noContract, /different chain/, 'the next step is: check the chain');

  const notErc20 = scaleFailureMessage('not-erc20', new Error('could not decode'), net);
  assert.match(notErc20, /on-chain minimum cannot be guessed/, 'the ERC-20 instruction is kept');
  assert.match(notErc20, /ERC-20 on this chain/, 'kept verbatim: lessons/gates reference this sentence');
});

test('source gate: the claim classifies failures instead of one flat sentence', () => {
  const src = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const claim = src.slice(src.indexOf('async function executeClaim'));
  assert.match(claim, /readTokenScaleResilient\(/, 'the claim must go through the retrying reader');
  assert.match(claim, /isTransportError\(/, 'the claim must tell transport from answered failures');
  assert.match(claim, /provider\.getCode\(tokenAddr\)/, 'the claim must ask whether the contract exists at all');
  assert.match(claim, /scaleFailureMessage\(/, 'the claim must use the classified message');
  assert.doesNotMatch(claim, /Could not read token decimals on this network — the on-chain minimum/,
    'the flat one-size message must not be hardcoded in the claim anymore');
  assert.doesNotMatch(claim, /assuming 18/, 'the claim must never guess the scale and continue');
});
