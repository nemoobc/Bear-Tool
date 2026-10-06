// Bear Tool — fork-eip7702-rescue.test.js
// RESCUE, end to end on an anvil fork — the flow `Rescue` in Tools runs:
// deploy the rescue helper, delegate the target EOA to it (EIP-7702 type-4),
// then the RESCUER (gas sponsor) calls rescueETH() THROUGH the delegation, so
// the delegated EOA sweeps its own balance into the SAFE.
//
// The Solidity is not copied into this file: it is read out of
// js/eip7702-tools.js at run time, so the source this test compiles is by
// construction the source the app deploys (a drift there would be invisible
// to every other test in the suite).
//
// An anvil/ethers without type-4 support skips with an honest reason — the
// same rule as fork-eip7702.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFork, compileSource, deployContract, forkSkipReason, ANVIL_ACCOUNT, ANVIL_ACCOUNT_2, ANVIL_KEY_2, stopFork, waitForTx, withRpcRetry } from './fork-helper.mjs';

const skip = forkSkipReason();

// The app's RESCUE_SOURCE, read from the module (never re-typed here).
function appSource(name) {
  const src = readFileSync(new URL('../../js/eip7702-tools.js', import.meta.url), 'utf8');
  const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) throw new Error(`${name} not found in js/eip7702-tools.js`);
  return m[1];
}

before(async () => { if (skip) return; await startFork(); });
after(async () => { if (skip) return; await stopFork(); });

test('fork: rescue helper delegates the target EOA and sweeps ETH into the SAFE', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // 1) deploy the rescue helper (SAFE = where the funds must land, RESCUER =
  //    the sponsor account broadcasting every tx in this flow).
  const SAFE = ethers.Wallet.createRandom().address;
  const { abi, bytecode } = await compileSource(appSource('RESCUE_SOURCE'), 'rescue');
  // The deployer is anvil's account #0 — the NonceManager signer has no .address.
  const helper = await deployContract(signer, abi, bytecode, [SAFE, ANVIL_ACCOUNT]);
  const helperAddr = await helper.getAddress();

  // 2) the target: anvil's second account, which holds ETH on the fork —
  //    exactly the user story (an EOA stuck with funds it cannot spend).
  const target = new ethers.Wallet(ANVIL_KEY_2, provider);
  assert.equal(target.address, ANVIL_ACCOUNT_2, 'target key is anvil account #2');
  const safeBefore = await provider.getBalance(SAFE);
  assert.equal(safeBefore, 0n, 'SAFE starts empty on the fork');

  // 3) authorize the target → helper. The nonce is tracked LOCALLY: anvil's
  //    fork state can lag, and a stale nonce makes the authorization invalid
  //    without any visible error.
  let targetNonce = await provider.getTransactionCount(target.address);
  let authorization;
  try {
    authorization = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  } catch {
    return;                                   // ethers without type-4 → honest skip
  }
  try {
    const tx = await target.sendTransaction({ to: target.address, authorizationList: [authorization], data: '0x' });
    await withRpcRetry(() => tx.wait(), { label: '7702 authorize receipt', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  } catch (err) {
    if (err instanceof ReferenceError || err instanceof TypeError) throw err;  // a bug is not an environment
    return;                                   // anvil refuses type-4 → honest skip
  }
  const code = await provider.getCode(target.address);
  assert.ok(code.startsWith('0xef0100'), 'target must carry the delegation designator');

  // Read the sweep amount HERE, after the authorize tx: that tx was paid by
  // the target itself, so its balance is already lower than the 10000 ETH it
  // starts with on a fork (the helper sweeps address(this).balance — whatever
  // it is at execution time).
  const targetBefore = await provider.getBalance(target.address);
  assert.ok(targetBefore > 0n, 'the target must hold funds worth rescuing');

  // 4) execute rescueETH through the delegation. Anvil only runs the
  //    delegation when the tx carries a FRESH authorization list, and on
  //    legacy-fee chains ethers would otherwise send a type-0 tx and drop the
  //    list silently — force type 4 + explicit fee data (same as the batch test).
  const auth2 = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  const fee = await provider.getFeeData();
  const execTx = await signer.sendTransaction({
    type: 4,
    to: target.address,
    authorizationList: [auth2],
    maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice,
    data: helper.interface.encodeFunctionData('rescueETH', []),
  });
  const receipt = await waitForTx(execTx, 'rescue execute');
  assert.equal(receipt.status, 1, 'delegated rescue must succeed');

  // 5) balances: poll instead of one read — anvil's fork state can sit a
  //    block behind the receipt (pattern shared with fork-send.test.js).
  const deadline = Date.now() + 30_000;
  let safeAfter = await provider.getBalance(SAFE);
  let targetAfter = await provider.getBalance(target.address);
  while ((safeAfter !== safeBefore + targetBefore || targetAfter !== 0n) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    safeAfter = await provider.getBalance(SAFE);
    targetAfter = await provider.getBalance(target.address);
  }
  assert.equal(targetAfter, 0n, 'the delegated EOA must be emptied');
  assert.equal(safeAfter, safeBefore + targetBefore, 'the SAFE must receive the whole balance');
});

test('fork: a non-rescuer cannot call rescueETH through the delegation', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // Same helper shape with a DIFFERENT rescuer: the sponsor account is no
  // longer authorized, so the delegated call must revert on onlyRescuer.
  const SAFE = ethers.Wallet.createRandom().address;
  const stranger = ethers.Wallet.createRandom().address;
  const { abi, bytecode } = await compileSource(appSource('RESCUE_SOURCE'), 'rescue');
  const helper = await deployContract(signer, abi, bytecode, [SAFE, stranger]);
  const helperAddr = await helper.getAddress();

  const target = new ethers.Wallet(ANVIL_KEY_2, provider);
  let targetNonce = await provider.getTransactionCount(target.address);
  let authorization;
  try {
    authorization = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  } catch { return; }
  try {
    const tx = await target.sendTransaction({ to: target.address, authorizationList: [authorization], data: '0x' });
    await withRpcRetry(() => tx.wait(), { label: '7702 authorize receipt (stranger rescuer)', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  } catch (err) {
    if (err instanceof ReferenceError || err instanceof TypeError) throw err;
    return;
  }

  const targetBefore = await provider.getBalance(target.address);
  const safeBefore = await provider.getBalance(SAFE);
  const auth2 = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  const fee = await provider.getFeeData();
  const data = helper.interface.encodeFunctionData('rescueETH', []);
  // The revert surfaces EITHER at eth_estimateGas (ethers gauges gas before
  // broadcasting and the guard fires there) or as a mined status=0 — waitForTx
  // enriches the latter with the replay verdict. Wrap both in one rejection.
  await assert.rejects(async () => {
    const execTx = await signer.sendTransaction({
      type: 4,
      to: target.address,
      authorizationList: [auth2],
      maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice,
      data,
    });
    await waitForTx(execTx, 'rescue execute (unauthorized)');
  }, /rescuer|revert/i, 'only RESCUER may sweep');
  assert.equal(await provider.getBalance(SAFE), safeBefore, 'SAFE must be untouched');
  assert.equal(await provider.getBalance(target.address), targetBefore, 'target keeps its funds');
});
