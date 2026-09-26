// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/fork-retry.test.js
// withRpcRetry must retry transport noise and must NOT retry a contract that
// actually refused. Getting that backwards would turn a real failure into a
// green test, which is worse than the flakiness it hides.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRpcRetry, withDeadline } from '../tests/fork/fork-helper.mjs';

test('a transport error is retried and can succeed', async () => {
  let n = 0;
  const r = await withRpcRetry(async () => {
    n++;
    if (n < 3) throw new Error('missing revert data (action="estimateGas", data=null)');
    return 'deployed';
  }, { delayMs: 1 });
  assert.equal(r, 'deployed');
  assert.equal(n, 3);
});

test('a real revert is NOT retried — the contract refused, and that is the answer', async () => {
  let n = 0;
  await assert.rejects(() => withRpcRetry(async () => {
    n++;
    throw new Error('execution reverted: reason=0x4e487b71');
  }, { delayMs: 1 }), /reverted/);
  assert.equal(n, 1, 'a revert must be reported on the first attempt');
});

test('an unrelated error is not retried either', async () => {
  let n = 0;
  await assert.rejects(() => withRpcRetry(async () => {
    n++;
    throw new Error('TypeError: cannot read properties of undefined');
  }, { delayMs: 1 }));
  assert.equal(n, 1, 'only transport noise is worth a second attempt');
});

test('every attempt failing still throws the last error', async () => {
  let n = 0;
  await assert.rejects(() => withRpcRetry(async () => {
    n++;
    throw new Error('socket hang up');
  }, { attempts: 3, delayMs: 1 }), /socket hang up/);
  assert.equal(n, 3, 'it must not give up early or loop forever');
});

test('a call that works is not called twice', async () => {
  let n = 0;
  await withRpcRetry(async () => { n++; return 1; }, { delayMs: 1 });
  assert.equal(n, 1);
});

// ── withDeadline: the fix for a probe that hangs instead of answering ────
test('withDeadline passes a value through when it settles in time', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 500, 'x'), 'ok');
});

test('withDeadline rejects instead of hanging forever', async () => {
  // The exact shape that hung a whole network run: a transaction anvil accepts
  // and never mines, so tx.wait() never settles.
  const never = new Promise(() => {});
  await assert.rejects(() => withDeadline(never, 30, '7702 probe'), /did not settle/);
});

test('withDeadline surfaces the original error, not a timeout', async () => {
  await assert.rejects(() => withDeadline(Promise.reject(new Error('execution reverted')), 500, 'x'),
    /execution reverted/);
});

test('withDeadline does not leave its timer running', async () => {
  // A leaked timer would keep the event loop alive and stall the whole run.
  await withDeadline(Promise.resolve(1), 60_000, 'x');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(true);
});
