// Bear Tool — fork-helper.mjs
// On-chain fork test harness. Each network is forked with Anvil (foundry)
// from a public RPC, then real transactions run against the fork:
// deploy, transfer, swap, approvals, EIP-7702.
//
// Local (Termux) has no anvil → every fork test skips with an honest reason.
// CI (GitHub Actions) installs foundry and runs one job per network.
//
// Usage:
//   node --test tests/fork/            # all fork tests (skip if no anvil)
//   FORK_NETWORK=ethereum node --test tests/fork/
//   FORK_RPC_URL=https://... node --test tests/fork/   # custom RPC
//   FORK_PORT=8545 node --test tests/fork/             # existing anvil

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// contracts.js reads `ethers` from globalThis (browser-style). The fork
// tests run in Node, so expose the real ethers BEFORE any helper uses it —
// otherwise buildDeployPlan throws TypeError and every fork test fails.
const { ethers } = await import('ethers');
globalThis.ethers = ethers;

// ── network table: public RPC per network (publicnode, free, stable) ──
export const FORK_NETWORKS = {
  ethereum:          { chainId: 1,      rpc: 'https://ethereum-rpc.publicnode.com',          type: 'mainnet' },
  bsc:               { chainId: 56,     rpc: 'https://bsc-rpc.publicnode.com',               type: 'mainnet' },
  polygon:           { chainId: 137,    rpc: 'https://polygon-bor-rpc.publicnode.com',       type: 'mainnet' },
  arbitrum:          { chainId: 42161,  rpc: 'https://arbitrum-one-rpc.publicnode.com',      type: 'mainnet' },
  optimism:          { chainId: 10,     rpc: 'https://optimism-rpc.publicnode.com',          type: 'mainnet' },
  base:              { chainId: 8453,   rpc: 'https://base-rpc.publicnode.com',              type: 'mainnet' },
  sepolia:           { chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', type: 'testnet' },
  amoy:              { chainId: 80002,  rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',  type: 'testnet' },
  'arbitrum-sepolia': { chainId: 421614, rpc: 'https://arbitrum-sepolia-rpc.publicnode.com', type: 'testnet' },
  'optimism-sepolia': { chainId: 11155420, rpc: 'https://optimism-sepolia-rpc.publicnode.com', type: 'testnet' },
  'base-sepolia':     { chainId: 84532, rpc: 'https://base-sepolia-rpc.publicnode.com',      type: 'testnet' },
  'bsc-testnet':      { chainId: 97,    rpc: 'https://bsc-testnet-rpc.publicnode.com',       type: 'testnet' }
};

export const NETWORK_NAMES = Object.keys(FORK_NETWORKS);

// Anvil's default funded account (10000 ETH on the fork).
export const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let anvilProcess = null;
let provider = null;
let signer = null;
let network = null;

export function currentNetwork() { return network; }

// Resolve which network to fork: FORK_NETWORK env, else FORK_RPC_URL, else ethereum.
function resolveNetwork() {
  const name = process.env.FORK_NETWORK || 'ethereum';
  const def = FORK_NETWORKS[name];
  if (!def) throw new Error(`Unknown FORK_NETWORK "${name}". Valid: ${NETWORK_NAMES.join(', ')}`);
  return { name, ...def, rpc: process.env.FORK_RPC_URL || def.rpc };
}

function hasAnvil() {
  return new Promise((resolve) => {
    const p = spawn('anvil', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

// Start anvil forked from the network RPC. Reuses FORK_PORT if already running.
export async function startFork() {
  if (provider) return { provider, signer, network };
  network = resolveNetwork();
  // Unique port per process: node --test runs each file in its own process,
  // and a shared port lets a later file REUSE a dirty anvil (nonces already
  // consumed) — the probe finds the port alive and skips a fresh start.
  // pid % 1000 keeps ports in 8545..9544, no collisions on a runner.
  const port = Number(process.env.FORK_PORT || (8545 + (process.pid % 1000)));

  // If something is already listening on the port, assume anvil is up (CI reuse).
  const alive = await new Promise((resolve) => {
    const probe = spawn('node', ['-e', `
      fetch('http://127.0.0.1:${port}').then(r => process.exit(0)).catch(() => process.exit(1));
    `], { stdio: 'ignore' });
    probe.on('exit', (code) => resolve(code === 0));
  });

  if (!alive) {
    if (!(await hasAnvil())) {
      throw new Error('anvil not installed — fork tests need foundry (CI installs it; locally run `npm run test:fork` only in CI)');
    }
    anvilProcess = spawn('anvil', [
      '--fork-url', network.rpc,
      '--port', String(port),
      '--silent',
      '--chain-id', String(network.chainId)
    ], { stdio: 'ignore' });
    // Do not let the anvil child keep the Node process alive after the
    // tests finish (pass OR fail) — otherwise CI hangs until timeout.
    anvilProcess.unref();
    process.on('exit', () => { if (anvilProcess) { try { anvilProcess.kill('SIGKILL'); } catch {} } });
    // wait for the RPC to answer
    const deadline = Date.now() + 60000;
    for (;;) {
      const ok = await new Promise((resolve) => {
        const p = spawn('node', ['-e', `
          fetch('http://127.0.0.1:${port}').then(r => process.exit(0)).catch(() => process.exit(1));
        `], { stdio: 'ignore' });
        p.on('exit', (code) => resolve(code === 0));
      });
      if (ok) break;
      if (Date.now() > deadline) throw new Error('anvil did not start in time');
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const { ethers } = await import('ethers');
  provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  // NonceManager tracks the nonce LOCALLY (query once, increment per send).
  // Anvil's "pending" nonce on a fork is base + txpool and IGNORES mined
  // txs, so a fresh query after a mined tx returns a stale low nonce →
  // "nonce too low" on the very next send. NonceManager sidesteps that.
  signer = new ethers.NonceManager(new ethers.Wallet(ANVIL_KEY, provider));
  return { provider, signer, network };
}

export async function stopFork() {
  if (anvilProcess) { anvilProcess.kill(); anvilProcess = null; }
  provider = null; signer = null; network = null;
}

// ── solc (real compile, cached per process) ──
let compileCache = new Map();

async function loadSolc() {
  const solcJs = await import('../../js/solc.js');
  const file = process.env.BEAR_SOLC_FILE || path.join('/data/data/com.termux/files/usr/tmp/opencode', 'soljson-0828.js');
  let code;
  if (fs.existsSync(file)) {
    code = fs.readFileSync(file, 'utf8');
  } else {
    const res = await fetch(solcJs.SOLC_URL);
    if (res.status !== 200) throw new Error('compiler download failed: ' + res.status);
    code = await res.text();
  }
  const sandbox = { console, setTimeout, clearTimeout, process, Buffer, __dirname: '.', module: {}, exports: {} };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const M = sandbox.Module;
  if (!M || typeof M.cwrap !== 'function') throw new Error('soljson did not expose Module.cwrap');
  const raw = M.cwrap('solidity_compile', 'string', ['string', 'number']);
  return { compile: (json) => raw(json, 1) };
}

// Compile a Solidity source → { abi, bytecode }. Cached by source+name.
export async function compileSource(source, contractName) {
  const key = contractName + ':' + source.length;
  if (compileCache.has(key)) return compileCache.get(key);
  const solc = await loadSolc();
  const input = {
    language: 'Solidity',
    sources: { [`${contractName}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error('Compile error: ' + (errors[0].formattedMessage || errors[0].message));
  const contract = output.contracts?.[`${contractName}.sol`]?.[contractName];
  if (!contract?.evm?.bytecode?.object) throw new Error('no bytecode for ' + contractName);
  const result = { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
  compileCache.set(key, result);
  return result;
}

// ── deploy helpers ──
export async function deployContract(signer, abi, bytecode, args = []) {
  const { ethers } = await import('ethers');
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

// Deploy a fresh ERC-20 (self-contained template from the app) and return it.
export async function deployErc20(signer) {
  const contracts = await import('../../js/contracts.js');
  const std = contracts.getStandard('erc20');
  const plan = contracts.buildDeployPlan({ standard: 'erc20', name: 'Fork Bear', symbol: 'FBR', supply: '1000000', decimals: 18 });
  const { abi, bytecode } = await compileSource(std.source, std.contract);
  return deployContract(signer, abi, bytecode, plan.args);
}

export async function deployErc721(signer) {
  const contracts = await import('../../js/contracts.js');
  const std = contracts.getStandard('erc721');
  const plan = contracts.buildDeployPlan({ standard: 'erc721', name: 'Fork Bears', symbol: 'FBR', baseUri: 'ipfs://fork/' });
  const { abi, bytecode } = await compileSource(std.source, std.contract);
  return deployContract(signer, abi, bytecode, plan.args);
}

export async function deployErc1155(signer) {
  const contracts = await import('../../js/contracts.js');
  const std = contracts.getStandard('erc1155');
  const plan = contracts.buildDeployPlan({ standard: 'erc1155', name: 'Fork Items', symbol: 'FITM', baseUri: 'ipfs://fork/' });
  const { abi, bytecode } = await compileSource(std.source, std.contract);
  return deployContract(signer, abi, bytecode, plan.args);
}

// ── well-known tokens on the fork (for send/swap/approval tests) ──
// WETH + a stablecoin per network, where they exist. Addresses are the
// canonical ones; the fork preserves them.
export const KNOWN_TOKENS = {
  ethereum: { weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  bsc:      { weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  polygon:  { weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
  arbitrum: { weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  optimism: { weth: '0x4200000000000000000000000000000000000006', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  base:     { weth: '0x4200000000000000000000000000000000000006', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  sepolia:  { weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  amoy:     { weth: null, usdc: null },
  'arbitrum-sepolia': { weth: null, usdc: null },
  'optimism-sepolia': { weth: null, usdc: null },
  'base-sepolia': { weth: null, usdc: null },
  'bsc-testnet': { weth: null, usdc: null }
};

// ── skip guard for tests that need a live fork ──
export function forkSkipReason() {
  if (process.env.FORK_SKIP === '1') return 'FORK_SKIP=1';
  if (!process.env.CI && !process.env.FORK_RPC_URL && !process.env.FORK_PORT) {
    return 'no anvil locally — fork tests run in GitHub Actions (CI)';
  }
  return false;
}