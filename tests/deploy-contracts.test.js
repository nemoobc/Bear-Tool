// Bear Tool — deploy-contracts.test.js
// The deploy wizard used to be a STUB (it only showed a toast) and the solc
// loader pointed at the CDN's NODE build, so every compile died with
// "Cannot read properties of undefined (reading 'compile')".
// Part 1 always runs: static guards + form validation (deterministic, offline).
// Part 2 runs with BEAR_SOLC=1: downloads the real soljson compiler and builds
// every template, asserting real abi + bytecode come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSource } from './helpers/app-source.mjs';

// This is an ES module, so there is no __dirname. Define it from import.meta.url
// — and via fileURLToPath, not .pathname, which on Windows comes back as
// "/C:/Users/…" and produces "C:\C:\Users\…".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {}
};
const { ethers } = await import('ethers');
globalThis.ethers = ethers;

const solcJs = await import('../js/solc.js');
const contracts = await import('../js/contracts.js');
const deploySrc = fs.readFileSync(new URL('../js/deploy.js', import.meta.url), 'utf8');

// ── part 1: static guards ──
test('deploy: solc loader uses the BROWSER build (soljson), never the Node CLI', () => {
  assert.match(solcJs.SOLC_URL, /\/soljson\.js$/, 'must load soljson.js (browser/wasm build)');
  assert.doesNotMatch(solcJs.SOLC_URL, /\/solc\.js$/, 'solc.js is the Node CLI wrapper and breaks in a browser');
  assert.match(solcJs.SOLC_URL, /solc@0\.8\.37\//, 'compiler version must be pinned');
  assert.match(solcJs.SOLC_URL, /^https:\/\/cdn\.jsdelivr\.net\//, 'CDN must be allow-listed by the CSP');
  assert.ok(Array.isArray(solcJs.SOLC_FALLBACK_URLS) && solcJs.SOLC_FALLBACK_URLS.length > 0, 'a fallback CDN must exist so a blocked primary does not look like a compile error');
  assert.ok(solcJs.SOLC_FALLBACK_URLS.every(u => /^https:\/\/unpkg\.com\//.test(u)), 'fallback CDN must be allow-listed by the CSP');
  assert.match(solcJs.SOLC_VERSION, /^0\.8\.\d+$/, 'version constant must be a 0.8.x release');
});

test('deploy: wizard performs a real deploy (no stub, no simulation)', async () => {
  // the old stub's dead-end toast must be gone
  assert.doesNotMatch(deploySrc, /needs contract templates/, 'the stub toast must be gone');
  assert.doesNotMatch(deploySrc, /Math\.random/, 'no simulated amounts in the deploy path');
  // every real step must be present, in order-ish
  assert.match(deploySrc, /compileContract\(/, 'bytecode must be compiled in-browser');
  assert.match(deploySrc, /new ethers\.ContractFactory\(/, 'must build a real ContractFactory');
  assert.match(deploySrc, /estimateGas/, 'must estimate gas before sending');
  assert.match(deploySrc, /factory\.deploy\(/, 'must actually deploy');
  assert.match(deploySrc, /waitForReceipt\(/, 'must wait for the receipt (bounded)');
  assert.match(deploySrc, /saveDeployed\(/, 'a deployed contract must be recorded in the registry');
});

test('deploy: each standard has a self-contained template (no imports to resolve)', () => {
  for (const id of ['erc20', 'erc721', 'erc1155']) {
    const std = contracts.getStandard(id);
    assert.ok(std, `${id} standard must exist`);
    assert.ok(std.source.includes(`contract ${std.contract}`), `${id} source must declare ${std.contract}`);
    assert.doesNotMatch(std.source, /^\s*import\s/m, `${id} must be self-contained (no import statements)`);
    // Pragma tracks the shipped compiler (single source: solc.js SOLC_VERSION).
    assert.match(std.source, new RegExp(`pragma solidity \\^${solcJs.SOLC_VERSION.replace(/\./g, '\\.')};`), `${id} must pin the pragma the compiler ships`);
    assert.ok(std.fields.length > 0, `${id} must declare its extra form fields`);
  }
  assert.match(contracts.getStandard('erc20').source, /function transferFrom\(/, 'ERC-20 must be a real token');
  assert.match(contracts.getStandard('erc721').source, /function ownerOf\(/, 'ERC-721 must be a real NFT');
  assert.match(contracts.getStandard('erc1155').source, /function safeBatchTransferFrom\(/, 'ERC-1155 must be real');
});

// ── compiler configuration passthrough (wizard: language / EVM version / optimization) ──
// The fake compiler records the exact standard-JSON input, so these tests fail
// if any knob stops reaching solc — no network, no wasm.
function fakeCompiler(record) {
  return {
    compile: (json) => {
      const input = JSON.parse(json);
      record.push(input);
      return JSON.stringify({
        contracts: { [Object.keys(input.sources)[0]]: {
          [input.sources ? Object.keys(input.sources)[0].replace(/\.sol$/, '') : 'X']: {
            abi: [], evm: { bytecode: { object: '60806040' } }
          }
        } },
        errors: []
      });
    }
  };
}

test('compileContract: compiler-config knobs reach the solc standard-JSON input', async () => {
  const seen = [];
  solcJs.injectCompiler(fakeCompiler(seen));

  // default path: no evmVersion key (compiler default = osaka) + Solidity
  await solcJs.compileContract('contract A {}', 'A');
  assert.equal(seen[0].language, 'Solidity', 'language defaults to Solidity');
  assert.ok(!('evmVersion' in seen[0].settings), 'absent evmVersion must stay absent (flag-off = shipped behavior)');
  assert.equal(seen[0].settings.optimizer.enabled, true, 'optimization defaults on');
  assert.equal(seen[0].settings.optimizer.runs, 200, 'runs default 200');

  // every wizard choice must survive the trip
  await solcJs.compileContract('contract B {}', 'B', {
    language: 'Solidity', evmVersion: 'london', optimizer: false, runs: 9999
  });
  assert.equal(seen[1].settings.evmVersion, 'london', 'evmVersion must be passed through');
  assert.equal(seen[1].settings.optimizer.enabled, false, 'optimizer toggle must be passed through');
  assert.equal(seen[1].settings.optimizer.runs, 9999, 'runs must be passed through');

  // all 14 wizard EVM options are solc-accepted identifiers (each was probed
  // against the real 0.8.37 wasm: 14/14 pass, 2026-10-04)
  const evms = ['osaka', 'prague', 'cancun', 'shanghai', 'paris', 'london', 'berlin', 'istanbul',
    'petersburg', 'constantinople', 'byzantium', 'spuriousDragon', 'tangerineWhistle', 'homestead'];
  for (const evm of evms) {
    await solcJs.compileContract('contract C {}', 'C', { evmVersion: evm });
    assert.equal(seen.at(-1).settings.evmVersion, evm, `${evm} must reach solc`);
  }
});

test('deploy: form validation rejects junk and builds constructor args', () => {
  const good = contracts.buildDeployPlan({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1000', decimals: 18 });
  assert.equal(good.args.length, 4);
  assert.equal(good.args[3], ethers.parseUnits('1000', 18), 'supply must be scaled by decimals');
  assert.equal(good.args[2], 18);
  assert.ok(good.summary.some(r => r.k === 'Supply' && r.v === '1000 BEAR'));

  const err = (input) => assert.throws(() => contracts.buildDeployPlan(input), Error);
  err({ standard: 'erc20', name: '', symbol: 'BEAR', supply: '1', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: '', supply: '1', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'B EAR', supply: '1', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '0', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1.5', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '-5', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1', decimals: 19 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1', decimals: 1.5 });
  err({ standard: 'erc20', name: 'x'.repeat(65), symbol: 'BEAR', supply: '1', decimals: 18 });
  err({ standard: 'erc20', name: 'Bear', symbol: 'x'.repeat(17), supply: '1', decimals: 18 });

  const nft = contracts.buildDeployPlan({ standard: 'erc721', name: 'Bears', symbol: 'BR', baseUri: 'ipfs://x/' });
  assert.deepEqual(nft.args, ['Bears', 'BR', 'ipfs://x/']);
  const multi = contracts.buildDeployPlan({ standard: 'erc1155', name: 'Items', symbol: 'ITM', baseUri: 'ipfs://y/' });
  assert.deepEqual(multi.args, ['Items', 'ITM', 'ipfs://y/']);

  // M7 (2026-10-04): symbol is normalised to UPPER CASE in the plan, and the
  // compiler knobs reach compileContract or fail loudly.
  const lower = contracts.buildDeployPlan({ standard: 'erc20', name: 'Bear', symbol: 'bear', supply: '1', decimals: 18 });
  assert.equal(lower.symbol, 'BEAR', 'symbol is upper-cased once, in the plan');
  assert.equal(lower.args[1], 'BEAR', 'the constructor argument carries the upper-case symbol');
  const compilerPlan = contracts.buildDeployPlan({
    standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1', decimals: 18,
    evmVersion: 'cancun', optimizer: false, runs: '999',
  });
  assert.deepEqual(compilerPlan.compiler, { language: 'Solidity', evmVersion: 'cancun', optimizer: false, runs: 999 },
    'compiler options reach the plan (and from there compileContract)');
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1', decimals: 18, evmVersion: 'paris2' });
  err({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1', decimals: 18, runs: '999.5' });

  // M8 (2026-10-04): ERC-721 — the fallback image is a 4th constructor arg
  // ONLY when set; manual ids flip the flag the generator keys off.
  const imgPlan = contracts.buildDeployPlan({ standard: 'erc721', name: 'Bears', symbol: 'BR', baseUri: 'ipfs://x/', image: 'https://x/y.png' });
  assert.deepEqual(imgPlan.args, ['Bears', 'BR', 'ipfs://x/', 'https://x/y.png'], 'four args with an image');
  const noImgPlan = contracts.buildDeployPlan({ standard: 'erc721', name: 'Bears', symbol: 'BR', baseUri: 'ipfs://x/' });
  assert.deepEqual(noImgPlan.args, ['Bears', 'BR', 'ipfs://x/'], 'three args without one');
  assert.equal(noImgPlan.flags.autoInc, true, 'auto-increment is the default');
  assert.equal(contracts.buildDeployPlan({ standard: 'erc721', name: 'Bears', symbol: 'BR', baseUri: 'x', autoInc: false }).flags.autoInc,
    false, 'unchecking the pill flips it');
  err({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: '', image: 'https://x/a"b.png' });
  err({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: '', image: 'https://x/' + 'a'.repeat(513) });
});

// ── part 2: real compilation (network, opt-in) ──
test('deploy: real solc compiles every template to real bytecode', { skip: process.env.BEAR_SOLC !== '1' && 'set BEAR_SOLC=1 (downloads ~9 MB compiler)' }, async () => {
  // Same rule as tests/fork/fork-helper.mjs: a list of plausible local copies,
  // not one Termux-only absolute path that exists on exactly one machine.
  const candidates = [
    process.env.BEAR_SOLC_FILE,
    path.join(__dirname, '..', 'soljson-0828.js'),
    path.join(__dirname, '..', 'vendor', 'soljson-0828.js'),
  ].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  let code;
  if (file) {
    code = fs.readFileSync(file, 'utf8');
  } else {
    const res = await fetch(solcJs.SOLC_URL);
    assert.equal(res.status, 200, 'compiler download must succeed');
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
  console.log('[bear-solc] runtime ready, compiler injected');

  const expectations = {
    BearERC20: [['transfer', 'approve', 'transferFrom', 'balanceOf', 'totalSupply']],
    BearERC721: [['ownerOf', 'balanceOf', 'transferFrom', 'safeTransferFrom', 'mint', 'tokenURI']],
    BearERC1155: [['balanceOf', 'balanceOfBatch', 'safeTransferFrom', 'safeBatchTransferFrom', 'uri', 'mint']]
  };
  for (const [id, std] of Object.entries({ erc20: contracts.getStandard('erc20'), erc721: contracts.getStandard('erc721'), erc1155: contracts.getStandard('erc1155') })) {
    const tc = Date.now();
    const out = await solcJs.compileContract(std.source, std.contract);
    console.log(`[bear-solc] template ${id} ok in ${Date.now() - tc}ms`);
    const names = out.abi.filter(e => e.type === 'function').map(e => e.name);
    for (const fn of expectations[std.contract][0]) {
      assert.ok(names.includes(fn), `${id} (${std.contract}) abi must expose ${fn}()`);
    }
    assert.ok(out.bytecode.startsWith('0x'), `${id} bytecode must be hex`);
    assert.ok(out.bytecode.length > 200, `${id} bytecode looks empty (${out.bytecode.length} chars)`);
    // the compiled bytecode must be deployable input for ethers
    const factory = new ethers.ContractFactory(out.abi, out.bytecode);
    assert.equal(factory.bytecode, out.bytecode, `${id} bytecode must round-trip through ContractFactory`);
  }
  // Generated feature combinations (wizard-options.test.js T7): the flag
  // builder must emit REAL Solidity, not just strings — compile an
  // all-features ERC-20, a mint-less ERC-721 and burnable NFT variants.
  const combos = [
    ['erc20-all', contracts.buildTokenSource('erc20', { burnable: true, mintable: true, pausable: true, cap: '1000000' }), 'BearERC20', ['burn', 'mint', 'pause', 'cap', 'transfer']],
    ['erc20-plain', contracts.buildTokenSource('erc20', {}), 'BearERC20', ['transfer', 'balanceOf']],
    ['erc721-burn', contracts.buildTokenSource('erc721', { mintable: true, burnable: true }), 'BearERC721', ['burn', 'mint', 'tokenURI']],
    ['erc721-nomint', contracts.buildTokenSource('erc721', { mintable: false }), 'BearERC721', ['ownerOf']],
    ['erc1155-burn', contracts.buildTokenSource('erc1155', { mintable: true, burnable: true }), 'BearERC1155', ['burn', 'mint', 'uri']],
    // ── M1 OZ-parity round 2 (2026-10-04): every handwritten feature must
    // produce REAL compilable solidity, not plausible-looking strings.
    ['erc20-parity', contracts.buildTokenSource('erc20', { burnable: true, mintable: true, pausable: true, permit: true, votes: true, cap: '1000000', access: 'accesscontrol' }), 'BearERC20', ['permit', 'DOMAIN_SEPARATOR', 'delegate', 'getPastVotes', 'grantRole', 'hasRole', 'pause', 'mint']],
    ['erc20-2step', contracts.buildTokenSource('erc20', { mintable: true, access: 'ownable2step' }), 'BearERC20', ['transferOwnership', 'acceptOwnership', 'mint']],
    ['erc20-permit-plain', contracts.buildTokenSource('erc20', { permit: true, votes: true }), 'BearERC20', ['permit', 'delegate', 'transfer']],
    ['erc721-parity', contracts.buildTokenSource('erc721', { mintable: true, burnable: true, pausable: true, enumerable: true, uriStorage: true }), 'BearERC721', ['tokenByIndex', 'tokenOfOwnerByIndex', 'setTokenURI', 'pause', 'burn', 'transferOwnership']],
    ['erc721-nomint-acl', contracts.buildTokenSource('erc721', { mintable: false, pausable: true, enumerable: true, access: 'accesscontrol' }), 'BearERC721', ['grantRole', 'pause', 'tokenByIndex']],
    ['erc1155-parity', contracts.buildTokenSource('erc1155', { mintable: true, burnable: true, pausable: true, access: 'accesscontrol' }), 'BearERC1155', ['grantRole', 'pause', 'burn', 'uri']],
    // ── M7 (2026-10-04): Callback / Flash Minting + Managed access must be
    // REAL Solidity too, in every combination the wizard can actually emit.
    ['erc20-callback', contracts.buildTokenSource('erc20', { mintable: true, callback: true }), 'BearERC20', ['transferAndCall', 'transfer']],
    ['erc20-flashmint', contracts.buildTokenSource('erc20', { mintable: true, flashmint: true }), 'BearERC20', ['flashLoan', 'maxFlashLoan', 'flashFee']],
    ['erc20-m7-all', contracts.buildTokenSource('erc20', { mintable: true, burnable: true, pausable: true, permit: true, votes: true, callback: true, flashmint: true, cap: '1000000', access: 'managed' }), 'BearERC20', ['transferAndCall', 'flashLoan', 'permit', 'delegate', 'beginDefaultAdminTransfer', 'grantRole', 'pause']],
    ['erc20-flashmint-cap', contracts.buildTokenSource('erc20', { mintable: true, flashmint: true, cap: '500', pausable: true, votes: true, access: 'managed' }), 'BearERC20', ['flashLoan', 'cap', 'pause', 'acceptDefaultAdminTransfer']],
    ['erc721-managed', contracts.buildTokenSource('erc721', { mintable: true, pausable: true, access: 'managed' }), 'BearERC721', ['beginDefaultAdminTransfer', 'grantRole', 'pause', 'mint']],
    ['erc721-managed-all', contracts.buildTokenSource('erc721', { mintable: true, pausable: true, access: 'managed', enumerable: true, uriStorage: true, burnable: true }), 'BearERC721', ['tokenByIndex', 'setTokenURI', 'burn', 'acceptDefaultAdminTransfer']],
    ['erc1155-managed', contracts.buildTokenSource('erc1155', { mintable: true, pausable: true, access: 'managed' }), 'BearERC1155', ['beginDefaultAdminTransfer', 'grantRole', 'pause', 'mint']],
    ['erc1155-managed-burn', contracts.buildTokenSource('erc1155', { mintable: true, access: 'managed', burnable: true }), 'BearERC1155', ['burn', 'grantRole']],
    // ── M8 (2026-10-04): manual token ids and the fallback image must be real
    // Solidity in every shape the ERC-721 wizard can emit.
    ['erc721-manual', contracts.buildTokenSource('erc721', { mintable: true, autoInc: false }), 'BearERC721', ['mint', 'tokenURI']],
    ['erc721-manual-enumerable', contracts.buildTokenSource('erc721', { mintable: true, enumerable: true, autoInc: false }), 'BearERC721', ['mint', 'tokenByIndex', 'tokenOfOwnerByIndex']],
    ['erc721-manual-acl', contracts.buildTokenSource('erc721', { mintable: true, access: 'accesscontrol', autoInc: false }), 'BearERC721', ['mint', 'grantRole']],
    ['erc721-manual-managed', contracts.buildTokenSource('erc721', { mintable: true, pausable: true, access: 'managed', autoInc: false }), 'BearERC721', ['mint', 'beginDefaultAdminTransfer', 'pause']],
    ['erc721-manual-burn', contracts.buildTokenSource('erc721', { mintable: true, burnable: true, autoInc: false }), 'BearERC721', ['mint', 'burn']],
    ['erc721-image', contracts.buildTokenSource('erc721', { mintable: true, image: 'https://example.com/bear.png' }), 'BearERC721', ['mint', 'tokenURI']],
    ['erc721-image-uristorage', contracts.buildTokenSource('erc721', { mintable: true, image: 'https://example.com/bear.png', uriStorage: true, baseUri: 'ipfs://z/' }), 'BearERC721', ['mint', 'setTokenURI', 'tokenURI']],
    ['erc721-m8-all', contracts.buildTokenSource('erc721', { mintable: true, burnable: true, pausable: true, enumerable: true, uriStorage: true, access: 'managed', autoInc: false, image: 'https://example.com/bear.png' }), 'BearERC721', ['mint', 'burn', 'setTokenURI', 'grantRole', 'tokenByIndex']],
    ['erc721-nomint-manual', contracts.buildTokenSource('erc721', { mintable: false, enumerable: true, autoInc: false }), 'BearERC721', ['ownerOf', 'tokenByIndex']],
    // ── M9 (2026-10-04): upgradeable (ERC-1967) builds. The constructor must
    // really have become initialize(), the upgrade gate must really exist for
    // each flavour of authority, and ERC1967Proxy must compile next to the
    // token in the SAME pass — the deploy needs both creation codes.
    ['erc20-upg-uups', contracts.buildTokenSource('erc20', { mintable: true, upgradeable: true, proxyType: 'uups' }), 'BearERC20', ['initialize', 'upgradeToAndCall']],
    ['erc20-upg-transparent', contracts.buildTokenSource('erc20', { mintable: true, upgradeable: true, proxyType: 'transparent' }), 'BearERC20', ['initialize']],
    ['erc20-upg-all-off', contracts.buildTokenSource('erc20', { upgradeable: true, proxyType: 'uups' }), 'BearERC20', ['initialize', 'upgradeToAndCall', 'setUpgrader']],
    ['erc20-upg-roles', contracts.buildTokenSource('erc20', { mintable: true, pausable: true, upgradeable: true, access: 'accesscontrol', proxyType: 'uups' }), 'BearERC20', ['initialize', 'upgradeToAndCall', 'grantRole']],
    ['erc20-upg-managed', contracts.buildTokenSource('erc20', { mintable: true, upgradeable: true, access: 'managed', proxyType: 'uups' }), 'BearERC20', ['initialize', 'upgradeToAndCall', 'beginDefaultAdminTransfer']],
    ['erc721-upg-uups', contracts.buildTokenSource('erc721', { mintable: true, upgradeable: true, proxyType: 'uups', image: 'https://example.com/bear.png' }), 'BearERC721', ['initialize', 'upgradeToAndCall']],
    ['erc1155-upg-transparent', contracts.buildTokenSource('erc1155', { mintable: true, upgradeable: true, proxyType: 'transparent' }), 'BearERC1155', ['initialize']],
  ];
  for (const [label, source, contract, fns] of combos) {
    const tc = Date.now();
    const out = await solcJs.compileContract(source, contract);
    console.log(`[bear-solc] combo ${label} ok in ${Date.now() - tc}ms`);
    const names = out.abi.filter(e => e.type === 'function').map(e => e.name);
    for (const fn of fns) assert.ok(names.includes(fn), `${label} abi must expose ${fn}()`);
    assert.ok(out.bytecode.startsWith('0x') && out.bytecode.length > 200, `${label} bytecode looks empty (${out.bytecode.length} chars)`);
    if (label.startsWith('erc721-nomint')) assert.ok(!names.includes('mint'), `${label}: a mint-less ERC-721 must not ship mint()`);
    // M9: an upgradeable source yields TWO deployable contracts, from one
    // compilation. The proxy is what the user is handed, so a token-only
    // result would compile "fine" and then fail at the deploy.
    if (source.includes(`contract ${contracts.PROXY_CONTRACT}`)) {
      const proxy = out.contracts?.[contracts.PROXY_CONTRACT];
      assert.ok(proxy?.bytecode?.startsWith('0x') && proxy.bytecode.length > 200,
        `${label}: ERC1967Proxy bytecode missing from the compilation output`);
      assert.ok(proxy.abi.some(e => e.type === 'constructor'), `${label}: proxy ABI must carry its constructor`);
      assert.ok(proxy.abi.some(e => e.type === 'fallback'), `${label}: proxy must expose the fallback that delegates`);
      assert.ok(proxy.abi.some(e => e.type === 'function' && e.name === 'upgradeTo'),
        `${label}: proxy ABI must carry the transparent admin upgrade()`);
      assert.ok(out.abi.some(e => e.type === 'function' && e.name === 'initialize'),
        `${label}: the token must expose initialize()`);
      assert.equal(out.abi.some(e => e.type === 'constructor' && e.inputs?.length > 0), false,
        `${label}: a parameterised constructor survived — it would run on the logic contract, not behind the proxy`);
    }
  }
});

test('tools: deploy helper tetap eksplisit, dan flow auto-deploy dgn konfirmasi', () => {
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  // Halaman = index.html + section view (M2: src/views/*.jsx).
  const html = appSource();
  // The helper-status card lives in the Tools view, ABOVE the flows that need
  // it. It used to be sliced out of a separate #view-eip7702 section; that view
  // is gone now — the EIP-7702 suite was merged into #view-deploy so there is a
  // single Tools entry instead of two views holding copies of the same forms.
  const view = html.slice(html.indexOf('id="view-deploy"'));
  assert.match(html, /id="view-deploy"/, 'the Tools view must exist');
  assert.doesNotMatch(html, /id="view-eip7702"/, 'the duplicate EIP-7702 view must be gone');
  assert.match(view, /id="btnDeployBatchHelper"/, 'each flow card carries its own Deploy contract button');
  assert.ok(view.indexOf('id="btnDeployBatchHelper"') < view.indexOf('id="btnBatchExecute"'),
    'the batch Deploy button sits in the action row next to Execute');
  assert.doesNotMatch(view, /id="helperStatusList"/, 'the removed Helper Contracts card must not return');
  // explicit up-front deploy + the fixed compiler
  assert.match(tools, /export async function deployBatchHelper\(\)/, 'user must be able to deploy the helper up front');
  assert.match(tools, /export async function deployRescueHelper\(\)/, 'rescue helper must be deployable up front');
  assert.match(tools, /export async function deployAirdropClaimer\(\)/, 'airdrop claimer must be deployable up front');
  assert.match(tools, /import \{ compileContract \} from '\.\/solc\.js'/, 'helper compile must use the fixed solc loader');
  assert.doesNotMatch(tools, /solc@[\d.]+\/solc\.js/, 'the Node solc build must never be loaded again');
  assert.doesNotMatch(tools, /ensureSolcLoaded/, 'the broken loader must be gone');
  //── Kontrak DIUBAH (2026-10-03, banding dgn nemoobc/EIP-7702-TOOL):
  // "di fitur tools itu ada yang salah bikin user bingung ... fungsinya tu kek gitu"
  // Flow kini MENGAMBIL ALIH deploy helper saat belum ada — dengan KONFIRMASI
  // (bukan silent), sehingga teks kartu "or let the flow deploy it for you"
  // (deploy.jsx:53) jadi BENAR. Hard-stop "step 1 above" = dihapus.
  assert.ok((tools.match(/ensureDeployedHelper\(/g) || []).length >= 4,
    'ensure helper: 1 definisi + dipakai ketiga flow (batch, rescue, claim)');
  assert.doesNotMatch(tools, /helper first \(step 1 above\)/,
    'toast buntu "step 1 above" hilang — flow deploy sendiri setelah konfirmasi');
  assert.doesNotMatch(tools, /Deployed automatically on the first run/,
    'kartu status tetap tidak menjanjikan deploy SENYAP');
  // a helper deploy must never spin forever
  const fn = tools.slice(tools.indexOf('async function deployContract'), tools.indexOf('// ── EIP-7702: delegate'));
  assert.match(fn, /waitForReceipt\(/, 'helper deploy must be bounded by waitForReceipt');
  assert.match(fn, /timedOut/, 'helper deploy must report a timeout instead of hanging');
  // and the card must be kept in sync after a run / registry change
  assert.ok((tools.match(/renderHelperStatus\(\)/g) || []).length >= 4, 'helper status must refresh after deploy/removal');
});

// ── live request (2026-10-03): "Deployed Contracts tambahin tombol copy" ──
test('Deployed Contracts: baris registry membawa tombol copy alamat penuh', () => {
  const reg = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.match(reg, /class="copy-btn"[^>]*data-copy="\$\{escapeHtml\(item\.address\)\}"/,
    'setiap baris harus menyalin alamat kontrak PENUH lewat handler copy global');
  assert.doesNotMatch(reg, /data-copy="\$\{escapeHtml\(wallet\.shortAddress/,
    'data-copy wajib alamat penuh — shortAddress tidak bisa dipakai tujuan copy');
});

// ── live requests (user, 2026-10-03):
//   "Sponsor private key ganti jadi auto detect yang udah kepasang di appnya
//    dan bisa pilih wallet"
//   "Target private key (if the wallet is not unlocked) ganti jadi
//    Private Key (Drainner)"
test('sponsor key field → wallet-only picker, no auto-detect (rescue + claim + revoke)', () => {
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  assert.equal((view.match(/<label htmlFor="\w+SponsorFrom">Sponsor wallet<\/label>/g) || []).length, 3,
    'all three forms (rescue + claim + revoke) offer the picker');
  assert.doesNotMatch(view, /auto-detect/i,
    'the auto entry and label are gone — sponsor is picked, never assumed (2026-10-06)');
  assert.doesNotMatch(view, /id="rescueSponsorKey"|id="claimSponsorKey"|id="revokeSponsorKey"/,
    'the paste-a-key input is gone — sponsor keys must never enter the DOM');
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.equal((tools.match(/sponsorKeyFromPicker\(/g) || []).length, 6,
    'helper defined once + used by all five sponsor entry points');
  assert.match(tools, /renderSponsorPickers\(\)/,
    'picker options are filled from the wallets saved in the app');
  assert.doesNotMatch(tools, /Auto-detect — active wallet/,
    'renderSponsorPickers lists wallets only');
  assert.match(tools, /toast\('Choose a sponsor wallet', 'error'\)/,
    'an empty pick stops the flow with a toast instead of assuming the active wallet');
});

//   "kalau mau deploy harus masukin Target private key" (2026-10-06): the
//   field is REQUIRED — the old "active wallet if empty" fallback derived
//   whatever wallet happened to be unlocked as the rescue target, so a
//   deploy recorded a Rescue target that was not the target and an execute
//   could sign the 7702 authorization with the wrong authority.
test('target key label → required wording; kosong menghentikan deploy & execute', () => {
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  // Scope: the RESCUE field. Claim's own target key (claimTargetKey) keeps
  // its wording — the user asked for rescue, and scope does not creep.
  const rescueAt = view.indexOf('htmlFor="rescueTargetKey"');
  assert.ok(rescueAt > -1, 'field rescue ada');
  const rescueLabel = view.slice(rescueAt, rescueAt + 140);
  assert.match(rescueLabel, /Target private key \(required — rescue deploys against this key\)/,
    'label states the requirement it actually enforces');
  assert.doesNotMatch(rescueLabel, /optional/,
    'the old optional wording on the rescue field is gone');
  assert.doesNotMatch(view, /Private Key \(Drainner\)/, 'the old label text is gone');
  assert.doesNotMatch(view, /Target private key \(if the wallet is not unlocked\)/,
    'the older label text is gone too');
  assert.match(view, /id="rescueTargetKey"/, 'the target key input itself stays');
  // The behaviour BEHIND the label: an empty key stops BOTH entry points
  // before any password prompt (cheap-first), instead of falling back.
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.match(tools, /function requireTargetKey\(\)/, 'the gate exists once');
  assert.match(tools, /if \(!key\) \{ toast\('Target private key is required for rescue', 'error'\); return null; \}/,
    'empty field → toast + stop — no silent active-wallet fallback');
  for (const name of ['async function executeRescue', 'async function deployRescueHelper']) {
    const at = tools.indexOf(name);
    assert.ok(at > -1, `${name} ada`);
    const body = tools.slice(at, at + 1600);
    const gate = body.indexOf('requireTargetKey() === null');
    const picker = body.indexOf('sponsorKeyFromPicker(');
    assert.ok(gate > -1, `${name}: gate dipanggil`);
    assert.ok(picker > -1 && gate < picker, `${name}: gate SEBELUM sponsor picker (validasi lokal dulu)`);
  }
});

// ── live request (2026-10-03): "kalau udah bandingin sama bear tool batch,
// rescue, claim, revoke delegate pasti beda step by stepnya"
// Banding dgn referensi nemoobc/EIP-7702-TOOL → P0 step-by-step.

test('P0 claim: RESCUER ikut sponsor (constructor) + lookup serasi rescuer', () => {
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const depStart = tools.indexOf('export async function deployAirdropClaimer');
  assert.ok(depStart >= 0, 'deployAirdropClaimer exists');
  const dep = tools.slice(depStart, tools.indexOf('export async function', depStart + 10));
  assert.match(dep, /deployContract\(sponsorSigner, abi, bytecode, \[sponsorAddress\]\)/,
    'constructor rescuer = sponsor pembayar broadcast (referensi memakai rescuer=sponsor)');
  assert.doesNotMatch(dep, /\[targetAddress\]/,
    'rescuer bukan wallet aktif — itu revert saat sponsor berbeda dari wallet aktif');
  assert.match(dep, /rescuer: sponsorAddress/, 'registry menyimpan rescuer untuk keputusan reuse');
  const execStart = tools.indexOf('async function executeClaim');
  assert.ok(execStart >= 0, 'executeClaim exists');
  // The body grew with the v1.2.0 additions (target key, decimals, before/
  // after balances), so the predicate sits further down than the old 4500.
  assert.match(tools.slice(execStart, execStart + 9000), /item\.rescuer[\s\S]{0,120}abiHasName\(item\.abi, 'claimAndForwardMin'\)/,
    'reuse claim harus cocokkan rescuer (sponsor) + ABI minimal v1.2.0, bukan hanya target deploy');
});

test('P0 revoke: auth nonce self-sponsored = nonce + 1', () => {
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const start = tools.indexOf('export async function revokeDelegation');
  assert.ok(start >= 0, 'revokeDelegation exists');
  // 2026-10-03: sponsor broadcasts even here (self-only path removed), so the
  // nonce rule is conditional: RAW authority nonce, +1 only when sponsor ==
  // target. A wrong nonce → tuple di-skip, tx ter-mine, revoke gagal diam-diam.
  const body = tools.slice(start, start + 5000);
  assert.match(body, /getTransactionCount\(target\)/, 'reads the authority nonce');
  assert.match(body, /selfSponsor \? nonce \+ 1 : nonce/,
    'self-sponsored revoke must use account nonce + 1, foreign sponsor the raw nonce');
});

test('P1 teks baris helper: binding sebenarnya (SAFE+sponsor), bukan locked wallet', () => {
  // The Helper Contracts card is gone (2026-10-04): the binding text now
  // lives in the flow-card paragraphs (deploy.jsx) + the confirm rows (tools).
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  assert.match(view, /sponsor pays gas and executes the sweep/, 'paragraf rescue menyentuh sponsor sbg eksekutor');
  assert.match(view, /The sponsor pays gas/, 'paragraf claim menyentuh sponsor sbg pembayar gas');
  assert.match(tools, /\{ k: 'SAFE destination', v: /, 'konfirmasi rescue menampilkan SAFE destination');
  assert.match(tools, /\{ k: 'Gas sponsor \(executor\)', v: /, 'konfirmasi rescue menampilkan gas sponsor');
  assert.doesNotMatch(tools + view, /takes your locked wallet/, 'teks keliru "locked wallet" pada rescue dihapus');
  assert.doesNotMatch(tools + view, /locked wallet as rescuer/, 'teks keliru "locked wallet as rescuer" pada claim dihapus');
});

test('P1 kartu Batch & Claim punya paragraf alur step-by-step', () => {
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  // Region per kartu — hitungan global bisa lolos oleh kartu lain (Revoke,
  // Deployed Contracts juga punya paragraf), jadi potong persis kartunya.
  const batchCard = view.slice(view.indexOf('data-i18n="eip7702.batch"'),
    view.indexOf('data-i18n="eip7702.rescue"'));
  const claimCard = view.slice(view.indexOf('data-i18n="eip7702.claim"'),
    view.indexOf('data-i18n="eip7702.revokeTitle"'));
  assert.match(batchCard, /<p className="small/, 'kartu Batch wajib punya paragraf alur');
  assert.match(claimCard, /<p className="small/, 'kartu Claim wajib punya paragraf alur');
});

test('P1 peringatan delegasi permanen di ketiga flow sebelum execute', () => {
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  // Referensi memperingatkan "delegasi PERMANEN + tutup dgn revoke" di batch,
  // rescue, dan claim (ref:1699-1701, 1851-1857, 2066-2076) — Bear tidak.
  assert.ok((tools.match(/Permanent until revoked/g) || []).length >= 3,
    'batch, rescue, dan claim masing-masing membawa baris peringatan permanen');
});
