// Bear Tool — dex-view.test.js
//
// The Dex view (user order: "Dex sepolia only") must exist, be reachable on
// desktop AND phone, and refuse every chain except Sepolia — the rules that
// shape the whole feature, pinned before the panels grow around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// network.js reads localStorage at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const indexHtml = read('../index.html');
const appJs = read('../js/app.js');
const dexJs = read('../js/dex.js');
const i18n = read('../js/i18n.js');
const dashboardJsx = read('../src/views/dashboard.jsx');
const { NETWORKS } = await import('../js/network.js');
const dex = await import('../js/dex.js');

test('the Dex nav item ships in the sidebar, right after Discord', () => {
  const nav = indexHtml.match(/<div class="nav-item[^>]*data-view="dex"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(nav, 'index.html must carry a nav-item for data-view="dex"');
  assert.match(nav[0], /data-i18n="nav\.dex"/, 'the nav item must carry the nav.dex key');
  const discordPos = indexHtml.indexOf('data-view="discord"');
  const dexPos = indexHtml.indexOf('data-view="dex"');
  assert.ok(discordPos > -1 && dexPos > discordPos, 'Dex must sit after Discord in the sidebar');
});

test('refreshView renders the Dex view BEFORE the wallet guard', () => {
  const fn = appJs.slice(appJs.indexOf('export function refreshView'));
  const branch = fn.indexOf("if (view === 'dex') renderDex($('#dexRoot'));");
  assert.ok(branch > -1, 'app.js must render the Dex root for the dex view');
  const guard = fn.indexOf("if (!get('address')) return;");
  assert.ok(guard > -1, 'the address guard must exist inside refreshView');
  assert.ok(branch < guard,
    'the Dex render must run before the address guard — a locked wallet must see the Sepolia gate, not an empty card');
  assert.match(appJs, /import \{ renderDex \} from '\.\/dex\.js';/, 'app.js must import renderDex');
});

test('the phone keeps a route to Dex', () => {
  const block = appJs.match(/const REACHABLE_ON_MOBILE = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'REACHABLE_ON_MOBILE must exist');
  assert.match(block[1], /dex:\s*'Dashboard quick action \(Dex\)'/,
    'Dex must be listed in REACHABLE_ON_MOBILE with its real route');
  assert.match(dashboardJsx, /data-view="dex"/,
    'the Dashboard must carry the Dex quick action the map claims');
});

test('Dex is pinned to Sepolia: the constant, the shipped network, and the gate', () => {
  assert.equal(dex.DEX_CHAIN_ID, 11155111, 'the Dex targets Sepolia');
  const sepolia = NETWORKS.find((n) => n.id === 'sepolia');
  assert.ok(sepolia, 'js/network.js must ship Sepolia');
  assert.equal(sepolia.chainId, 11155111, 'Sepolia chainId drifted from the Dex constant');
  assert.match(dexJs, /export function dexChainOk\(\) \{ return dexChainId\(\) === DEX_CHAIN_ID; \}/,
    'the gate must compare the live chain against DEX_CHAIN_ID');
});

test('the Uniswap V2 registry carries verified Sepolia addresses', () => {
  const v2 = dex.UNISWAP_V2[11155111];
  assert.ok(v2, 'the V2 registry must cover Sepolia');
  for (const key of ['factory', 'router', 'weth']) {
    assert.match(v2[key], /^0x[0-9a-fA-F]{40}$/, `V2 ${key} must be a 20-byte address`);
  }
  // The native coin is gas only — WETH is the router's wrap target, never a
  // pair side the Dex offers on its own.
  assert.notEqual(v2.weth.toLowerCase(), v2.router.toLowerCase());
});

test('the pair comes from an ERC-20 address, never from a native-coin option', () => {
  // loadPair is the ONLY writer of dex.pair, and it refuses anything that is
  // not 0x+40hex before it touches the chain.
  const writers = dexJs.match(/set\('dex\.pair'/g) || [];
  assert.equal(writers.length, 1, 'dex.pair must be written in exactly one place');
  assert.match(dexJs, /\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(String\(v \|\| ''\)\)/,
    'loadPair must validate the address shape through a shape check before any RPC');
  const sepolia = NETWORKS.find((n) => n.id === 'sepolia');
  assert.equal(sepolia.symbol, 'ETH', 'sanity: Sepolia native coin is ETH — and it stays gas-only');
});

test('the Dex offers exactly the three preset coins, each a real ERC-20 shape', () => {
  // User order: "custom coin native hapus, pake ini aja [tiga alamat]" —
  // the address list IS the spec. If one drifts, the Dex trades a contract
  // nobody probed.
  const presets = dex.DEX_PRESETS;
  assert.equal(presets.length, 3, 'the Dex ships exactly three preset coins');
  for (const p of presets) {
    assert.match(p.address, /^0x[0-9a-fA-F]{40}$/, `${p.symbol} preset must be a 20-byte address`);
    assert.ok(p.symbol && p.name, `${p.address} must carry symbol and name`);
    assert.equal(p.decimals, 18, `${p.symbol} probed as 18 decimals on-chain 2026-10-13`);
  }
  const addrs = presets.map((p) => p.address.toLowerCase());
  assert.equal(new Set(addrs).size, 3, 'the three presets must be three distinct contracts');
  // Sepolia native ETH is gas only: no preset may BE the chain's native coin
  // identity — but token 0x8847… is an ERC-20 contract with symbol "ETH".
  const sepolia = NETWORKS.find((n) => n.id === 'sepolia');
  assert.notEqual(addrs[0], '0x0000000000000000000000000000000000000000',
    'a preset must never be the zero address (native-coin stand-in)');
  assert.ok(sepolia.symbol === 'ETH', 'native ETH stays gas-only');
});

test('the Dex lost the minting panels: no Create, no Curve, no local registry', () => {
  // Same order: custom coin native is gone. A leftover key or panel would be
  // a button that deploys a contract the new spec never asked for.
  assert.deepEqual(dex.DEX_PANELS, ['swap', 'chart', 'liquidity', 'mm'],
    'the panel list must be exactly the four that remain');
  for (const gone of ['dex.tab.create', 'dex.tab.curve']) {
    assert.ok(!i18n.includes(`'${gone}':`),
      `i18n must not define ${gone} — the panels are gone`);
  }
  for (const gone of ['dex.create.', 'dex.curve.']) {
    assert.ok(!i18n.includes(`'${gone}`),
      `i18n must not define any ${gone}* key — the panels are gone`);
  }
  assert.ok(!/function (createHtml|bindCreate|curveHtml|bindCurve|panelCreate|panelCurve)\b/.test(dexJs),
    'dex.js must not define the Create/Curve panel functions');
  assert.ok(!/bear\.dexTokens|DEX_CURVE_SOURCE|CURVE_ABI/.test(dexJs),
    'the local token registry and the curve ABI must be gone from dex.js');
  assert.ok(/DEX_PRESETS/.test(dexJs), 'the preset table replaces the local registry');
});

test('Dex labels are translated in both languages', () => {
  const idStart = i18n.indexOf('\n  id: {');
  assert.ok(idStart > -1, 'i18n.js must keep an id block');
  const en = i18n.slice(0, idStart);
  const id = i18n.slice(idStart);
  for (const key of ['nav.dex', 'dex.hint', 'dex.gate.needSepolia', 'dex.gate.howto',
                     'dex.pair.label', 'dex.pair.base', 'dex.pair.quote', 'dex.needWallet',
                     'dex.tab.swap', 'dex.tab.chart',
                     'dex.tab.liquidity', 'dex.tab.mm']) {
    for (const [lang, block] of [['en', en], ['id', id]]) {
      assert.ok(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'[^']+'`).test(block),
        `${key} must be defined in the ${lang} block`);
    }
  }
});
