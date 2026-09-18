// Bear Tool — fork-deploy.test.js
// Deploy ERC-20 / ERC-721 / ERC-1155 on an anvil fork of the network and
// verify real on-chain state: totalSupply, ownerOf, balanceOf, transfer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, deployErc20, deployErc721, deployErc1155, forkSkipReason, ANVIL_ACCOUNT, stopFork } from './fork-helper.mjs';

const skip = forkSkipReason();

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('fork: deploy ERC-20 → totalSupply + balance + transfer', { skip }, async () => {
  const { signer, provider } = await startFork();
  const token = await deployErc20(signer);
  const addr = await token.getAddress();

  const supply = await token.totalSupply();
  assert.equal(supply, 1000000n * 10n ** 18n, 'totalSupply must be 1,000,000 scaled by 18 decimals');

  const bal = await token.balanceOf(ANVIL_ACCOUNT);
  assert.equal(bal, supply, 'deployer must hold the full supply');

  // real transfer on the fork
  const to = '0x000000000000000000000000000000000000dEaD';
  const tx = await token.transfer(to, 12345n * 10n ** 18n);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'transfer must succeed on-chain');
  assert.equal(await token.balanceOf(to), 12345n * 10n ** 18n, 'recipient must receive the tokens');
  assert.equal(await token.balanceOf(ANVIL_ACCOUNT), supply - 12345n * 10n ** 18n, 'sender balance must decrease');

  // contract must be recorded as alive on the fork
  assert.notEqual(await provider.getCode(addr), '0x', 'deployed contract must have code');
});

test('fork: deploy ERC-721 → mint + ownerOf', { skip }, async () => {
  const { signer } = await startFork();
  const nft = await deployErc721(signer);
  const addr = await nft.getAddress();

  // template mints with auto-incrementing id (mint(address), no id param)
  const tx = await nft.mint(ANVIL_ACCOUNT);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'mint must succeed on-chain');
  assert.equal(await nft.ownerOf(1n), ANVIL_ACCOUNT, 'token 1 must belong to the minter');
  assert.equal(await nft.balanceOf(ANVIL_ACCOUNT), 1n, 'minter must hold 1 NFT');
  assert.ok(addr.startsWith('0x'), 'contract address must be hex');
});

test('fork: deploy ERC-1155 → mint + balanceOf', { skip }, async () => {
  const { signer } = await startFork();
  const multi = await deployErc1155(signer);

  // template mint signature is mint(address,uint256,uint256) — no data param
  const tx = await multi.mint(ANVIL_ACCOUNT, 7n, 42n);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'mint must succeed on-chain');
  assert.equal(await multi.balanceOf(ANVIL_ACCOUNT, 7n), 42n, 'balance must be 42 for token id 7');
});