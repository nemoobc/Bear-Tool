// The swap test could not fail.
//
// fork-swap.test.js read KNOWN_TOKENS[network].USDC while the table's keys are
// lowercase. `stable` was therefore always undefined, both venue cases skipped
// with "no known stable token", and the file was green on every network without
// having executed a single swap — Uniswap V2 included. The overclaim it created
// was reported for a full round before anyone asked what a green run of that
// file actually proved.
//
// These detectors exist so a green fork-swap run can never again mean "nothing
// happened". They are deliberately cheap and deterministic: no anvil, no
// network, no fork. A detector that needs a chain to prove the fixture is
// intact is a detector that does not run where the fixture is edited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { KNOWN_TOKENS, knownStable, knownWeth, MAINNETS_WITH_TOKENS } =
  await import(pathToFileURL(path.join(here, 'fork', 'fork-helper.mjs')).href);

test('the swap test resolves its stablecoin through the helper, not by hand', () => {
  const src = readFileSync(path.join(here, 'fork', 'fork-swap.test.js'), 'utf8');
  // The exact expression that made the file unfailable. If this comes back, the
  // helper is being bypassed and the casing bug is one rename away again.
  assert.doesNotMatch(src, /KNOWN_TOKENS\?\.\[[^\]]+\]\?\.(USDC|USDT|WETH)\b/,
    'fork-swap harus memakai knownStable()/knownWeth(), bukan membaca KNOWN_TOKENS langsung');
  assert.doesNotMatch(src, /KNOWN_TOKENS\[[^\]]+\]\.(usdc|usdt|weth)\b/,
    'fork-swap tidak boleh accessing kunci token langsung');
});

test('every mainnet in the token table yields a stable through knownStable()', () => {
  // The exact set, not a minimum. Seventeen networks carry known tokens and
  // six are testnets with none (plus blast, a mainnet whose only dollar token
  // is USDB — a null row, not a missing one); a count of "at least N" would
  // keep passing after a network was dropped, which is the failure this
  // detector exists to catch. Listing them makes a drop visible as a diff.
  const expected = [
    'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'sepolia',
    'avalanche', 'gnosis', 'celo', 'sonic', 'linea', 'scroll', 'mantle',
    'zksync', 'unichain', 'worldchain'
  ];
  assert.deepEqual([...MAINNETS_WITH_TOKENS].sort(), [...expected].sort(),
    'jaringan yang punya token berubah — tabel atau daftarnya harus diperbarui dua-duanya');
  for (const name of MAINNETS_WITH_TOKENS) {
    const stable = knownStable(name);
    assert.match(stable ?? '', /^0x[0-9a-fA-F]{40}$/,
      `${name} tidak punya token stabil yang bisa dipakai — swap akan skip`);
  }
});

test('the testnets in the table carry nulls, not missing keys', () => {
  // Null is a claim: "this network has no token we know". A missing key is
  // silence, and silence is what made the original bug invisible.
  const testnets = Object.keys(KNOWN_TOKENS).filter((n) => !MAINNETS_WITH_TOKENS.includes(n));
  assert.ok(testnets.length >= 5, `hanya ${testnets.length} testnet terdaftar`);
  for (const name of testnets) {
    assert.equal(KNOWN_TOKENS[name].weth, null, `${name} ada di daftar testnet — harus null, bukan alamat`);
    assert.equal(knownStable(name), null, `${name} tidak boleh mengembalikan token`);
  }
});

test('every mainnet in the token table yields a wrapped native through knownWeth()', () => {
  for (const name of MAINNETS_WITH_TOKENS) {
    assert.match(knownWeth(name) ?? '', /^0x[0-9a-fA-F]{40}$/,
      `${name} tidak punya WETH di tabel — swap ke pair stable tidak mungkin`);
  }
});

test('a network with no token row is an error, not an empty answer', () => {
  // "I have no data for this network" and "I looked it up wrong" looked identical
  // to the caller, which is how the original bug hid. A typo in a network name
  // must now be loud.
  assert.throws(() => knownStable('polygonn'), /tidak dikenal/,
    'ejaan salah pada nama jaringan harus melempar, bukan mengembalikan undefined');
  assert.throws(() => knownWeth('ethereum-typo'), /tidak dikenal/);
});

test('testnets are listed as having no token rather than missing from the table', () => {
  // A missing row would make MAINNETS_WITH_TOKENS silently shorter, so a network
  // dropped by accident reads as "this chain has no tokens" — true, and wrong.
  for (const name of Object.keys(KNOWN_TOKENS)) {
    assert.ok('weth' in KNOWN_TOKENS[name], `${name} tidak punya kunci weth`);
    assert.ok('usdc' in KNOWN_TOKENS[name], `${name} tidak punya kunci usdc`);
  }
});

test('the token table keys are lowercase, which is the whole point', () => {
  for (const [name, row] of Object.entries(KNOWN_TOKENS)) {
    for (const key of Object.keys(row)) {
      assert.equal(key, key.toLowerCase(),
        `kunci token pada ${name} harus huruf kecil: ${key}`);
    }
  }
});
