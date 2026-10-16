// LeakProofVault runtime proof — the Ambire-style two-key custody path.
//
// The one thing a smart-contract wallet can guarantee beyond a plain "owner"
// contract is: NO SINGLE leaked key can drain it. This compiles the real
// ./test-contracts/LeakProofVault.sol (via js/solc.js, same gate as the M9
// proxy suite), deploys it on a throwaway anvil chain and walks the leak
// story end to end: the owner key is stolen, the thief queues a withdrawal,
// the guardian cancels it, the guardian recovers the vault to a fresh key,
// and the thief never receives a satoshi.
//
// Honest limit, stated rather than hidden: if BOTH keys leak, no on-chain
// scheme can help — the chain cannot tell the real holder from a thief
// holding the exact same two keys. Keep the guardian on a cold/hardware key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ethers } from 'ethers';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MNEMONIC = `${'test '.repeat(11)}junk`;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const solcJs = await import('../js/solc.js');
const solcCandidates = [
  process.env.BEAR_SOLC_FILE,
  path.join(root, 'soljson-0828.js'),
  path.join(root, 'vendor', 'soljson-0828.js'),
].filter(Boolean);

const hasAnvil = (() => {
  try { return spawnSync('anvil', ['--version'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
})();

const hasSolc = Boolean(solcCandidates.find((f) => existsSync(f)));
const skipReason = !hasAnvil
  ? 'foundry anvil is not installed — there is no chain to deploy on'
  : (!hasSolc && process.env.BEAR_SOLC !== '1'
    ? 'set BEAR_SOLC=1 (downloads ~9 MB compiler) or point BEAR_SOLC_FILE at a local soljson'
    : false);

/** Load the real wasm compiler into solc.js's single injection seam. */
async function injectRealSolc() {
  const local = solcCandidates.find((f) => existsSync(f));
  let code = local ? readFileSync(local, 'utf8') : null;
  if (!code) {
    const res = await fetch(solcJs.SOLC_URL, { signal: AbortSignal.timeout(60_000) });
    if (res.status !== 200) throw new Error(`compiler download HTTP ${res.status}`);
    code = await res.text();
  }
  const sandbox = { console, setTimeout, clearTimeout, process, Buffer, __dirname: '.', module: {}, exports: {} };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'soljson.js' });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (typeof sandbox.Module?.cwrap === 'function') { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > 120000) { clearInterval(iv); reject(new Error('solc runtime never became ready')); }
    }, 100);
  });
  const raw = sandbox.Module.cwrap('solidity_compile', 'string', ['string', 'number']);
  solcJs.injectCompiler({ compile: (json) => raw(json, 1) });
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/** Spawn anvil on a free port and wait until it answers eth_chainId. */
async function startAnvil(port) {
  const child = spawn('anvil', ['--port', String(port), '--mnemonic', MNEMONIC], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + String(d)).slice(-400); });
  // An anvil that dies mid-test turns every later ethers await into a wait
  // that never settles. Leave its death on the record, timestamped.
  child.on('exit', (code, signal) => console.log(`# [anvil] exited code=${code} signal=${signal}`));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with ${child.exitCode}${err.trim() ? `: ${err.trim()}` : ''}`);
    }
    try {
      // A probe with no bound can hang on undici's long default timeout
      // against a socket that accepts but never answers — this loop has to
      // keep its own clock: 2s per probe, then try again.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('anvil never answered'); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, url };
}

/** Fast-forward anvil's clock — the tests must not sleep for two days. */
async function warp(provider, seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// 300s, sized from measurement, not fear: this story passes in 64.2s on a
// Termux phone (2026-10-16, anvil + real wasm compile included) and 26.2s on
// a GitHub runner — 300s is ~4.7x the slowest honest run, the same headroom
// ratio the M9 proof carries. The old 900s turned one wedged await into
// fifteen minutes of silence (runs 38898501268, 38930491444); five is enough
// for a hang to name itself, and the [leakproof] phase lines below say WHICH
// await wedged.
test('LeakProofVault: a leaked key can never drain the vault', { skip: skipReason, timeout: 300_000 }, async (t) => {
  if (skipReason) return;
  let started;
  try {
    console.log('# [leakproof] boot: injecting real solc (local file or download)');
    await injectRealSolc();
    console.log('# [leakproof] solc injected — spawning anvil');
    const port = await freePort();
    started = await startAnvil(port);
  } catch (e) {
    return t.skip(`toolchain unavailable: ${e?.message || e}`);
  }
  const { child, url } = started;
  // Phase lines + a 30s alive-tick: on 2026-10-16 this file froze twice with
  // zero output under a silent cap (runs 38898501268 at 300s, 38930491444 at
  // 900s). A tick still printing = an await never settled; tick silence = the
  // call stack itself is wedged.
  let phase = 'starting';
  const t0 = Date.now();
  const mark = (m) => {
    phase = m;
    console.log(`# [leakproof] ${m} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  };
  const hb = setInterval(() => console.log(`# [leakproof] alive, waiting on: ${phase}`), 30_000);
  hb.unref();
  mark(`toolchain ready — anvil answering at ${url}`);
  const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  // anvil's key #0 is the deployer; key #1 is the guardian; the thief owns a
  // DIFFERENT private key — the leak scenario only works because the vault
  // treats the thief as the legitimate owner (the key was the same).
  const deployer = new ethers.Wallet(KEY, provider);
  const leaked = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider); // owner — its key is stolen below
  const guardian = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1").connect(provider);
  const stranger = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  const fresh = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  try {
    // Gas for everyone so every "rejection" below is an access-control
    // rejection, not an account that cannot pay for the transaction.
    for (const w of [leaked, guardian, stranger, fresh]) {
      await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther('10') })).wait();
    }
    mark('wallets funded');

    const src = readFileSync(path.join(root, 'test-contracts', 'LeakProofVault.sol'), 'utf8');
    const out = await solcJs.compileContract(src, 'LeakProofVault');
    mark('vault compiled');
    // The OWNER deploys the vault: the key that ends up in the attacker's hands
    // is the one the chain already accepts as owner.
    const factory = new ethers.ContractFactory(out.abi, out.bytecode, leaked);
    const vault = await factory.deploy(guardian.address);
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    assert.equal(await vault.owner(), leaked.address, 'the (soon-to-leak) key is the first owner');
    assert.equal(await vault.guardian(), guardian.address, 'guardian key is registered at deploy');
    await (await deployer.sendTransaction({ to: vaultAddr, value: ethers.parseEther('1.337') })).wait();
    assert.equal(await vault.balance(), ethers.parseEther('1.337'), 'the vault holds the funds');
    mark('vault deployed + funded');

    // ── The public has no access at all ──────────────────────────
    await assert.rejects(vault.connect(stranger).queueWithdrawal(1n, stranger.address), 'a stranger cannot queue');
    await assert.rejects(vault.connect(stranger).executeWithdrawal(), 'a stranger cannot execute');
    await assert.rejects(vault.connect(stranger).cancelWithdrawal(), 'a stranger cannot cancel');
    await assert.rejects(vault.connect(stranger).recoverOwner(stranger.address), 'a stranger cannot recover');
    await assert.rejects(vault.connect(stranger).finalizeRecovery(), 'with nothing pending, a stranger cannot finalize');
    mark('stranger gates all rejected');

    // ── The benign path: owner queues, waits, executes ───────────
    await (await vault.queueWithdrawal(ethers.parseEther('0.337'), leaked.address)).wait();
    await assert.rejects(vault.executeWithdrawal(), 'the withdraw cannot run before COOLDOWN');
    await warp(provider, 2 * 24 * 3600 + 1);
    await (await vault.executeWithdrawal()).wait();
    assert.equal(await vault.balance(), ethers.parseEther('1'), 'the queued amount left, the rest stayed');
    mark('benign withdraw done');

    // ── THE LEAK: that owner key is now in an attacker's hands ───
    // From the chain's point of view the attacker IS the owner. It queues a
    // full drain to itself. Same key, same power — the only thing between the
    // attacker and the funds is the structure of the vault.
    await (await vault.queueWithdrawal(ethers.parseEther('1'), leaked.address)).wait();
    await (await vault.connect(guardian).cancelWithdrawal()).wait();
    assert.equal(await vault.balance(), ethers.parseEther('1'), 'guardian cancelled the theft — nothing moved');
    mark('theft cancelled by guardian');

    // The attacker tries to take over instead: it cannot replace the guardian
    // (the watchdog), and it cannot cancel the guardian's recovery.
    await assert.rejects(vault.changeGuardian(leaked.address), 'a leaked owner key cannot replace the guardian');
    const before = await vault.owner();
    await (await vault.connect(guardian).recoverOwner(fresh.address)).wait();
    await assert.rejects(vault.cancelRecovery(), 'the leaked owner cannot cancel guardian recovery');
    await assert.rejects(vault.connect(leaked).recoverOwner(leaked.address), 'only the guardian can propose recovery');
    await assert.rejects(vault.finalizeRecovery(), 'recovery needs RECOVERY_DELAY to ripen');
    await warp(provider, 1 * 24 * 3600 + 1);
    await (await vault.finalizeRecovery()).wait();
    assert.equal(await vault.owner(), fresh.address, 'the vault escaped to a fresh key');
    assert.equal(await vault.balance(), ethers.parseEther('1'), 'the attacker drained nothing across the whole story');
    mark('recovery done — leaked key powerless');

    // Post-recovery, the stolen key is a nobody: not owner, not guardian.
    await assert.rejects(vault.queueWithdrawal(1n, leaked.address), 'the stolen key lost all power after recovery');
    await assert.rejects(vault.connect(leaked).finalizeRecovery(), 'nothing left to finalize');
    assert.notEqual(await vault.owner(), before, 'ownership actually changed');

    // ── Normal rotation while keys are healthy ───────────────────
    const nextOwner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
    await (await vault.connect(fresh).changeOwner(nextOwner.address)).wait();
    assert.equal(await vault.owner(), nextOwner.address, 'owner can rotate while its key is alive');
    await assert.rejects(vault.connect(fresh).changeGuardian(nextOwner.address), 'only the guardian hands off the guardian key');
    const nextGuardian = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
    await (await vault.connect(guardian).changeGuardian(nextGuardian.address)).wait();
    assert.equal(await vault.guardian(), nextGuardian.address, 'guardian key hands off to the next cold key');
    mark('done — rotation complete');
  } finally {
    clearInterval(hb);
    provider.destroy();
    child.kill('SIGKILL');
  }
});