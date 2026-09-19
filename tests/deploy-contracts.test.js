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
  assert.match(solcJs.SOLC_URL, /solc@0\.8\.28\//, 'compiler version must be pinned');
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
    assert.match(std.source, /pragma solidity \^0\.8\.28;/, `${id} must pin the pragma the compiler ships`);
    assert.ok(std.fields.length > 0, `${id} must declare its extra form fields`);
  }
  assert.match(contracts.getStandard('erc20').source, /function transferFrom\(/, 'ERC-20 must be a real token');
  assert.match(contracts.getStandard('erc721').source, /function ownerOf\(/, 'ERC-721 must be a real NFT');
  assert.match(contracts.getStandard('erc1155').source, /function safeBatchTransferFrom\(/, 'ERC-1155 must be real');
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
});

// ── part 2: real compilation (network, opt-in) ──
test('deploy: real solc compiles every template to real bytecode', { skip: process.env.BEAR_SOLC !== '1' && 'set BEAR_SOLC=1 (downloads ~9 MB compiler)' }, async () => {
  const file = process.env.BEAR_SOLC_FILE || path.join('/data/data/com.termux/files/usr/tmp/opencode', 'soljson-0828.js');
  let code;
  if (fs.existsSync(file)) {
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

  const expectations = {
    BearERC20: [['transfer', 'approve', 'transferFrom', 'balanceOf', 'totalSupply']],
    BearERC721: [['ownerOf', 'balanceOf', 'transferFrom', 'safeTransferFrom', 'mint', 'tokenURI']],
    BearERC1155: [['balanceOf', 'balanceOfBatch', 'safeTransferFrom', 'safeBatchTransferFrom', 'uri', 'mint']]
  };
  for (const [id, std] of Object.entries({ erc20: contracts.getStandard('erc20'), erc721: contracts.getStandard('erc721'), erc1155: contracts.getStandard('erc1155') })) {
    const out = await solcJs.compileContract(std.source, std.contract);
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
});

test('tools: "deploy the helper first" is explicit, real, and bounded', () => {
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // status card lives in the Tools view, ABOVE the flows that need it
  const view = html.slice(html.indexOf('id="view-eip7702"'));
  assert.match(view, /id="helperStatusList"/, 'Tools must show helper-contract status');
  assert.ok(view.indexOf('id="helperStatusList"') < view.indexOf('id="batchList"'), 'step 1 must come before the batch queue');
  // explicit up-front deploy + the fixed compiler
  assert.match(tools, /export async function deployBatchHelper\(\)/, 'user must be able to deploy the helper up front');
  assert.match(tools, /export async function deployRescueHelper\(\)/, 'rescue helper must be deployable up front');
  assert.match(tools, /export async function deployAirdropClaimer\(\)/, 'airdrop claimer must be deployable up front');
  assert.match(tools, /import \{ compileContract \} from '\.\/solc\.js'/, 'helper compile must use the fixed solc loader');
  assert.doesNotMatch(tools, /solc@0\.8\.28\/solc\.js/, 'the Node solc build must never be loaded again');
  assert.doesNotMatch(tools, /ensureSolcLoaded/, 'the broken loader must be gone');
  // every flow REQUIRES the helper to be deployed first — no silent auto-deploy
  assert.match(tools, /Deploy the batch helper first/, 'batch exec must demand a pre-deployed helper');
  assert.match(tools, /Deploy the rescue helper first/, 'rescue exec must demand a pre-deployed helper');
  assert.match(tools, /Deploy the airdrop claimer first/, 'claim exec must demand a pre-deployed helper');
  assert.doesNotMatch(tools, /Compiling batch contract\.\.\./, 'batch exec must not auto-deploy');
  assert.doesNotMatch(tools, /Compiling rescue contract\.\.\./, 'rescue exec must not auto-deploy');
  assert.doesNotMatch(tools, /Compiling airdrop claimer contract\.\.\./, 'claim exec must not auto-deploy');
  assert.doesNotMatch(tools, /Deployed automatically on the first run/, 'status card must not promise auto-deploy');
  // a helper deploy must never spin forever
  const fn = tools.slice(tools.indexOf('async function deployContract'), tools.indexOf('// ── EIP-7702: delegate'));
  assert.match(fn, /waitForReceipt\(/, 'helper deploy must be bounded by waitForReceipt');
  assert.match(fn, /timedOut/, 'helper deploy must report a timeout instead of hanging');
  // and the card must be kept in sync after a run / registry change
  assert.ok((tools.match(/renderHelperStatus\(\)/g) || []).length >= 4, 'helper status must refresh after deploy/removal');
});
