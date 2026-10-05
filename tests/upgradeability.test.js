// M9 — upgradeability (ERC-1967 proxy + initialize).
//
// This is the milestone where a typo in a generated contract is not a cosmetic
// bug: an upgradeable token whose gate is empty, whose constructor survived, or
// whose proxy never got deployed is either un-upgradeable or, worse, quietly
// upgradeable by a stranger. The real-solc run proves it compiles; this file
// proves the SHAPE the compile cannot argue with — which authority gates the
// upgrade, that the logic contract cannot be pre-initialized, that the proxy is
// really in the source, and that the deploy sends the two transactions in the
// order that leaves no uninitialized window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { appSource } from './helpers/app-source.mjs';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.ethers = ethers;

const contracts = await import('../js/contracts.js');
const deploySrc = readFileSync(new URL('../js/deploy.js', import.meta.url), 'utf8');
const solcSrc = readFileSync(new URL('../js/solc.js', import.meta.url), 'utf8');

const STDS = ['erc20', 'erc721', 'erc1155'];
const TOKEN_NAME = { erc20: 'BearERC20', erc721: 'BearERC721', erc1155: 'BearERC1155' };
const P = contracts.PROXY_CONTRACT; // 'ERC1967Proxy'

const plan = (over = {}) => contracts.buildDeployPlan({
  standard: 'erc20', name: 'Bear', symbol: 'bear', supply: '1000', decimals: 18, ...over,
});
const src = (std, flags) => contracts.buildTokenSource(std, flags);
// Everything up to the appended proxy — the part that must behave like a token.
const tokenPart = (s) => s.slice(0, s.indexOf(`contract ${P}`));
const ctors = (s) => (s.match(/constructor\([^)]*\)/g) || []);

// ── the plan ────────────────────────────────────────────────────
test('M9: the plan carries the proxy and says so to the signer', () => {
  const on = plan({ upgradeable: true, proxyType: 'transparent' });
  assert.equal(on.flags.upgradeable, true);
  assert.equal(on.flags.proxyType, 'transparent');
  assert.ok(on.summary.some((r) => r.k === 'Proxy' && r.v === 'ERC-1967 (Transparent)'),
    `the confirmation dialog must name the proxy, got ${JSON.stringify(on.summary)}`);

  assert.equal(plan({ upgradeable: true }).flags.proxyType, 'uups',
    'absent proxy type = the wizard default, never "no proxy"');
  assert.equal(plan({ upgradeable: true, proxyType: 'delegateme' }).flags.proxyType, 'uups',
    'an unknown proxy type must not deploy a contract nobody can reason about');

  const off = plan({});
  assert.equal(off.flags.upgradeable, false);
  assert.ok(!off.summary.some((r) => r.k === 'Proxy'),
    'the flag-off plan must not advertise a proxy it will not deploy');

  // initialize() takes EXACTLY what the constructor took — same values, same
  // order, same scaling. Anything else and the proxy inits with wrong data.
  assert.deepEqual(on.args, off.args, 'upgradeable must not change a single argument');

  for (const std of ['erc721', 'erc1155']) {
    const p = contracts.buildDeployPlan({
      standard: std, name: 'Bear', symbol: 'bear', baseUri: 'ipfs://x/', upgradeable: true,
    });
    assert.ok(p.summary.some((r) => r.k === 'Proxy'), `${std} must advertise its proxy too`);
    assert.equal(p.flags.upgradeable, true, `${std} flags must carry the choice`);
  }
});

