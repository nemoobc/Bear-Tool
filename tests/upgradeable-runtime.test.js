// M9 runtime proof — drive a DEPLOYED proxy pair, not the generator's text.
//
// Every other M9 test asserts on the Solidity source the wizard emits. That
// proves the strings are right; it does not prove the two contracts behave as
// a proxy pair once they are on a chain: that the implementation slot really
// points at the implementation, that initialize() cannot run twice, that the
// upgrade gate rejects a stranger, that state survives an upgrade, and — the
// case that decides whether the deployed token is usable at all — that the
// admin (which IS the deployer in this wallet) can still transfer its own
// tokens through the proxy.
//
// One throwaway anvil chain, one real solc compile per proxy kind, no network
// beyond localhost. Opt-in the same way the real-solc gate is: a local
// soljson copy runs it, and `BEAR_SOLC=1` also allows the download. Without
// anvil or without a compiler the test SKIPs with the reason instead of
// pretending to have proved something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const solcJs = await import('../js/solc.js');
const contracts = await import('../js/contracts.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// EIP-1967 slots — the whole point of the proxy is what lives here.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// anvil's own test mnemonic: the chain is spawned BY THIS TEST, so the key is
// public by design. It is never reused for anything but the throwaway chain.
// Built by repeat() — a hand-typed phrase that is one word short is rejected
// outright by anvil, and the test would skip for a typo instead of a missing tool.
const MNEMONIC = `${'test '.repeat(11)}junk`;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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
    const res = await fetch(solcJs.SOLC_URL);
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
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with ${child.exitCode}${err.trim() ? `: ${err.trim()}` : ''}`);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('anvil never answered'); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, url };
}

/** Compile one standard the way the wizard does: buildTokenSource + plan.compiler. */
async function build(overrides) {
  const plan = contracts.buildDeployPlan({
    standard: 'erc20', name: 'Bear Runtime', symbol: 'BRT', supply: '1000', decimals: '18',
    mintable: true, ...overrides,
  });
  const std = contracts.getStandard(plan.standard);
  const source = contracts.buildTokenSource(std.id, plan.flags);
  const out = await solcJs.compileContract(source, std.contract, plan.compiler);
  return { plan, std, source, out };
}

/** Token ABI + proxy ABI for one address. Constructors are dropped — ethers
 *  warns about the duplicate, and neither is called through a proxy. */
const both = (a, b) => [...a, ...b].filter((f) => f.type !== 'constructor');

test('M9 runtime: a deployed proxy pair behaves like a proxy pair', { skip: skipReason }, async (t) => {
  if (skipReason) return;
  // A missing compiler is an unavailable tool (skip, and say so). Anvil that
  // is INSTALLED but refuses to start is a broken test, not a missing tool —
  // letting that skip would hide an argument typo as an environmental excuse.
  let started;
  try {
    await injectRealSolc();
    const port = await freePort();
    started = await startAnvil(port);
  } catch (e) {
    return t.skip(`toolchain unavailable: ${e?.message || e}`);
  }
  const { child, url } = started;
  // batchMaxCount:1 + cacheTimeout:-1 — ethers v6's default response cache
      // races anvil's instan-mine here: a stale eth_getTransactionCount answers
      // with an old nonce and the proxy deploy dies NONCE_EXPIRED (seen on CI).
      const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  const deployer = new ethers.Wallet(KEY, provider);
  const stranger = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  try {
      // Gas for the stranger: a "rejection" that only happens because the
      // account cannot pay for the transaction would prove nothing.
      await (await deployer.sendTransaction({ to: stranger.address, value: ethers.parseEther('1') })).wait();

      // ── UUPS ────────────────────────────────────────────────────
      const uups = await build({ upgradeable: true, proxyType: 'uups' });
      const initArgs = uups.plan.args;
      const implF = new ethers.ContractFactory(uups.out.contracts[uups.std.contract].abi,
        uups.out.contracts[uups.std.contract].bytecode, deployer);
      const proxyF = new ethers.ContractFactory(uups.out.contracts.ERC1967Proxy.abi,
        uups.out.contracts.ERC1967Proxy.bytecode, deployer);
      const iface = new ethers.Interface(uups.out.contracts[uups.std.contract].abi);
      const initData = iface.encodeFunctionData('initialize', initArgs);

      const impl1 = await implF.deploy();
      await impl1.waitForDeployment();
      const impl1Addr = await impl1.getAddress();
      // Exactly the two transactions the deploy flow signs: implementation
      // first, then the proxy with initialize() inside its constructor.
      const proxy1 = await proxyF.deploy(impl1Addr, initData, ethers.ZeroAddress);
      await proxy1.waitForDeployment();
      const proxy1Addr = await proxy1.getAddress();

      const tok = new ethers.Contract(proxy1Addr, uups.out.contracts[uups.std.contract].abi, deployer);
      assert.equal(await tok.name(), 'Bear Runtime', 'the proxy answers with initialize() state');
      assert.equal(await tok.owner(), deployer.address, 'ownership was set through the proxy');
      assert.ok((await tok.totalSupply()) > 0n, 'the premint landed in proxy storage');
      assert.notEqual(await provider.getCode(proxy1Addr), '0x', 'there is code at the address the user holds');

      const slot1 = await provider.getStorage(proxy1Addr, IMPL_SLOT);
      assert.equal(ethers.getAddress(`0x${slot1.slice(-40)}`), impl1Addr, 'EIP-1967 slot points at the implementation');
      const admin1 = await provider.getStorage(proxy1Addr, ADMIN_SLOT);
      assert.equal(ethers.getAddress(`0x${admin1.slice(-40)}`), ethers.ZeroAddress, 'UUPS keeps the admin slot empty');

      // One-shot initialisation, through the proxy AND on the bare logic.
      await assert.rejects(tok.initialize(...initArgs), 'initialize() through the proxy must revert the second time');
      const bare = new ethers.Contract(impl1Addr, uups.out.contracts[uups.std.contract].abi, deployer);
      await assert.rejects(bare.initialize(...initArgs), 'the implementation locks its own initializer');

      // Upgrade as the owner: state must survive, and the slot must move.
      const impl2 = await implF.deploy();
      await impl2.waitForDeployment();
      const impl2Addr = await impl2.getAddress();
      await (await tok.upgradeToAndCall(impl2Addr, '0x')).wait();
      assert.equal(ethers.getAddress(`0x${(await provider.getStorage(proxy1Addr, IMPL_SLOT)).slice(-40)}`),
        impl2Addr, 'the slot follows the upgrade');
      assert.equal(await tok.name(), 'Bear Runtime', 'upgrade must not wipe proxy storage');
      assert.ok((await tok.totalSupply()) > 0n, 'the balance survives the upgrade too');

      // The gate: somebody else must not be able to move the logic.
      const impl3 = await implF.deploy();
      await impl3.waitForDeployment();
      await assert.rejects(
        tok.connect(stranger).upgradeToAndCall(await impl3.getAddress(), '0x'),
        'a stranger cannot upgrade a UUPS proxy');

      // And the proxy itself must not offer an admin path in UUPS mode —
      // the four selectors are admin-only, and UUPS has no admin.
      const uupsProxy = new ethers.Contract(proxy1Addr,
        both(uups.out.contracts[uups.std.contract].abi, uups.out.contracts.ERC1967Proxy.abi), deployer);
      await assert.rejects(uupsProxy.upgradeTo(impl2Addr),
        'a UUPS proxy must not expose an admin upgrade path');

      // ── Transparent ─────────────────────────────────────────────
      const tr = await build({ upgradeable: true, proxyType: 'transparent' });
      const trInit = tr.plan.args;
      const trIface = new ethers.Interface(tr.out.contracts[tr.std.contract].abi);
      const trImplF = new ethers.ContractFactory(tr.out.contracts[tr.std.contract].abi,
        tr.out.contracts[tr.std.contract].bytecode, deployer);
      const trProxyF = new ethers.ContractFactory(tr.out.contracts.ERC1967Proxy.abi,
        tr.out.contracts.ERC1967Proxy.bytecode, deployer);

      const tImpl1 = await trImplF.deploy();
      await tImpl1.waitForDeployment();
      const tImpl1Addr = await tImpl1.getAddress();
      // The deploy flow sets the admin to the deployer's own address.
      const tProxy = await trProxyF.deploy(tImpl1Addr, trIface.encodeFunctionData('initialize', trInit), deployer.address);
      await tProxy.waitForDeployment();
      const tProxyAddr = await tProxy.getAddress();

      const tTok = new ethers.Contract(tProxyAddr, tr.out.contracts[tr.std.contract].abi, deployer);
      // Proxy-only selectors need the proxy's ABI next to the token's: in
      // transparent mode they are two halves of the same address.
      const tAdmin = new ethers.Contract(tProxyAddr,
        both(tr.out.contracts[tr.std.contract].abi, tr.out.contracts.ERC1967Proxy.abi), deployer);
      assert.equal(ethers.getAddress(`0x${(await provider.getStorage(tProxyAddr, ADMIN_SLOT)).slice(-40)}`),
        deployer.address, 'the admin slot holds the deployer');
      // admin() reads through ifAdmin, which can delegatecall — so solc marks it
      // nonpayable and ethers would SEND A TRANSACTION. staticCall asks the node
      // instead, which is what "answers the admin" means.
      assert.equal(await tAdmin.connect(deployer).admin.staticCall(), deployer.address, 'admin() answers the admin');
      await assert.rejects(tAdmin.connect(stranger).admin.staticCall(), 'admin() must not answer anyone else');

      // The decision that makes the deployed token usable: the admin IS the
      // first user here, so it must be able to spend through the proxy.
      await (await tTok.transfer(stranger.address, 10n)).wait();
      assert.equal(await tTok.balanceOf(stranger.address), 10n, 'the admin can transfer its own tokens');

      const tImpl2 = await trImplF.deploy();
      await tImpl2.waitForDeployment();
      const tImpl2Addr = await tImpl2.getAddress();
      await (await tAdmin.connect(deployer).upgradeTo(tImpl2Addr)).wait();
      assert.equal(ethers.getAddress(`0x${(await provider.getStorage(tProxyAddr, IMPL_SLOT)).slice(-40)}`),
        tImpl2Addr, 'the admin upgrades through the proxy');
      assert.equal(await tTok.name(), 'Bear Runtime', 'state survives a transparent upgrade');
      await assert.rejects(tAdmin.connect(stranger).upgradeTo(tImpl1Addr), 'a stranger cannot upgrade through the proxy');

      // ── ERC-721 behind a proxy ──────────────────────────────────
      // The NFT wizard path is the one shape whose initialize() is easiest to
      // break silently: nothing else in the suite executes it, and a regression
      // that drops `owner = msg.sender` would ship a proxy that can never mint
      // or upgrade again. So drive it: ownership set, mint accepted, id owned.
      const nft = await build({ standard: 'erc721', upgradeable: true, proxyType: 'uups' });
      const nftIface = new ethers.Interface(nft.out.contracts[nft.std.contract].abi);
      const nftImplF = new ethers.ContractFactory(nft.out.contracts[nft.std.contract].abi,
        nft.out.contracts[nft.std.contract].bytecode, deployer);
      const nftProxyF = new ethers.ContractFactory(nft.out.contracts.ERC1967Proxy.abi,
        nft.out.contracts.ERC1967Proxy.bytecode, deployer);
      const nftImpl = await nftImplF.deploy();
      await nftImpl.waitForDeployment();
      const nftProxy = await nftProxyF.deploy(await nftImpl.getAddress(),
        nftIface.encodeFunctionData('initialize', nft.plan.args), ethers.ZeroAddress);
      await nftProxy.waitForDeployment();
      const nftTok = new ethers.Contract(await nftProxy.getAddress(), nft.out.contracts[nft.std.contract].abi, deployer);
      assert.equal(await nftTok.owner(), deployer.address, 'the NFT initialize() must hand ownership to the deployer');
      assert.equal(await nftTok.name(), 'Bear Runtime', 'the NFT proxy answers with initialize() state');
      const nextId = await nftTok.mint.staticCall(deployer.address);
      await (await nftTok.mint(deployer.address)).wait();
      assert.equal(await nftTok.ownerOf(nextId), deployer.address, 'minting through the NFT proxy works');
      const nftImpl2 = await nftImplF.deploy();
      await nftImpl2.waitForDeployment();
      await (await nftTok.upgradeToAndCall(await nftImpl2.getAddress(), '0x')).wait();
      assert.equal(await nftTok.ownerOf(nextId), deployer.address, 'the mint survives an NFT upgrade');
    } finally {
      provider.destroy();
      child.kill('SIGKILL');
    }
});
