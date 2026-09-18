// Bear Tool — fork-approval.test.js
// Approval lifecycle on an anvil fork: approve → allowance, unlimited
// approval detection, revoke → allowance back to 0.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, deployErc20, forkSkipReason, ANVIL_ACCOUNT } from './fork-helper.mjs';

const skip = forkSkipReason();
const SPENDER = '0x000000000000000000000000000000000000dEaD';

before(async () => {
  if (skip) return;
  await startFork();
});


test('fork: approve → allowance recorded on-chain', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const amount = 1000n * 10n ** 18n;

  const tx = await token.approve(SPENDER, amount);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'approve must succeed');
  assert.equal(await token.allowance(ANVIL_ACCOUNT, SPENDER), amount, 'allowance must be recorded');
});

test('fork: unlimited approval is detectable (max uint256)', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const MAX = (1n << 256n) - 1n;

  const tx = await token.approve(SPENDER, MAX);
  await tx.wait();
  const allowance = await token.allowance(ANVIL_ACCOUNT, SPENDER);
  assert.equal(allowance, MAX, 'unlimited approval must be stored as max uint256');
  assert.equal(allowance === MAX, true, 'the app can flag this as UNLIMITED');
});

test('fork: revoke → allowance back to 0', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const amount = 1000n * 10n ** 18n;

  await (await token.approve(SPENDER, amount)).wait();
  assert.equal(await token.allowance(ANVIL_ACCOUNT, SPENDER), amount, 'precondition: allowance set');

  const tx = await token.approve(SPENDER, 0n);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'revoke must succeed');
  assert.equal(await token.allowance(ANVIL_ACCOUNT, SPENDER), 0n, 'allowance must be zero after revoke');
});