// ── the source transform ────────────────────────────────────────
test('M9: constructor becomes initialize(), in every standard and both proxy types', () => {
  for (const std of STDS) {
    for (const proxyType of ['uups', 'transparent']) {
      const s = src(std, { mintable: true, upgradeable: true, proxyType });
      const t = tokenPart(s);
      const tag = `${std}/${proxyType}`;
      assert.ok(t.includes('function initialize('), `${tag}: the constructor never became initialize()`);
      assert.deepEqual(ctors(t), ['constructor()'],
        `${tag}: exactly one constructor, the no-arg lock — a parameterised one would run on the logic contract`);
      assert.ok(t.includes('modifier initializer()'), `${tag}: the initializer guard is missing`);
      assert.ok(t.includes('_initialized'), `${tag}: the initialised flag is missing`);
      assert.ok(!/public immutable/.test(t),
        `${tag}: immutable survives — initialize() cannot assign one through delegatecall`);
      assert.ok(t.includes('event Initialized(uint64 version);') && t.includes('emit Initialized(1);'),
        `${tag}: the initialisation must leave a record an indexer can see`);
      assert.equal(s.split(`contract ${P}`).length - 1, 1, `${tag}: proxy must appear exactly once`);
      assert.ok(s.includes('function initialize(') && !t.includes('_supply) {'),
        `${tag}: the old constructor body is gone from the token`);
    }
  }
});

