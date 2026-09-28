// ═══════════════════════════════════════════════════════════════════════════
// Bear Tool — tests/safetx-receipt.test.js
// A revert is an on-chain outcome, not a failure to broadcast.
//
// ethers v6 throws CALL_EXCEPTION (with the receipt attached) on a reverted
// transaction. waitForReceipt used to rethrow that, which meant every
// `receipt.status === 1 ? 'success' : 'failed'` branch across send / swap /
// bridge / eip7702 was unreachable, and a reverted transaction reached the user
// as "swap failed" with no hash and a history row stuck on "pending" forever.
//
// The user needs the hash of a reverted transaction more than of a successful
// one — that hash is how they find out what actually went wrong on chain.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForReceipt } from '../js/safetx.js';

const HASH = '0x' + 'ab'.repeat(32);

const txReturning = (receipt) => ({ hash: HASH, wait: async () => receipt });
const txThrowing = (err) => ({ hash: HASH, wait: async () => { throw err; } });

test('a confirmed receipt comes back with the hash and not reverted', async () => {
  const r = await waitForReceipt(txReturning({ status: 1, gasUsed: 21000n }), { timeoutMs: 1000 });
  assert.equal(r.hash, HASH);
  assert.equal(r.timedOut, false);
  assert.equal(r.reverted, false);
  assert.equal(r.receipt.status, 1);
});

test('a REVERT is reported as a result, with its receipt and hash — not thrown', async () => {
  const err = new Error('transaction execution reverted');
  err.code = 'CALL_EXCEPTION';
  err.receipt = { status: 0, gasUsed: 21000n };
  err.transactionHash = HASH;

  const r = await waitForReceipt(txThrowing(err), { timeoutMs: 1000 });

  assert.equal(r.reverted, true, 'the caller must be able to tell a revert from a timeout');
  assert.equal(r.timedOut, false, 'a revert did not time out');
  assert.ok(r.receipt, 'the receipt must survive — it carries the gas actually burned');
  assert.equal(r.receipt.status, 0);
  assert.equal(r.hash, HASH, 'the hash must reach the user; it is how they look it up');
});

test('a transaction replaced in flight reports both hashes', async () => {
  const err = new Error('transaction was replaced');
  err.code = 'TRANSACTION_REPLACED';
  err.replacement = { hash: '0x' + 'cd'.repeat(32) };

  const r = await waitForReceipt(txThrowing(err), { timeoutMs: 1000 });

  assert.equal(r.replaced, true);
  assert.equal(r.reverted, false);
  assert.equal(r.hash, HASH, 'the dropped hash is still worth keeping');
  assert.equal(r.replacement, '0x' + 'cd'.repeat(32), 'the hash that actually landed is reported too');
});

test('a timeout is still a timeout, and still not a revert', async () => {
  const r = await waitForReceipt({ hash: HASH, wait: () => new Promise(() => {}) }, { timeoutMs: 60 });
  assert.equal(r.timedOut, true);
  assert.equal(r.receipt, null);
  assert.equal(r.hash, HASH, 'an unconfirmed tx must still be trackable by hash');
});

test('an unrelated failure (RPC down, user rejected) is still allowed to throw', async () => {
  // Swallowing everything would hide real errors; only the two known
  // transaction-outcome codes are converted into results.
  const boom = new Error('network unreachable');
  boom.code = 'SERVER_ERROR';
  await assert.rejects(
    () => waitForReceipt(txThrowing(boom), { timeoutMs: 500 }),
    /network unreachable/,
  );
});
