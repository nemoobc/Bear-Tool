// Bear Tool — catalog-match.test.js
// The address bar must not navigate on noise.
//
// Typing into the in-app browser's address bar and pressing Enter goes through
// navigate(), which for anything that is not a URL falls into the catalogue search:
//
//     const q = verdict.url || '';
//     const hit = catalog.find((d) => (d.name + ' ' + d.category)
//       .toLowerCase().includes(q.toLowerCase()));
//     if (hit) return navigate(hit.url, hit.name);
//
// `includes` on an empty needle is true for every string, and on a one-character
// needle it is true for nearly every name. Measured against the shipped catalogue:
//
//     "a"   -> navigates to Uniswap
//     "e"   -> navigates to Curve
//     "o"   -> navigates to Compound
//     "x"   -> navigates to Etherscan
//     "  "  -> navigates to Uniswap
//
// That last one is the worst: classifyInput("  ") returns {kind:'search',
// reason:'empty'} — the classifier explicitly says there is no query — and the
// caller ignores the reason and navigates anyway. Pressing Enter in an empty
// address bar drops the user inside a dApp browser, which is the one surface in
// this app that can ask for a signature. It is not an exploit, the dApp still has
// to request and the user still has to approve, but a wallet that jumps somewhere
// unbidden on a stray keystroke is a wallet behaving like a toy.
//
// The fix is to make the rule a function so it can be pinned. Substring matching is
// kept for longer queries — "compound" should still find Compound — but an empty or
// one-character query is noise, and an exact name must beat a substring that
// happens to occur inside some other entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCatalog } from '../js/dapp-safety.js';

const CATALOG = [
  { name: 'Uniswap', category: 'dex', url: 'https://app.uniswap.org' },
  { name: 'Curve', category: 'dex', url: 'https://curve.fi' },
  { name: 'Compound', category: 'lending', url: 'https://app.compound.finance' },
  { name: 'Aave', category: 'lending', url: 'https://app.aave.com' },
  { name: 'Etherscan', category: 'tools', url: 'https://etherscan.io' },
];

test('an empty query navigates nowhere', () => {
  for (const q of ['', ' ', '   ', '\t', '\n', null, undefined]) {
    assert.equal(matchCatalog(CATALOG, q), null,
      `${JSON.stringify(q)} must not pick a dApp — this is Enter in an empty address bar`);
  }
});

test('a single character is noise, not a choice', () => {
  for (const q of ['a', 'e', 'o', 'x', 's', 'n', 'i', 'r', '.', ',']) {
    assert.equal(matchCatalog(CATALOG, q), null,
      `${JSON.stringify(q)} is one keystroke on the way to something else, and must not navigate`);
  }
});

test('a real name still finds its dApp', () => {
  assert.equal(matchCatalog(CATALOG, 'aave')?.name, 'Aave');
  assert.equal(matchCatalog(CATALOG, 'Aave')?.name, 'Aave');
  assert.equal(matchCatalog(CATALOG, '  compound  ')?.name, 'Compound');
  assert.equal(matchCatalog(CATALOG, 'curve')?.name, 'Curve');
});

test('a category is still searchable once there is something to search for', () => {
  // Substring matching on the category is kept — "lending" is how a person looks
  // for Aave or Compound. Which entry answers is the catalogue's business; the
  // requirement is only that a two-letter-or-longer category query finds something
  // rather than nothing.
  assert.equal(matchCatalog(CATALOG, 'lending')?.name, 'Compound',
    'lending is Compound\'s category in this fixture, so it is the one that should answer');
  assert.equal(matchCatalog(CATALOG, 'dex')?.name, 'Uniswap',
    'and dex is Uniswap\'s — the first entry carrying it, which is fine at this length');
});

test('an exact name beats an entry that merely contains it', () => {
  // "AAVE" as a substring occurs inside nothing here, but the point stands for a
  // catalogue where one name is a substring of another: the exact one wins.
  const overlapping = [
    { name: 'Swap', category: 'dex', url: 'https://swap.example' },
    { name: 'CoW Swap', category: 'dex', url: 'https://cow.example' },
  ];
  assert.equal(matchCatalog(overlapping, 'swap')?.name, 'Swap');
});

test('an exact match is preferred over a prefix match', () => {
  const overlapping = [
    { name: 'CoW Swap', category: 'dex', url: 'https://cow.example' },
    { name: 'Swap', category: 'dex', url: 'https://swap.example' },
  ];
  assert.equal(matchCatalog(overlapping, 'swap')?.name, 'Swap',
    'the catalogue order must not decide which dApp opens');
});

test('nothing matches means nothing opens', () => {
  assert.equal(matchCatalog(CATALOG, 'zzzzz'), null);
  assert.equal(matchCatalog([], 'aave'), null);
});
