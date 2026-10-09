// Bear Tool — tests/add-token-checksum.test.js
//
// Live E2E 2026-10-09 (fork mainnet): pasting the DAI address with one letter's
// case wrong (…094c44… vs EIP-55's …094C44…) made ethers v6 throw
// "bad address checksum" BEFORE any network call. soft() swallowed it into a
// null, so the probe reported the contract verdict instead of the real one:
// "No ERC-20 name/symbol found at that address on this network" — a confident
// answer about the wrong thing. The same bytes typed in lowercase probed fine
// (DAI · 18 decimals), because case carries no data beyond the typo check.
//
// Gates: both probe and save build the contract from the literal hex
// (toLowerCase), and what gets stored is the checksummed form of those bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const app = code('../js/app.js');

test('detect() probes with the literal hex (no EIP-55 throw before the call)', () => {
  assert.match(app, /new ethers\.Contract\(addr\.toLowerCase\(\), ERC20, provider\)/,
    'a case-only checksum mismatch must not be swallowed as "no ERC-20 here"');
});

test('save() builds from the literal hex too, via getAddress normalization', () => {
  assert.match(app, /ethers\.getAddress\(addr\.toLowerCase\(\)\)/,
    'save must re-derive the checksum from the bytes, not trust the typed case');
  assert.match(app, /new ethers\.Contract\(normalized, ERC20, provider\)/);
});

test('stored token address is the normalized checksummed form', () => {
  assert.match(app, /tokens\.push\(\{ address: normalized,/);
  assert.match(app, /persistCustomToken\(\{ address: normalized,/);
  // The raw, possibly-bad-case `addr` must not leak into storage.
  assert.ok(!/tokens\.push\(\{ address: addr,/.test(app),
    'storing the typed case would fork the duplicate check below it');
});
