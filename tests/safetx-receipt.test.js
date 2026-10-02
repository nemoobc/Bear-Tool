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

test('a transient receipt-poll failure is retried, not fatal', async () => {
  // CI 36997713895: four mainnets broadcast successfully (receipt status=1 on
  // the local fork) but anvil forwarded eth_getTransactionReceipt to an
  // upstream answering 403 — ethers rejected the whole wait(), the old code
  // rethrew, and every row was stranded "pending" forever. A node hiccup must
  // not end the wait while the deadline still has room.
  const boom = new Error('Fork Error: Transport(HttpError { status: 403 })');
  boom.code = 'SERVER_ERROR';
  let calls = 0;
  const tx = {
    hash: HASH,
    wait: async () => {
      calls += 1;
      if (calls === 1) throw boom;
      return { status: 1, gasUsed: 21000n };
    },
  };

  const r = await waitForReceipt(tx, { timeoutMs: 2000, retryMs: 10 });

  assert.equal(r.timedOut, false, 'the retry must reach the receipt');
  assert.equal(r.receipt.status, 1);
  assert.equal(r.hash, HASH);
  assert.ok(calls >= 2, 'the poll must have been retried after the error');
});

test('a persistent transient failure ends as an honest timeout, never a throw', async () => {
  // Swallowing must still be bounded: the caller learns "unconfirmed in
  // time" with the hash intact — not an exception that skips its cleanup.
  const boom = new Error('network unreachable');
  boom.code = 'SERVER_ERROR';

  const r = await waitForReceipt(txThrowing(boom), { timeoutMs: 120, retryMs: 15 });

  assert.equal(r.timedOut, true, 'a node that never answers is a timeout, not a crash');
  assert.equal(r.receipt, null);
  assert.equal(r.hash, HASH, 'an unconfirmed tx must still be trackable by hash');
});
