// Bear Tool — fork-send.test.js
// Send native + ERC-20 on an anvil fork: balances must actually move.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, deployErc20, forkSkipReason, ANVIL_ACCOUNT } from './fork-helper.mjs';

const skip = forkSkipReason();

before(async () => {
  if (skip) return;
  await startFork();
});


test('fork: send native ETH — balances move on-chain', { skip }, async () => {
  const { signer, provider } = await startFork();
  const to = '0x000000000000000000000000000000000000dEaD';
  const beforeBal = await provider.getBalance(to);
  const amount = 1000000000000000n; // 0.001

  const tx = await signer.sendTransaction({ to, value: amount });
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'native send must succeed');
  assert.equal(await provider.getBalance(to), beforeBal + amount, 'recipient balance must increase by the exact amount');
});

test('fork: send ERC-20 — balances move on-chain', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const to = '0x000000000000000000000000000000000000dEaD';
  const amount = 500n * 10n ** 18n;

  const tx = await token.transfer(to, amount);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'ERC-20 send must succeed');
  assert.equal(await token.balanceOf(to), amount, 'recipient must hold the sent amount');
  assert.equal(await token.balanceOf(ANVIL_ACCOUNT), 1000000n * 10n ** 18n - amount, 'sender balance must decrease');
});