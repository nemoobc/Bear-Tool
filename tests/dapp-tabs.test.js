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
  assert.match(dapps, /closeNativeTab\(i\)/,
    'tab close wired to the native plugin');
  assert.match(dapps, /openNativeTab\(i\)/,
    'tab open wired to the native plugin');
  assert.match(dapps, /info\.active/,
    'active tab highlighted');
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