test('M9: the flag-off source is untouched — no proxy, no initialize, same constructor', () => {
  for (const std of STDS) {
    const s = src(std, { mintable: true });
    assert.ok(!s.includes(`contract ${P}`), `${std}: a plain build must not ship a proxy`);
    assert.ok(!s.includes('function initialize('), `${std}: a plain build must not ship initialize()`);
    assert.equal(ctors(s).length, 1, `${std}: the shipped constructor stays`);
    assert.ok(/constructor\((string|uint)/.test(s), `${std}: constructor keeps its parameters`);
  }
});

// ── the upgrade gate ────────────────────────────────────────────
test('M9: every UUPS implementation has a gate, and it is the contract\'s own authority', () => {
  const cases = [
    [{ mintable: true }, 'onlyOwner', 'Ownable token → the owner upgrades'],
    [{ mintable: true, pausable: true, access: 'ownable2step' }, 'onlyOwner', 'Ownable2Step → still the owner'],
    [{ mintable: true, access: 'accesscontrol' }, 'onlyRole(DEFAULT_ADMIN_ROLE)', 'Roles → the admin role'],
    [{ mintable: true, pausable: true, access: 'managed' }, 'onlyDefaultAdmin', 'Managed → the default admin'],
    // All-off differs by standard, and the difference is the point: an ERC-20
    // with no features has no owner at all, so it needs its own upgrade
    // authority — while ERC-721/1155 always ship an owner (OZ parity), so
    // giving them a second one would create two doors for one lock.
    [{}, { erc20: 'onlyUpgrader', erc721: 'onlyOwner', erc1155: 'onlyOwner' },
      'no owner at all → a dedicated upgrader (ERC-20 all-off only)'],
  ];
  for (const [flags, gate, why] of cases) {
    for (const std of STDS) {
      const expect = typeof gate === 'string' ? gate : gate[std];
      const s = src(std, { ...flags, upgradeable: true, proxyType: 'uups' });
      const t = tokenPart(s);
      const tag = `${std} (${why})`;
      assert.ok(
        t.includes(`function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ${expect}`),
        `${tag}: expected gate "${expect}", got:\n${(t.match(/function upgradeToAndCall[^\n]*/) || ['(missing)'])[0]}`);
      assert.ok(!/upgradeToAndCall\(address newImplementation, bytes calldata data\) external payable \{/.test(t),
        `${tag}: an UNGATED upgradeToAndCall is a takeover button`);
    }
  }

  // The all-off case gets the dedicated authority, wired through initialize().
  const bare = tokenPart(src('erc20', { upgradeable: true, proxyType: 'uups' }));
  assert.ok(bare.includes('function setUpgrader(address newUpgrader) external onlyUpgrader'),
    'a dedicated upgrader must be transferable, or it is a one-way key');
  assert.match(bare, /function initialize\([^)]*\) external initializer \{\n        emit Initialized\(1\);\n        upgrader = msg\.sender;/,
    'initialize() emits its own proof, then hands the upgrader to whoever deployed the proxy');
  assert.ok(!bare.includes('modifier onlyUpgrader') || bare.includes('require(msg.sender == upgrader'),
    'the modifier must actually check the caller');

  // A gated token must NOT also carry an upgrader — two authorities for one
  // upgrade path is how a rotation gets done in the wrong place.
  const owned = tokenPart(src('erc20', { mintable: true, upgradeable: true, proxyType: 'uups' }));
  assert.ok(!owned.includes('modifier onlyUpgrader'),
    'an ownable token must not grow a second, parallel upgrade authority');
});

test('M9: Transparent keeps the upgrade logic OUT of the implementation', () => {
  const t = tokenPart(src('erc20', { mintable: true, upgradeable: true, proxyType: 'transparent' }));
  assert.ok(!t.includes('upgradeToAndCall'), 'a transparent implementation must not expose upgrades');
  assert.ok(!t.includes('_IMPL_SLOT'), 'nor the ERC-1967 slot it would write to');
  const s = src('erc20', { mintable: true, upgradeable: true, proxyType: 'transparent' });
  const proxy = s.slice(s.indexOf(`contract ${P}`));
  assert.ok(proxy.includes('function upgradeTo(address newImplementation) external ifAdmin'),
    'the transparent admin upgrades through the proxy');
  assert.ok(proxy.includes('function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ifAdmin'),
    'and can hand initialise/migration calldata along with it');
});

// ── the proxy itself ────────────────────────────────────────────
test('M9: the proxy is one EIP-1967 contract with the transparent rule', () => {
  const s = src('erc20', { mintable: true, upgradeable: true, proxyType: 'uups' });
  const proxy = s.slice(s.indexOf(`contract ${P}`));
  assert.ok(proxy.includes('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'),
    'the EIP-1967 implementation slot must be the standard one, or no explorer/proxy will read it');
  assert.ok(proxy.includes('0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'),
    'the EIP-1967 admin slot must be the standard one');
  assert.ok(proxy.includes('modifier ifAdmin()'), 'the transparent rule needs ifAdmin');
  assert.ok(proxy.includes('function _delegate(address implementation_) internal'), 'every non-admin call must delegate');
  assert.ok(proxy.includes('fallback() external payable'), 'the proxy needs a payable fallback');
  assert.ok(proxy.includes('require(implementation_.code.length > 0'),
    'a proxy pointed at an address with no code is a dead contract on arrival');
  // Initialisation rides in the constructor — that is the whole point of M9.
  assert.match(proxy, /constructor\(address implementation_, bytes memory data, address admin_\) payable \{/,
    'the proxy constructor must take (impl, init data, admin)');
  assert.ok(proxy.includes('implementation_.delegatecall(data)'),
    'and it must delegatecall the initialisation itself, in the deploy transaction');
  assert.ok(proxy.includes('function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ifAdmin'),
    'the proxy upgrade path is admin-gated');
  // Honest deviation: unlike OZ, the fallback delegates for the admin too — the
  // admin IS the deployer, who must be able to spend their own token (see the
  // comment in PROXY_SOURCE). What must NEVER happen is a selector clash: the
  // proxy owns these four names, so a token defining any of them would lose it
  // to the proxy for every caller.
  assert.ok(proxy.includes('fallback() external payable {') && proxy.includes('_delegate(_implementation());'),
    'the fallback must delegate — a proxy that swallows calls ships a dead token');
  assert.ok(!/fallback\(\)[^}]*_admin\(\)[^}]*revert/.test(proxy),
    'blocking the admin would lock the deployer out of the token they just deployed');
  // One standard and one flag set would not catch a future feature that grows
  // a clashing name: the sweep covers all three standards × flag sets that
  // actually change the emitted body (ownership model, votes, pausable).
  for (const std of STDS) {
    for (const flags of [{}, { mintable: true, pausable: true },
      { mintable: true, access: 'accesscontrol' }, { mintable: true, votes: true, permit: true }]) {
      const body = tokenPart(src(std, flags));
      for (const clash of ['admin', 'implementation', 'changeAdmin', 'upgradeTo']) {
        assert.ok(!body.includes(`function ${clash}(`),
          `${std} ${JSON.stringify(flags)}: the token must not define ${clash}() — the proxy owns that selector`);
      }
    }
  }
});

test('M9: contractEndIndex ignores braces inside strings and comments', () => {
  // ERC-1155 URIs look like ipfs://{id}.json — a naive brace count would put
  // the UUPS block OUTSIDE the contract, where it would not compile.
  const tiny = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

contract Tiny {
    string public uri;
    constructor(string memory u) { uri = u; }
}`;
  const out = contracts.makeUpgradeable(tiny, 'Tiny', 'uups');
  const before = out.slice(0, out.indexOf(`contract ${P}`));
  assert.ok(before.includes('function initialize(string memory u) external initializer {'), 'transform ran');
  assert.ok(before.includes('function upgradeToAndCall('),
    'the UUPS block landed INSIDE the contract — a brace in a string must not end the scan early');
  assert.ok(before.lastIndexOf('}') > before.lastIndexOf('function upgradeToAndCall('),
    'and before the contract closes, so it is inside the body');
  assert.ok(out.includes(`contract ${P}`), 'the proxy is appended after the token');

  // A brace inside a comment must not end the contract either.
  const commented = `contract T2 {
    // } not the end
    string public uri;
    constructor(string memory u) { uri = u; }
}`;
  const out2 = contracts.makeUpgradeable(commented, 'T2', 'uups');
  assert.ok(out2.includes('function initialize(string memory u)'),
    'comment braces must be ignored too');
});

// ── the wizard form ─────────────────────────────────────────────
test('M9: all three standards offer the option, and Proxy type is born disabled', () => {
  for (const std of STDS) {
    const html = contracts.extraFieldsHtml(std);
    assert.ok(html.includes('id="deployUpgradeable"'), `${std}: the upgradeable toggle must render`);
    assert.match(html, /<select class="select" id="deployProxyType" disabled>/,
      `${std}: proxy type must be inert until the toggle is ticked`);
    assert.match(html, /wizard-section-title[^>]*>Upgradeability</,
      `${std}: the option needs its own section heading, not a stray field`);
    const fields = contracts.getStandard(std).fields;
    assert.ok(fields.some((f) => f.id === 'deployUpgradeable' && f.type === 'checkbox'),
      `${std}: the toggle must be a checkbox (the form reads .checked)`);
    assert.ok(fields.some((f) => f.id === 'deployProxyType' && f.type === 'select' && f.options.length === 2),
      `${std}: exactly two proxy flavours`);
  }
  const html = appSource();
  assert.ok(html.includes('id="deployExtra"'), 'the extra fields render into #deployExtra');
  assert.equal((html.match(/id="deployUpgradeable"/g) || []).length, 0,
    'the toggle is generated per standard, never baked into the static markup');
});

// ── the deploy ──────────────────────────────────────────────────
test('M9: the deploy reads the fields and sends two transactions, proxy last', () => {
  assert.match(deploySrc, /upgradeable: \$\('#deployUpgradeable'\)\?\.checked/, 'the toggle is read');
  assert.match(deploySrc, /proxyType: \$\('#deployProxyType'\)\?\.value/, 'the flavour is read');
  assert.match(deploySrc, /import \{[^}]*PROXY_CONTRACT[^}]*\} from '\.\/contracts\.js'/, 'the proxy name is imported');

  // tx 1: implementation with NO constructor arguments.
  assert.match(deploySrc, /const implContract = await factory\.deploy\(\);/,
    'the logic contract takes no constructor arguments — initialize() runs behind the proxy');
  // tx 2: the proxy, carrying initialize() in its constructor.
  assert.match(deploySrc, /iface\.encodeFunctionData\('initialize', plan\.args\)/,
    'the initialise calldata is ABI-encoded, not guessed');
  assert.match(deploySrc, /proxyFactory\.deploy\(implAddress, initData, adminAddr\)/,
    'the proxy is deployed WITH the initialisation — no uninitialised window');
  assert.match(deploySrc, /const proxyArt = compiled\.contracts\?\.\[PROXY_CONTRACT\]/,
    'the proxy ABI/bytecode comes from the same compilation as the token');
  assert.match(deploySrc, /await provider\.estimateGas\(\{\s*\.\.\.\(await proxyFactory\.getDeployTransaction/,
    'the proxy gas is estimated once its address input actually exists');

  // Admin choice: UUPS is adminless, Transparent is admin\'d by the deployer.
  assert.match(deploySrc, /adminAddr = plan\.flags\.proxyType === 'transparent' \? get\('address'\) : ethers\.ZeroAddress/,
    'admin = the deployer only for Transparent; UUPS must have NO admin');

  // Each transaction is confirmed on its own, and a dead implementation stops
  // the run before a proxy is pointed at it.
  assert.match(deploySrc, /const implRes = await waitForReceipt\(implTx\);/, 'the implementation is awaited');
  assert.ok(deploySrc.indexOf('const implRes = await waitForReceipt(implTx);')
      < deploySrc.indexOf('proxyFactory.deploy(implAddress'),
    'implementation must be confirmed BEFORE the proxy deploy runs');
  assert.match(deploySrc, /if \(implRes\.receipt\?\.status !== 1\) \{[\s\S]{0,200}Implementation deploy reverted/,
    'a reverted implementation must not leave a proxy pointing at nothing');
  assert.match(deploySrc, /const implAddress = ''|implAddress = ''/, 'the logic address is tracked');

  // Critic VETO-2: the activity row must never disagree with the status line.
  // Unconfirmed (timeout) and replaced (speed-up) are both NEITHER success nor
  // failure, so they return BEFORE the row is finalised — otherwise the log
  // files a "failed" deploy while the screen says "wait for it", and the user
  // pays for the same deploy twice.
  const timeoutIdx = deploySrc.indexOf('if (implRes.timedOut && !implRes.receipt)');
  const replacedIdx = deploySrc.indexOf('if (!implRes.receipt && !implRes.timedOut)');
  const finalIdx = deploySrc.indexOf('status: implRes.receipt?.status === 1 ? \'success\' : \'failed\'');
  assert.ok(timeoutIdx > -1 && replacedIdx > -1 && finalIdx > -1,
    'the implementation path must still check timeout AND replacement before it writes a final status');
  assert.ok(timeoutIdx < finalIdx && replacedIdx < finalIdx,
    'an unconfirmed or replaced implementation must NOT be filed as failed');
  assert.match(deploySrc, /if \(replaced && !receipt\) \{[\s\S]{0,200}Nothing was recorded/,
    'a replaced transaction says it was replaced, and records nothing');

  // The recorded token is the PROXY — the address the user actually holds —
  // with the implementation filed next to it.
  assert.match(deploySrc, /\.\.\.\(upg \? \{ impl: implAddress, proxy: plan\.flags\.proxyType \} : \{\}\)/,
    'the logic address must be filed, or an upgradeable token looks impl-less');

  // Verify both addresses: an explorer only shows the token once the
  // implementation source is up too.
  assert.match(deploySrc, /\{ tag: 'impl', address: implAddress, contractName: std\.contract/,
    'the implementation is published');
  assert.match(deploySrc, /\{ tag: 'proxy', address, contractName: PROXY_CONTRACT/,
    'and so is the address the user shares');

  // Proxy type enablement is delegated (#deployExtra is re-rendered wholesale).
  assert.match(deploySrc, /extraBox\.dataset\.boundProxy/, 'the sync is bound on the container');
  assert.match(deploySrc, /if \(upg && pt\) pt\.disabled = !upg\.checked/, 'and really flips the select');
});

test('M9: one compilation hands back every deployable contract', () => {
  assert.match(solcSrc, /contracts\[name\] = \{ abi: c\.abi, bytecode: '0x' \+ c\.evm\.bytecode\.object \}/,
    'compileContract must expose the proxy too — two compiles could disagree');
  assert.match(solcSrc, /abi: contract\.abi,\s*\n\s*bytecode: '0x' \+ contract\.evm\.bytecode\.object,\s*\n\s*contracts,/,
    'the requested contract stays the primary result, contracts is additive');
  assert.match(solcSrc, /Interfaces\/libraries carry no creation code and are skipped/,
    'and the skip rule is written down, not implied');
});
