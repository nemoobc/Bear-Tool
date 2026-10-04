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
  // Generated feature combinations (wizard-options.test.js T7): the flag
  // builder must emit REAL Solidity, not just strings — compile an
  // all-features ERC-20, a mint-less ERC-721 and burnable NFT variants.
  const combos = [
    ['erc20-all', contracts.buildTokenSource('erc20', { burnable: true, mintable: true, pausable: true, cap: '1000000' }), 'BearERC20', ['burn', 'mint', 'pause', 'cap', 'transfer']],
    ['erc20-plain', contracts.buildTokenSource('erc20', {}), 'BearERC20', ['transfer', 'balanceOf']],
    ['erc721-burn', contracts.buildTokenSource('erc721', { mintable: true, burnable: true }), 'BearERC721', ['burn', 'mint', 'tokenURI']],
    ['erc721-nomint', contracts.buildTokenSource('erc721', { mintable: false }), 'BearERC721', ['ownerOf']],
    ['erc1155-burn', contracts.buildTokenSource('erc1155', { mintable: true, burnable: true }), 'BearERC1155', ['burn', 'mint', 'uri']],
  ];
  for (const [label, source, contract, fns] of combos) {
    const out = await solcJs.compileContract(source, contract);
    const names = out.abi.filter(e => e.type === 'function').map(e => e.name);
    for (const fn of fns) assert.ok(names.includes(fn), `${label} abi must expose ${fn}()`);
    assert.ok(out.bytecode.startsWith('0x') && out.bytecode.length > 200, `${label} bytecode looks empty (${out.bytecode.length} chars)`);
    if (label === 'erc721-nomint') assert.ok(!names.includes('mint'), 'a minted-off ERC-721 must not ship mint()');
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
  assert.match(view, /id="helperStatusList"/, 'Tools must show helper-contract status');
  assert.ok(view.indexOf('id="helperStatusList"') < view.indexOf('id="batchList"'), 'step 1 must come before the batch queue');
  // explicit up-front deploy + the fixed compiler
  assert.match(tools, /export async function deployBatchHelper\(\)/, 'user must be able to deploy the helper up front');
  assert.match(tools, /export async function deployRescueHelper\(\)/, 'rescue helper must be deployable up front');
  assert.match(tools, /export async function deployAirdropClaimer\(\)/, 'airdrop claimer must be deployable up front');
  assert.match(tools, /import \{ compileContract \} from '\.\/solc\.js'/, 'helper compile must use the fixed solc loader');
  assert.doesNotMatch(tools, /solc@0\.8\.28\/solc\.js/, 'the Node solc build must never be loaded again');
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
test('sponsor key field → auto-detect wallet picker (rescue + claim + revoke)', () => {
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  assert.equal((view.match(/Sponsor wallet \(auto-detect\)/g) || []).length, 3,
    'all three forms (rescue + claim + revoke) offer the picker');
  assert.doesNotMatch(view, /id="rescueSponsorKey"|id="claimSponsorKey"|id="revokeSponsorKey"/,
    'the paste-a-key input is gone — sponsor keys must never enter the DOM');
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.equal((tools.match(/sponsorKeyFromPicker\(/g) || []).length, 6,
    'helper defined once + used by all five sponsor entry points');
  assert.match(tools, /renderSponsorPickers\(\)/,
    'picker options are filled from the wallets saved in the app');
});

test('target key label → Private Key (Drainner), field stays', () => {
  const view = fs.readFileSync(new URL('../src/views/deploy.jsx', import.meta.url), 'utf8');
  assert.match(view, /Private Key \(Drainner\)/, 'new label text');
  assert.doesNotMatch(view, /Target private key \(if the wallet is not unlocked\)/,
    'old label text is gone');
  assert.match(view, /id="rescueTargetKey"/, 'the target key input itself stays');
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
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.match(tools, /Bound to SAFE \+ sponsor/, 'baris rescue menyebut SAFE + sponsor');
  assert.match(tools, /Bound to the sponsor wallet \(gas payer\)/, 'baris claim menyentuh sponsor sbg pembayar gas');
  assert.doesNotMatch(tools, /takes your locked wallet/, 'teks keliru "locked wallet" pada rescue dihapus');
  assert.doesNotMatch(tools, /locked wallet as rescuer/, 'teks keliru "locked wallet as rescuer" pada claim dihapus');
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
