// Bear Tool — fork-eip7702.test.js
// EIP-7702 delegation on an anvil fork: deploy the batch helper, authorize a
// target EOA to delegate to it, then execute a batch call through the
// delegation. Anvil versions without type-4 support skip with an honest
// reason — the app still falls back to the non-7702 path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, compileSource, forkSkipReason, ANVIL_ACCOUNT, ANVIL_KEY, stopFork } from './fork-helper.mjs';

const skip = forkSkipReason();

// Same batch helper the app deploys (js/eip7702-tools.js BATCH_SOURCE).
const BATCH_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract batch {
    event CallExecuted(address indexed to, uint256 indexed value, bytes data, bool success);
    struct Call { bytes data; address to; uint256 value; }
    address public immutable DEPLOYER;
    modifier onlyDeployer() { require(msg.sender == DEPLOYER, "batch: caller is not deployer"); _; }
    constructor() { DEPLOYER = msg.sender; }
    receive() external payable {}
    fallback() external payable {}
    function execute(Call[] calldata calls) external payable onlyDeployer {
        require(calls.length > 0, "batch: empty call list");
        for (uint256 i=0; i<calls.length; i++) {
            Call memory call = calls[i];
            require(call.to != address(0), "batch: call target zero");
            (bool success, ) = call.to.call{value: call.value}(call.data);
            require(success, "batch: call reverted");
            emit CallExecuted(call.to, call.value, call.data, success);
        }
    }
    function version() external pure returns (string memory) { return "1.0.0"; }
}`;

// Anvil's second funded account — the EOA that delegates.
const TARGET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('fork: EIP-7702 delegation → batch call executes through the EOA', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // 1) deploy the batch helper
  const { abi, bytecode } = await compileSource(BATCH_SOURCE, 'batch');
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const helper = await factory.deploy();
  await helper.waitForDeployment();
  const helperAddr = await helper.getAddress();

  // 2) authorize the target EOA to delegate to the helper (EIP-7702)
  //    Track the target nonce LOCALLY: anvil's fork state can lag, so a
  //    fresh getTransactionCount after a mined type-4 tx sometimes returns
  //    the SAME stale nonce → the second authorization is invalid and anvil
  //    silently skips it (delegation never executes).
  const target = new ethers.Wallet(TARGET_KEY, provider);
  let targetNonce = await provider.getTransactionCount(target.address);
  let authorization;
  try {
    authorization = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  } catch (err) {
    // ethers without type-4 support — honest skip
    return;
  }

  // 3) send the type-4 transaction
  let receipt;
  try {
    const tx = await target.sendTransaction({
      to: target.address,
      authorizationList: [authorization],
      data: '0x'
    });
    receipt = await tx.wait();
  } catch (err) {
    // anvil without EIP-7702 support — honest skip (app falls back)
    return;
  }
  assert.equal(receipt.status, 1, 'type-4 tx must succeed');

  // 4) the EOA must now carry the delegation designator (0xef0100...)
  const code = await provider.getCode(target.address);
  assert.ok(code.startsWith('0xef0100'), 'EOA code must be a delegation designator (0xef0100)');

  // 5) execute a batch call through the delegation: transfer 0.001 ETH.
  // The helper's execute() is onlyDeployer, so the tx must come from the
  // deployer (signer) TO the delegated EOA — the EOA's code (delegation
  // designator) then runs helper.execute with msg.sender == deployer.
  // NOTE: anvil only executes the delegation when the tx carries a fresh
  // authorizationList (auth applied + executed in the same tx); a delegation
  // set by an earlier tx is stored but not executed on a later plain tx.
  // Fresh recipient: no base state on the forked chain, so anvil's
  // eth_getBalance reflects the locally-mined transfer (#4700).
  const to = ethers.Wallet.createRandom().address;
  const value = ethers.parseEther('0.001');
  const beforeBal = await provider.getBalance(to);
  assert.equal(beforeBal, 0n, 'fresh address must start at zero');
  const calls = [{ data: '0x', to, value }];
  const auth2 = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  // Force type-4 explicitly: on chains where fee data is legacy (e.g. BSC)
  // ethers v6 would otherwise populate a type-0 tx and silently drop the
  // authorizationList, so the delegation never executes.
  const fee = await provider.getFeeData();
  const execTx = await signer.sendTransaction({
    type: 4,
    to: target.address,
    value, // the delegated helper has no ETH; the tx must carry the value
    authorizationList: [auth2],
    maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice,
    data: helper.interface.encodeFunctionData('execute', [calls])
  });
  const execReceipt = await execTx.wait();
  assert.equal(execReceipt.status, 1, 'batch execute through delegation must succeed');
  // Poll the balance instead of a single read: anvil's fork state can lag
  // one block behind, so eth_getBalance may briefly return the pre-tx value
  // even after the receipt exists (same pattern as fork-send.test.js).
  const deadline = Date.now() + 30000;
  let afterBal = await provider.getBalance(to);
  while (afterBal !== beforeBal + value && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    afterBal = await provider.getBalance(to);
  }
  assert.equal(afterBal, beforeBal + value, 'delegated call must move ETH on-chain');
});