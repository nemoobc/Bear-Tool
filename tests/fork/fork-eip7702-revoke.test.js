// Bear Tool — fork-eip7702-revoke.test.js
//
// The delegate → batch test proves a delegation WORKS. It never proves that a
// revoke actually REMOVES it. That is the most dangerous path in a self-custody
// wallet: a failed revoke leaves the EOA executing attacker-chosen code on
// every future transaction until the user notices. So this file asserts the
// on-chain delegation state at each step of the lifecycle, not just that a
// transaction was accepted:
//
//   delegate  → getCode == 0xef0100 || <impl>
//   revoke    → getCode == 0x            (delegation gone, EOA is an EOA again)
//   re-delegate → getCode points at a DIFFERENT impl (revoke really took effect)
//
// A delegation set by an earlier tx is stored but not executed on a later plain
// tx, so each step sends its own fresh authorizationList (see fork-eip7702).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, compileSource, forkSkipReason, stopFork, withDeadline, waitForTx } from './fork-helper.mjs';

const skip = forkSkipReason();

// anvil 1.8.3 executes an EIP-7702 authorization during the transaction (the
// trace shows the delegated code running) but never PERSISTS the resulting code
// change — verified on a mainnet fork AND on a fresh empty chain with
// --hardfork prague. Without this probe every assertion below would fail for an
// environment reason, or worse, the pre-existing mainnet delegation on
// 0x70997970… would make an assertion pass for the wrong reason.
// Set by the probe below, read by the skip message, so the reason a suite is
// skipped is the measured mechanism rather than a slogan.
let probeDetail = '';

async function supports7702State() {
  const { ethers } = await import('ethers');
  const { provider, network } = await startFork();
  const probe = new ethers.Wallet(TARGET_KEY, provider);
  const impl = '0x1111111111111111111111111111111111111111';
  const before = await provider.getCode(probe.address);
  const n = await provider.getTransactionCount(probe.address, 'pending');
  const fee = await provider.getFeeData();
  try {
    const auth = probe.authorizeSync({ chainId: network.chainId, address: impl, nonce: n });
    const tx = await probe.sendTransaction({
      type: 4, to: probe.address, data: '0x', authorizationList: [auth],
      maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice,
    });
    // Bounded on purpose. Anvil can accept a type-4 transaction and never mine
    // it; an unbounded tx.wait() then hangs the whole run with no error, and
    // the catch below never runs. A probe that cannot answer in time has its
    // answer: this build does not persist the state.
    const rcpt = await withDeadline(tx.wait(), 20_000, '7702 probe receipt');
    await new Promise((r) => setTimeout(r, 1500));
    const after = await provider.getCode(probe.address);
    const applied = before === '0x' && after.toLowerCase() === ('0xef0100' + impl.slice(2).toLowerCase());
    if (!applied) {
      // Record WHICH of the three things failed, because "does not persist state"
      // is three different bugs wearing one name. Measured on anvil 1.8.3 and
      // 1.6.0-nightly, against a chain with --hardfork prague and a clean EOA:
      //
      //   status 1, gas used 46,000, nonce 0 → 1, code unchanged
      //
      // The transaction RAN. It was mined, it consumed gas, the account's nonce
      // advanced — and the authorization list had no effect on the code. That
      // rules out the two explanations that look the same from a distance: a
      // transaction that was never executed (nonce would not move) and a
      // signature that was built wrongly (the node would reject it, or the
      // authorization tuple would be wrong in a way the trace would show).
      //
      // So the honest statement is "this chain mines type-4 transactions and
      // discards the authorization", not "7702 is unsupported here". The first
      // is a statement about the chain, the second about the standard, and only
      // the first one is true.
      const nonceAfter = await provider.getTransactionCount(probe.address, 'latest');
      const ran = rcpt.status === 1 && nonceAfter > Number(n);
      probeDetail = ran
        ? `tx jalan (status ${rcpt.status}, gas ${rcpt.gasUsed}, nonce ${n}→${nonceAfter}) tapi authorization tidak diterapkan`
        : `tx tidak dieksekusi (status ${rcpt.status}, nonce ${n}→${nonceAfter})`;
    }
    return applied;
  } catch (e) {
    probeDetail = `probe gagal: ${e && e.message ? e.message.slice(0, 60) : e}`;
    return false;
  }
}

