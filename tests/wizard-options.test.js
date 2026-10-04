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
  for (const id of ['deployCap', 'deployBurnable', 'deployMintable', 'deployPausable']) {
    assert.ok(erc20.includes(id), `erc20 must expose ${id}`);
  }
  const erc721 = ids('erc721');
  assert.ok(erc721.includes('deployBurnable'), 'erc721 must expose deployBurnable');
  assert.ok(erc721.includes('deployMintable'), 'erc721 must expose deployMintable');
  const erc1155 = ids('erc1155');
  assert.ok(erc1155.includes('deployBurnable'), 'erc1155 must expose deployBurnable');
  assert.ok(erc1155.includes('deployMintable'), 'erc1155 must expose deployMintable');
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
  assert.deepEqual(plan.flags, { burnable: true, mintable: true, pausable: false, cap: '5000' },
    'flags travel with the plan');
  assert.equal(plan.args.length, 5, 'cap becomes the fifth constructor argument');
  assert.equal(plan.args[4], ethers.parseUnits('5000', 18), 'cap is scaled by decimals like the supply');

  const bare = buildDeployPlan({ standard: 'erc20', name: 'Bear', symbol: 'BEAR', supply: '1000', decimals: 18 });
  assert.equal(bare.args.length, 4, 'no cap → the constructor stays four arguments');
  assert.deepEqual(bare.flags, { burnable: false, mintable: false, pausable: false, cap: '' },
    'defaults are all-off');

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
  // Every generated source stays import-free (browser solc has no resolver).
  for (const s of [plain, burn, mint, pause, capped, all]) {
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
