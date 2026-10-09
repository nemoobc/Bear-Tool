// Bear Tool — tests/nft-import-feedback.test.js
//
// The NFT import button validated silently: aria-invalid was set (assistive
// tech only — cartoon.css has no styling for it) and nothing else happened.
// A sighted user saw the click land and the field just sit there — the exact
// "button does nothing" class. The deploy form next door answers with a
// toast ("Enter a token name"); this pins the import row doing the same.
//
// Source gate (device from eip7702-settings-ui.test.js) — found by live E2E
// 2026-10-09 (empty submit and "not-an-address" both produced zero feedback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const nft = code('../js/nft.js');
const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');

test('nft.js imports toast from ui.js', () => {
  assert.match(nft, /import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*'\.\/ui\.js'/,
    'the import handler needs toast() — ui.js exports it');
});

test('invalid NFT import address raises a visible toast', () => {
  const invalidBranch = nft.match(/if\s*\(!ethers\.isAddress\(addr\)\)\s*\{[\s\S]{0,400}?\}/);
  assert.ok(invalidBranch, 'the isAddress guard must exist');
  assert.match(invalidBranch[0], /toast\(/,
    'the rejection must be VISIBLE (toast), not only aria-invalid');
});

test('empty address gets its own message, distinct from malformed', () => {
  // Both paths must talk: empty ("Enter a collection…") vs malformed
  // ("Enter a valid contract address…") — one lumped message leaves the
  // empty case vague.
  assert.match(nft, /Enter a collection contract address/);
  assert.match(nft, /Enter a valid contract address/);
});

test('aria-invalid stays for assistive tech', () => {
  assert.match(nft, /setAttribute\('aria-invalid',\s*'true'\)/,
    'the toast is for sighted users; aria-invalid remains the a11y channel');
});

test('cartoon.css still has no aria-invalid styling (why the toast is required)', () => {
  // Guards the premise: IF someone later styles aria-invalid prominently,
  // the toast assertion above may be revisited — until then this documents
  // that aria-invalid alone was invisible.
  assert.ok(!css.includes('aria-invalid'),
    'cartoon.css gained aria-invalid styling — revisit the silent-fail premise');
});
