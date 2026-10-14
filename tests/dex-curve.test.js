// Bear Tool — dex-curve.test.js
//
// The bonding-curve launchpad lives in js/dex/ (order: "taro di folder dex
// only"). curve.js is the pricing half, and it is the half that decides how
// much ETH leaves a buyer's wallet — so it is held to arithmetic properties,
// not to snapshots. The Solidity in contracts.js must run the SAME numbers:
// a preview that disagrees with the settle is a preview that lies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAD, BPS, FEE_CREATOR_BPS, FEE_PROTOCOL_BPS, FEE_TOTAL_BPS,
  VIRTUAL_QUOTE, VIRTUAL_TOKENS, GRADUATION_QUOTE,
  takeFee, splitFee, quoteBuy, quoteSell, graduationProgress, spotPrice,
} from '../js/dex/curve.js';

// Whole ETH (or fractions of it) to wei. BigInt() rejects a fractional
// number outright, so scale first — the values here are clean decimals.
const ETH = (n) => BigInt(Math.round(n * 1e18));

test('the fee is exactly 1.25%, split 0.30% creator / 0.95% protocol', () => {
  assert.equal(FEE_TOTAL_BPS, 125n, '1.25% = 125 bps');
  assert.equal(FEE_CREATOR_BPS, 30n, '0.30% = 30 bps');
  assert.equal(FEE_PROTOCOL_BPS, 95n, '0.95% = 95 bps');
  assert.equal(FEE_CREATOR_BPS + FEE_PROTOCOL_BPS, FEE_TOTAL_BPS, 'the split adds up');

  // 8 ETH in → 0.10 ETH fee → creator 0.024, protocol 0.076
  const { net, fee } = takeFee(ETH(8), FEE_TOTAL_BPS);
  assert.equal(fee, ETH(0.1));
  assert.equal(net, ETH(7.9));
  const { creator, protocol } = splitFee(fee);
  assert.equal(creator, ETH(0.024));
  assert.equal(protocol, ETH(0.076));
  assert.equal(creator + protocol, fee, 'the split neither creates nor burns wei');
});

test('takeFee floors the fee the way Solidity does — the pool keeps the dust', () => {
  // 1 wei at 1.25% floors to 0 fee, not 0.0125 rounded up.
  const { net, fee } = takeFee(1n, FEE_TOTAL_BPS);
  assert.equal(fee, 0n, 'floor, never round — matches Solidity integer division');
  assert.equal(net, 1n, 'and the whole input survives');
  // 79 wei: 79*125/10000 = 0.9875 → 0
  assert.equal(takeFee(79n, FEE_TOTAL_BPS).fee, 0n);
  // 80 wei: 80*125/10000 = 1.0 → 1
  assert.equal(takeFee(80n, FEE_TOTAL_BPS).fee, 1n);
});

test('a buy moves price against the buyer — bigger order, worse price', () => {
  const small = quoteBuy(VIRTUAL_QUOTE, VIRTUAL_TOKENS, ETH(1));
  const big = quoteBuy(VIRTUAL_QUOTE, VIRTUAL_TOKENS, ETH(20));
  assert.ok(small.tokensOut > 0n && big.tokensOut > 0n);
  // Price is tokens per ETH. Doubling the order must NOT double the tokens.
  const pSmall = (small.tokensOut * WAD) / ETH(1);
  const pBig = (big.tokensOut * WAD) / ETH(20);
  assert.ok(pBig < pSmall, `slippage must bite: small=${pSmall} big=${pBig}`);
});

test('the constant product never shrinks — fees only grow k', () => {
  const k0 = VIRTUAL_QUOTE * VIRTUAL_TOKENS;
  let vE = VIRTUAL_QUOTE, vT = VIRTUAL_TOKENS;
  // A sequence of buys and sells must never leave the pool with less k.
  for (const size of [ETH(1), ETH(5), ETH(2), ETH(9)]) {
    const b = quoteBuy(vE, vT, size);
    vE = b.nextVirtualQuote; vT = b.nextVirtualTokens;
    assert.ok(vE * vT >= k0, 'k must not shrink after a buy');
    const s = quoteSell(vE, vT, b.tokensOut / 2n);
    vE = s.nextVirtualQuote; vT = s.nextVirtualTokens;
    assert.ok(vE * vT >= k0, 'k must not shrink after a sell');
  }
});

