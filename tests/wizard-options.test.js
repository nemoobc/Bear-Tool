// Wizard feature options, aligned with the OpenZeppelin Contracts Wizard
// (github.com/OpenZeppelin/contracts-wizard, core/solidity README 2026-10-03):
// Bear's form only asked for name/symbol/supply/decimals/baseURI. The gap
// that matters for real launches: burnable/mintable/pausable toggles and a
// supply cap — without the OZ library itself, whose imports the in-browser
// solc cannot resolve (templates stay self-contained).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const contracts = await import('../js/contracts.js');

const { buildTokenSource, buildDeployPlan, getStandard, extraFieldsHtml } = contracts;

test('T1: every standard declares the OZ-parity option fields', () => {
  const ids = (std) => getStandard(std).fields.map((f) => f.id);
  const erc20 = ids('erc20');
  for (const id of ['deployCap', 'deployBurnable', 'deployMintable', 'deployPausable',
    'deployPermit', 'deployVotes', 'deployAccess',
    // M7 (2026-10-04 report): Callback / Flash Minting + compiler configuration.
    'deployCallback', 'deployFlashMint', 'deploySupply',
    'deployLanguage', 'deployEvmVersion', 'deployOptimizer', 'deployRuns']) {
    assert.ok(erc20.includes(id), `erc20 must expose ${id}`);
  }
  const erc721 = ids('erc721');
  for (const id of ['deployBurnable', 'deployMintable', 'deployPausable',
    'deployEnumerable', 'deployUriStorage', 'deployAccess',
    // M8 (2026-10-04): manual token ids, fallback image, compiler knobs.
    'deployAutoInc', 'deployImage',
    'deployLanguage', 'deployEvmVersion', 'deployOptimizer', 'deployRuns']) {
    assert.ok(erc721.includes(id), `erc721 must expose ${id}`);
  }
  const erc1155 = ids('erc1155');
  for (const id of ['deployBurnable', 'deployMintable', 'deployPausable', 'deployAccess']) {
    assert.ok(erc1155.includes(id), `erc1155 must expose ${id}`);
  }
  // ERC-1155 has no compiler block yet — it must not CLAIM ids it never
  // renders, or the ID probe would accept a control nothing paints.
  for (const id of ['deployLanguage', 'deployEvmVersion', 'deployOptimizer', 'deployRuns',
    'deployAutoInc', 'deployImage']) {
    assert.ok(!erc1155.includes(id), `erc1155 must not claim ${id} before it renders it`);
  }
  // mint defaults ON for the NFT standards — today's templates always mint.
  assert.equal(getStandard('erc721').fields.find((f) => f.id === 'deployMintable').value, true,
    '721 mintable defaults to the current behaviour (on)');
  assert.equal(getStandard('erc1155').fields.find((f) => f.id === 'deployMintable').value, true,
    '1155 mintable defaults to the current behaviour (on)');
});

test('T2: extraFieldsHtml renders checkboxes as checkboxes', () => {
  const html = extraFieldsHtml('erc20');
  assert.match(html, /type="checkbox"/, 'checkbox fields render type=checkbox');
  assert.match(html, /id="deployMintable"/, 'the mint toggle is in the form');
  assert.match(html, /id="deployCap"/, 'the cap field is in the form');
  // Toggles come AFTER the numeric fields in the markup so the form reads
  // parameters first, features second (OZ layout).
  assert.ok(html.indexOf('id="deployDecimals"') < html.indexOf('id="deployBurnable"'),
    'feature toggles follow the parameters');
});

