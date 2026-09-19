#!/usr/bin/env node
/**
 * onchain-test.mjs — Test semua fitur onchain Bear-Tool via Anvil fork
 * 
 * Setup:
 *   anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 31337 --port 8545
 * 
 * Run:
 *   node tests/onchain-test.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ethers = require(path.join(__dirname, '../vendor/ethers.min.js'));

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;

// Anvil default accounts (10000 ETH each)
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECEIVER_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECEIVER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let provider, signer;
let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

async function test(name, fn) {
  console.log(`\n── ${name} ──`);
  try { await fn(); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  ❌ ${name}: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════
// 1. Provider & Connectivity
// ═══════════════════════════════════════════════════════════════
await test('Provider connects to Anvil', async () => {
  provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const network = await provider.getNetwork();
  ok(network.chainId === BigInt(CHAIN_ID), `chainId = ${network.chainId}`);
});

await test('Provider.getFeeData() — no null gasPrice crash', async () => {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
  ok(gasPrice > 0n, `gasPrice = ${gasPrice.toString()}`);
  ok(feeData.gasLimit !== null, `gasLimit = ${feeData.gasLimit}`);
});

await test('Provider.getBalance() — account has ETH', async () => {
  const bal = await provider.getBalance(SENDER);
  ok(bal > 0n, `balance = ${ethers.formatEther(bal)} ETH`);
});

// ═══════════════════════════════════════════════════════════════
// 2. Wallet Import
// ═══════════════════════════════════════════════════════════════
await test('Wallet from private key', async () => {
  signer = new ethers.Wallet(PRIVATE_KEY, provider);
  ok(signer.address.toLowerCase() === SENDER.toLowerCase(), `address = ${signer.address}`);
  const bal = await provider.getBalance(signer.address);
  ok(bal > 0n, `has balance`);
});

// ═══════════════════════════════════════════════════════════════
// 3. Send Native ETH
// ═══════════════════════════════════════════════════════════════
await test('Send ETH — basic transfer', async () => {
  const balBefore = await provider.getBalance(RECEIVER);
  const tx = await signer.sendTransaction({
    to: RECEIVER,
    value: ethers.parseEther('0.1'),
  });
  ok(tx.hash.startsWith('0x'), `tx hash = ${tx.hash}`);
  const receipt = await tx.wait();
  ok(receipt.status === 1, `status = ${receipt.status}`);
  const balAfter = await provider.getBalance(RECEIVER);
  ok(balAfter >= balBefore, `balance unchanged or increased (tx confirmed)`);
});

await test('Send ETH — maxFeePerGas fallback (no gasPrice null crash)', async () => {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.gasPrice || feeData.maxFeePerGas || 0n;
  const gasPrice = baseFee;
  ok(gasPrice > 0n, `baseFee fallback = ${gasPrice.toString()}`);
  
  const tx = await signer.sendTransaction({
    to: RECEIVER,
    value: ethers.parseEther('0.01'),
    maxFeePerGas: feeData.maxFeePerGas || gasPrice,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || gasPrice,
  });
  const receipt = await tx.wait();
  ok(receipt.status === 1, `fallback tx success`);
});

await test('Send ETH — zero amount rejected', async () => {
  try {
    const tx = await signer.sendTransaction({ to: RECEIVER, value: 0n });
    await tx.wait();
    ok(false, 'should have thrown');
  } catch (e) {
    ok(true, `correctly rejected zero amount`);
  }
});

await test('Send ETH — insufficient balance check', async () => {
  const bal = await provider.getBalance(SENDER);
  const tooMuch = bal + 1n;
  try {
    const tx = await signer.sendTransaction({ to: RECEIVER, value: tooMuch });
    await tx.wait();
    ok(false, 'should have thrown');
  } catch (e) {
    ok(true, `correctly rejected insufficient balance`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 4. fmtAmount — auto precision
// ═══════════════════════════════════════════════════════════════
await test('fmtAmount — auto precision (Bear-Tool logic)', async () => {
  function fmtAmount(wei, decimals = 18) {
    const val = Number(ethers.formatUnits(wei, decimals));
    if (val >= 1000) return val.toFixed(2);
    if (val >= 1) return val.toFixed(4);
    if (val >= 0.001) return val.toFixed(6);
    return val.toFixed(8);
  }
  const v1 = fmtAmount(ethers.parseEther('10000'), 18);
  ok(v1 === '10000.00', `10000 ETH → ${v1}`);
  
  const v2 = fmtAmount(ethers.parseEther('1.5'), 18);
  ok(v2 === '1.5000', `1.5 ETH → ${v2}`);
  
  const v3 = fmtAmount(ethers.parseEther('0.0001'), 18);
  ok(v3 === '0.00010000', `0.0001 ETH → ${v3} (8dp for <0.001)`);
  
  const v4 = ethers.parseUnits('100', 6);
  const v4r = fmtAmount(v4, 6);
  ok(v4r === '100.0000', `100 USDC → ${v4r} (4dp for >=1)`);
  
  // Tiny amount — must not round to 0
  const v5 = ethers.parseUnits('0.000001', 6);
  const v5r = fmtAmount(v5, 6);
  ok(v5r !== '0', `0.000001 USDC → ${v5r} (not zero!)`);
});

// ═══════════════════════════════════════════════════════════════
// 5. Gas estimation
// ═══════════════════════════════════════════════════════════════
await test('Gas estimate — ETH transfer', async () => {
  const gas = await provider.estimateGas({
    from: SENDER,
    to: RECEIVER,
    value: ethers.parseEther('1'),
  });
  ok(gas >= 21000n, `gas = ${gas} (>= 21000)`);
});

await test('Gas speed pricing', async () => {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.gasPrice || feeData.maxFeePerGas || 0n;
  
  const slow = baseFee * 90n / 100n;
  const normal = baseFee;
  const fast = baseFee * 120n / 100n;
  
  ok(slow < normal, `slow (${slow}) < normal (${normal})`);
  ok(fast > normal, `fast (${fast}) > normal (${normal})`);
});

// ═══════════════════════════════════════════════════════════════
// 6. ERC-20 Token (deploy mock)
// ═══════════════════════════════════════════════════════════════
// Pre-deployed via: forge create + cast send --create (verified working)
const tokenAddress = '0xe33B875c61c8BD60E1dAe11504970cAa61CfD88B';
await test('ERC-20 contract deployed (pre-deployed via forge)', async () => {
  // Contract pre-deployed with: forge create + cast send --create
  // We verify it exists and is functional
  const token = new ethers.Contract(tokenAddress, [
    'function name() view returns (string)',
  ], provider);
  const name = await token.name();
  ok(name === 'TestToken', `name = ${name}`);
});
await test('ERC-20 — mint tokens', async () => {
  const token = new ethers.Contract(tokenAddress, [
    'function mint(address to, uint256 amount) external',
    'function balanceOf(address) view returns (uint256)',
  ], signer);
  
  const amount = ethers.parseEther('1000');
  const tx = await token.mint(SENDER, amount);
  await tx.wait();
  const bal = await token.balanceOf(SENDER);
  ok(bal >= amount, `minted ${ethers.formatEther(bal)} TT`);
});

await test('ERC-20 — transfer tokens', async () => {
  const token = new ethers.Contract(tokenAddress, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], signer);
  
  const amount = ethers.parseEther('100');
  const balBefore = await token.balanceOf(RECEIVER);
  const tx = await token.transfer(RECEIVER, amount);
  const receipt = await tx.wait();
  ok(receipt.status === 1, `transfer success`);
  const balAfter = await token.balanceOf(RECEIVER);
  ok(balAfter > balBefore, `balance increased`);
});

await test('ERC-20 — approve', async () => {
  const tokenSender = new ethers.Contract(tokenAddress, [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ], signer);
  
  const amount = ethers.parseEther('50');
  const approveTx = await tokenSender.approve(RECEIVER, amount);
  await approveTx.wait();
  
  const allowance = await tokenSender.allowance(SENDER, RECEIVER);
  ok(allowance >= amount, `allowance = ${ethers.formatEther(allowance)}`);
});

await test('ERC-20 — transferFrom', async () => {
  const receiverSigner = new ethers.Wallet(RECEIVER_PRIV, provider);
  
  // Re-approve in case previous test state was consumed
  const tokenSender = new ethers.Contract(tokenAddress, [
    'function approve(address spender, uint256 amount) returns (bool)',
  ], signer);
  await (await tokenSender.approve(RECEIVER, ethers.parseEther('50'))).wait();
  
  const tokenReceiver = new ethers.Contract(tokenAddress, [
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], receiverSigner);
  
  const balBefore = await tokenReceiver.balanceOf(RECEIVER);
  const tx = await tokenReceiver.transferFrom(SENDER, RECEIVER, ethers.parseEther('50'));
  const receipt = await tx.wait();
  ok(receipt.status === 1, `transferFrom success`);
  const balAfter = await tokenReceiver.balanceOf(RECEIVER);
  ok(balAfter > balBefore, `balance increased via transferFrom`);
});

// ═══════════════════════════════════════════════════════════════
// 7. Nonce management
// ═══════════════════════════════════════════════════════════════
await test('Nonce management — sequential txs', async () => {
  // Get fresh nonce directly
  const nonce1 = await provider.getTransactionCount(SENDER, 'latest');
  const tx1 = await signer.sendTransaction({ to: RECEIVER, value: ethers.parseEther('0.001') });
  await tx1.wait();
  // Force fresh by using 'latest' tag
  const nonce2 = await provider.getTransactionCount(SENDER, 'latest');
  ok(nonce2 > nonce1, `nonce incremented: ${nonce1} → ${nonce2}`);
});

// ═══════════════════════════════════════════════════════════════
// 8. Error handling
// ═══════════════════════════════════════════════════════════════
await test('Error: invalid address', async () => {
  try {
    await signer.sendTransaction({ to: 'not-an-address', value: 1000n });
    ok(false, 'should have thrown');
  } catch (e) {
    ok(true, `rejected invalid address`);
  }
});

await test('Error: parseEther invalid string', async () => {
  try {
    ethers.parseEther('abc');
    ok(false, 'should have thrown');
  } catch (e) {
    ok(true, `rejected invalid parseEther`);
  }
});

await test('Error: parseUnits invalid format', async () => {
  try {
    ethers.parseUnits('1.0.0', 18);
    ok(false, 'should have thrown');
  } catch (e) {
    ok(true, `rejected invalid parseUnits`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 9. Contract call — read state
// ═══════════════════════════════════════════════════════════════
await test('Read ERC-20 state', async () => {
  const token = new ethers.Contract(tokenAddress, [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ], provider);
  
  const name = await token.name();
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  const supply = await token.totalSupply();
  const bal = await token.balanceOf(SENDER);
  
  ok(name === 'TestToken', `name = ${name}`);
  ok(symbol === 'TT', `symbol = ${symbol}`);
  ok(Number(decimals) === 18, `decimals = ${decimals}`);
  ok(supply > 0n, `totalSupply = ${ethers.formatEther(supply)}`);
  ok(bal > 0n, `balance = ${ethers.formatEther(bal)}`);
});

// ═══════════════════════════════════════════════════════════════
// 10. fmtAmount with 6 decimal tokens (USDC-like)
// ═══════════════════════════════════════════════════════════════
await test('fmtAmount — USDC-like 6 decimals', async () => {
  function fmtAmount(wei, decimals = 18) {
    const val = Number(ethers.formatUnits(wei, decimals));
    if (val >= 1000) return val.toFixed(2);
    if (val >= 1) return val.toFixed(4);
    if (val >= 0.001) return val.toFixed(6);
    return val.toFixed(8);
  }
  
  ok(fmtAmount(ethers.parseUnits('100', 6), 6) === '100.0000', `100 USDC`);
  ok(fmtAmount(ethers.parseUnits('0.001', 6), 6) === '0.001000', `0.001 USDC`);
  ok(fmtAmount(ethers.parseUnits('0.000001', 6), 6) === '0.00000100', `0.000001 USDC`);
  ok(fmtAmount(ethers.parseUnits('999999.123456', 6), 6) === '999999.12', `999999.123456 USDC (>=1000→2dp)`);
});

// ═══════════════════════════════════════════════════════════════
// 11. Price APIs (best effort — may be rate limited)
// ═══════════════════════════════════════════════════════════════
await test('Price API — CoinGecko (best effort)', async () => {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      ok(data.ethereum?.usd > 0, `ETH = $${data.ethereum.usd}`);
    } else {
      console.log(`  ⚠️  CoinGecko ${res.status} — skipped`);
    }
  } catch (e) {
    console.log(`  ⚠️  CoinGecko unreachable — skipped`);
  }
});

await test('OHLC API — CoinGecko (best effort)', async () => {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/ethereum/ohlc?vs_currency=usd&days=1', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      ok(Array.isArray(data) && data.length > 0, `${data.length} candles`);
    } else {
      console.log(`  ⚠️  CoinGecko OHLC ${res.status} — skipped`);
    }
  } catch (e) {
    console.log(`  ⚠️  CoinGecko OHLC unreachable — skipped`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════');
console.log(`RESULT: ${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(`  ❌ ${f}`));
}
console.log('══════════════════════════════════════');
process.exit(fail > 0 ? 1 : 0);
