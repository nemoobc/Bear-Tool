// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/fork-retry.test.js
// withRpcRetry must retry transport noise and must NOT retry a contract that
// actually refused. Getting that backwards would turn a real failure into a
// green test, which is worse than the flakiness it hides.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRpcRetry, withDeadline, waitForTx } from '../tests/fork/fork-helper.mjs';

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

test('withDeadline sinks the loser — a late rejection is never unhandled', async () => {
  // The mechanism behind CI run 36889949127's optimism leg:
  // `A resource generated asynchronous activity after the test ended` with
  // `Fork Error: Transport(… 429 …)` on eth_getTransactionReceipt. The race
  // was decided (the deadline), the losing tx.wait() kept polling, and its
  // rejection landed on whatever test was running afterwards.
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    let rejectLoser;
    const loser = new Promise((_, reject) => { rejectLoser = reject; });
    await assert.rejects(() => withDeadline(loser, 10, 'bounded wait'), /did not settle/);
    // The loser settles AFTER the race was decided — exactly the CI sequence.
    rejectLoser(new Error('Fork Error: Transport(Custom("HTTP error 429 …"))'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rejections.length, 0,
      `loser yang kalah tidak boleh jadi unhandled rejection: ${rejections.map((e) => e.message).join(' | ')}`);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('withRpcRetry classifies the transport failures CI and the solc download hit as retryable', async () => {
  // Each message below is copied from run 36889949127's logs, plus the local
  // `TypeError: terminated` the solc CDN download produced. If the
  // classifier drifts, the retry never engages and the leg fails on the first
  // throttled read again — so the strings themselves are pinned here.
  const ciShapes = [
    // run 89, fork-swap.test.js:137 — eth_call WETH() on the V2 router
    'missing revert data (action="call", data=null, reason=null, code=CALL_EXCEPTION, version=6.17.0)',
    // run 90, fork-eip7702.test.js:50 — anvil's upstream was rate-limited
    'could not coalesce error (error={ "code": -32603, "message": "Fork Error: Transport(Custom(\\"Max retries exceeded HTTP error 429 with body: …\\"))" })',
    'HTTP error 429 with body: {"jsonrpc":"2.0","error":{"code":-32016,"message":"Your IP has exceeded its requests per second capacity"}}',
    // local Termux: the solc CDN connection dropped mid-body (NGHTTP2_STREAM_ERROR)
    'TypeError: terminated',
  ];
  for (const msg of ciShapes) {
    let n = 0;
    await assert.rejects(() => withRpcRetry(async () => { n++; throw new Error(msg); },
      { attempts: 3, delayMs: 1 }), undefined, `harus tetap melempar: ${msg.slice(0, 60)}`);
    assert.equal(n, 3, `harus dicoba 3× (transport): ${msg.slice(0, 60)}`);
  }
  // And the boundary: a genuine contract refusal must still fail on the first
  // attempt, or a broken router would look like flaky RPC.
  let n = 0;
  await assert.rejects(() => withRpcRetry(async () => {
    n++;
    throw new Error('execution reverted (action="call", reason="UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT")');
  }, { attempts: 3, delayMs: 1 }));
  assert.equal(n, 1, 'revert ber-alasan bukan gangguan transport — jangan diulang');
});

// ── waitForTx enrichment: a status=0 must explain itself ──
//
// CI's swap leg3 arrived as "gasLimit=171325 gasUsed=171325 — replay reverted,
// undecoded": a replay at the tx's own gas limit cannot tell out-of-gas from an
// empty require (both come back without data), so the failure named nothing.
// The enrichment now replays at 5M, adds a fresh estimate, and this test pins
// that message — if the diagnostics silently stop forming, the next red is a
// blind one, and that costs a full wave to rediscover.

const statusZeroTx = (provider) => ({
  hash: '0x' + '11'.repeat(32),
  provider,
  to: '0xb'.padEnd(42, '0'),
  data: '0xbeef',
  from: '0xa'.padEnd(42, '0'),
  gasLimit: 171325n,
  wait: async () => {
    const e = new Error('transaction execution reverted');
    e.code = 'CALL_EXCEPTION';
    e.receipt = { status: 0, gasUsed: 171325n, blockNumber: 123456 };
    throw e;
  },
});

test('waitForTx enriches a status=0 with a 5M-gas replay verdict and a fresh estimate', async () => {
  const provider = {
    getTransaction: async () => ({ gasLimit: 171325n, data: '0xbeef' }),
    call: async () => '0x',             // replay at 5M passes → it was out of gas
    estimateGas: async () => 147571n,   // the number the estimate should have shipped
  };
  await assert.rejects(
    () => waitForTx(statusZeroTx(provider), 'leg3 token→native', 5000),
    (e) => {
      assert.match(e.message, /status=0 \[gasLimit=171325 gasUsed=171325/,
        `baris status wajib ada: ${e.message.slice(0, 120)}`);
      assert.match(e.message, /OUT OF GAS at its own limit/,
        'replay 5M sukses + limit==gasUsed = verdict OOG harus terucap');
      assert.match(e.message, /estimateNow=147571/,
        'angka estimate segar wajib ikut — itu bukti divergensi');
      return true;
    },
  );
});

test('a real revert reason still wins over the OOG verdict', async () => {
  const provider = {
    getTransaction: async () => ({ gasLimit: 171325n, data: '0xbeef' }),
    call: async () => { throw Object.assign(new Error('execution reverted'), { reason: 'UniswapV2: K' }); },
    estimateGas: async () => { throw new Error('execution reverted: this state can never run it'); },
  };
  await assert.rejects(
    () => waitForTx(statusZeroTx(provider), 'leg3 with reason', 5000),
    (e) => {
      assert.match(e.message, /revert reason: UniswapV2: K/,
        `alasan revert nyata harus tampil: ${e.message.slice(0, 160)}`);
      assert.match(e.message, /estimateNow=error:/, 'estimate yang melempar harus tercatat apa adanya');
      assert.doesNotMatch(e.message, /OUT OF GAS/, 'alasan revert nyata menang, bukan ditebak OOG');
      return true;
    },
  );
});
