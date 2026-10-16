// Bear Tool — dex-interaction.test.js
//
// The launchpad must not be a wall of dead buttons. This gate drives the REAL
// view in jsdom: it boots the page shell, opens the Dex, presses Start here,
// and walks the two destinations — the feed and the coin page — asserting each
// renders its own live controls.
//
// UPDATED for the Dex v2 rebuild (2026-10-15, docs/DEX-V2.md): the nav carries
// the v2 surfaces (feed / swap / pools / liquidity / portfolio — one pool
// engine), and this gate walks them in jsdom. Every panel must be a real
// control, and every panel must speak honestly when it cannot read the chain.
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

test('Start here reveals the workspace with the v2 nav — feed, swap, pools', async () => {
  await click($('#dexStartHere'));
  assert.equal($('#dexWorkspace').hidden, false, 'Start here must open the workspace');

  // The nav is the navigation now, and it carries only real destinations.
  const tabs = [...window.document.querySelectorAll('[data-dex-tab]')].map((b) => b.dataset.dexTab);
  assert.deepEqual(tabs, ['feed', 'swap', 'pools', 'liquidity', 'portfolio'],
    'the nav is the feed plus the four v2 surfaces');
  assert.equal($('[data-dex-tab="feed"]').getAttribute('aria-pressed'), 'true',
    'the feed is the active tab at home');

  // The old ambiguity markers stay dead: no pair chips, no coin strip, and the
  // old codebase's swap-box id is not reused by v2.
  assert.equal($('.dex-coinstrip'), null, 'the coin picker strip is back');
  assert.equal($('.dex-pairbar'), null, 'the pair bar is back');
  assert.equal($('#dexSwapFrom'), null, 'the OLD swap-box id must not come back — v2 has its own ids');
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

test('the Swap tab renders the v2 form, and says honestly when it cannot read', async () => {
  await click($('[data-dex-tab="swap"]'));
  assert.equal(state.get('dex.route'), 'swap', 'the nav tab must route to swap');
  assert.equal($('[data-dex-tab="swap"]').getAttribute('aria-pressed'), 'true',
    'the active tab must follow the route');
  for (const id of ['dexSwapPool', 'dexSwapSheet', 'dexSwapNote']) {
    assert.ok($(`#${id}`), `the swap tab must carry #${id}`);
  }
  // With no chain the panel says so before ever mounting the trade form: the
  // ONE sheet component stays out, and the note explains why.
  assert.equal($('#dexSwapSheet').children.length, 0, 'no trade form without a readable pool list');
  // No provider in this gate: the panel must SAY it cannot read — never zeros.
  assert.ok($('#dexSwapNote').textContent.trim().length > 0,
    'the swap tab must explain its empty state');
});

test('the Pools tab renders the pool list shell, and the nav returns to the feed', async () => {
  await click($('[data-dex-tab="pools"]'));
  assert.equal(state.get('dex.route'), 'pools');
  assert.ok($('#dexPoolsList'), 'the pools tab must carry the list container');
  assert.ok($('#dexPoolsNote').textContent.trim().length > 0,
    'with no chain, the list must say why it is empty');

  await click($('[data-dex-tab="feed"]'));
  assert.equal(state.get('dex.route'), 'feed', 'the nav must be able to return to the feed');
});

test('the Liquidity tab renders the add/remove/lock controls, honestly gated', async () => {
  await click($('[data-dex-tab="liquidity"]'));
  assert.equal(state.get('dex.route'), 'liquidity');
  for (const id of ['dexLpPool', 'dexLpQuoteIn', 'dexLpTokenIn', 'dexLpAddGo', 'dexLpShares',
    'dexLpMax', 'dexLpRemoveGo', 'dexLpLockDur', 'dexLpLockGo', 'dexLpNote']) {
    assert.ok($(`#${id}`), `the liquidity tab must carry #${id}`);
  }
  // No provider in this gate: the panel must SAY it cannot read — never zeros.
  assert.ok($('#dexLpNote').textContent.trim().length > 0,
    'the liquidity tab must explain its empty state');
});

test('the Portfolio tab renders its containers, then the nav returns to the feed', async () => {
  await click($('[data-dex-tab="portfolio"]'));
  assert.equal(state.get('dex.route'), 'portfolio');
  assert.ok($('#dexPfLp'), 'portfolio must carry the LP container');
  assert.ok($('#dexPfTokens'), 'portfolio must carry the tokens container');
  assert.ok($('#dexPfNote').textContent.trim().length > 0,
    'with no chain, the portfolio must say why it is empty');

  await click($('[data-dex-tab="feed"]'));
  assert.equal(state.get('dex.route'), 'feed', 'the nav must be able to return to the feed');
});

test('the launch button opens the create form, and Back returns to the feed', async () => {
  await click($('#dexGoCreate'));
  assert.equal(state.get('dex.route'), 'create', 'the launch button must route to create');
  for (const id of ['dexCreateName', 'dexCreateSymbol', 'dexCreateGo',
    'dexLaunchSupply', 'dexLaunchTokens', 'dexLaunchQuoteIn', 'dexLaunchLock']) {
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
  // "pair" is still a ghost: this launchpad has no pairs and never had a
  // concept of one. "pool" and "quote" are NOT ghosts any more — the curve
  // really does accept liquidity deposits, and it really is quoted in one of the
  // three Dex coins — so banning those words would be banning the truth.
  assert.ok(!/pair/i.test(text),
    'the coin page must never mention a "pair" — a launchpad has none');

  // The claim worth protecting is the PROMISE, not the vocabulary. The bot
  // panel has to be able to say out loud that it adds no real liquidity, so
  // banning the word would force the app to lie about itself. What must never
  // appear is a promise of a migration the contract does not perform.
  assert.ok(!/migrat/i.test(text),
    'the coin page must not promise a liquidity migration — withdraw() is not one');
  assert.ok(!/(move|withdraw|pindah)[^.]{0,20}liquidity (out|migration)/i.test(text),
    'no button may promise to move liquidity out — withdraw() pays the creator\'s fee only');
  assert.ok(/backing|withdraw/i.test(text),
    'the coin page must say plainly that the backing is withdrawn to your wallet');
});

test('Back from a coin returns to the feed with the coin still listed', async () => {
  await click($('#dexTradeBack'));
  assert.equal(state.get('dex.tokenView'), null, 'Back must clear the open coin');
  assert.ok($('[data-dex-token]'), 'the feed must be back, still listing the coin');
});

test('an address outside the feed opens, and nothing about it is invented', async () => {
  // The feed is a view of the chain now, so any coin address is openable — that
  // is how a coin launched on another device, or by another wallet, becomes
  // reachable. Its identity comes from the CONTRACT, not from a local entry, so
  // an address this browser never stored still shows its real name.
  //
  // What must never happen is a coin page that looks finished while showing
  // nothing true. So the controls exist, no pair gate appears, and every figure
  // waits for the chain rather than being filled in to look complete.
  dex.openCoin('0x2222222222222222222222222222222222222222');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok($('#dexTradeBack'), 'an address outside the feed must still be openable');
  assert.ok($('#dexTradeBuy'), 'and must offer the trade controls');
  assert.ok(!/pick a base|choose a coin|pair/i.test(panel().textContent),
    'no pair gate may appear — a launchpad has no pairs');
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
