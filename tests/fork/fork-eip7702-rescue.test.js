// Bear Tool — fork-eip7702-rescue.test.js
// RESCUE, end to end on an anvil fork — the flow `Rescue` in Tools runs:
// deploy the rescue helper, delegate the target EOA to it (EIP-7702 type-4),
// then the RESCUER (gas sponsor) calls rescueERC20All() THROUGH the
// delegation, so the delegated EOA sweeps its own TOKENS into the SAFE.
//
// Native ETH is NOT part of the story anymore (user request 2026-10-18): the
// helper has no rescueETH and no receive(), so an EOA with only ETH has
// nothing this flow can pull out — the test pins that ETH stays put and the
// SAFE never fills with it (nothing can enter, nothing gets bricked).
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
import { startFork, compileSource, deployContract, deployErc20, forkSkipReason, ANVIL_ACCOUNT, ANVIL_ACCOUNT_2, ANVIL_KEY_2, stopFork, waitForTx, withRpcRetry } from './fork-helper.mjs';

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

// The surface pin (pure string — runs even where foundry is missing): the
// request 2026-10-18 killed ETH-only rescue, on-chain AND on explorers' Write
// Contract tab. Comments mentioning the names are fine; CODE is not.
test('rescue surface: no rescueETH, no receive() — the ERC-20 sweep is the live surface', async () => {
  const src = appSource('RESCUE_SOURCE');
  assert.ok(!/function\s+rescueETH\b/.test(src), 'rescueETH must not exist (dropped by request 2026-10-18)');
  assert.ok(!/function\s+receive\b/.test(src), 'helper must have no receive() — nothing can gift it ETH to get stuck');
  assert.ok(/function\s+rescueERC20All\b/.test(src), 'the token sweep is the live path this test exercises');
});

test('fork: rescue helper delegates the target EOA and sweeps ERC-20 into the SAFE', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // 1) fresh ERC-20 (deployer = anvil #0 = the sponsor seen by `onlyRescuer`)
  //    and the rescue helper: SAFE = where funds must land, RESCUER = sponsor.
  const token = await deployErc20(signer);
  const tokenAddr = await token.getAddress();
  const deployerTokens = await token.balanceOf(ANVIL_ACCOUNT);
  assert.ok(deployerTokens > 0n, 'the token template must mint its supply to the deployer');
  const SAFE = ethers.Wallet.createRandom().address;
  const { abi, bytecode } = await compileSource(appSource('RESCUE_SOURCE'), 'rescue');
  // The deployer is anvil's account #0 — the NonceManager signer has no .address.
  const helper = await deployContract(signer, abi, bytecode, [SAFE, ANVIL_ACCOUNT]);
  const helperAddr = await helper.getAddress();

  // 2) the target: anvil's second account — the user story is an EOA stuck
  //    with assets it cannot spend. Hand it tokens worth rescuing first.
  const target = new ethers.Wallet(ANVIL_KEY_2, provider);
  assert.equal(target.address, ANVIL_ACCOUNT_2, 'target key is anvil account #2');

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
  if (!code.startsWith('0xef0100')) {
    // authorize mined, but this chain's forked EVM (pre-Prague at its pinned
    // block — avalanche, blast, CI 38012045876) wipes EOA code: no type-4.
    // Honest skip, loudly; ethereum and other7702 chains still prove it live.
    process.stderr.write(`[fork] ${network.name}: authorize mined but no delegation designator — chain EVM predates EIP-7702, honest skip\n`);
    return;
  }

  const amount = deployerTokens / 10n;        // 10% of the supply — plenty, deterministic
  const funding = await withRpcRetry(() => token.transfer(target.address, amount), { label: 'token to target', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  await withRpcRetry(() => funding.wait(), { label: 'token funding receipt', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  const targetTokens = await token.balanceOf(target.address);
  assert.equal(targetTokens, amount, 'the target must hold the tokens that will be swept');
  assert.equal(await token.balanceOf(SAFE), 0n, 'SAFE starts empty on the fork');

  // The sponsoring account pays for every tx in this flow, so the target's
  // native ETH is untouched from here on — the pin at the end relies on it.
  const targetEthBefore = await provider.getBalance(target.address);

  // 4) execute rescueERC20All through the delegation. Anvil only runs the
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
    data: helper.interface.encodeFunctionData('rescueERC20All', [tokenAddr]),
  });
  const receipt = await waitForTx(execTx, 'rescue execute');
  assert.equal(receipt.status, 1, 'delegated rescue must succeed');

  // 5) balances: poll instead of one read — anvil's fork state can sit a
  //    block behind the receipt (pattern shared with fork-send.test.js).
  const deadline = Date.now() + 30_000;
  let safeTokens = await token.balanceOf(SAFE);
  let targetAfter = await token.balanceOf(target.address);
  while ((targetAfter !== 0n || safeTokens !== targetTokens) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    safeTokens = await token.balanceOf(SAFE);
    targetAfter = await token.balanceOf(target.address);
  }
  assert.equal(targetAfter, 0n, 'the delegated EOA must be emptied of tokens');
  assert.equal(safeTokens, targetTokens, 'the SAFE must receive the whole token balance');

  // 6) native ETH is intentionally NOT recoverable (request 2026-10-18): no
  //    rescueETH, no receive() — and the sponsor paid the gas, so the EOA's
  //    ETH sits exactly where it was. Nothing entered the helper to brick.
  assert.equal(await provider.getBalance(target.address), targetEthBefore, 'ETH stays put — no native rescue exists');
  assert.equal(await provider.getBalance(SAFE), 0n, 'the SAFE receives no ETH either');
});

test('fork: a non-rescuer cannot call rescueERC20All through the delegation', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const { ethers } = await import('ethers');

  // Same helper shape with a DIFFERENT rescuer: the sponsor account is no
  // longer authorized, so the delegated call must revert on onlyRescuer.
  const token = await deployErc20(signer);
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

  const amount = 1000n * 10n ** 18n;
  const funding = await withRpcRetry(() => token.transfer(target.address, amount), { label: 'token to target (stranger rescuer)', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });
  await withRpcRetry(() => funding.wait(), { label: 'token funding receipt (stranger rescuer)', attempts: 3, delayMs: 3000, timeoutMs: 45_000 });

  const targetTokens = await token.balanceOf(target.address);
  const targetEthBefore = await provider.getBalance(target.address);
  const auth2 = target.authorizeSync({ chainId: network.chainId, address: helperAddr, nonce: targetNonce++ });
  const fee = await provider.getFeeData();
  const data = helper.interface.encodeFunctionData('rescueERC20All', [await token.getAddress()]);
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
  assert.equal(await token.balanceOf(SAFE), 0n, 'SAFE must be untouched');
  assert.equal(await token.balanceOf(target.address), targetTokens, 'target keeps its tokens');
  assert.equal(await provider.getBalance(target.address), targetEthBefore, 'target keeps its ETH');
});