test('T3: plan carries flags and validates the cap', () => {
  const plan = buildDeployPlan({
    standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1000', decimals: 18,
    cap: '5000', burnable: true, mintable: true, pausable: false,
  });
  assert.deepEqual(plan.flags, {
    burnable: true, mintable: true, pausable: false, permit: false, votes: false,
    // M7 (2026-10-04): Callback / Flash Minting travel with the flags too.
    callback: false, flashmint: false,
    // M9 (2026-10-04): the proxy flags ride along — they change the SOURCE.
    upgradeable: false, proxyType: 'uups',
    cap: '5000', access: 'ownable',
  }, 'flags travel with the plan (permit/votes/access joined 2026-10-04)');
  assert.equal(plan.args.length, 5, 'cap becomes the fifth constructor argument');
  assert.equal(plan.args[4], ethers.parseUnits('5000', 18), 'cap is scaled by decimals like the supply');

  const bare = buildDeployPlan({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1000', decimals: 18 });
  assert.equal(bare.args.length, 4, 'no cap → the constructor stays four arguments');
  assert.deepEqual(bare.flags, {
    burnable: false, mintable: false, pausable: false, permit: false, votes: false,
    callback: false, flashmint: false,
    upgradeable: false, proxyType: 'uups',
    cap: '', access: 'ownable',
  }, 'defaults are all-off, access defaults to Ownable');
  // M7 compiler config: absent fields = wizard defaults, never a throw.
  assert.deepEqual(bare.compiler, { language: 'Solidity', evmVersion: 'osaka', optimizer: true, runs: 200 },
    'no compiler fields on the form → solc defaults (Solidity/osaka/on/200)');

  const err = (input) => assert.throws(() => buildDeployPlan(input), Error);
  err({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1000', decimals: 18, cap: '500' },
    'cap below supply would make the premint revert');
  err({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1000', decimals: 18, cap: '0' });
  err({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1000', decimals: 18, cap: '1.5' });
  err({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1000', decimals: 18, cap: '-5' });
});

test('T4: flags compose the source; all-off ERC-20 keeps no owner (parity)', () => {
  const plain = buildTokenSource('erc20', {});
  // "ownerless" = no owner STATE/MODIFIER; the word "owner" legitimately
  // appears in the standard Approval event parameter.
  assert.ok(!/address public owner|onlyOwner/.test(plain), 'the default ERC-20 must stay ownerless');
  assert.ok(!/function burn\(/.test(plain), 'no burn() unless asked');
  assert.ok(!/function mint\(/.test(plain), 'no mint() unless asked');
  assert.equal(plain, getStandard('erc20').source, 'default output is exactly the shipped template');

  const burn = buildTokenSource('erc20', { burnable: true });
  assert.match(burn, /function burn\(/, 'burnable adds burn()');
  assert.match(burn, /totalSupply -=/, 'burn shrinks totalSupply');

  const mint = buildTokenSource('erc20', { mintable: true });
  assert.match(mint, /onlyOwner/, 'mintable brings owner-gated minting');
  assert.match(mint, /function mint\(/, 'mint() exists');
  assert.match(mint, /address public owner/, 'owner state exists');
  assert.match(mint, /owner = msg.sender/, 'the deployer owns it');

  const pause = buildTokenSource('erc20', { pausable: true });
  assert.match(pause, /whenNotPaused/, 'pausable guards transfers');
  assert.match(pause, /function pause\(/, 'owner can pause');
  assert.ok(/address public owner/.test(pause), 'pausable needs an owner even without mintable');

  const capped = buildTokenSource('erc20', { cap: '5000' });
  assert.match(capped, /uint256 public immutable cap/, 'cap is a real state variable');
  assert.match(capped, /uint256 _cap/, 'the constructor takes the cap');
  assert.match(capped, /_cap >= _supply/, 'the premint must fit under the cap');

  const all = buildTokenSource('erc20', { burnable: true, mintable: true, pausable: true, cap: '5000' });
  for (const pattern of [/function burn\(/, /function mint\(/, /function pause\(/, /immutable cap/]) {
    assert.match(all, pattern, 'all features compose into one source');
  }

  // OZ-parity round 2 (2026-10-04): permit, votes, access mechanics.
  const permit = buildTokenSource('erc20', { permit: true });
  assert.match(permit, /function permit\(/, 'permit adds the EIP-2612 entry point');
  assert.match(permit, /function DOMAIN_SEPARATOR\(/, 'permit needs a domain separator');
  assert.match(permit, /nonces\[owner_\]\+\+/, 'permit consumes a nonce');
  assert.match(permit, /hex"1901"/, 'EIP-712 digest prefix, not a string escape guess');
  assert.ok(!/address public owner|onlyOwner/.test(permit),
    'permit alone does NOT drag an owner in (owner only exists for gated features)');

  const votes = buildTokenSource('erc20', { votes: true });
  assert.match(votes, /function delegate\(/, 'votes adds delegation');
  assert.match(votes, /function getPastVotes\(/, 'votes adds checkpoint reads');
  assert.match(votes, /_moveVotingPower\(from, to, value\)/, 'transfers move voting power');
  assert.ok(!/^\s*import\s/m.test(votes), 'votes source stays self-contained');

  const acl = buildTokenSource('erc20', { mintable: true, pausable: true, access: 'accesscontrol' });
  assert.match(acl, /function grantRole\(/, 'AccessControl can grant');
  assert.match(acl, /modifier onlyRole\(/, 'role modifier replaces onlyOwner');
  assert.ok(!/address public owner/.test(acl), 'no owner var under AccessControl');
  assert.ok(!/modifier onlyOwner\(/.test(acl), 'no onlyOwner modifier under AccessControl');
  assert.match(acl, /onlyRole\(MINTER_ROLE\)/, 'mint is gated by MINTER_ROLE');
  assert.match(acl, /onlyRole\(PAUSER_ROLE\)/, 'pause is gated by PAUSER_ROLE');

  const twoStep = buildTokenSource('erc20', { mintable: true, access: 'ownable2step' });
  assert.match(twoStep, /function acceptOwnership\(/, '2-step needs the accept side');
  assert.match(twoStep, /pendingOwner = to;/, 'transfer parks the new owner');
  assert.ok(!/pendingOwner/.test(buildTokenSource('erc20', { mintable: true })),
    'plain Ownable keeps single-step transfer, no pending state');

  const ownable = buildTokenSource('erc20', { mintable: true });
  assert.match(ownable, /function transferOwnership\(/, 'OZ Ownable ships transferOwnership — Bear never had it before');

  // Every generated source stays import-free (browser solc has no resolver).
  for (const s of [plain, burn, mint, pause, capped, all, permit, votes, acl, twoStep, ownable]) {
    assert.ok(!/^\s*import\s/m.test(s), 'generated sources stay self-contained');
  }
});

test('T5: NFT standards — mint default on, burnable optional', () => {
  const nftPlain = buildTokenSource('erc721', { mintable: true });
  assert.match(nftPlain, /function mint\(/, 'mintable 721 keeps mint');
  const noMint = buildTokenSource('erc721', { mintable: false });
  assert.ok(!/function mint\(/.test(noMint), 'mint can be turned OFF at generation time');
  const burn721 = buildTokenSource('erc721', { mintable: true, burnable: true });
  assert.match(burn721, /function burn\(/, 'burnable 721 adds burn()');
  assert.match(burn721, /emit Transfer\([^)]*address\(0\)/, 'burn emits the zero-address Transfer');

  const burn1155 = buildTokenSource('erc1155', { mintable: true, burnable: true });
  assert.match(burn1155, /function burn\(/, 'burnable 1155 adds burn()');
  assert.match(burn1155, /TransferSingle\(msg\.sender, from, address\(0\)/, '1155 burn reports a zero-address burn');
  const plain1155 = buildTokenSource('erc1155', { mintable: true });
  assert.ok(!/function burn\(/.test(plain1155), 'no burn() unless asked');
  assert.ok(!/^\s*import\s/m.test(nftPlain), 'NFT sources stay self-contained');
});

test('T6: deploy compiles through the builder, not the raw template', () => {
  const deploy = src('js/deploy.js');
  assert.match(deploy, /buildTokenSource\(/, 'doDeploy composes the source from the flags');
  assert.match(deploy, /deployBurnable|deployMintable/, 'the flag inputs are read from the form');
  assert.ok(!/compileContract\(std\.source/.test(deploy), 'raw std.source compilation is gone');
});

test('T7: the real-solc test compiles the feature combinations too', () => {
  const t = src('tests/deploy-contracts.test.js');
  assert.match(t, /buildTokenSource\(/, 'the opt-in solc test must exercise generated sources');
  assert.match(t, /bear=all|all features|burnable: true, mintable: true/i,
    'the solc test compiles an all-features combination');
});

// Live report (2026-10-03): "fitur wizard deploy masih kurang akurat, kasih
// tombol aja jangan kotak". Reference: wizard.openzeppelin.com — every feature
// is a highlighted row in .checkbox-group (global.css), labels are the SHORT
// name (Mintable/Burnable/Pausable) with the description behind a tooltip, and
// the ERC-20 order is Mintable → Burnable → Pausable (ERC20Controls.svelte).
test('T8: feature toggles are pill BUTTONS, not naked checkboxes', () => {
  const css = src('css/cartoon.css');
  const html = extraFieldsHtml('erc20');

  // Each toggle is a pill button that wraps the real input.
  assert.match(html, /class="toggle-pill"[^>]*for="deployBurnable"/,
    'burnable renders as a pill button label');
  assert.match(html, /<input type="checkbox" id="deployBurnable"/,
    'the real input stays in the DOM — deploy.js reads .checked');
  assert.match(html, /class="feature-group"/, 'toggles live in one Features group');

  // OZ ERC-20 feature order: Mintable, Burnable, Pausable.
  assert.ok(html.indexOf('id="deployMintable"') < html.indexOf('id="deployBurnable"'),
    'OZ order: Mintable before Burnable');
  assert.ok(html.indexOf('id="deployBurnable"') < html.indexOf('id="deployPausable"'),
    'OZ order: Burnable before Pausable');

  // Short label on the pill, description behind the tooltip (OZ HelpTooltip).
  assert.match(html, /title="holders can burn their own"/,
    'the parenthetical description moves to the tooltip');
  assert.ok(!/>\s*Burnable \(holders can burn their own\)\s*</.test(html),
    'the pill shows the short name only');

  // The pill lights up when checked — a button, visually.
  assert.match(css, /\.toggle-pill:has\(input:checked\)/, 'checked pill lights up');
  assert.match(css, /\.toggle-pill\s*\{[^}]*border-radius: 999px/,
    'it is a rounded pill, not a square box');
  assert.match(css, /\.toggle-pill input\s*\{[^}]*opacity: 0/,
    'the native checkbox is visually replaced, not display:none (stays focusable)');
});

// ── OZ-parity round 2 (2026-10-04): "fitur di bear tool kurang lengkap"
// (wizard.openzeppelin.com — contracts-wizard README fetched 2026-10-04:
// types erc20/erc721/erc1155/governor/custom/stablecoin/RWA/account,
// access = ownable|ownable2step|accessControl, upgradeable uups/transparent).
// M1 covers token-option parity + access select + export; governor and the
// rest are the next milestones, not silently forgotten.
test('T9: NFT options + ownership select + export row (M1 parity)', () => {
  // ERC-721: pausable, enumerable, uriStorage.
  const e721 = buildTokenSource('erc721', { mintable: true, pausable: true, enumerable: true, uriStorage: true });
  assert.match(e721, /modifier whenNotPaused\(/, '721 pausable adds the guard');
  assert.match(e721, /function tokenOfOwnerByIndex\(/, '721 enumerable exposes owner index');
  assert.match(e721, /function tokenByIndex\(/, '721 enumerable exposes global index');
  assert.match(e721, /uint256 private _nextId;/, 'enumerable splits the id counter from the live count');
  assert.match(e721, /function setTokenURI\(/, 'uriStorage exposes a setter');
  assert.match(e721, /string memory custom = _tokenURIs\[id\]/, 'tokenURI honours the stored URI first');
  assert.match(e721, /function transferFrom\(address from, address to, uint256 id\) public whenNotPaused/,
    'pausable wraps the real transfer, not a side path');
  const plain721 = buildTokenSource('erc721', { mintable: true });
  assert.ok(!/tokenOfOwnerByIndex|whenNotPaused|_tokenURIs/.test(plain721),
    'flag-off 721 stays lean (only the unconditional ownership transfer)');
  assert.match(plain721, /function transferOwnership\(/, '721 owner can always hand over the contract (OZ Ownable)');

  // ERC-1155: pausable.
  const e1155 = buildTokenSource('erc1155', { mintable: true, pausable: true });
  assert.match(e1155, /modifier whenNotPaused\(/, '1155 pausable adds the guard');
  assert.match(e1155, /external whenNotPaused \{/, 'the 1155 transfers are guarded');
  assert.ok(!/whenNotPaused/.test(buildTokenSource('erc1155', { mintable: true })), 'flag-off 1155 unchanged');

  // Ownership select renders as a <select>, one per standard.
  // M7 adds a 4th choice (Managed) plus Language/EVM selects on ERC-20 — so
  // count options INSIDE the access select, not over the whole form.
  const accessOptions = (html) => {
    const m = /<select class="select" id="deployAccess">([\s\S]*?)<\/select>/.exec(html);
    assert.ok(m, 'the access select must render');
    return (m[1].match(/<option/g) || []).length;
  };
  for (const id of ['erc20', 'erc721', 'erc1155']) {
    const html = extraFieldsHtml(id);
    assert.match(html, /<select class="select" id="deployAccess">/, `${id} renders the access select`);
    assert.equal(accessOptions(html), 4, `${id} offers ownable/2step/ACL/Managed`);
    assert.match(html, /value="managed"/, `${id} offers the Managed access choice`);
    assert.match(html, /value="ownable" selected/, 'Ownable is the default selection');
  }
  const html721 = extraFieldsHtml('erc721');
  assert.ok(html721.indexOf('id="deployMintable"') < html721.indexOf('id="deployAccess"'),
    'toggles stay above the access select (features first, mechanics after)');

  // Plan: unknown access falls back; NFT flags carry access + new toggles.
  const bad = buildDeployPlan({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, access: 'evil' });
  assert.equal(bad.flags.access, 'ownable', 'unknown access value falls back to Ownable');
  const nftPlan = buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: 'x', enumerable: true, uriStorage: true, pausable: true, access: 'ownable2step' });
  assert.equal(nftPlan.flags.access, 'ownable2step');
  assert.equal(nftPlan.flags.enumerable, true);
  assert.equal(nftPlan.flags.uriStorage, true);
  assert.ok(nftPlan.summary.some((r) => r.k === 'Access' && r.v === 'Ownable2Step'), 'summary names the access choice');
  assert.ok(nftPlan.summary.some((r) => r.k === 'Features' && /Enumerable/.test(r.v)), 'summary lists new features');
  const noOwnerErc20 = buildDeployPlan({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, access: 'accesscontrol' });
  assert.ok(!noOwnerErc20.summary.some((r) => r.k === 'Access'), 'ownerless ERC-20 must not advertise an access row');

  // Export row: present in the form, filled only after a real compile.
  const view = src('src/views/deploy.jsx');
  assert.match(view, /id="deployExport"/, 'the export row exists in the form');
  assert.equal((view.match(/data-export="/g) || []).length, 3, 'copy source, download .sol, copy ABI');
  const deploy = src('js/deploy.js');
  // M9: the source is built ONCE (compile + export + verify all reuse that
  // string) — `lastBuild = { source, abi: ... }` instead of a second build.
  assert.match(deploy, /lastBuild = \{ source, abi: compiled\.abi/,
    'a successful compile stores what to export');
  assert.match(deploy, /exp\.addEventListener\('click', onExportClick\)/, 'the row is bound once');
  assert.match(deploy, /access: \$\('#deployAccess'\)\?\.value/, 'the access select is read with the other fields');
});

// ── M7 (2026-10-04 report: "upgrade fitur Tools") ──
// ERC-20: symbol auto-kapital, premint presets, Callback / Flash Minting,
// akses Ownable/Roles/Managed, compiler configuration.
test('T10: M7 — symbol uppercase, compiler config, presets, new toggles, Managed', () => {
  // 1. Symbol (auto kapital semua) — normalised ONCE, in the plan.
  const up = buildDeployPlan({ standard: 'erc20', name: 'Bear', symbol: 'bear', supply: '1000', decimals: 18 });
  assert.equal(up.symbol, 'BEAR', 'the plan uppercases the symbol');
  assert.equal(up.args[1], 'BEAR', 'the constructor argument carries the uppercased symbol');
  const mixed = buildDeployPlan({ standard: 'erc721', name: 'Bear', symbol: 'mPx', baseUri: 'x' });
  assert.equal(mixed.symbol, 'MPX', 'NFT standards uppercase too');
  // Uppercasing happens BEFORE validation, so 'bear' is legal and a junk
  // symbol still fails (no regex weakening).
  assert.throws(() => buildDeployPlan({ standard: 'erc20', name: 'B', symbol: 'b ad', supply: '1', decimals: 18 }),
    Error, 'symbols still reject spaces after uppercasing');
  assert.throws(() => buildDeployPlan({ standard: 'erc20', name: 'B', symbol: '', supply: '1', decimals: 18 }),
    Error, 'empty symbol still fails');

  // 2. Compiler configuration — valid values pass through, junk throws.
  const comp = buildDeployPlan({
    standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18,
    language: 'Solidity', evmVersion: 'cancun', optimizer: false, runs: '999',
  });
  assert.deepEqual(comp.compiler, { language: 'Solidity', evmVersion: 'cancun', optimizer: false, runs: 999 },
    'language/evm/optimizer/runs travel to compileContract');
  const compErr = (input) => assert.throws(() => buildDeployPlan(input), Error, 'junk compiler config must throw');
  compErr({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, evmVersion: 'nonsense' });
  compErr({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, runs: 'abc' });
  compErr({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, runs: '-1' });
  compErr({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, runs: '4294967296' });
  compErr({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, language: 'Vyper' });
  // EVM spelling is pinned: ejaan camelCase yang pernah bikin solc nolak.
  assert.throws(() => buildDeployPlan({ standard: 'erc20', name: 'B', symbol: 'S', supply: '1', decimals: 18, evmVersion: 'spuriousdragon' }),
    Error, 'spuriousDragon must be spelled camelCase');

  // 3. Compiler UI: section heading + Language/EVM selects + optimizer pill
  //    sitting ON THE SAME ROW as the runs input.
  const html = extraFieldsHtml('erc20');
  assert.match(html, /wizard-section-title[^>]*>Compiler configuration/, 'the compiler block has its own heading');
  assert.match(html, /id="deployLanguage"/, 'language select renders');
  assert.match(html, /id="deployEvmVersion"/, 'EVM version select renders');
  assert.match(html, /value="osaka" selected/, 'osaka is the default EVM selection');
  assert.match(html, /Default \(osaka\)/, 'the default option is labelled as the default');
  assert.match(html, /id="deployOptimizer"/, 'the optimizer toggle renders');
  assert.match(html, /id="deployRuns"/, 'the runs input renders');
  assert.ok(html.indexOf('id="deployOptimizer"') < html.indexOf('id="deployRuns"'),
    'the optimizer pill is rendered inside the runs row');
  assert.match(html, /class="field-inline"/, 'optimizer + runs share one row');
  const nftHtml = extraFieldsHtml('erc721');
  assert.match(nftHtml, /wizard-section-title[^>]*>Compiler configuration/,
    'M8: the ERC-721 wizard carries the same compiler block as ERC-20');
  assert.ok(!/wizard-section-title[^>]*>Compiler configuration/.test(extraFieldsHtml('erc1155')),
    'the ERC-1155 wizard does not advertise a compiler block it cannot deliver');

  // 4. Premint presets render as clickable pills (delegated at the container).
  for (const [label, value] of [['100M', '100000000'], ['500M', '500000000'], ['1B', '1000000000'], ['100B', '100000000000']]) {
    assert.match(html, new RegExp(`data-preset="${value}"[^>]*>${label}<`), `the ${label} preset pill renders`);
  }
  const deploy = src('js/deploy.js');
  assert.match(deploy, /extraBox\.addEventListener\('click'/,
    'preset clicks are delegated at the container (renderDeployExtra rewrites innerHTML)');
  assert.match(deploy, /sym\.addEventListener\('input'/, 'the symbol field uppercases as you type');
  assert.match(deploy, /\.\.\.plan\.compiler/, 'the plan compiler options are spread into compileContract');
  assert.match(deploy, /callback: \$\('#deployCallback'\)\?\.checked/, 'the Callback toggle is read');
  assert.match(deploy, /flashmint: \$\('#deployFlashMint'\)\?\.checked/, 'the Flash Minting toggle is read');

  // 5. Callback (ERC-1363) and Flash Minting (ERC-3156) generate real code.
  const cb = buildTokenSource('erc20', { mintable: true, callback: true });
  assert.match(cb, /function transferAndCall\(address to, uint256 value, bytes calldata data\)/,
    'callback adds transferAndCall');
  assert.match(cb, /onTokenTransfer\(msg.sender, value, data\)/, 'the receiver hook is actually called');
  assert.ok(cb.indexOf('interface IERC1363Receiver') > cb.lastIndexOf('function transferAndCall'),
    'the receiver interface lives OUTSIDE the contract');
  assert.ok(!/interface IERC1363Receiver/.test(buildTokenSource('erc20', { mintable: true })),
    'flag-off does not ship the interface');
  const fm = buildTokenSource('erc20', { mintable: true, flashmint: true });
  assert.match(fm, /function flashLoan\(address receiver, address token, uint256 amount, bytes calldata data\)/,
    'flashmint adds flashLoan');
  assert.match(fm, /function maxFlashLoan\(address token\)/, 'flashmint adds maxFlashLoan');
  assert.match(fm, /function flashFee\(address token/, 'flashmint adds flashFee');
  assert.match(fm, /ERC3156FlashBorrower\.onFlashLoan/, 'the ERC-3156 success selector is the spec keccak');
  assert.ok(fm.indexOf('interface IERC3156Borrower') > fm.indexOf('function flashLoan'),
    'the borrower interface lives OUTSIDE the contract');
  const fmCap = buildTokenSource('erc20', { mintable: true, flashmint: true, cap: '1000' });
  assert.match(fmCap, /cap exceeded/, 'a capped token never flashes past its cap');
  assert.ok(!/cap exceeded/.test(fm), 'an uncapped token must not grow a cap check');

  // 6. Managed access, all three standards.
  for (const std of ['erc20', 'erc721', 'erc1155']) {
    const man = buildTokenSource(std, { mintable: true, pausable: true, access: 'managed' });
    assert.match(man, /function beginDefaultAdminTransfer\(/, `${std}: managed can propose an admin`);
    assert.match(man, /function acceptDefaultAdminTransfer\(/, `${std}: managed accepts in a second tx`);
    assert.match(man, /modifier onlyDefaultAdmin\(/, `${std}: managed gates on defaultAdmin`);
    assert.match(man, /address public defaultAdmin;/, `${std}: managed tracks the admin`);
    assert.ok(!/function transferOwnership\(/.test(man), `${std}: managed does NOT offer plain transferOwnership`);
    assert.ok(!/address public owner;/.test(man), `${std}: managed has no owner state`);
    // Roles stay role-gated (managed = roles + admin handover, not Ownable).
    assert.match(man, /function grantRole\(/, `${std}: managed can grant MINTER/PAUSER`);
    assert.match(man, /onlyRole\(MINTER_ROLE\)/, `${std}: minting stays role-gated`);
    // The two-step handover must be usable by a non-admin acceptor.
    assert.match(man, /require\(msg\.sender == pendingDefaultAdmin/, `${std}: accept is for the pending admin only`);
    // Proposal must be admin-only and reject the zero address.
    assert.match(man, /function beginDefaultAdminTransfer\(address newAdmin\) external onlyDefaultAdmin/,
      `${std}: only the current admin may propose`);
    assert.match(man, /require\(newAdmin != address\(0\)/, `${std}: zero-address proposals are rejected`);
  }
  // Managed must not be a silent alias: acl keeps its own shape.
  const acl20 = buildTokenSource('erc20', { mintable: true, access: 'accesscontrol' });
  assert.ok(!/beginDefaultAdminTransfer/.test(acl20), 'plain Roles keeps grant-based admin (no two-step)');
  assert.match(acl20, /onlyRole\(DEFAULT_ADMIN_ROLE\)/, 'plain Roles gates admin actions on the admin role');
});

// ── M8 (2026-10-04): ERC-721 token ids + fallback image ──
test('T11: M8 — manual token ids, fallback image metadata, 721 compiler block', () => {
  // 1. auto-inc is the DEFAULT — the shipped behaviour must not move.
  const on = buildTokenSource('erc721', { mintable: true });
  assert.match(on, /function mint\(address to\) external onlyOwner returns \(uint256\)/,
    'default mint keeps the auto-increment signature');
  assert.match(on, /uint256 id = \+\+totalSupply;/, 'default mint still hands out ids');
  assert.ok(!/id already minted/.test(on), 'the duplicate guard belongs to manual ids only');
  // Explicit true (the checkbox is checked) must equal the default.
  assert.equal(buildTokenSource('erc721', { mintable: true, autoInc: true }), on,
    'autoInc:true is byte-identical to leaving the flag out');

  // 2. autoInc OFF → mint(to, id) with zero + duplicate rejection.
  const off = buildTokenSource('erc721', { mintable: true, autoInc: false });
  assert.match(off, /function mint\(address to, uint256 id\) external onlyOwner returns \(uint256\)/,
    'manual mode takes the id from the caller');
  assert.match(off, /require\(id > 0, "ERC721: id must be greater than 0"\)/, 'zero ids are rejected');
  assert.match(off, /require\(_owners\[id\] == address\(0\), "ERC721: id already minted"\)/,
    'duplicate ids are rejected');
  assert.ok(!/\+\+totalSupply/.test(off), 'totalSupply is no longer a counter');
  assert.match(off, /totalSupply \+= 1;/, 'manual mint still counts the supply');

  // 3. Combinations the wizard can actually emit — enumerable flips the rewrite.
  const enurOff = buildTokenSource('erc721', { mintable: true, enumerable: true, autoInc: false });
  assert.match(enurOff, /function mint\(address to, uint256 id\)/, 'manual + enumerable keeps the caller id');
  assert.ok(!/_nextId/.test(enurOff), 'the unused id counter is removed, not left dead in the source');
  assert.match(enurOff, /function tokenByIndex\(/, 'manual + enumerable keeps the index API');
  assert.ok(!/\+\+_nextId/.test(enurOff), 'no auto-increment survives in manual mode');
  // AccessControl/Managed rewrite the MINT SIGNATURE — manual ids must still land.
  for (const access of ['accesscontrol', 'managed']) {
    const src = buildTokenSource('erc721', { mintable: true, pausable: true, access, autoInc: false });
    assert.match(src, /function mint\(address to, uint256 id\) external onlyRole\(MINTER_ROLE\)/,
      `${access}: role-gated manual mint keeps BOTH the role and the id`);
    assert.ok(!/\+\+totalSupply|\+\+_nextId/.test(src), `${access}: no auto-increment left`);
  }

  // 4. Burning in manual mode shrinks the live count (it is not a counter).
  const burnOff = buildTokenSource('erc721', { mintable: true, burnable: true, autoInc: false });
  assert.match(burnOff, /unchecked \{ totalSupply -= 1; \}/, 'manual burn decrements totalSupply');
  assert.ok(!/next-id counter/.test(burnOff), 'the counter comment is wrong once ids are manual');
  const burnOn = buildTokenSource('erc721', { mintable: true, burnable: true });
  assert.match(burnOn, /totalSupply doubles as the next-id counter/, 'auto-inc burn behaviour is unchanged');

  // 5. Fallback image: 4th constructor argument ONLY when set.
  const noImage = buildTokenSource('erc721', { mintable: true });
  assert.ok(!/_image|function _base64|string public image/.test(noImage),
    'no image → the shipped 3-arg template is untouched');
  const img = buildTokenSource('erc721', { mintable: true, image: 'https://example.com/bear.png' });
  assert.match(img, /constructor\(string memory _name, string memory _symbol, string memory _baseURI, string memory _image\)/,
    'the image rides in as the fourth constructor argument');
  assert.match(img, /string public image;/, 'the URL is readable on-chain');
  assert.match(img, /function _base64\(bytes memory data\) internal pure returns \(string memory\)/,
    'base64 encoding is self-contained (no import)');
  assert.match(img, /if \(bytes\(baseURI\)\.length == 0\)/, 'the fallback only fires when Base URI is empty');
  assert.match(img, /data:application\/json;base64,/, 'the fallback is a data: JSON document');
  assert.match(img, /'{"name":"', name, ' #', _toString\(id\), '","image":"', image, '"}'/,
    'the metadata names the token and carries the image URL');
  assert.match(img, /return string\(abi\.encodePacked\(baseURI, _toString\(id\)\)\);/,
    'a set Base URI still wins over the fallback');
  // uriStorage keeps precedence: its custom-URI early return stays first.
  const uriImg = buildTokenSource('erc721', { mintable: true, image: 'https://x/y.png', uriStorage: true, baseUri: 'ipfs://z/' });
  assert.ok(uriImg.indexOf('if (bytes(custom).length > 0) return custom;') < uriImg.indexOf('if (bytes(baseURI).length == 0)'),
    'a stored per-token URI outranks the image fallback');

  // 6. Plan: the image travels as the 4th arg, and junk is rejected.
  const p = buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: 'ipfs://x/', image: 'https://x/y.png' });
  assert.deepEqual(p.args, ['B', 'S', 'ipfs://x/', 'https://x/y.png'], 'four arguments when an image is set');
  assert.equal(p.flags.image, 'https://x/y.png', 'the image travels in the flags');
  const pNoImg = buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: 'ipfs://x/' });
  assert.deepEqual(pNoImg.args, ['B', 'S', 'ipfs://x/'], 'three arguments when it is not');
  assert.equal(pNoImg.flags.autoInc, true, 'auto-increment defaults ON in the plan');
  const pManual = buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: '', autoInc: false });
  assert.equal(pManual.flags.autoInc, false, 'unchecking the pill flips the flag');
  assert.ok(pManual.summary.some((r) => r.k === 'Features' && /Manual ids/.test(r.v)),
    'the summary says the ids are manual');
  assert.throws(() => buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: '', image: 'https://x/a"b.png' }),
    Error, 'a quote in the URL would break the generated JSON — rejected up front');
  assert.throws(() => buildDeployPlan({ standard: 'erc721', name: 'B', symbol: 'S', baseUri: '', image: 'https://x/' + 'a'.repeat(513) }),
    Error, 'oversized image URLs are rejected (contract size)');

  // 7. Wiring: deploy.js reads both fields.
  const deploy = src('js/deploy.js');
  assert.match(deploy, /autoInc: \$\('#deployAutoInc'\)\?\.checked/, 'the auto-inc pill is read');
  assert.match(deploy, /image: \$\('#deployImage'\)\?\.value/, 'the image field is read');
});
