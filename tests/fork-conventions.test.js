// Three bugs in this same file, found in one round, all of them the test being
// wrong rather than the app — and the first one meant the file could not fail at
// all. Together they had the file reporting green for a swap it never executed:
//
//   1. KNOWN_TOKENS[network].USDC against lowercase table keys → stable always
//      undefined → both venue cases skipped on every network.
//   2. swapExactETHForTokens called with no { value } → the router wrapped zero
//      and reverted INSUFFICIENT_INPUT_AMOUNT, which reads like a dead router.
//   3. `const { receipt } = await waitForTx(tx)` while the helper returns the
//      receipt itself → undefined.status.
//
// Each was invisible for the same reason: the file skipped, so nothing below the
// skip was ever reached. A detector is worth writing when a bug class has cost
// more than one round, and this class has now cost two.
//
// These are shape checks, and that is a deliberate trade: they cannot tell
// whether a swap works, only whether the call is written in a form that has
// already been proven to hide a failure. The behaviour check is fork-swap.test.js
// itself, which can now fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const forkDir = path.join(here, 'fork');
const swapSrc = readFileSync(path.join(forkDir, 'fork-swap.test.js'), 'utf8');
const helperSrc = readFileSync(path.join(forkDir, 'fork-helper.mjs'), 'utf8');
const allForkTests = readdirSync(forkDir).filter((f) => f.endsWith('.test.js')).map((f) => ({
  name: f,
  src: readFileSync(path.join(forkDir, f), 'utf8'),
}));

test('no fork test destructures a receipt out of waitForTx', () => {
  // The helper returns the receipt. `{ receipt }` silently yields undefined, and
  // the failure lands on the next line as a confusing undefined-property read
  // rather than on the mistake.
  for (const { name, src } of allForkTests) {
    assert.doesNotMatch(src, /const\s*\{\s*receipt\s*\}\s*=\s*await\s*waitForTx\(/,
      `${name} membongkar waitForTx; helper mengembalikan receipt secara langsung`);
  }
});

test('the receipt a fork test reads is checked for presence before its status', () => {
  // `receipt.status` on an undefined receipt throws a TypeError that says nothing
  // about the swap. Asserting the shape first turns that into a sentence about
  // what actually went wrong.
  assert.doesNotMatch(swapSrc, /receipt\.status/,
    'baca receipt?.status dan sertakan keterbacaannya di pesan');
  assert.match(swapSrc, /receipt\?\.status/);
});

test('every payable router call in the swap test carries a value', () => {
  // swapExactETHForTokens wraps msg.value and swaps that. Without a value it
  // wraps zero and the router's library reverts with INSUFFICIENT_INPUT_AMOUNT —
  // indistinguishable, in the log, from a router that is not really there.
  const calls = [...swapSrc.matchAll(/swapExactETHForTokens\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
  assert.ok(calls.length >= 1, 'tidak ada panggilan swapExactETHForTokens — pola detektor mungkin basi');
  for (const args of calls) {
    assert.match(args, /\{\s*value\s*:/,
      `swapExactETHForTokens tanpa { value: … } akan membungkus nol: ${args.trim().slice(0, 80)}`);
  }
});

test('the app sends a value, and the test mirrors the app rather than guessing', () => {
  // The point of fixing the test is that it can now catch the app being wrong.
  // So the detector asserts the app's own call shape, and the test asserts the
  // same shape — if either drifts, one of them says so.
  const appSrc = readFileSync(path.join(here, '..', 'js', 'swap.js'), 'utf8');
  const appCalls = [...appSrc.matchAll(/swapExactETHForTokens\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
  assert.ok(appCalls.length >= 1, 'tidak ada panggilan swapExactETHForTokens di js/swap.js');
  for (const args of appCalls) {
    assert.match(args, /\{\s*value\s*:/, 'app memanggil swapExactETHForTokens tanpa value — bug produk');
  }
});

test('the swap test skips only for two named reasons, and the fixture one fails', () => {
  // The shape of the original failure: two venue cases, both skipped, file green,
  // nothing below the skip ever reached. A skip is legitimate in exactly two
  // situations here, and both are named so a new one cannot slip in unexamined:
  //
  //   - the file is being run on a network that is not this venue's;
  //   - the venue genuinely has no pair with reserves for the stable in use.
  //
  // The second is a property of the chain, not of the registry: anyone can pull
  // liquidity at any time, and a test that failed on that would be testing the
  // chain. It is still not "pass" — run-net.ps1 exits 3 on any skip so a sweep
  // cannot read it as coverage, and the message names the venue and the network.
  //
  // A missing stablecoin is NOT on this list. That one is a fixture gap, it is
  // asserted rather than skipped, and it is the bug this whole file is about.
  const allowed = [
    /venue ini diuji di/,      // wrong network for this venue
    /tidak ada pair WETH→stable dengan likuiditas/, // measured: no reserves
  ];
  const skipCalls = [...swapSrc.matchAll(/t\.skip\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
  assert.ok(skipCalls.length >= 1, 'pola detektor tadinya tidak menemukan skip — periksa regex');
  for (const arg of skipCalls) {
    assert.ok(allowed.some((re) => re.test(arg)),
      `skip dengan alasan yang tidak dikenal: ${arg.trim().slice(0, 90)} — ` +
      'tambahkan hanya kalau ini benar-benar properti chain, bukan gap fixture');
  }
  // And the specific thing that went wrong: no stable must never be a skip.
  assert.doesNotMatch(swapSrc, /t\.skip\([^)]*tidak ada token stabil/,
    'stable yang hilang harus assert.fail, bukan skip — inilah bug aslinya');
  assert.match(swapSrc, /assert\.fail\([^)]*tidak punya token stabil/,
    'jalur stable-hilang harus gagal keras');
});

test('forkSkipReason is the only thing allowed to skip a fork test wholesale', () => {
  // "no anvil locally" skips every case in the file and still exits 0. That is
  // correct behaviour for the guard and dangerous everywhere else, so the guard's
  // wording is pinned: if it ever stops explaining itself, a green run stops
  // meaning anything.
  assert.match(helperSrc, /function forkSkipReason\(\)/);
  assert.match(helperSrc, /FORK_SKIP/);
  assert.match(helperSrc, /FORK_RPC_URL/);
  assert.match(helperSrc, /FORK_PORT/,
    'tanpa FORK_PORT, seluruh file ter-skip dengan pesan soal CI');
});
