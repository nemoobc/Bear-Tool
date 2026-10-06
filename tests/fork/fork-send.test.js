// Bear Tool — fork-send.test.js
// Send native + ERC-20 on an anvil fork: balances must actually move.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, deployErc20, forkSkipReason, ANVIL_ACCOUNT, stopFork, waitForTx } from './fork-helper.mjs';

const skip = forkSkipReason();

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('fork: send native ETH — balances move on-chain', { skip }, async (t) => {
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
  // 75s, not 30s: the optimism legs were observed taking >30s to reflect a
  // local transfer (92s test runtime vs ~10-20s elsewhere) while every other
  // leg lands in <5s — the poll deadline, not the chain, was failing first.
  // 120s, not 75s: the optimism legs on the official endpoint were observed
  // never reflecting the credit within 75s (CI 37446987317, 78s run) while the
  // same test lands in <5s elsewhere — the deadline was still the first thing
  // to expire. The fallback below, not the clock, is the real fix.
  const deadline = Date.now() + 120000;
  let afterBal = await provider.getBalance(to);
  while (afterBal !== beforeBal + amount && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    afterBal = await provider.getBalance(to);
  }
  if (afterBal !== beforeBal + amount) {
    // Evidence bundle before the assertion, then the authoritative re-read:
    // WHERE is the tx, and what does the balance say AT ITS OWN BLOCK? A block
    // above the pin exists only on this anvil — a 'latest'/block read that fell
    // through to the upstream node answers with the upstream's own chain
    // (fresh address → 0, unknown tx → receipt null; anvil's receipt lookup
    // for a local tx is documented falling through in mem/mod.rs). CI
    // 37446987317: recipient=0, receipt=null, bn=pin+1 for the whole deadline.
    let info = await provider.getTransaction(tx.hash).catch((e) => 'ERR ' + (e?.message || e));
    let minedAt = (info && info.blockNumber != null) ? info.blockNumber : null;
    const bnNow = await provider.getBlockNumber().catch(() => -1);
    if (minedAt == null) {
      // getTransaction can fall through too — the local block scan cannot lie
      // about a hash that only this node ever saw.
      for (let b = bnNow; b > Math.max(0, bnNow - 8) && minedAt == null; b--) {
        const blk = await provider.getBlock(b).catch(() => null);
        const txs = blk?.transactions;
        if (Array.isArray(txs) && txs.some(h => (typeof h === 'string' ? h : h.hash) === tx.hash)) minedAt = b;
      }
    }
    const senderBal = await provider.getBalance(ANVIL_ACCOUNT).catch(() => 'ERR');
    if (minedAt != null) {
      const atBlock = await provider.getBalance(to, minedAt).catch((e) => 'ERR ' + (e?.message || e));
      t.diagnostic(`send: latest=${afterBal} atBlock(${minedAt})=${atBlock} sender=${senderBal} bn=${bnNow}`);
      if (atBlock === beforeBal + amount) afterBal = atBlock;
    } else {
      // No retry: the observed failure (bn=pin+1) proves the tx mined, so a
      // blind resend would risk double-crediting the exact-amount assertion.
      // The sender debit in the diagnostic separates "tx applied, read lied"
      // from "tx never applied" for the next iteration.
      t.diagnostic(`send: tx tidak ditemukan (getTransaction=${info == null ? 'null' : typeof info === 'string' ? info : 'blockNumber=' + info.blockNumber}, bn=${bnNow}, sender=${senderBal}, recipient=${afterBal})`);
    }
  }
  assert.equal(afterBal, beforeBal + amount, 'recipient balance must increase by the exact amount');
});

test('fork: send ERC-20 — balances move on-chain', { skip }, async () => {
  const { signer } = await startFork();
  const token = await deployErc20(signer);
  const to = '0x000000000000000000000000000000000000dEaD';
  const amount = 500n * 10n ** 18n;

  const tx = await token.transfer(to, amount);
  const receipt = await waitForTx(tx, 'send native');
  assert.equal(receipt.status, 1, 'ERC-20 send must succeed');
  assert.equal(await token.balanceOf(to), amount, 'recipient must hold the sent amount');
  assert.equal(await token.balanceOf(ANVIL_ACCOUNT), 1000000n * 10n ** 18n - amount, 'sender balance must decrease');
});