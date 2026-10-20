// Bear Tool — rescue-helper-nft.test.js
//
// The ERC-721 rescue path was broken in the shipped source and the suite was
// green while it was broken.
//
// abi.encodeWithSignature("transferFrom", address(this), SAFE, ids[i]) hashes
// the string EXACTLY as given — it does not append the argument types — so it
// produced the selector 0x0c41b033 (keccak of the bare word "transferFrom").
// No ERC-721 has that selector: the call fell through to the token's
// fallback and the sweep reverted with "ERC721 transfer failed" — every
// single time, on every NFT.
//
// Measured on anvil (prague), before the fix: the delegated type-4 estimate
// of the NFT sweep reverted, and the real tx reverted with the same reason.
// After the fix (the source shipped in js/eip7702-tools.js, compiled as-is):
// the sweep succeeds and the NFTs land in the SAFE.
//
// This gate pins the fix at the level where it broke: the selector the
// helper actually calls. The expected value is DERIVED from the canonical
// ABI signature, so renaming the constant or re-introducing the bare-name
// encode fails the gate instead of shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ethers } from 'ethers';

const toolsSrc = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
const m = toolsSrc.match(/const RESCUE_SOURCE = `([\s\S]*?)`;\n/);
assert.ok(m, 'RESCUE_SOURCE must exist in js/eip7702-tools.js');
const RESCUE_SOURCE = m[1];

// The gates look at CODE, not at prose: a comment that names the old broken
// call must not fail the suite, and a comment must never be able to satisfy
// one either. So the Solidity comments are stripped before anything is
// matched.
function stripSolidityComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
const RESCUE_CODE = stripSolidityComments(RESCUE_SOURCE);

// The canonical ERC-721 transferFrom selector, derived — not hard-coded.
const TRANSFER_FROM = ethers.id('transferFrom(address,address,uint256)').slice(0, 10);
const ERC20_TRANSFER = ethers.id('transfer(address,uint256)').slice(0, 10);

test('the ERC-721 sweep calls the canonical transferFrom selector', () => {
  assert.notEqual(TRANSFER_FROM, '0x0c41b033',
    'the bare-name hash of "transferFrom" is exactly the bug this gate exists for');
  // The ERC-721 line must use the canonical selector.
  const erc721Line = RESCUE_CODE.split('\n').find((l) => l.includes('function rescueERC721'));
  assert.ok(erc721Line, 'rescueERC721 must exist in RESCUE_SOURCE');
  assert.ok(erc721Line.includes(`encodeWithSelector(${TRANSFER_FROM}`),
    `the NFT sweep must call ${TRANSFER_FROM} (transferFrom(address,address,uint256))`);
  assert.doesNotMatch(RESCUE_CODE, /encodeWithSignature\(\s*["']transferFrom["']/,
    'abi.encodeWithSignature hashes the string as given — it must not be used for a selector');
});

test('the ERC-20 sweep still calls the canonical transfer selector', () => {
  const erc20Line = RESCUE_CODE.split('\n').find((l) => l.includes('function rescueERC20('));
  assert.ok(erc20Line, 'rescueERC20 must exist in RESCUE_SOURCE');
  assert.ok(erc20Line.includes(`encodeWithSelector(${ERC20_TRANSFER}`),
    `the ERC-20 sweep must call ${ERC20_TRANSFER} (transfer(address,uint256))`);
});

test('the helper reports the version the reuse gate expects', () => {
  const version = RESCUE_CODE.match(/function version\(\) external pure returns \(string memory\) \{ return "([^"]+)"; \}/);
  assert.ok(version, 'the helper must expose version()');
  const gate = toolsSrc.match(/const RESCUE_HELPER_VERSION = '([^']+)'/);
  assert.ok(gate, 'RESCUE_HELPER_VERSION must exist');
  assert.equal(version[1], gate[1],
    'the compiled helper version and the reuse gate must agree, or an old helper is reused');
});

test('an NFT sweep never reuses a helper without that version', () => {
  assert.match(toolsSrc, /type !== 'erc721' \|\| item\.version === RESCUE_HELPER_VERSION/,
    'the registry predicate must refuse an NFT sweep on an old helper');
  // …and the registry must record the version it deployed.
  assert.match(toolsSrc, /saveDeployed\('rescue', addr, \{[^}]*version: RESCUE_HELPER_VERSION/,
    'a deployed rescue helper must be recorded with its version');
});
