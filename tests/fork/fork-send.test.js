// Bear Tool — fork-send.test.js
// Send native + ERC-20 on an anvil fork: balances must actually move.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, deployErc20, forkSkipReason, ANVIL_ACCOUNT, stopFork } from './fork-helper.mjs';

const skip = forkSkipReason();

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('fork: send native ETH — balances move on-chain', { skip }, async () => {
  const { signer, provider } = await startFork();
  // Fresh address: no base state on the forked chain, so anvil's
  // eth_getBalance reflects the locally-mined transfer. (0xdEaD has a
  // mainnet balance that anvil returns from the REMOTE base state,
  // ignoring fork txs — foundry-rs/foundry#4700.)
  const { ethers } = await import('ethers');
  const to = ethers.Wallet.createRandom().address;
  const beforeBal = await provider.getBalance(to);
  assert.equal(beforeBal, 0n, 'fresh address must start at zero');
  const amount = 1000000000000000n; // 0.001

  const tx = await signer.sendTransaction({ to, value: amount });
  // Poll the balance instead of tx.wait(): anvil's receipt lookup for a
  // local tx can fall through to the remote RPC (mem/mod.rs
  // transaction_receipt → fork.transaction_receipt), and publicnode 403s
  // eth_getTransactionReceipt (archive restriction) on some networks.
  // The balance change IS the assertion — it proves the transfer landed.
  const deadline = Date.now() + 30000;
  let afterBal = await provider.getBalance(to);
  while (afterBal !== beforeBal + amount && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    afterBal = await provider.getBalance(to);
  }
  assert.equal(afterBal, beforeBal + amount, 'recipient balance must increase by the exact amount');
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