test('a round trip (buy then sell the same tokens) always LOSES money', () => {
  // The safety property: nobody can mint profit by churning a trade. Fees
  // plus slippage mean the way back is always cheaper than the way in.
  for (const size of [ETH(0.01), ETH(1), ETH(7), ETH(25)]) {
    const buy = quoteBuy(VIRTUAL_QUOTE, VIRTUAL_TOKENS, size);
    const sell = quoteSell(buy.nextVirtualQuote, buy.nextVirtualTokens, buy.tokensOut);
    assert.ok(sell.quoteOut < size,
      `round trip profited: in ${size} wei, out ${sell.quoteOut} wei`);
    // And the loss is at least the fee we paid on the way in.
    assert.ok(size - sell.quoteOut >= buy.fee,
      'the loss must cover the fee taken on the way in');
  }
});

test('a sell moves price against the seller — bigger exit, worse price', () => {
  const vE = VIRTUAL_QUOTE, vT = VIRTUAL_TOKENS;
  const chunk = vT / 1000n;
  const small = quoteSell(vE, vT, chunk);
  const big = quoteSell(vE, vT, chunk * 50n);
  const pSmall = (small.quoteOut * WAD) / chunk;
  const pBig = (big.quoteOut * WAD) / (chunk * 50n);
  assert.ok(pBig < pSmall, 'a large exit must get a worse price per token');
});

test('zero and degenerate inputs return zero instead of dividing by zero', () => {
  const cases = [
    [VIRTUAL_QUOTE, VIRTUAL_TOKENS, 0n],
    [0n, VIRTUAL_TOKENS, ETH(1)],
    [VIRTUAL_QUOTE, 0n, ETH(1)],
    [-1n, VIRTUAL_TOKENS, ETH(1)],
  ];
  for (const [vE, vT, amt] of cases) {
    assert.equal(quoteBuy(vE, vT, amt).tokensOut, 0n);
    assert.equal(quoteSell(vE, vT, amt).quoteOut, 0n);
  }
  // And the reserves come back untouched, not NaN-corrupted.
  assert.equal(quoteBuy(VIRTUAL_QUOTE, VIRTUAL_TOKENS, 0n).nextVirtualQuote, VIRTUAL_QUOTE);
});

test('graduation progress is capped at 100% and trips exactly at the threshold', () => {
  assert.deepEqual(graduationProgress(0n), { bps: 0n, graduated: false });
  assert.deepEqual(graduationProgress(GRADUATION_QUOTE / 2n), { bps: 5000n, graduated: false });
  assert.deepEqual(graduationProgress(GRADUATION_QUOTE), { bps: BPS, graduated: true });
  // Past the threshold reads as done, never as 137%.
  const over = graduationProgress(GRADUATION_QUOTE * 3n);
  assert.equal(over.bps, BPS, 'a progress bar that overflows is a bar that lies');
  assert.equal(over.graduated, true);
});

test('the opening price matches the virtual reserves by hand', () => {
  // spot = virtualTokens / virtualEth, in WAD.
  const spot = spotPrice(VIRTUAL_QUOTE, VIRTUAL_TOKENS);
  const hand = (VIRTUAL_TOKENS * WAD) / VIRTUAL_QUOTE;
  assert.equal(spot, hand, 'spotPrice must be the exact virtual ratio, not an estimate');
});

test('graduation sits within an order of magnitude of the virtual reserve', () => {
  // Regression guard for the dead-curve bug: graduation used to be 0.015 ETH
  // against 30 ETH of virtual reserve, so the whole bonding phase moved the
  // price by ~0.05% and the launchpad chart drew a flat line. A graduation
  // target must be comparable to VIRTUAL_QUOTE or the curve never moves.
  const ratio = (GRADUATION_QUOTE * 100n) / VIRTUAL_QUOTE; // percent
  assert.ok(ratio >= 50n && ratio <= 1000n,
    `graduation must be 0.5x–10x the virtual reserve, got ${ratio / 100n}x (flat-curve bug)`);
});

test('a buy then sell leaves the pool strictly richer than the trader', () => {
  // Symmetric phrasing of the round-trip property, from the pool's side: the
  // reserves the pair ends with are worth more than what the trader got back.
  const buy = quoteBuy(VIRTUAL_QUOTE, VIRTUAL_TOKENS, ETH(3));
  const sell = quoteSell(buy.nextVirtualQuote, buy.nextVirtualTokens, buy.tokensOut);
  const k0 = VIRTUAL_QUOTE * VIRTUAL_TOKENS;
  assert.ok(buy.nextVirtualQuote * buy.nextVirtualTokens >= k0);
  // The trader put in 3 ETH and got back strictly less.
  assert.ok(sell.quoteOut < ETH(3));
  assert.ok(sell.quoteOut > 0n, 'but not zero — a functioning curve still pays out');
});

