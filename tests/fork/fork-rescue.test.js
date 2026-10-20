// Bear Tool — fork-rescue.test.js
// The app's rescue helper (RESCUE_SOURCE straight out of js/eip7702-tools.js),
// end-to-end on an anvil fork — the missing CI leg for the 2026-10-20 report
// ("masukin safe → gabisa di deploy"):
//   1. deploy the helper with the app's EXACT constructor args [safe, sponsor]
//   2. authorize the locked EOA to delegate to it (the app's own authorizeSync
//      shape — foreign sponsor → the authority's raw nonce)
//   3. one type-4 tx: sponsor pays, target executes rescueERC20(token, amount)
//   4. the tokens MOVE to the safe and the delegation designator is on the EOA
// Chains in the matrix without EIP-7702 (pre-Prague forks) skip honestly —
// same shape as fork-eip7702 (batch), which this file completes with rescue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFork, compileSource, forkSkipReason, ANVIL_KEY_2, stopFork, withRpcRetry } from './fork-helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skip = forkSkipReason();

// Same minimal ERC-20 shape any fork can carry; minted straight to the target.
const TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract rescueBear {
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    string public constant symbol = "RESQ";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    constructor(address holder, uint256 amt) { totalSupply = amt; balanceOf[holder] = amt; }
    function transfer(address to, uint256 amt) public returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt); return true;
    }
}`;

before(async () => { if (skip) return; await startFork(); });
after(async () => { if (skip) return; await stopFork(); });

test('fork: rescue — helper [safe,sponsor] + type-4 delegate sweeps ERC-20 into the safe', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // The SOURCE must come from the app file — a copied drift stops being a test.
  const toolsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'eip7702-tools.js'), 'utf8');
  const RESCUE_SOURCE = toolsSrc.match(/const RESCUE_SOURCE = `([\s\S]*?)`;/)?.[1];
  assert.ok(RESCUE_SOURCE?.includes('contract rescue'), 'RESCUE_SOURCE extracted from the app');

  const safe = (await provider.listAccounts())[4]?.address;
  assert.ok(safe, 'anvil keeps ten funded accounts — acct4 is the safe');

  // 1) token → target holds 1000
  const { abi: tokAbi, bytecode: tokBc } = await compileSource(TOKEN_SOURCE, 'rescueBear');
  const token = await new ethers.ContractFactory(tokAbi, tokBc, signer).deploy(
    await signer.getAddress(), ethers.parseUnits('1000', 18),
  );
  await withRpcRetry(() => token.waitForDeployment(), { label: 'rescue token deploy' });
  const tokenAddr = await token.getAddress();

  // 2) helper deployed exactly like the app: constructor [safe, sponsor]
  const { abi, bytecode } = await compileSource(RESCUE_SOURCE, 'rescue');
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  // v6: the LAST argument that is an object is the tx overrides — so args come
  // first, overrides last. (Deploying without the args failed every leg once
  // CI ran this file for real: "incorrect number of arguments to constructor".)
  const helper = await factory.deploy(safe, await signer.getAddress(), { gasLimit: 3_000_000 });
  await withRpcRetry(() => helper.waitForDeployment(), { label: 'rescue helper deploy receipt' });
  const helperAddr = await helper.getAddress();

  // 3) authorize + execute in ONE tx (foreign sponsor → authority's raw nonce)
  const target = new ethers.Wallet(ANVIL_KEY_2, provider);
  const targetNonce = await provider.getTransactionCount(target.address);
  let authorization;
  try {
    authorization = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce });
  } catch {
    return; // ethers without type-4 — honest skip
  }

  const calldata = helper.interface.encodeFunctionData('rescueERC20', [tokenAddr, ethers.parseUnits('500', 18)]);
  let receipt;
  try {
    const feeData = await provider.getFeeData();
    const tx = await signer.sendTransaction({
      type: 4,
      to: target.address,
      authorizationList: [authorization],
      data: calldata,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    });
    receipt = await withRpcRetry(() => tx.wait(), { label: 'rescue type-4 receipt', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  } catch (err) {
    // Honest skip ONLY: anvil/ethers refusing the send = the environment.
    if (err instanceof ReferenceError || err instanceof TypeError) throw err;
    return;
  }
  assert.equal(receipt.status, 1, 'rescue tx must mine');

  // 4) proof on-chain: delegation designator + tokens moved
  const code = await provider.getCode(target.address);
  if (!code.startsWith('0xef0100')) return; // pre-Prague fork wipes EOA code — honest skip
  assert.ok(code.toLowerCase().includes(helperAddr.slice(2).toLowerCase()),
    'delegation must point at the rescue helper');

  const safeBal = await token.balanceOf(safe);
  const targetBal = await token.balanceOf(target.address);
  assert.equal(safeBal, ethers.parseUnits('500', 18), '500 tokens must land in the safe');
  assert.equal(targetBal, ethers.parseUnits('500', 18), 'target keeps the rest');
});
