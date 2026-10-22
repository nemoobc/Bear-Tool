// Bear Tool — tests/deploy-fee-confirm.test.js
//
// User report 2026-10-21: "ask tx -> Compiler... -> ask tx -> Deploy".
//
// The helper deploy used to ask ONCE (before anything was compiled), then
// compile AND deploy in one shot. That first confirm could not price the
// deploy — there was no bytecode to estimate gas from yet — so the user
// approved a number they could not see, and the deploy fired immediately
// after the compiler finished with no second chance to back out.
//
// The flow now is: ask-tx #1 (intent) → compileSource (Compiler…) →
// ask-tx #2 (confirmDeployFee, priced off the REAL bytecode) → deployContract.
// confirmDeployFee estimates gas from the compiled bytecode and shows the fee
// before a single wei moves; cancelling at either confirm throws a
// `cancelled`-flagged error so the catch shows a quiet info toast, not a
// red failure.
//
// Two layers, like the sibling helper tests:
//   1. the helper exists and is wired to estimateGas + the fee money row;
//   2. every deploy site calls it BETWEEN compile and deploy — the order is
//      the whole point, so the test pins the sequence, not just presence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tools = readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');

// ── 1. the helper ─────────────────────────────────────────────────────────

test('confirmDeployFee exists and prices the deploy off estimateGas', () => {
  assert.match(tools, /async function confirmDeployFee\(/,
    'the second confirm must exist');
  // It estimates gas from the compiled bytecode (the whole reason it runs
  // AFTER compile): estimateGas with the bytecode as calldata.
  assert.match(tools, /provider\.estimateGas\(\{ from, data: bytecode \}\)/,
    'the fee must be estimated from the REAL bytecode, not guessed');
  // It surfaces the fee through the money row (gasWei), the same row the
  // rescue/claim/batch ask-sheets already use.
  assert.match(tools, /confirmDeployFee[\s\S]{0,600}?gasWei/,
    'the confirm must carry the fee as a gasWei money row');
});

test('confirmDeployFee throws a cancelled-flagged error so the catch stays quiet', () => {
  assert.match(tools, /\{ cancelled: true \}/,
    'a cancel must be flagged so the catch can show info, not error');
  // The deploy catches honour the flag: info on cancel, error otherwise.
  const catches = tools.match(/toast\(e\?\.message \|\| String\(e\), e\?\.cancelled \? 'info' : 'error'\)/g) || [];
  assert.ok(catches.length >= 3,
    `the manual deploy catches must honour the cancelled flag (got ${catches.length})`);
});

// ── 2. every deploy site runs it between compile and deploy ───────────────

test('all 6 deploy sites ask-tx#2 BETWEEN compile and deploy', () => {
  // Find each compileSource → … → deployContract window and require a
  // confirmDeployFee call inside it. Order is the point: the fee confirm must
  // sit AFTER the compiler (so bytecode exists) and BEFORE the deploy (so it
  // can still stop it).
  const compileIdx = [...tools.matchAll(/await compileSource\(/g)].map((m) => m.index);
  const deployIdx = [...tools.matchAll(/await deployContract\(/g)].map((m) => m.index);
  assert.equal(compileIdx.length, 6, `6 compile sites (got ${compileIdx.length})`);
  assert.equal(deployIdx.length, 6, `6 deploy sites (got ${deployIdx.length})`);

  let covered = 0;
  for (const c of compileIdx) {
    // The next deployContract after this compile.
    const d = deployIdx.find((i) => i > c);
    assert.ok(d !== undefined, 'every compile must be followed by a deploy');
    const window = tools.slice(c, d);
    assert.match(window, /await confirmDeployFee\(/,
      'confirmDeployFee must run between compileSource and deployContract');
    covered++;
  }
  assert.equal(covered, 6, 'every one of the 6 sites is covered');
});

test('the fee confirm runs AFTER the compiler, never before', () => {
  // Guard the regression the user actually hit: confirm#2 must not be hoisted
  // above the compile (where bytecode is unknown and the fee would be a guess).
  const calls = [...tools.matchAll(/await confirmDeployFee\(/g)].map((m) => m.index);
  const compiles = [...tools.matchAll(/await compileSource\(/g)].map((m) => m.index);
  for (const call of calls) {
    const lastCompileBefore = compiles.filter((i) => i < call).pop();
    assert.ok(lastCompileBefore !== undefined && lastCompileBefore < call,
      'confirmDeployFee must come after a compileSource (bytecode must exist)');
  }
});
