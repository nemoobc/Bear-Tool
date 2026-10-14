// Bear Tool — dex-interaction.test.js
//
// The launchpad must not be a wall of dead buttons. This gate drives the REAL
// view in jsdom: it boots the page shell, opens the Dex, presses Start here,
// and walks the two destinations — the feed and the coin page — asserting each
// renders its own live controls.
//
// REWRITTEN for the pure-launchpad rebuild. The old gate pressed a pair picker
// and walked five feature tabs; none of that exists any more, and a gate that
// still described it would have kept passing while the product changed under
// it. What replaces it is the ambiguity guarantee: two destinations, one way to
// trade, and every button a real control.
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
const panel = () => $('#dexPanelHost');
const click = async (el) => { el.click(); await new Promise((r) => setTimeout(r, 80)); };

// A coin this wallet "launched", so the feed has something real to render. The
// address is only an identity here — the coin page's chain reads are all
// guarded and report honestly when there is no provider, which is the state
// this gate measures.
const COIN = {
  address: '0x1111111111111111111111111111111111111111',
  name: 'Bear Moon',
  symbol: 'BMOON',
  image: '',
};

// The app boots on Ethereum; put the Dex on Sepolia so we measure the panels,
// not the chain gate (the gate gets its own test at the bottom).
state.set('networkId', 'sepolia');
state.set('dex.launched', [COIN]);
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

test('Start here reveals the workspace on the feed — no tabs, no pair', async () => {
  await click($('#dexStartHere'));
  assert.equal($('#dexWorkspace').hidden, false, 'Start here must open the workspace');

  // The ambiguity guarantee, measured on the live DOM: nothing here offers a
  // second way to trade. No tab strip, no pair chips, no pool controls.
  assert.equal($('[data-dex-tab]'), null, 'a tab button is on screen — there are no tabs to choose between');
  assert.equal($('#dexTabs'), null, 'the tab strip is back');
  assert.equal($('.dex-coinstrip'), null, 'the coin picker strip is back');
  assert.equal($('.dex-pairbar'), null, 'the pair bar is back');
  assert.equal($('#dexSwapFrom'), null, 'a swap box is on screen — a launchpad has no swap');
  assert.equal($('#dexLiq'), null, 'a liquidity control is on screen — a launchpad has no pools');
});

test('the feed is home, and it lists the launched coin', () => {
  assert.equal(state.get('dex.route'), 'feed', 'the feed must be the default route');
  assert.ok($('#dexLaunchbar, .dex-launchbar'), 'the feed needs its launch bar');
  assert.ok($('#dexGoCreate'), 'the feed must offer the one action: launch a coin');

  const row = $('[data-dex-token]');
  assert.ok(row, 'the feed must list the launched coin');
  assert.equal(row.dataset.dexToken, COIN.address, 'the row must carry the coin address');
  assert.match(row.textContent, /Bear Moon/, 'the row must name the coin');
  assert.match(row.textContent, /BMOON/, 'the row must show the ticker');
});

test('the launch button opens the create form, and Back returns to the feed', async () => {
  await click($('#dexGoCreate'));
  assert.equal(state.get('dex.route'), 'create', 'the launch button must route to create');
  for (const id of ['dexCreateName', 'dexCreateSymbol', 'dexCreateGo']) {
    assert.ok($(`#${id}`), `the launch form must carry #${id}`);
  }
  // The coin list must not still be underneath the form.
  assert.equal($('[data-dex-token]'), null, 'the feed must not sit behind the launch form');

  await click($('#dexCreateBack'));
  assert.equal(state.get('dex.route'), 'feed', 'Back must return to the feed');
  assert.ok($('[data-dex-token]'), 'the feed must be back');
});

