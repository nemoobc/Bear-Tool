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

import { waitForReceipt, receiptVerdict } from '../js/safetx.js';

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

// ── receiptVerdict ─────────────────────────────────────────────────────────
// A REPLACED tx (speed-up / drop-and-replace) has NO receipt for the hash the
// caller holds, only the replacement's. waitForReceipt says so honestly with
// `receipt: null`; the shared shape `receipt.status === 1 ? success : failed`
// then threw "Cannot read properties of null (reading 'status')" — in send,
// swap, bridge and all five eip7702 flows. receiptVerdict() is the ONE place
// that case is decided. These pin the verdict, and pin that no module reaches
// for `.status` on a receipt that may be null.

test('receiptVerdict: success / revert / timeout / replaced', () => {
  assert.equal(receiptVerdict({ receipt: { status: 1 }, hash: HASH }).kind, 'success');
  assert.equal(receiptVerdict({ receipt: { status: 0 }, hash: HASH }).kind, 'failed');
  assert.equal(receiptVerdict({ receipt: null, timedOut: true, hash: HASH }).kind, 'pending');
  const r = receiptVerdict({ receipt: null, replaced: true, replacement: HASH, hash: HASH });
  assert.equal(r.kind, 'replaced');
  assert.equal(r.receipt, null, 'a replaced tx has NO receipt — callers must not read one');
});

test('receiptVerdict: malformed input degrades to pending, never throws', () => {
  for (const empty of [null, undefined, {}, { receipt: null }]) {
    assert.equal(receiptVerdict(empty).kind, 'pending');
    assert.equal(receiptVerdict(empty).receipt, null);
  }
});

test('no app module reads .status/.gasUsed off a possibly-null receipt', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
  const NL = String.fromCharCode(10);
  const bad = /(^|[^A-Za-z0-9_$])receipt[.](status|gasUsed)/g;
  const offenders = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.js') || f === 'safetx.js') continue; // safetx defines the guard
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(bad)) offenders.push(`${f}:${src.slice(0, m.index).split(NL).length}`);
  }
  assert.deepEqual(offenders, [], 'use receipt?.status or receiptVerdict()');
});

test('send / swap / bridge / eip7702 settle their tx through receiptVerdict', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
  for (const f of ['send.js', 'swap.js', 'bridge.js', 'eip7702-tools.js']) {
    assert.match(readFileSync(path.join(dir, f), 'utf8'), /receiptVerdict[(]/, `${f} must use receiptVerdict()`);
  }
});