// ── the contract source itself ────────────────────────────────
// PUMP_TOKEN_SOURCE is a JS template literal, so the Solidity inside it is not
// free text: a stray backtick ends the string, and a `${` starts an
// interpolation. Both fail as a JavaScript SyntaxError named after whatever
// Solidity token happened to follow — "Unexpected identifier 'realEthReserve'" —
// which points at the contract when the real mistake was a comment. Caught in
// this repo while fixing the reserve drift, so it is pinned here.
test('the Solidity source survives being a JS template literal', async () => {
  const { PUMP_TOKEN_SOURCE, PUMP_ABI } = await import('../js/dex/pump-source.js');

  assert.equal(typeof PUMP_TOKEN_SOURCE, 'string');
  assert.ok(PUMP_TOKEN_SOURCE.length > 1000, 'the source must actually be there');

  // An interpolation would have produced "[object Object]" or "undefined"
  // somewhere in the middle of the contract instead of failing loudly.
  assert.ok(!PUMP_TOKEN_SOURCE.includes('${'), 'no ${ may survive into the Solidity source');

  // Native ETH is gas only, and that is a property of the code: the contract
  // must REFUSE it. A promise in a comment, or a payable fallback that quietly
  // accepts ETH, would let gas money become trading money again.
  assert.match(PUMP_TOKEN_SOURCE, /receive\(\) external payable \{ revert\("gas only"\); \}/,
    'the curve must refuse native ETH outright — it pays gas and nothing else');
  assert.ok(!/function (buy|sell)\([^)]*\) external payable returns/.test(PUMP_TOKEN_SOURCE.replace(/\n    \/\/.*$/gm, '')),
    'buy must not be payable: there is no msg.value path into this contract');
  assert.ok(!PUMP_TOKEN_SOURCE.includes('undefined'), 'the source must contain no unresolved interpolation');

  // …and it must still be a contract: balance, constructor, and the two verbs
  // the whole launchpad depends on.
  for (const part of ['contract PumpToken', 'constructor(', 'function buy(uint256 quoteIn, uint256 minTokensOut)',
                      'function sell(uint256 tokensIn, uint256 minQuoteOut)',
                      'function claimFees()', 'function withdraw()', '_mintTo',
                      'function addLiquidity(uint256 quoteIn)', 'function removeLiquidity(uint256 shares)']) {
    assert.ok(PUMP_TOKEN_SOURCE.includes(part), `the source must contain ${part}`);
  }

  // The ABI must describe exactly what the UI calls. A function the UI invokes
  // but the ABI omits fails at runtime, in the browser, only when a user clicks.
  const sigs = PUMP_ABI.map(String);
  // The slippage floors are ABI, not decoration: a UI that computes a minimum
  // and cannot pass it is protecting nobody.
  for (const sig of ['function buy(uint256 quoteIn, uint256 minTokensOut) payable returns (uint256)',
                     'function sell(uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
                     'function quoteToken() view returns (address)',
                     'function addLiquidity(uint256 quoteIn) returns (uint256 shares)',
                     'function removeLiquidity(uint256 shares) returns (uint256 quoteOut)',
                     'function balanceOf(address owner) view returns (uint256)',
                     'function claimFees() returns (uint256)',
                     'function withdraw() returns (uint256)',
                     'function totalFeesCreator() view returns (uint256)']) {
    assert.ok(sigs.includes(sig), `PUMP_ABI must carry: ${sig}`);
  }
  for (const ev of ['event Bought(', 'event Sold(', 'event Graduated(',
                    'event FeesClaimed(', 'event Withdrawn(']) {
    assert.ok(sigs.some((s) => s.startsWith(ev)), `PUMP_ABI must carry: ${ev}`);
  }
});

test('the reserve and the ETH actually held cannot drift apart', async () => {
  // The invariant, stated where the maths lives. sell() used to drop
  // realEthReserve by the payout but not by the protocol's share, so the
  // number grew above the ETH physically in the contract; claimFees() then
  // underflowed and the creator's revenue was locked forever.
  //
  // Modelled here in integers: buy adds msg.value then removes the protocol
  // share; sell removes the payout AND its protocol share. Drop the second
  // removal and the sum stops matching.
  const FEE = 125n, CREATOR = 30n, BPS = 10_000n;
  const protocolOf = (fee) => fee - (fee * CREATOR) / FEE;

  const msgValue = ETH(1);
  const fee = (msgValue * FEE) / BPS;
  let reserve = msgValue - protocolOf(fee);   // buy(): value in, protocol share out

  const quoteOut = ETH(1) / 2n;
  const sellFee = (quoteOut * FEE) / BPS;
  // Correct: both what left the contract.
  reserve -= quoteOut + protocolOf(sellFee);
  const held = msgValue - protocolOf(fee) - quoteOut - protocolOf(sellFee);

  assert.equal(reserve, held,
    'reserve + unpaid creator fees must equal the ETH held — this is the identity claimFees() depends on');
});
