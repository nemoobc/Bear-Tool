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
import os from 'node:os';   // os.tmpdir() for the per-port anvil lock

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// contracts.js reads `ethers` from globalThis (browser-style). The fork
// tests run in Node, so expose the real ethers BEFORE any helper uses it —
// otherwise buildDeployPlan throws TypeError and every fork test fails.
const { ethers } = await import('ethers');
globalThis.ethers = ethers;

// ── network table: public RPC per network ──
// publicnode blocks eth_getTransactionReceipt (archive) with 403 on most
// networks, so non-ethereum networks use official chain endpoints.
export const FORK_NETWORKS = {
  ethereum:          { chainId: 1,      rpc: 'https://ethereum-rpc.publicnode.com',          type: 'mainnet' },
  bsc:               { chainId: 56,     rpc: 'https://bsc-dataseed.binance.org',             type: 'mainnet' },
  polygon:           { chainId: 137,    rpc: 'https://polygon-bor-rpc.publicnode.com',       type: 'mainnet' },
  arbitrum:          { chainId: 42161,  rpc: 'https://arb1.arbitrum.io/rpc',                 type: 'mainnet' },
  optimism:          { chainId: 10,     rpc: 'https://mainnet.optimism.io',                  type: 'mainnet' },
  base:              { chainId: 8453,   rpc: 'https://mainnet.base.org',                     type: 'mainnet' },
  sepolia:           { chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', type: 'testnet' },
  amoy:              { chainId: 80002,  rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',  type: 'testnet' },
  'arbitrum-sepolia': { chainId: 421614, rpc: 'https://sepolia-rollup.arbitrum.io/rpc',      type: 'testnet' },
  'optimism-sepolia': { chainId: 11155420, rpc: 'https://sepolia.optimism.io',               type: 'testnet' },
  'base-sepolia':     { chainId: 84532, rpc: 'https://sepolia.base.org',                     type: 'testnet' },
  'bsc-testnet':      { chainId: 97,    rpc: 'https://data-seed-prebsc-1-s1.binance.org:8545', type: 'testnet' }
};

export const NETWORK_NAMES = Object.keys(FORK_NETWORKS);

// Anvil's default funded account (10000 ETH on the fork).
export const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Anvil's second default account. Needed by anything that has to model a
// THIRD party pulling a token: `transferFrom` checks the allowance of
// msg.sender, so a test that approves the router and then calls transferFrom as
// the owner checks allowance(owner, owner) — which is zero — and reverts with
// "ERC20: insufficient allowance" no matter what was approved. The spender has
// to be the one making the call.
export const ANVIL_ACCOUNT_2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const ANVIL_KEY_2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

let anvilProcess = null;
// Set by startFork(); stopFork() calls it so the port lock is freed as soon as the
// fork is stopped, instead of only when the process happens to exit.
let releaseForkLock = null;
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
  const port = Number(process.env.FORK_PORT || 8545);

  // A lock, so two runs cannot share one anvil.
  //
  // The probe below treats "something is listening on the port" as "anvil is
  // already up, reuse it". That is a trap with no way out: a second `npm run
  // test:fork` on the same machine silently adopts the FIRST run's anvil, and
  // the two then deploy from the same funded account — same deployer, same
  // nonce, same block. They deadlock or produce nonces that belong to the other
  // run, and the symptom is a hang with every process at 0% CPU, which reads as
  // "the machine is slow" rather than "two runs are fighting".
  //
  // Observed exactly that: a full-suite run and a single-file diagnostic, both
  // on port 8545, all four node processes idle and the suite never finishing.
  //
  // The lock is held by the process, so a crashed run releases it, and it names
  // the holder in the error so the cause is obvious from the message.
  const lockPath = path.join(os.tmpdir(), `bear-fork-${port}.lock`);
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeSync(lockFd, `pid=${process.pid} started=${new Date().toISOString()}\n`);
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    const holder = (() => { try { return fs.readFileSync(lockPath, 'utf8').trim(); } catch { return 'unknown'; } })();
    throw new Error(
      `Port ${port} is already locked by another Bear Tool fork run (${holder}). ` +
      `Two runs cannot share one anvil: they deploy from the same account with the ` +
      `same nonce and deadlock. Wait for it to finish, or set FORK_PORT to a ` +
      `different port for this run. If you are sure nothing is running, delete ` +
      `${lockPath}.`
    );
  }
  const releaseLock = () => {
    if (releaseForkLock === releaseLock) releaseForkLock = null;
    try { if (lockFd != null) fs.closeSync(lockFd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };
  releaseForkLock = releaseLock;
  process.on('exit', releaseLock);

  try {
    return await startForkLocked(port);
  } catch (e) {
    releaseLock();
    throw e;
  }
}

async function startForkLocked(port) {
  // "Something is listening" is not "our anvil". When FORK_NETWORK changes and
  // the previous network's anvil is still on the port, this used to adopt it —
  // wrong chain, wrong state — and every test failed until something else killed
  // it. A sweep across twelve networks needed a retry on all 7 files, every
  // time, which is not flakiness: it is this, deterministically.
  //
  // So the port is only reused if the thing on it is actually on the chain we
  // asked for. Anything else gets killed and replaced.
  const probeChain = () => new Promise((resolve) => {
    const probe = spawn('node', ['-e', `
      (async () => {
        try {
          const r = await fetch('http://127.0.0.1:${port}', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          });
          const j = await r.json();
          process.stdout.write(String(parseInt(j.result, 16)));
        } catch { process.stdout.write('none'); }
        process.exit(0);
      })();
    `], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (c) => { out += c; });
    probe.on('exit', () => resolve(out.trim()));
    probe.on('error', () => resolve('none'));
  });

  let found = await probeChain();
  if (found !== 'none' && found !== String(network.chainId)) {
    process.stderr.write(
      `[fork] port ${port} is serving chain ${found}, not ${network.chainId} — ` +
      `replacing it rather than adopting it
`);
    await new Promise((resolve) => {
      const killer = spawn('node', ['-e', `
        const net = require('net');
        // Find the pid listening on the port via netstat and stop it. Windows and
        // POSIX differ, so try both shapes and ignore failure.
        const { execSync } = require('child_process');
        for (const cmd of ['netstat -ano -p tcp', 'netstat -anp tcp', 'ss -lptn']) {
          try {
            const out = execSync(cmd, { encoding: 'utf8' });
            for (const line of out.split('\n')) {
              if (!line.includes(':' + ${port} + ' ')) continue;
              const m = line.trim().match(/(\d+)\s*$/);
              if (m && m[1] !== String(process.pid)) {
                try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
              }
            }
            break;
          } catch {}
        }
        process.exit(0);
      `], { stdio: 'ignore' });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await probeChain()) === 'none') break;
    }
    found = await probeChain();
  }
  const alive = found !== 'none';

  if (!alive) {
    if (!(await hasAnvil())) {
      throw new Error('anvil not installed — fork tests need foundry (CI installs it; locally run `npm run test:fork` only in CI)');
    }
    // Retry loop: publicnode RPCs can be slow/rate-limited (polygon flakes
    // "anvil did not start in time"). A fresh anvil process often initializes
    // faster than waiting on a stuck one, so kill and retry up to 3 attempts.
    let started = false;
    for (let attempt = 1; attempt <= 3 && !started; attempt++) {
      anvilProcess = spawn('anvil', [
        '--fork-url', network.rpc,
        '--port', String(port),
        '--silent',
        '--chain-id', String(network.chainId),
        '--hardfork', 'prague',
        // Harmless for the node tests, and it lets the same anvil serve a
        // browser: without it anvil does not answer the CORS preflight, so a
        // page cannot POST JSON-RPC to it even though curl and node can.
        '--allow-origin', '*'
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
        if (ok) { started = true; break; }
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!started) {
        try { anvilProcess.kill('SIGKILL'); } catch {}
        anvilProcess = null;
      }
    }
    if (!started) throw new Error('anvil did not start in time');
  }

  const { ethers } = await import('ethers');
  provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  // NonceManager keeps nonces strictly sequential. Without it, ethers v6
  // queries getTransactionCount per tx and anvil's fork state can lag one
  // block behind → two txs share a nonce → "nonce too low" (flaky).
  signer = new ethers.NonceManager(new ethers.Wallet(ANVIL_KEY, provider));
  return { provider, signer, network };
}

export async function stopFork() {
  if (anvilProcess) { anvilProcess.kill(); anvilProcess = null; }
  if (releaseForkLock) releaseForkLock();
  // A provider left polling keeps the event loop alive, so the test file
  // finishes its assertions and then never exits — which the runner reports as
  // a timeout on the FILE, not on any test. This is reachable whenever a
  // bounded wait is abandoned: the poller behind tx.wait() is still running,
  // and nothing cancels it. Turning polling off and destroying the provider
  // releases the timer.
  try {
    if (provider) {
      provider.polling = false;
      if (typeof provider.destroy === 'function') provider.destroy();
    }
  } catch { /* a provider that cannot be destroyed must not block teardown */ }
  provider = null; signer = null; network = null;
}

// ── solc (real compile, cached per process) ──
let compileCache = new Map();

async function loadSolc() {
  const solcJs = await import('../../js/solc.js');
  // Look in a list of plausible local copies, not one hardcoded path. The
  // default used to be /data/data/com.termux/… — a Termux-only absolute path,
  // so on any other machine the file never existed and every fork test either
  // skipped or silently fell through to the network. Same class of bug as the
  // new URL(...).pathname one: a path that is only correct on the machine that
  // wrote it. Order matters — the first hit wins.
  const candidates = [
    process.env.BEAR_SOLC_FILE,
    path.join(__dirname, 'soljson-0828.js'),
    path.join(__dirname, '..', '..', 'soljson-0828.js'),
    path.join(__dirname, '..', '..', 'vendor', 'soljson-0828.js'),
  ].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  let code;
  if (file) {
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
/**
 * Retry a call that failed for transport reasons only.
 *
 * These tests fork public RPC endpoints, and four forks run in parallel, so a
 * dropped connection looks like a contract failure: the node answers
 * estimateGas with "missing revert data" and no revert reason, which is what a
 * node says when it could not run the call at all. Retrying that is honest.
 * Retrying a revert that carries an actual reason string is not — that is the
 * contract refusing, and re-running it would just hide a real result.
 */
/**
 * Bound a promise. A capability probe that waits forever is not a probe, it is
 * a hang: when anvil accepts a transaction it never mines, `tx.wait()` never
 * settles, and the surrounding try/catch never sees an error to handle.
 */
export function withDeadline(promise, ms = 30_000, label = 'operation') {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

export async function withRpcRetry(fn, { attempts = 3, delayMs = 2500, label = 'call', timeoutMs = 45000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    // A deadline per attempt, not just a retry count.
    //
    // The retry logic only ever runs on a THROWN error, and a stalled RPC call
    // does not throw — it simply never settles. So before this, any fork
    // operation could wait forever: anvil idle with an empty txpool, zero CPU
    // across every process, and a suite that looked like a slow machine. It was
    // not slow, it was stuck, and nothing in the helper could say so.
    //
    // With a deadline the stall becomes a thrown timeout, which the existing
    // transport-error check already recognises — so the retry path engages and
    // a genuinely wedged endpoint still fails with a message instead of
    // hanging until the file timeout.
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: timed out after ${timeoutMs}ms (attempt ${i}/${attempts})`)),
        timeoutMs);
    });
    try {
      const real = Promise.resolve().then(fn);
      // Promise.race does not cancel the loser. Once the deadline wins, the real
      // call keeps running, and if it later rejects that rejection is unhandled
      // — which the node test runner reports as a failure belonging to a test
      // that did not fail. Attach a sink to the loser so only the race decides
      // the outcome.
      real.catch(() => {});
      return await Promise.race([real, deadline]);
    } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      const hasReason = /\brevert(ed)?\b/i.test(msg) && /reason=/.test(msg);
      const transport = /missing revert data|could not coalesce|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network error|fetch failed|timed out after/i.test(msg);
      if (hasReason || !transport || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
      process.stderr.write(`[fork] ${label}: retrying after a transport error (${i}/${attempts - 1}) — ${msg.slice(0, 90)}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/**
 * Wait for a transaction with a deadline.
 *
 * `tx.wait()` has no timeout: if the node stops answering, the promise never
 * settles and the test file sits there until the runner's own timeout fires,
 * reporting a file-level timeout that names no test and no cause. Measured on
 * this box: 1 run in 3 hung this way, with anvil idle, an empty txpool and
 * every process at 0% CPU.
 *
 * A stalled wait therefore gets the same treatment as a stalled call: a bounded
 * promise that rejects, so the failure names the transaction and the wait.
 */
export async function waitForTx(tx, label = 'transaction', timeoutMs = 60000) {
  if (!tx || typeof tx.wait !== 'function') throw new Error(`${label}: not a transaction`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label}: no receipt after ${timeoutMs}ms (tx ${String(tx.hash ?? '?').slice(0, 14)})`)), timeoutMs);
  });
  try {
    const real = tx.wait();
    // Same reason as in withRpcRetry: the loser of a race is not cancelled, and
    // an unhandled rejection from it would be attributed to the wrong test.
    real.catch(() => {});
    return await Promise.race([real, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function deployContract(signer, abi, bytecode, args = []) {
  const { ethers } = await import('ethers');
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await withRpcRetry(() => factory.deploy(...args), { label: 'contract deploy' });
  await withRpcRetry(() => contract.waitForDeployment(), { label: 'deployment receipt' });
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

// ── token lookup ──
//
// This function exists because of a bug that made an entire test file unable to
// fail. fork-swap.test.js read KNOWN_TOKENS[network].USDC while the table's keys
// are lowercase, so `stable` was always undefined and both swap cases skipped
// with "no known stable token" — on every network. The suite was green and had
// never executed a single swap through any venue, Uniswap included.
//
// So the lookup lives here, next to the table, where a casing mistake is
// visible in one screen, and it throws for a network it does not know instead of
// quietly returning nothing. "I have no data for this network" and "I looked it
// up wrong" must not look the same to a caller.
export function knownWeth(networkName) {
  const row = KNOWN_TOKENS[networkName];
  if (!row) throw new Error(`knownWeth: jaringan tidak dikenal: ${networkName}`);
  return row.weth;
}

export function knownStable(networkName) {
  const row = KNOWN_TOKENS[networkName];
  if (!row) throw new Error(`knownStable: jaringan tidak dikenal: ${networkName}`);
  return row.usdc || row.usdt || null;
}

// Every mainnet in the table must be reachable by the function above. Without
// this, a key renamed in the table leaves the swap test skipping instead of
// failing — which is how the original bug survived a full green run.
export const MAINNETS_WITH_TOKENS = Object.keys(KNOWN_TOKENS).filter((n) => KNOWN_TOKENS[n].weth);

// ── skip guard for tests that need a live fork ──
export function forkSkipReason() {
  if (process.env.FORK_SKIP === '1') return 'FORK_SKIP=1';
  if (!process.env.CI && !process.env.FORK_RPC_URL && !process.env.FORK_PORT) {
    return 'no anvil locally — fork tests run in GitHub Actions (CI)';
  }
  return false;
}