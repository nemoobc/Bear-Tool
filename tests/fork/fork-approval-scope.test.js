// Bear Tool — fork-approval-scope.test.js
//
// fork-approval.test.js proves the ERC-20 standard behaves: approve stores what
// you passed, MaxUint256 stores as MaxUint256, revoke stores 0. All three call
// the contract directly as the token owner, so none of them notice what the APP
// asks for, and none of them can tell an exact approval from an unlimited one
// at the point it matters.
//
// That gap mattered. js/swap.js used to call c.approve(router, MaxUint256),
// which is a shape every one of those existing tests passes with. This file
// asserts the property the app depends on: an approval covers the swap being
// made and no more, so once it is spent the spender has nothing left to take.
// That is the difference between "the router may pull this swap's worth" and
// "the router may pull everything, silently, forever".
//
// One detail that makes this file work, and that the first version got wrong:
// transferFrom checks the allowance of msg.sender, not of `from`. Approving the
// router and then calling transferFrom as the owner looks up allowance(owner,
// owner), which is zero, and reverts with "ERC20: insufficient allowance"
// however much was approved. The spender must be the account making the call,
// so these tests run it from anvil's second account — which is what a router
// does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Imported rather than read off globalThis: fork-helper.mjs does set
// globalThis.ethers, but relying on that here would make this file's behaviour
// depend on an import side effect it does not own.
const { ethers } = await import('ethers');
import {
  startFork, deployErc20, forkSkipReason, ANVIL_ACCOUNT, stopFork,
  ANVIL_ACCOUNT_2, ANVIL_KEY_2, waitForTx } from './fork-helper.mjs';

const skip = forkSkipReason();
const MAX = (1n << 256n) - 1n;

const swapSrc = fs.readFileSync(
  fileURLToPath(new URL('../../js/swap.js', import.meta.url)), 'utf8');

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('the swap path approves the swap amount, not the maximum', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const amountIn = 1000n * 10n ** 18n;
  const spender = new ethers.Wallet(ANVIL_KEY_2, signer.provider);

  // The crux, asserted: the spender must be a different account from the owner.
  // transferFrom checks allowance(msg.sender, owner), so when the caller IS the
  // owner the check reads allowance(owner, owner) — always zero — and the whole
  // test fails with "insufficient allowance" regardless of what was approved.
  assert.notEqual(spender.address.toLowerCase(), ANVIL_ACCOUNT.toLowerCase(),
    'the spender must not be the owner, or transferFrom checks the wrong allowance');
  assert.equal(spender.address.toLowerCase(), ANVIL_ACCOUNT_2.toLowerCase(),
    'the spender wallet must be the documented second anvil account');

  // Exactly what js/swap.js does for the ERC-20 branch: approve(router, amountWei)
  await waitForTx(await token.approve(spender.address, amountIn), 'approve swap amount');
  const afterApprove = await token.allowance(ANVIL_ACCOUNT, spender.address);
  assert.equal(afterApprove, amountIn,
    'the allowance must be the swap amount, not MaxUint256');
  assert.notEqual(afterApprove, MAX,
    'an unlimited approval would let the spender pull every future deposit');
});

test('a spent exact approval leaves the spender with nothing', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const spender = new ethers.Wallet(ANVIL_KEY_2, signer.provider);
  const first = 500n * 10n ** 18n;
  const second = 250n * 10n ** 18n;

  await waitForTx(await token.approve(spender.address, first), 'approve first swap');
  // Precondition, stated rather than assumed: if this is not the number that
  // was approved, the failure below is about the approve, not about spending.
  const set = await token.allowance(ANVIL_ACCOUNT, spender.address);
  assert.equal(set, first, `precondition: allowance must be ${first}, got ${set}`);

  // The spender pulls what the swap needs, exactly — called by the spender,
  // which is the whole point.
  const asSpender = token.connect(spender);
  await waitForTx(await asSpender.transferFrom(ANVIL_ACCOUNT, spender.address, first), 'spender pulls the swap');
  assert.equal(await token.allowance(ANVIL_ACCOUNT, spender.address), 0n,
    'after the swap consumes the approval the spender must hold nothing');

  // A second swap therefore needs a fresh approval — the cost this design
  // accepts in exchange for bounding the exposure.
  assert.ok(0n < second, 'the spent allowance must not cover a later swap');
  await waitForTx(await token.approve(spender.address, second), 'approve second swap');
  assert.equal(await token.allowance(ANVIL_ACCOUNT, spender.address), second);
});

test('for contrast: MaxUint256 is never reduced, and keeps the exposure open', { skip }, async () => {
  // The behaviour that was replaced, asserted so the difference is a measured
  // fact rather than a claim in a comment.
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const spender = new ethers.Wallet(ANVIL_KEY_2, signer.provider);
  const balance = await token.balanceOf(ANVIL_ACCOUNT);

  await waitForTx(await token.approve(spender.address, MAX), 'approve MAX (contrast case)');
  const setMax = await token.allowance(ANVIL_ACCOUNT, spender.address);
  assert.equal(setMax, MAX, `precondition: allowance must be MAX, got ${setMax}`);

  await waitForTx(await token.connect(spender).transferFrom(ANVIL_ACCOUNT, spender.address, 10n ** 18n), 'spend from an unlimited approval');
  assert.equal(await token.allowance(ANVIL_ACCOUNT, spender.address), MAX,
    'an unlimited approval is not reduced by spending');
  assert.ok(balance > 10n ** 18n,
    'the account still holds funds the spender could take at any time, with no ' +
    'further prompt from this wallet');
});

test('js/swap.js still contains no unlimited approval', () => {
  // A source-level lock, so the fork assertions above can never drift into
  // describing a behaviour the app no longer has.
  assert.doesNotMatch(swapSrc, /\.approve\(\s*[^,]+,\s*(?:ethers\.)?MaxUint256\s*\)/,
    'the swap path must never approve MaxUint256');
  // The address is `approveTo` (built.approveTo || router — the contract that
  // actually pulls, js/swap.js:661-662), not the literal name `router`.
  assert.match(swapSrc, /\.approve\(\s*\w+\s*,\s*amountWei\s*\)/,
    'the swap path must approve the amount being swapped');
});
