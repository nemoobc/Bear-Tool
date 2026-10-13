// Bear Tool — dex-interaction.test.js
//
// The Dex must not be a wall of dead buttons. This gate drives the REAL view
// in jsdom: it boots the page shell, opens the Dex, presses Start here,
// changes the pair through the picker and walks every feature tab, asserting
// each renders its own live controls.
//
// The pair picker is a single <select> over the three preset pairs (the three
// contracts make exactly three pairs) and defaults to the first, so a one-sided
// "pick a base and a quote" gate cannot exist — the panel is live on open.
// That is the "gajelas / tombol polos" complaint, pinned: every tab must offer
// real controls the moment the workspace opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dexJsx = readFileSync(new URL('../src/views/dex.jsx', import.meta.url), 'utf8');
const section = dexJsx.slice(dexJsx.indexOf('<section'), dexJsx.lastIndexOf('</section>') + '</section>'.length);
const at = shell.indexOf('</body>');
const dom = new JSDOM(shell.slice(0, at) + section + shell.slice(at), { url: 'http://localhost/' });
const { window } = dom;
for (const key of ['window', 'document', 'localStorage', 'navigator', 'location',
  'HTMLElement', 'Node', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true }); } catch { /* already a getter (navigator) */ }
}
if (!globalThis.matchMedia) {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.matchMedia = globalThis.matchMedia;
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const state = await import('../js/state.js');
const dex = await import('../js/dex/index.js');

const $ = (sel) => window.document.querySelector(sel);
const tabs = () => [...window.document.querySelectorAll('[data-dex-tab]')];
const panel = () => $('#dexPanelHost');
const click = async (el) => { el.click(); await new Promise((r) => setTimeout(r, 80)); };

// The app boots on Ethereum; put the Dex on Sepolia so we measure the panels,
// not the chain gate (the gate gets its own test at the bottom).
state.set('networkId', 'sepolia');
const root = $('#dexRoot');
dex.renderDex(root, { fresh: true });

test('the Dex opens on the welcome screen: heading, bear logo, Start here', () => {
  assert.equal(root.innerHTML.length > 500, true, 'renderDex must paint #dexRoot');
  assert.equal($('#dexWelcome').hidden, false, 'the welcome shows on a fresh open');
  assert.equal($('#dexWorkspace').hidden, true, 'the workspace is hidden behind it');
  assert.ok($('#dexWelcomeTitle').textContent.trim(), 'the welcome needs a heading');
  assert.ok($('#dexWelcomeLogo').getAttribute('src').includes('bear'), 'the bear logo must show');
  assert.equal($('#dexStartHere').textContent.trim(), 'Start here');
});

test('Start here reveals the workspace with a live pair and four feature tabs', async () => {
  await click($('#dexStartHere'));
  assert.equal($('#dexWorkspace').hidden, false, 'Start here must open the workspace');
  // The chart is part of Swap now, not a tab of its own; Tokens leads.
  assert.deepEqual(tabs().map((t) => t.dataset.dexTab),
    ['tokens', 'create', 'swap', 'liquidity', 'mm'],
  'the feature tabs are Tokens + the four actions');
});

test('a default pair exists so no panel is gated behind "pick two coins"', () => {
  // The three tokens are the Dex's own coins; there is no global base/quote
  // gate any more. A working pair is set on open so every panel is live.
  assert.ok(dex.dexPair(), 'a default pair must exist on open');
  assert.deepEqual(
    [dex.dexPair().base.symbol, dex.dexPair().quote.symbol],
    ['ETH', 'USDT'],
    'the default pair is the first preset pair',
  );
  assert.equal($('#dexPairSelect'), null, 'no global base/quote picker — the Swap panel owns from/to');
});

test('the Swap panel picks both coins itself and shows the chart inline', async () => {
  await click(tabs().find((t) => t.dataset.dexTab === 'swap'));
  const from = $('#dexSwapFrom');
  assert.ok(from, 'Swap must offer a coin selector');
  // Both sides visible at once (the mature DEX shape).
  assert.ok($('#dexSwapReceive'), 'Swap must show what you receive');
  assert.ok($('#dexChartCanvas'), 'the TradingView chart must live inside Swap, not a separate tab');
  // Changing direction keeps both faces honest.
  $('#dexSwapFlip').click();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok($('#dexSwapReceive'), 'flipping must not blank the Buy box');
});

test('every feature tab renders its own live body — no dead buttons', async () => {
  for (const key of ['create', 'swap', 'liquidity', 'mm']) {
    await click(tabs().find((t) => t.dataset.dexTab === key));
    const controls = panel().querySelectorAll('button, input, select, textarea');
    assert.ok(controls.length >= 2,
      `${key} panel must render real controls, found ${controls.length}`);
  }
});

test('Liquidity is a LIST of pools, each row opening its own add form', async () => {
  await click(tabs().find((t) => t.dataset.dexTab === 'liquidity'));
  const rows = panel().querySelectorAll('[data-dex-pool]');
  assert.equal(rows.length, 3, 'three coins make exactly three pools — list them all');
  assert.ok(panel().textContent.includes('ETH'), 'rows name the coins');
});

test('on the default network the gate dims everything AND offers the way out', async () => {
  state.set('networkId', 'ethereum'); // what the app boots on
  dex.renderDex(root, { fresh: true });
  assert.equal($('#dexGate').hidden, false, 'the gate must show on a non-Sepolia chain');
  assert.equal($('#dexTabs').style.pointerEvents, 'none', 'actions must be inert off-chain');
  assert.equal($('#dexTabs').style.opacity, '0.5');
  const go = $('#dexGateGo');
  assert.ok(go, 'the gate must contain a button, not just a sentence');

  await click(go);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(state.get('networkId'), 'sepolia',
    'the gate button must actually move the wallet to Sepolia');
  assert.equal($('#dexGate').hidden, true, 'and the gate must retire once it did');
  assert.equal($('#dexTabs').style.pointerEvents, '', 'and the controls come back');
});
