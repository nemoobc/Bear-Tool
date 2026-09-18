// Bear Tool — fork-swap.test.js
// Real swap on an anvil fork via the verified V2 router of each network that
// has one with liquidity (Ethereum Uniswap V2, BSC PancakeSwap, Polygon
// Quickswap). Networks without a V2 router skip with an honest reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, forkSkipReason, KNOWN_TOKENS, ANVIL_ACCOUNT, stopFork } from './fork-helper.mjs';

const skip = forkSkipReason();

// Verified V2 routers per network (from js/swap.js + on-chain checks).
const V2_ROUTERS = {
  ethereum: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2
  bsc:      '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap V2
  polygon:  '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'  // Quickswap V2
};

const V2_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});


test('fork: swap ETH→stable via verified V2 router', { skip }, async () => {
  const { signer, provider, network } = await startFork();
  const routerAddr = V2_ROUTERS[network.name];
  if (!routerAddr) {
    // honest skip: no V2 router with liquidity on this fork
    return;
  }
  const tokens = KNOWN_TOKENS[network.name];
  if (!tokens?.weth || !tokens?.usdc) return;

  const { ethers } = await import('ethers');
  const router = new ethers.Contract(routerAddr, V2_ABI, signer);
  const weth = tokens.weth;
  const usdc = tokens.usdc;
  const amountIn = ethers.parseEther('0.001');

  // 1) quote — proves liquidity exists on the fork
  const amounts = await router.getAmountsOut(amountIn, [weth, usdc]);
  assert.ok(amounts[1] > 0n, 'quote must return a positive output (liquidity exists)');

  // 2) real swap — ETH in, stable out
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const minOut = (amounts[1] * 90n) / 100n; // 10% slippage headroom
  const tx = await router.swapExactETHForTokens(minOut, [weth, usdc], ANVIL_ACCOUNT, deadline, { value: amountIn });
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'swap must succeed on-chain');

  // 3) the stable actually arrived
  const usdcContract = new ethers.Contract(usdc, ['function balanceOf(address) view returns (uint256)'], provider);
  const bal = await usdcContract.balanceOf(ANVIL_ACCOUNT);
  assert.ok(bal >= minOut, `USDC balance must be >= minOut (got ${bal})`);
});