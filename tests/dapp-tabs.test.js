// tests/dapp-tabs.test.js
// DApp browser: OKX-style tab strip (kartu per tab with close button), wired
// to the native plugin (openNativeTab / closeNativeTab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const DAPP_KEYS = [
  'dapp.browser.label', 'dapp.tab.new', 'dapp.tab.close', 'dapp.tab.closeAria',
  'dapp.tab.lastAccessed', 'dapp.tab.empty.title', 'dapp.tab.empty.desc',
  'dapp.address.placeholder', 'dapp.address.go', 'dapp.tab.title', 'dapp.tab.url',
  'dapp.tab.switch', 'dapp.native.toolbarAria',
];

test('dApp browser tab strip: closeNativeTab exposed + renderTabsEntry builds the strip', () => {
  const nd = read('../js/native-dapp.js');
  assert.match(nd, /export async function closeNativeTab\(index\)/,
    'closeNativeTab exposed from native-dapp.js');
  assert.match(nd, /p\.closeTab\(\{[^}]*index/,
    'closeNativeTab calls the plugin closeTab method');

  const dapps = read('../js/dapps.js');
  assert.match(dapps, /import.*closeNativeTab.*from '\.\/native-dapp\.js'/,
    'dapps.js imports closeNativeTab');
  assert.match(dapps, /launch-tabstrip/,
    'tab strip rendered (horizontal strip of tab cards)');
  assert.match(dapps, /class="launch-tab-close"/,
    'close button on every tab card');
  assert.match(dapps, /closeNativeTab\(Number\(close\.dataset\.i\)/,
    'tab close wired to the native plugin (exact tab index from the pressed row)');
  assert.match(dapps, /openNativeTab\(Number\(row\.dataset\.i\)/,
    'tab open wired to the native plugin (exact tab index from the pressed row)');
  assert.match(dapps, /if \(!info\.open \|\| !tabs\.length\) return;/,
    'no ghost "Browser · 0" chip: a closed/empty session paints no door');
  assert.doesNotMatch(dapps, /closeNativeTab\(Number\(close\.dataset\.i\)[\s\S]{0,240}renderTabsEntry\(/,
    'the ✕ handler must NOT paint a second render — the browserClosed event owns the repaint (a second one races it: chips×2, strips×2)');
  assert.match(dapps, /info\.active/,
    'active tab highlighted');
  // 2026-10-17 live bug: <button> rows wrapping <button class="…-close"> —
  // nested interactive elements are INVALID HTML, the parser hoists the inner
  // button out of its row, indexes shift, and one ✕ press duplicated the
  // Browser chip while deleting the wrong tab. Rows must stay divs.
  assert.doesNotMatch(dapps, /<button[^>]*class="launch-tab"/,
    'tab row outer element must NOT be a button (no nested interactive)');
  assert.doesNotMatch(dapps, /dappTabsBtn/,
    'ONE tabs feature post-merge (user report 2026-10-18): the "Browser · n" chip + its modal chooser are gone — the live strip is the only tabs door');
  assert.match(dapps, /\.launch-tabstrip'\)\.forEach\(\(el\) => el\.remove\(\)/,
    're-render removes stale strips');
});

test('dApp tab i18n keys balanced EN vs ID', () => {
  const i18n = read('../js/i18n.js');
  for (const k of DAPP_KEYS) {
    assert.ok(new RegExp(`'${k}':`).test(i18n), `i18n key ${k} present`);
  }
  const idStart = i18n.indexOf("'dapp.addChain.title': 'Tambah jaringan yang diminta dApp ini?'");
  assert.ok(idStart !== -1, 'ID dapp section present');
  const enCount = (i18n.slice(0, idStart).match(/'dapp\./g) || []).length;
  const idCount = (i18n.slice(idStart).match(/'dapp\./g) || []).length;
  assert.ok(enCount > 0, 'EN dapp keys present');
  assert.equal(enCount, idCount, 'dapp i18n keys balanced EN vs ID');
});
