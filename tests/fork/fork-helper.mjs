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
  // drpc.org, bukan publicnode — probe tests/fork/probe-ethereum-rpc.mjs:
  // publicnode eth menolak state historis (HTTP 403, bukan arsip) sementara
  // anvil mem-pinning block dan menggiling beberapa menit; jawaban historis
  // yang bervariasi antar-panggilan = kelas foundry#4700 (fetch diam-diam
  // gagal → slot kosong saat eksekusi → swap revert status=0 logs=[] walau
  // minOut 1% longgar) — pola hijau/merah antar-wave dengan kode identik.
  // drpc: serve N-50000 + 3/3 stabil (1rpc: 1/3; lainnya mati).
  ethereum:          { chainId: 1,      rpc: 'https://eth.drpc.org',                        type: 'mainnet' },
  bsc:               { chainId: 56,     rpc: 'https://bsc-dataseed.binance.org',             type: 'mainnet' },
  // optimism: endpoint resmi dulu, drpc cadangan. Keduanya pernah biru maupun
  // merah di CI dan dengan mode gagal yang BERBEDA, jadi pilihan di bawah ini
  // berbasis pengukuran ulang 2026-10-06, bukan ingatan:
  //   - burst 25 eth_blockNumber serentak (1 IP): mainnet.optimism.io 25/25 ok
  //     (1.4s) vs optimism.drpc.org 21/25 + HTTP 429 — dan tiga run CI
  //     beruntun (37434161631 + 2x rerun) optimism kalah di drpc dengan
  //     "Public endpoint rate limit" / balance check 8s timeout.
  //   - drpc sempat menang atas resmi pada run 37338189440 (fork-send optimism
  //     kehilangan tx sendiri saat ~14 fork start paralel) — itulah alasan
  //     `alts` ada: kandidat pertama yang menjawab query pin menjadi upstream
  //     fork ini, jadi kedua riwayat buruk punya jalan keluar tanpa edit kode.
  //   - probe retensi (probe-optimism-rpc.mjs) kini lolos dua-duanya (6h+1d+3/3),
  //     publicnode tetap tersingkir (eth_getCode historis HTTP 403).
  optimism:          { chainId: 10,     rpc: 'https://mainnet.optimism.io',                  alts: ['https://optimism.drpc.org'], type: 'mainnet' },
  // drpc.org, bukan publicnode: anvil mem-pinning block lalu suite menggiling
  // beberapa menit, dan publicnode polygon BUKAN arsip — retention singkat +
  // backend broker 5xx/529 → `historical state ... is not available` muncul
  // SETELAH pin menua (fork-poly4 lolos 20s → fork-poly5 mati pada run yang
  // sama-sama benar). Probe 8 kandidat (tests/fork/probe-polygon-rpc.mjs):
  // hanya drpc.org serve state N-50000 dan 3/3 eth_call stabil.
  polygon:           { chainId: 137,    rpc: 'https://polygon.drpc.org',                     type: 'mainnet' },
  arbitrum:          { chainId: 42161,  rpc: 'https://arb1.arbitrum.io/rpc',                 type: 'mainnet' },
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
  // FORK_RPC_URL pins a single endpoint deliberately (no fallback), otherwise
  // the table's `rpc` leads and `alts` follow: the pin query picks the first
  // candidate that ANSWERS, and that candidate serves the whole run.
  if (process.env.FORK_RPC_URL) return { name, ...def, rpc: process.env.FORK_RPC_URL, alts: [] };
  return { name, ...def, alts: def.alts || [] };
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
    //
    // Pin the fork to a block. A live-following fork has two failure modes this
    // suite actually hit: (a) upstream trades move the pair reserves between
    // v2Quote and the swap a second later, and the 1% minOut reverts on the
    // busiest pair on the chain (status=0, no logs); (b) each new upstream block
    // makes anvil re-sync state, the same window in which foundry#4700-class
    // behaviour wipes a local credit while the gas debit survives — leg3 status=1
    // with the output ETH credited to nowhere. A pinned block cannot drift and
    // never re-syncs: upstream is touched once, at boot. If the block query
    // fails (rate limit), the flag is skipped and the old behaviour stands.
    let forkBlock = process.env.FORK_BLOCK || '';
    // Diagnostic escape hatch: FORK_UNPINNED=1 forces the live-following mode
    // (the state CI actually failed in) so the two modes can be compared on
    // the same machine. Deliberate, loud, and never the default.
    if (process.env.FORK_UNPINNED === '1') {
      forkBlock = '';
      process.stderr.write('[fork] FORK_UNPINNED=1 — live-following fork (diagnostic mode)\n');
    } else if (!forkBlock) {
      // The pin query is the load-bearing line above, and a single rate-limited
      // HTTP 429/529 (publicnode, drpc) used to silently drop it — leaving a
      // live-following fork, the exact mode CI failed in. Retry like every
      // other RPC call in this helper; only after 3 attempts per CANDIDATE
      // give up, loudly. Candidates: the table's `rpc` first, then `alts` —
      // the first endpoint that answers becomes this run's upstream, so one
      // throttled provider costs a switch instead of the whole leg.
      const candidates = [network.rpc, ...(network.alts || [])];
      for (const cand of candidates) {
        if (forkBlock) break;
        for (let a = 1; a <= 3 && !forkBlock; a++) {
          try {
            const rq = await fetch(cand, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
              signal: AbortSignal.timeout(15000),
            });
            const rj = await rq.json();
            if (rj?.result) forkBlock = String(parseInt(rj.result, 16));
            else if (a === 3) process.stderr.write(`[fork] eth_blockNumber empty after ${a} tries on ${cand}: ${JSON.stringify(rj).slice(0, 160)}\n`);
          } catch (e) {
            process.stderr.write(`[fork] eth_blockNumber attempt ${a}/3 failed on ${cand}: ${String(e.message).slice(0, 120)}\n`);
            if (a < 3) await new Promise((r) => setTimeout(r, 1000 * a));
          }
        }
        if (forkBlock && cand !== network.rpc) {
          process.stderr.write(`[fork] upstream switch: ${network.rpc} did not answer the pin query — using ${cand}\n`);
          network.rpc = cand; // the whole run forks from the endpoint that worked
        }
      }
    }
    // The pin is the difference between a frozen fork and one that re-syncs
    // upstream mid-run — and skipping it is SILENT, which is how CI run
    // 36889949127 shipped failures while carrying this very code. Make the
    // decision observable in every run's log: either this fork is pinned to a
    // block, or the query failed and it is not.
    process.stderr.write(`[fork] ${network.name}: ` +
      (forkBlock ? `pinning to block ${forkBlock}` :
        'NO --fork-block-number pin (eth_blockNumber query failed/empty) — live-following fork') + '\n');
    let started = false;
    // Boot over the candidate chain as well: the pin query can be answered by
    // an endpoint that then stalls under anvil's state-fetch burst (the
    // official node did exactly that — CI 36921954638's optimism receipt
    // timeouts), and an endpoint that boots can still be the one anvil's
    // transport hammers later. Two attempts per candidate, in order, so a
    // stall costs a switch instead of the whole leg.
    const bootCandidates = [network.rpc, ...(network.alts || [])];
    let chosenRpc = network.rpc;
    for (const cand of bootCandidates) {
      if (started) break;
      chosenRpc = cand;
      for (let attempt = 1; attempt <= 2 && !started; attempt++) {
      const args = [
        '--fork-url', cand,
        '--port', String(port),
        '--silent',
        '--chain-id', String(network.chainId),
        '--hardfork', 'prague',
        // Upstream resilience. CI run 36889949127's optimism leg died inside
        // anvil's own transport ("Max retries exceeded HTTP error 429 … IP has
        // exceeded its requests per second capacity") and reappeared one run
        // later as `missing revert data` on an eth_call. Make anvil itself
        // back off and re-fetch instead of surfacing a dead fork: 8 tries
        // (default 5) with a 2s initial backoff (default 1s); the per-request
        // timeout stays anvil's own 45s default — it was measured generous
        // enough for the slow legs and cutting it would trade one flake for
        // another.
        '--retries', '8',
        '--fork-retry-backoff', '2000',
        // Harmless for the node tests, and it lets the same anvil serve a
        // browser: without it anvil does not answer the CORS preflight, so a
        // page cannot POST JSON-RPC to it even though curl and node can.
        '--allow-origin', '*'
      ];
      if (forkBlock) args.push('--fork-block-number', forkBlock);
      anvilProcess = spawn('anvil', args, { stdio: 'ignore' });
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
        process.stderr.write(`[fork] anvil boot failed on ${cand} (attempt ${attempt}/2)\n`);
      }
      }
    }
    if (!started) throw new Error(`anvil did not start in time (candidates: ${bootCandidates.join(', ')})`);
    if (chosenRpc !== network.rpc) {
      process.stderr.write(`[fork] upstream switch at boot: ${network.rpc} would not boot — serving the fork from ${chosenRpc}\n`);
      network.rpc = chosenRpc;
    }
  }

  const { ethers } = await import('ethers');
  // cacheTimeout: -1 turns ethers' 250ms response cache off. The default
  // cache returns the pre-funding balance right after anvil_setBalance
  // (journey "funded and can send value" failed on all 12 legs exactly that
  // way, 2026-10-01): test reads must see their own writes.
  provider = retryingProvider(new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 }));
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
    // No local compiler: this is a real network download (jsdelivr, ~8MB),
    // and it is what a fork test does first in every process. A dropped
    // connection mid-body shows up as undici's `TypeError: terminated`
    // (NGHTTP2_STREAM_ERROR) — measured on this box, failing an otherwise
    // green deploy leg. Transport noise, so retry it like every other RPC
    // call in this helper; a non-200 is also transport (CDN hiccup), and the
    // message is worded so withRpcRetry's classifier recognises it.
    const res = await withRpcRetry(async () => {
      const r = await fetch(solcJs.SOLC_URL, { signal: AbortSignal.timeout(60_000) });
      if (r.status !== 200) throw new Error(`compiler download failed: HTTP error ${r.status} from ${solcJs.SOLC_URL}`);
      return r;
    }, { label: 'solc download', attempts: 3, delayMs: 2000, timeoutMs: 70_000 });
    code = await res.text();
    if (!code || code.length < 1000) throw new Error(`compiler download incomplete: ${code ? code.length : 0} bytes`);
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
  const raced = Promise.race([promise, guard]);
  // Promise.race does not cancel the loser. If the guard wins, `promise` keeps
  // running and a later rejection of it is UNHANDLED — and node's runner then
  // attributes it to whatever test is running at that moment. CI run
  // 36889949127's optimism leg failed exactly that way: a receipt poll from a
  // bounded wait rejecting minutes of work later with an upstream 429
  // ("A resource generated asynchronous activity after the test ended",
  // fork-eip7702.test.js). Sink the loser: only the race decides.
  promise.catch(() => {});
  return raced.finally(() => clearTimeout(timer));
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
      // A `reason` only counts when it carries a VALUE. ethers renders the
      // failure CI run 36889949127's optimism leg hit as `missing revert data
      // … reason=null` — an answer that never arrived (anvil's upstream was
      // throttled), not a contract that refused. The old `reason=` substring
      // test read that as a real revert and skipped the retry on exactly the
      // message the retry exists for.
      const reasonValue = (msg.match(/reason=([^,)\s]+)/i) || [])[1];
      const hasReason = /\brevert(ed)?\b/i.test(msg)
        && !!reasonValue
        && !/^null$/i.test(reasonValue)
        && !/missing revert data/i.test(msg);
      const transport = /missing revert data|could not coalesce|Fork Error|HTTP error 4[0-9]{2}|exceeded its requests per second|\bterminated\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network error|fetch failed|timed out after/i.test(msg);
      if (hasReason || !transport || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
      process.stderr.write(`[fork] ${label}: retrying after a transport error (${i}/${attempts - 1}) — ${msg.slice(0, 90)}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

// ── provider-level retry ──
//
// The app resolves its provider from state (state.get('provider')) and calls it
// DIRECTLY — decimals(), balanceOf(), v2Quote — so a test-level withRpcRetry
// wrapped around OUR reads never sees those calls. When anvil's upstream
// throttles (HTTP 529 "upstream overloaded" on polygon — observed in
// fork-poly4: decimals() on 0x2791…174 died with `missing revert data …
// reason=null`), the app's own call failed and the swap test went red even
// though every helper call had been retried.
//
// Wrapping the READ surface of the provider itself covers every consumer at
// once: app code, ethers.Contract, helpers. Writes stay unwrapped — retrying a
// broadcast is how two runs spend each other's nonce.
const RETRYING_READS = new Set([
  'call', 'getStorage', 'getCode', 'getBalance', 'getBlock', 'getBlockNumber',
  'getTransaction', 'getTransactionReceipt', 'getFeeData', 'estimateGas',
  'resolveName', 'lookupAddress',
]);

export function retryingProvider(p) {
  return new Proxy(p, {
    get(target, prop) {
      const v = target[prop];   // no receiver: getters run against the real target
      if (typeof v !== 'function') return v;
      if (RETRYING_READS.has(prop)) {
        return (...args) => withRpcRetry(() => v.apply(target, args), {
          label: `provider.${String(prop)}`, delayMs: 1500, timeoutMs: 30000,
        });
      }
      return v.bind(target);
    },
  });
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
 *
 * 150s, not the original 60: the wait runs under withRpcRetry (3 attempts ×
 * 45s + backoff ≈ 140s), so a 60s deadline cut the ladder after attempt 1 and
 * every retry log you have ever seen post-dated its own test failure — CI
 * 37490251865 optimism-sepolia died at "no receipt after 60000ms" with the tx
 * already mined and receipt reads blocked by upstream transport errors, the
 * exact shape CI 37005258456 recorded for a forwarded 429. Healthy receipts
 * still land in <5s; this only decides how long a STALL argues with the
 * upstream before it is allowed to fail.
 */
export async function waitForTx(tx, label = 'transaction', timeoutMs = 150000) {
  if (!tx || typeof tx.wait !== 'function') throw new Error(`${label}: not a transaction`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label}: no receipt after ${timeoutMs}ms (tx ${String(tx.hash ?? '?').slice(0, 14)})`)), timeoutMs);
  });
  try {
    // tx.wait() runs its receipt poll on the RAW provider (waitForTransaction is
    // not in RETRYING_READS, and the proxy applies methods with `this` = target),
    // so a single throttled eth_getTransactionReceipt rejected the whole wait and
    // escaped — CI 37005258456: optimism-sepolia's journey send died on anvil's
    // forwarded 429 "IP exceeded requests per second" while the tx sat mined on
    // the fork. Same treatment as every other read in this suite (and as
    // fork-eip7702.test.js already does): retry the wait, never the broadcast.
    const real = withRpcRetry(() => tx.wait(), { label: `${label} wait` });
    // Same reason as in withRpcRetry: the loser of a race is not cancelled, and
    // an unhandled rejection from it would be attributed to the wrong test.
    real.catch(() => {});
    return await Promise.race([real, deadline]);
  } catch (e) {
    // status=0 is the one failure where WHY is invisible by default: ethers
    // reports it from the receipt path with no reason string and no gas
    // figures, and CI 36983252053's swap leg3 then spent three rounds
    // guessing INSUFFICIENT_OUTPUT vs TRANSFER_FROM_FAILED vs out-of-gas from
    // nothing but "gasUsed 171349". Three readings fix that: the gasLimit the
    // tx shipped with, an eth_call replay of the same tx at 5M gas (generous
    // on purpose — a replay at the tx's own limit cannot tell out-of-gas from
    // an empty require, both come back "missing revert data", which is how CI
    // arrived at "replay reverted, undecoded" with gasLimit == gasUsed and no
    // verdict), and a fresh estimateGas whose number either converges with the
    // shipped limit or exposes the divergence. If the replay succeeds, the tx
    // simply needed more gas than its estimate granted; a string names the
    // real revert. Enrichment never masks the original error.
    try {
      const rc = e?.receipt;
      if (rc && rc.status === 0) {
        const prov = tx.provider;
        const full = prov ? await prov.getTransaction(tx.hash).catch(() => null) : null;
        const limit = full?.gasLimit ?? tx.gasLimit ?? '?';
        let why = 'replay skipped (no provider)';
        if (prov && limit !== '?') {
          why = 'replay skipped (no from/to/data)';
          if (tx.to && (tx.data || full?.data)) {
            // Replay at a GENEROUS gas limit, not at the tx's own: a replay
            // at `limit` returns "missing revert data" for BOTH an out-of-gas
            // and an empty require, so it can never tell them apart — that is
            // exactly how CI's swap leg3 arrived ("replay reverted, undecoded")
            // with gasLimit == gasUsed, leaving OOG-vs-state unproven. One
            // extra reading settles it: success at 5M = the tx simply needed
            // more gas than its estimate granted (estimate ran against state
            // the execution did not see); a string = the real revert; bare
            // again = a state-side empty require (WETH9-class).
            const req = {
              to: tx.to, data: tx.data ?? full?.data, value: tx.value ?? full?.value ?? 0n,
              from: tx.from ?? full?.from, gasLimit: 5000000n,
            };
            try {
              await prov.call({ ...req, blockTag: rc.blockNumber });
              why = limit === rc.gasUsed
                ? 'replay SUCCEEDED at 5M gas — OUT OF GAS at its own limit (estimate under-granted)'
                : 'replay SUCCEEDED at 5M gas — revert depended on state that moved';
            } catch (re) {
              const r = re?.reason ?? re?.revert?.args?.[0] ?? null;
              why = r ? `revert reason: ${String(r)}`
                : `replay reverted at 5M gas, undecoded: ${String(re?.shortMessage || re?.message || re).slice(0, 160)} (state-side empty require)`;
            }
            // What does an estimate say NOW? ethers v6 estimateGas has no
            // block tag — it reads the node head — but while this catch runs
            // the head IS the receipt's block (one tx per auto-mined block,
            // nothing else sends on this anvil), so the number is comparable
            // to the limit the tx shipped with. Returns a value = the
            // divergence is visible; throws = this state can never execute
            // it, which is its own answer.
            const est = await prov.estimateGas(req)
              .then((v) => String(v))
              .catch((er) => `error: ${String(er?.shortMessage || er?.message || er).slice(0, 90)}`);
            why += ` | estimateNow=${est}`;
          }
        }
        const tag = String(label).slice(0, 60);
        e.message = `${tag}: status=0 [gasLimit=${limit} gasUsed=${rc.gasUsed} — ${why}] — ${e.message}`;
      }
    } catch { /* enrichment is best-effort; the original throw stands */ }
    throw e;
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