test('tapping a coin opens that coin\'s page — price, chart, tape and trade', async () => {
  await click($('[data-dex-token]'));
  assert.equal(state.get('dex.tokenView'), COIN.address, 'the tap must select the coin');

  // One screen per coin, carrying everything about it. The old Dex split price
  // (Swap) from the chart from the tape; here they cannot be separated.
  for (const id of ['dexTradePrice', 'dexTradeGradFill', 'dexTradeChart',
                    'dexTradeTape', 'dexTradeBuyEth', 'dexTradeBuy', 'dexTradeSellTok', 'dexTradeSell']) {
    assert.ok($(`#${id}`), `the coin page must carry #${id}`);
  }
  assert.equal($('[data-dex-token]'), null, 'the feed must give way to the coin page');
  assert.ok($('#dexTradeBack'), 'the coin page needs a way back');
});

test('a coin page is never gated behind a pair or a pool', async () => {
  // The old Dex opened Swap behind "pick a base and a quote" — a gate box ON
  // TOP of nothing, and the real controls only after you satisfied it. The tell
  // for that is an empty box where the controls should be. Here the controls are
  // ALWAYS there; an empty box can only be the trade tape saying "no trades yet",
  // which lives inside the tape, not in place of the page.
  assert.ok($('#dexTradeBuy') && $('#dexTradeSell') && $('#dexTradeChart'),
    'the coin page must render its controls, whatever the tape says');
  for (const box of [...panel().querySelectorAll('.dex-empty')]) {
    assert.equal(box.closest('#dexTradeTape') !== null, true,
      'the only empty box allowed on a coin page is the trade tape saying "no trades yet"');
  }
  const text = panel().textContent;
  for (const ghost of ['pair', 'quote', 'pool']) {
    assert.ok(!new RegExp(ghost, 'i').test(text),
      `the coin page must never mention a "${ghost}" — a launchpad has none`);
  }
  // "Liquidity" does appear, but only on the graduation button: once a coin
  // graduates its backing moves to a pool. That is the coin's exit, not a
  // pool-management feature — so it must be the ONLY thing that says it.
  const saysLiquidity = [...window.document.querySelectorAll('#dexPanelHost *')]
    .filter((el) => el.children.length === 0 && /liquidity/i.test(el.textContent))
    .map((el) => el.id || el.className);
  assert.deepEqual(saysLiquidity, ['dexTradeGraduate'],
    'only the graduation button may talk about moving a coin\'s backing out');
});

test('Back from a coin returns to the feed with the coin still listed', async () => {
  await click($('#dexTradeBack'));
  assert.equal(state.get('dex.tokenView'), null, 'Back must clear the open coin');
  assert.ok($('[data-dex-token]'), 'the feed must be back, still listing the coin');
});

test('an address that is not a launched coin says so instead of rendering a page', async () => {
  // Rendering an unknown address would mean drawing a contract this wallet knows
  // nothing about. The honest answer is a plain "not in this list" with a way back.
  dex.openCoin('0x2222222222222222222222222222222222222222');
  await new Promise((r) => setTimeout(r, 40));
  assert.match(panel().textContent, /not in this launchpad/i,
    'an unknown coin must say it is not in the list');
  assert.ok($('#dexCoinBack'), 'an unknown coin must still offer a way back');
});

test('on the default network the gate dims everything AND offers the way out', async () => {
  dex.go('feed');
  await new Promise((r) => setTimeout(r, 40));
  state.set('networkId', 'ethereum');
  dex.renderDex(root);
  await new Promise((r) => setTimeout(r, 40));

  assert.equal($('#dexGate').hidden, false, 'the gate must show off Sepolia');
  assert.ok($('#dexGateGo').textContent.trim(), 'the gate must offer a way out');
  // Dimmed AND inert: a button that still clicks on the wrong chain just fails
  // later, with a worse message.
  assert.equal(panel().style.pointerEvents, 'none', 'the panels must be inert on the wrong chain');
  assert.equal(panel().getAttribute('aria-disabled'), 'true', 'the panels must be announced as disabled');

  state.set('networkId', 'sepolia');
  dex.renderDex(root);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal($('#dexGate').hidden, true, 'back on Sepolia the gate must hide');
  assert.equal(panel().style.pointerEvents, '', 'the panels must be live again on Sepolia');
});