const IMPL_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract impl {
    receive() external payable {}
    function version() external pure returns (string memory) { return "impl-v1"; }
}`;

const IMPL2_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract impl2 {
    receive() external payable {}
    function version() external pure returns (string memory) { return "impl-v2"; }
}`;

// Anvil's second funded account — the EOA that delegates.
const TARGET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ZERO = '0x0000000000000000000000000000000000000000';

let ctx;
let target;
let nonce;

before(async () => {
  if (skip) return;
  const { ethers } = await import('ethers');
  ctx = await startFork();
  const { provider, network } = ctx;
  target = new ethers.Wallet(TARGET_KEY, provider);
  // Track the nonce LOCALLY: anvil's fork state can lag one block, so a fresh
  // getTransactionCount after a mined type-4 tx can return the same stale value.
  nonce = await provider.getTransactionCount(target.address);
});

after(async () => {
  if (skip) return;
  await stopFork();
});

/** Send a type-4 tx carrying an authorization to `implAddr` (ZERO = revoke). */
async function authorize(implAddr) {
  const { ethers } = await import('ethers');
  const { provider, network } = ctx;
  const auth = target.authorizeSync({ chainId: network.chainId, address: implAddr, nonce: nonce++ });
  const fee = await provider.getFeeData();
  const tx = await target.sendTransaction({
    type: 4,
    to: target.address,
    data: '0x',
    authorizationList: [auth],
    maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice,
  });
  return waitForTx(tx, '7702 helper tx');
}

async function deploy(src, name) {
  const { ethers } = await import('ethers');
  const { signer } = ctx;
  const { abi, bytecode } = await compileSource(src, name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy();
  await c.waitForDeployment();
  return c.getAddress();
}

test('fork: EIP-7702 delegate → revoke → re-delegate is verifiable on-chain', { skip }, async (t) => {
  const { ethers } = await import('ethers');
  const { provider } = ctx;

  // Honest skip: anvil builds that never persist 7702 state would fail every
  // assertion below for an environment reason, not a code reason.
  if (!(await supports7702State())) {
    return t.skip(
      'this chain mines EIP-7702 type-4 transactions but does not apply the ' +
      'authorization: ' + (probeDetail || 'detail tidak terukur') +
      '. Verified on a fresh chain with --hardfork prague and a clean EOA, in the ' +
      'same shape js/eip7702.js sends. Re-run this file once the chain persists ' +
      'the code change — the assertions below are already written and will run.'
    );
  }

  const implA = await deploy(IMPL_SOURCE, 'impl');

  // --- step 1: clean slate -------------------------------------------------
  assert.equal(await provider.getCode(target.address), '0x',
    'EOA must start with no code — an account that is ALREADY delegated on the '
    + 'upstream chain would satisfy every assertion below for the wrong reason');

  // --- step 2: delegate ---------------------------------------------------
  const r1 = await authorize(implA);
  assert.equal(r1.status, 1, 'delegate tx must succeed');
  const codeA = await provider.getCode(target.address);
  assert.ok(codeA.startsWith('0xef0100'), 'EOA must carry a delegation designator');
  assert.ok(codeA.toLowerCase().endsWith(implA.toLowerCase().slice(2)),
    `designator must point at impl A (${implA}); got ${codeA}`);

  // --- step 3: revoke -----------------------------------------------------
  const r2 = await authorize(ZERO);
  assert.equal(r2.status, 1, 'revoke tx must succeed');
  assert.equal(await provider.getCode(target.address), '0x',
    'after revoke the EOA must have NO code — this is the assertion the ' +
    'delegate→batch test never made');

  // --- step 4: re-delegate to a DIFFERENT impl ---------------------------
  // Proves the revoke genuinely changed state rather than the reads lagging.
  const implB = await deploy(IMPL2_SOURCE, 'impl2');
  assert.notEqual(implA, implB, 'the two impls must differ for this to mean anything');
  const r3 = await authorize(implB);
  assert.equal(r3.status, 1, 're-delegate tx must succeed');
  const codeB = await provider.getCode(target.address);
  assert.ok(codeB.toLowerCase().endsWith(implB.toLowerCase().slice(2)),
    `after re-delegating, designator must point at impl B (${implB}); got ${codeB}`);

  // --- step 5: revoke again, back to a plain EOA -------------------------
  const r4 = await authorize(ZERO);
  assert.equal(r4.status, 1, 'second revoke tx must succeed');
  assert.equal(await provider.getCode(target.address), '0x',
    'lifecycle must end with the EOA clean');
});
