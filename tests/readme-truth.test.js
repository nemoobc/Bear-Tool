// Bear Tool — readme-truth.test.js
//
// The README and the GitHub repo description are the first thing a visitor
// reads, and both drifted from the code for real: commit ebc2c8a deleted
// BTC/SOL/XRP sending outright (16 files), and the README intro plus the repo
// description kept selling "native Bitcoin, Solana and XRP sending" for days.
// The structure tree silently lost 11 modules the same way. Prose is written
// for humans, but every NUMBER and NAME it prints must be graded against the
// code at test time — the same rule as dapp-catalog-truth, applied to the rest
// of the document.
//
// The repo description lives on GitHub and cannot be read offline, so it is
// not gated here; it is rewritten from the same facts this file checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// network.js touches localStorage at import time (testnet-mode preference).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const { NETWORKS, CHAIN_PRESETS } = await import(join(root, 'js/network.js'));

test('every js/ module is named in the README structure tree', () => {
  const modules = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js'));
  const missing = modules.filter((f) => !readme.includes(f));
  assert.deepEqual(missing, [],
    `README structure tree lost these modules: ${missing.join(', ')}`);
});

test('the intro network claim equals the shipped network list (HUKUM 10)', () => {
  const claim = readme.match(/\*\*(\d+) EVM networks\*\* built in — (\d+) mainnet \+ (\d+) testnet/);
  assert.ok(claim, 'the intro must state "<N> EVM networks built in — <m> mainnet + <t> testnet"');
  const mainnets = NETWORKS.filter((n) => n.type === 'mainnet').length;
  const testnets = NETWORKS.filter((n) => n.type === 'testnet').length;
  assert.equal(Number(claim[1]), NETWORKS.length,
    `README claims ${claim[1]} built-in networks, js/network.js ships ${NETWORKS.length}`);
  assert.equal(Number(claim[2]), mainnets, `README claims ${claim[2]} mainnet, code has ${mainnets}`);
  assert.equal(Number(claim[3]), testnets, `README claims ${claim[3]} testnet, code has ${testnets}`);
});

test('the Add-Network preset claim equals CHAIN_PRESETS, name for name', () => {
  const line = readme.split('\n').find((l) => l.includes('further EVM chains'));
  assert.ok(line, 'the Networks feature row must mention the Add-Network presets');
  const claim = line.match(/(\d+) further EVM chains \(([^)]+)\)/);
  assert.ok(claim, 'the preset claim must read "<N> further EVM chains (Name, Name, ...)"');
  assert.equal(Number(claim[1]), CHAIN_PRESETS.length,
    `README claims ${claim[1]} presets, js/network.js ships ${CHAIN_PRESETS.length}`);
  const named = claim[2].split(',').map((s) => s.trim());
  const shipped = CHAIN_PRESETS.map((p) => p.name);
  assert.deepEqual(named, shipped, 'preset names drifted between README and CHAIN_PRESETS');
});

test('the e2e spec count claim equals the spec files on disk', () => {
  const claim = readme.match(/The (\d+) specs are driven/);
  assert.ok(claim, 'the Test section must state how many browser specs exist');
  const specs = readdirSync(join(root, 'tests/e2e')).filter((f) => f.endsWith('.spec.js'));
  assert.equal(Number(claim[1]), specs.length,
    `README claims ${claim[1]} specs, tests/e2e holds ${specs.length}`);
});

test('the README never sells a chain family the wallet does not ship', () => {
  // ebc2c8a removed BTC/SOL/XRP entirely; a sentence pairing them with
  // "sending" is the exact shape of the stale claim that survived that commit.
  const sales = readme.match(/(Bitcoin|Solana|XRP)[^.\n]{0,60}send|send[^.\n]{0,60}(Bitcoin|Solana|XRP)/gi) || [];
  assert.deepEqual(sales, [],
    `README advertises non-EVM sending that js/network.js cannot back: ${sales.join(' | ')}`);
  for (const n of NETWORKS) {
    assert.ok(n.type === 'mainnet' || n.type === 'testnet',
      `${n.id} has type ${n.type} — the network list is EVM-only now, say so in the README`);
  }
});
