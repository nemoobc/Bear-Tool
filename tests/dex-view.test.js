// Bear Tool — dex-view.test.js
//
// The Dex view (user order: "Dex sepolia only") must exist, be reachable on
// desktop AND phone, and refuse every chain except Sepolia — the rules that
// shape the whole feature, pinned before the panels grow around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
const dexJs = read('../js/dex/index.js');
const coreJs = read('../js/dex/core.js');
const i18n = read('../js/i18n.js');
const dashboardJsx = read('../src/views/dashboard.jsx');
const { NETWORKS } = await import('../js/network.js');
const dex = await import('../js/dex/index.js');

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
  const branch = fn.indexOf("if (view === 'dex') renderDex($('#dexRoot'), { fresh: true });");
  assert.ok(branch > -1, 'app.js must render the Dex root for the dex view, opened fresh (welcome shows)');
  const guard = fn.indexOf("if (!get('address')) return;");
  assert.ok(guard > -1, 'the address guard must exist inside refreshView');
  assert.ok(branch < guard,
    'the Dex render must run before the address guard — a locked wallet must see the Sepolia gate, not an empty card');
  assert.match(appJs, /import \{ renderDex \} from '\.\/dex\/index\.js';/, 'app.js must import renderDex');
  // The welcome screen is the entry: heading on top, bear logo under it,
  // "Start here" under the logo, and the workspace hidden until it is pressed.
  const order = [
    dexJs.indexOf('id="dexWelcomeTitle"'),
    dexJs.indexOf('id="dexWelcomeLogo"'),
    dexJs.indexOf('id="dexStartHere"'),
    dexJs.indexOf('id="dexWorkspace"'),
  ];
  assert.ok(order.every((n) => n > -1), 'welcome heading, bear logo, Start here and workspace must all exist');
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    'order must be heading (top) → bear logo → Start here → workspace (bottom)');
  assert.match(dexJs, /if \(opts\.fresh\) openWelcome\(\);/,
    'only an explicit fresh open re-shows the welcome — a chain switch must not');
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
  assert.match(coreJs, /export function dexChainOk\(\) \{ return dexChainId\(\) === DEX_CHAIN_ID; \}/,
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

test('the launchpad Create panel is part of the Dex, on the curve contract', () => {
  // The user asked for the full launchpad back: "ada fitur create token,
  // market maker auto buy sell via contract token, add liquid … intinya
  // lengkap". So Create is a REQUIRED first tab, and it ships with the
  // PumpToken contract that trades on the bonding curve.
  assert.ok(dex.DEX_PANELS.includes('create'),
    'Create Token must be one of the feature tabs');
  assert.equal(dex.DEX_PANELS[0], 'tokens',
    'the live token list is the Dex home screen, so it leads the tabs');
  for (const need of ['swap', 'liquidity', 'mm']) {
    assert.ok(dex.DEX_PANELS.includes(need), `${need} must remain alongside create`);
  }
  assert.ok(!dex.DEX_PANELS.includes('chart'),
    'the chart is not a tab — it is part of the Swap screen, not separate');
  assert.match(i18n, /'dex\.tab\.create':/, 'the Create tab needs a label');
  assert.match(i18n, /'dex\.create\./, 'the Create panel needs its own keys');
  assert.match(dexJs, /PumpToken|createHtml|bindCreate|panelCreate/,
    'the Dex view must render a Create panel backed by the curve token');
  // The chart block lives in the swap markup so it cannot drift out of Swap.
  assert.match(dexJs, /function swapHtml[\s\S]*?dexChartCanvas/,
    'the TradingView chart markup must be inside swapHtml');
});

test('Curve is not its own tab — it is the maths behind Create', () => {
  // The bonding curve is the engine of the launchpad, not a second trading
  // surface competing with the Dex. So: a `curve` tab must stay gone, while
  // the curve maths and contract live inside js/dex/.
  assert.ok(!dex.DEX_PANELS.includes('curve'), 'there must be no separate Curve tab');
  assert.ok(!i18n.includes(`'dex.tab.curve':`), 'no dex.tab.curve label');
  assert.ok(/DEX_PANELS/.test(dexJs), 'the preset/panel registry lives in the Dex module');
});

test('the pair comes from a preset address, never from free text', () => {
  // loadPair is the only USER-facing writer of dex.pair and it refuses
  // anything that is not 0x+40hex before it touches the chain. The silent
  // default (ensureDefaultPair) is the second, non-interactive writer and may
  // only ever name a preset — never anything from the DOM.
  const shapeCheck = /\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(String\(v \|\| ''\)\)/;
  assert.match(coreJs, shapeCheck,
    'loadPair must validate the address shape through a shape check before any RPC');
  assert.match(dexJs, /const \[base, quote\] = DEX_PRESETS;/,
    'the default pair must be drawn from the fixed preset table, not user input');
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

test('the preset table replaces the old local token registry', () => {
  // The Dex has no local minted-token store; the three presets ARE the
  // registry. Launchpad tokens live on-chain, never in local state.
  assert.ok(!/bear\.dexTokens/.test(dexJs),
    'no local token registry may creep back into the Dex module');
  assert.ok(/DEX_PRESETS/.test(dexJs), 'the preset table replaces the local registry');
});

test('the Dex and its launchpad live in one folder, and only that folder', () => {
  // User order, twice, and the second one corrected the first reading:
  //   "fitur dex jangan disatuin itu fitur kayak launchpad token gitu, buat
  //    folder dex"  →  the Dex gets a folder of its own
  //   "jangan di satuin, taro di folder dex only"  →  the launchpad/create
  //    token feature goes IN THAT SAME FOLDER — it is not split out into a
  //    sibling js/launchpad/.
  // So: one folder, holding the swap core AND the bonding-curve launchpad.
  const dir = fileURLToPath(new URL('../js/dex', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

  // The launchpad is part of the Dex, not a tenant next door.
  assert.ok(files.includes('index.js'), 'js/dex/index.js — the Dex view itself');
  assert.ok(files.includes('contract.js'), 'js/dex/contract.js — the V2 ABIs');
  assert.ok(files.includes('curve.js'),
    'js/dex/curve.js — the bonding-curve maths belongs inside the Dex folder');
  assert.ok(files.includes('chart.js'),
    'js/dex/chart.js — the TradingView renderer belongs inside the Dex folder');
  assert.ok(files.includes('pump-source.js'),
    'js/dex/pump-source.js — the launchpad token contract belongs inside the Dex folder');

  // …and nothing was split back out into a sibling folder.
  const siblingLaunchpad = existsSync(fileURLToPath(new URL('../js/launchpad', import.meta.url)));
  assert.equal(siblingLaunchpad, false,
    'js/launchpad/ is back — the launchpad must live inside js/dex/, per "taro di folder dex only"');
});

test('Dex labels are translated in both languages', () => {
  const idStart = i18n.indexOf('\n  id: {');
  assert.ok(idStart > -1, 'i18n.js must keep an id block');
  const en = i18n.slice(0, idStart);
  const id = i18n.slice(idStart);
  for (const key of ['nav.dex', 'dex.hint', 'dex.gate.needSepolia', 'dex.gate.howto',
                     'dex.pair.label', 'dex.needWallet',
                     'dex.welcome.title', 'dex.welcome.sub', 'dex.welcome.start',
                     'dex.panel.locked',
                     'dex.tab.create', 'dex.tab.swap', 'dex.tab.chart',
                     'dex.tab.liquidity', 'dex.tab.mm']) {
    for (const [lang, block] of [['en', en], ['id', id]]) {
      assert.ok(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'[^']+'`).test(block),
        `${key} must be defined in the ${lang} block`);
    }
  }
});
