// Bear Tool — dex-view.test.js
//
// The Dex view (user order: "Dex sepolia only") must exist, be reachable on
// desktop AND phone, and refuse every chain except Sepolia.
//
// This gate was REWRITTEN for the pure-launchpad rebuild (user: "ambigu fitur
// dexnya, rombak ulang semuanya" → "opsi 1"). The old Dex carried two trading
// engines at once — Uniswap V2 pools and bonding curves — plus a global pair
// and a second "ETH". That ambiguity was the complaint, so its removal is now
// pinned here: the tests below assert the V2 layer is GONE, not merely unused.
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
const tokensJs = read('../js/dex/tokens.js');
const tradeJs = read('../js/dex/trade.js');
const historyJs = read('../js/dex/history.js');
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
  assert.match(appJs, /import \{ renderDex \} from '\.\/dex\/index\.js\';/, 'app.js must import renderDex');
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

// ── the rebuild's core promise ──────────────────────────────────
// Two ways to trade with no rule saying which is what made the old Dex
// ambiguous. These tests exist so the V2 layer cannot quietly return: not as a
// dead file, not as a half-wired helper, not as a CSS class nobody renders.
test('the launchpad has ONE way to trade — the Uniswap V2 layer is gone', () => {
  const dir = fileURLToPath(new URL('../js/dex', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

  assert.equal(files.includes('contract.js'), false,
    'js/dex/contract.js is back — it only held the V2 router/factory/pair ABIs, which a launchpad does not use');

  for (const f of files) {
    const src = readFileSync(new URL(`../js/dex/${f}`, import.meta.url), 'utf8');
    for (const gone of ['UNISWAP_V2', 'V2_ROUTER_ABI', 'V2_FACTORY_ABI', 'V2_PAIR_ABI', 'poolFor', 'DEX_PRESETS']) {
      assert.ok(!new RegExp(`\\b${gone}\\b`).test(src),
        `js/dex/${f} still references ${gone} — the V2 layer must stay deleted`);
    }
  }
});

test('there is no pair, no pool, and no second ETH anywhere in the Dex', async () => {
  // dex.pair was the global pair selector. With it gone, nothing may write it.
  assert.ok(!/dex\.pair/.test(dexJs) && !/dex\.pair/.test(coreJs),
    'nothing may write or read dex.pair — a launchpad has no pair');
  assert.ok(!/export function loadPair/.test(dexJs), 'loadPair is back — it existed only to pick a pair');
  assert.ok(!/export function chooseCoin/.test(dexJs),
    'chooseCoin is back — it existed only to choose a pair side');

  // The old Dex offered the 0x8847… ERC-20 as a coin called "ETH" while native
  // Sepolia ETH was the gas token: two ETHs, one screen. That is the ambiguity
  // the rebuild was commissioned to remove, so the preset table must not come
  // back in any form.
  // The three coins came BACK — as the currency the launchpad is QUOTED in,
  // which is what they were always for. Sepolia native ETH is gas only, and the
  // curve contract refuses it outright, so the two can never be confused again:
  // one is the money you trade in, the other is the money you pay fees with.
  const core = await import('../js/dex/core.js');
  assert.equal(core.QUOTE_PRESETS.length, 3, 'the Dex has exactly three coins');
  const addrs = core.QUOTE_PRESETS.map((q) => q.address.toLowerCase());
  for (const a of ['0x8847346f20ace5bd4619b7fbf3467d001e269fe9',
                   '0x8719d774726b11497faddcfdf7bc369c56f6b5d3',
                   '0x4669689d94991bb4ab6a6e071f9af9cc42d9deef']) {
    assert.ok(addrs.includes(a), `the Dex must carry coin ${a}`);
  }
  // …and none of them may be the chain's native token standing in for it.
  assert.ok(!addrs.includes('0x0000000000000000000000000000000000000000'),
    'no coin may be a native-coin stand-in');
  assert.equal(core.defaultQuote().symbol, 'ETH', 'the first coin is the default quote');
  // Exactly one place defines them, so an address is never written twice.
  assert.ok(!/0x8847346f20aCe5bd4619B7fbF3467D001E269fE9/.test(dexJs),
    'the addresses live in core.js only');
});

test('the launchpad has ONE way to read a coin — swap/liquidity/mm panels are gone', () => {
  for (const gone of ['panelSwap', 'panelLiquidity', 'panelMM', 'swapHtml', 'liquidityHtml', 'mmHtml', 'stopMM']) {
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(dexJs),
      `${gone} is back — the launchpad trades coins on their own curves, not through pools`);
  }
  // The market maker was a swap loop, so it has nothing left to loop over.
  // Measured below the header: naming what was deleted is how the next reader
  // knows the absence was deliberate, not an oversight.
  const code = dexJs.slice(dexJs.indexOf('import '));
  assert.ok(!/market maker/i.test(code), 'the market maker must not creep back into the view');
  // …and the deleted panels are named in that header, so the record of what
  // went away survives the code that removed it.
  for (const gone of ['Swap', 'Liquidity', 'Market Maker', 'DEX_PAIRS']) {
    assert.ok(dexJs.includes(gone), `the header must still record that ${gone} was removed`);
  }
});

test('no tab strip: the feed and the coin page are the navigation', () => {
  assert.deepEqual(dex.DEX_ROUTES, ['feed', 'create'],
    'the launchpad has exactly two destinations — browse coins, or launch one');
  assert.ok(!dexJs.includes('dexTabs'), 'the tab strip is back — there is nothing left for tabs to choose between');
  assert.ok(!/data-dex-tab/.test(dexJs), 'tab buttons are back');
  assert.ok(!/DEX_PANELS/.test(dexJs), 'DEX_PANELS is back — the five feature tabs are gone');
  assert.equal(getComputedRouteDefault(), 'feed', 'the feed is home; the Dex must never open on a form');
});

// The router's default is a state read, so exercise it rather than grep for it.
function getComputedRouteDefault() {
  return dex.DEX_ROUTES[0];
}

test('the feed lists ONLY curve coins, and tapping one opens that coin', () => {
  // A coin is a PumpToken this wallet deployed, trading on its own curve. The
  // old feed mixed three preset ERC-20s (no curve, tradeable only via a pool)
  // with curve coins, so tapping a row did different things depending on which
  // kind it was — the ambiguity again. Now every row is a coin.
  assert.ok(/const launched = launchedTokens\(\)/.test(tokensJs),
    'the feed must be built from launched tokens');
  assert.ok(!/DEX_PRESETS|dex-token-tag--native/.test(tokensJs),
    'the feed must not carry preset coins or a "native" row kind');
  assert.match(tokensJs, /onOpen\(row\.dataset\.dexToken\)/,
    'tapping a row must hand the address to the view so it can open that coin');
  assert.match(dexJs, /bindTokens\(host, \(address\) => openCoin\(address\)\)/,
    'the feed must route a tap straight to the coin page');
});

test('a coin page shows price, chart, tape and trade in one place', () => {
  // The ambiguity complaint was partly "chartnya kok terpisah" — price lived on
  // a different screen from trading. In the launchpad, one coin is one screen:
  // its live state, its chart, its tape and its buy/sell boxes together.
  for (const id of ['dexTradePrice', 'dexTradeGradFill', 'dexTradeChart', 'dexTradeTape',
                    'dexTradeBuy', 'dexTradeSell', 'dexTradeClaim', 'dexTradeGraduate']) {
    assert.ok(tradeJs.includes(`id="${id}"`), `the coin page must carry #${id}`);
  }
  assert.match(tradeJs, /drawCandles\(chartHost, candles/,
    'the coin page must render the TradingView candles');
  assert.match(tradeJs, /tradesHtml\(hist\.trades, state\.sym/,
    'the coin page must render the trade tape from the same read that fed the chart — '
    + 'and from the contract\'s ticker, which a chain-discovered coin does not have locally');
});

test('the launchpad\'s new UI is reachable by keyboard and by screen reader', () => {
  // New surfaces in the rebuild: the feed\'s launch bar and the trade tape.
  // Both carry meaning without colour or hover, so both must be nameable and
  // operable — a tape of divs reads as one run-on sentence to a screen reader.
  const tape = historyJs.slice(historyJs.indexOf('export function tradesHtml'));
  assert.match(tape, /<ul class="dex-trades" aria-label=/,
    'the trade tape must be a labelled list, not a pile of divs');
  assert.match(tape, /<li class="dex-trade-row/g,
    'each fill must be one list item, so it is counted as one');

  // The chart is an image to a screen reader; it needs a name and a role, or it
  // is skipped entirely and the price history is unreachable non-visually.
  assert.match(tradeJs, /<div id="dexTradeChart"[^>]*role="img"/,
    'the price chart must carry role="img"');
  assert.match(tradeJs, /id="dexTradeChart"[^>]*aria-label="\$\{escapeHtml\(t\('dex\.trade\.chartAria'\)\)\}"/,
    'and be named, so it is not skipped silently');

  // The launch bar\'s action is the one way to launch; it must be a real button
  // with text (not an icon or a bare div).
  assert.match(dexJs, /<button type="button" class="btn btn-primary" id="dexGoCreate">[\s\S]*?dex\.tab\.create/,
    'the launch action must be a labelled button, not an icon or a div');
  assert.match(dexJs, /<button type="button" class="btn btn-secondary btn-block mb-8" id="dexCreateBack">/,
    'Back must be a real button');
  assert.match(dexJs, /<button type="button" class="btn btn-secondary btn-block mt-8" id="dexCoinBack">/,
    'the unknown-coin way back must be a real button too');

  // The folded curve is a <details>, so it is keyboard-operable for free and
  // announced as collapsed — better than a custom toggle to get right.
  assert.match(tradeJs, /<details class="dex-curve-details/, 'the curve must fold behind <details>');
});

test('a coin page with no wallet still shows price, chart and tape', async () => {
  // Both bugs here were found in the BROWSER against a live anvil, not by a
  // unit test, and both made a coin look dead rather than unread:
  //
  //  1. balanceOf('0x0') — not a 20-byte address, so ethers rejected it, and
  //     because every read shared one Promise.all the visitor lost the PRICE,
  //     the market cap and the graduation bar, not just their own balance.
  //  2. The chart was only mounted inside the has-wallet branch, so a
  //     wallet-less visitor got an empty div — the "chart ga keliatan" report.
  //
  // So both are pinned on the source: a missing wallet may cost a BALANCE and
  // nothing else.
  assert.ok(!/balanceOf\(get\('address'\) \|\| '0x0'\)/.test(tradeJs),
    "balanceOf must not be called with '0x0' — that address is invalid and it took the whole page down");
  assert.match(tradeJs, /me \? c\.balanceOf\(me\) : Promise\.resolve\(0n\)/,
    'no wallet must mean "no balance", not "no price"');

  const chart = tradeJs.slice(tradeJs.indexOf('if (!p || !dexChainOk())'));
  assert.match(chart, /paintChart\(\[\]\)/,
    'the chart must mount with no wallet — an empty candlestick frame, not an empty div');
  assert.match(chart, /tradesHtml\(\[\], token\.symbol \|\| ''\)/,
    'the tape must say there are no trades rather than showing an empty box');

  // …and the price readout must be painted by the same refresh that reads the
  // curve, not by something wallet-gated.
  const refresh = tradeJs.slice(tradeJs.indexOf('const refresh = async'), tradeJs.indexOf('const quoteBuyLive'));
  assert.match(refresh, /dexTradePrice/,
    'the price readout is chain state, so it must not be inside a wallet-only path');
});

test('the chart and the tape come from ONE read of the coin\'s own events', () => {
  // Two separate reads could disagree — a chart at block N and a tape at N+1 —
  // and the user would see a price that contradicts the fill next to it. One
  // loadHistory() feeds both.
  const calls = tradeJs.match(/loadHistory\(/g) || [];
  assert.equal(calls.length, 1, 'loadHistory must be called exactly once per repaint');
  const fn = tradeJs.slice(tradeJs.indexOf('const paintHistory'));
  assert.ok(fn.indexOf('loadHistory') < fn.indexOf('tradesHtml'),
    'the tape must be painted from the history that was just read');
  assert.match(historyJs, /contract\.filters\.Bought\(\)/,
    'the history must read the contract\'s own Bought event');
  assert.match(historyJs, /contract\.filters\.Sold\(\)/,
    'the history must read the contract\'s own Sold event');
});

test('the launchpad lives in one folder, and only that folder', () => {
  // User order, twice, the second correcting the first:
  //   "fitur dex jangan disatuin itu fitur kayak launchpad token gitu, buat
  //    folder dex"  →  the Dex gets a folder of its own
  //   "jangan di satuin, taro di folder dex only"  →  the launchpad/create
  //    token feature goes IN THAT SAME FOLDER, not a sibling js/launchpad/.
  const dir = fileURLToPath(new URL('../js/dex', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

  assert.ok(files.includes('index.js'), 'js/dex/index.js — the launchpad view itself');
  assert.ok(files.includes('curve.js'), 'js/dex/curve.js — the bonding-curve maths');
  assert.ok(files.includes('chart.js'), 'js/dex/chart.js — the TradingView renderer');
  assert.ok(files.includes('pump-source.js'), 'js/dex/pump-source.js — the curve token contract');
  assert.ok(files.includes('tokens.js'), 'js/dex/tokens.js — the feed');
  assert.ok(files.includes('trade.js'), 'js/dex/trade.js — the coin page');
  assert.ok(files.includes('create.js'), 'js/dex/create.js — the launch form');
  assert.ok(files.includes('history.js'), 'js/dex/history.js — the trade tape the feed is missing');

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
                     'dex.needWallet',
                     'dex.welcome.title', 'dex.welcome.sub', 'dex.welcome.start',
                     'dex.tab.create',
                     'dex.tokens.title', 'dex.tokens.none', 'dex.tokens.unknown',
                     'dex.trades.title', 'dex.trades.none', 'dex.trades.buy', 'dex.trades.sell',
                     'dex.create.']) {
    const re = new RegExp(`'${key.replace(/\./g, '\\.').replace(/\\\.$/, '\\.')}`);
    for (const [lang, block] of [['en', en], ['id', id]]) {
      assert.ok(re.test(block), `${key} must be defined in the ${lang} block`);
    }
  }
});

// ── the four bugs the WEB found that no unit test could ─────────
// Each of these was found by pressing the real button in a browser against a
// live anvil. None of them is visible from a unit test, because each one only
// misbehaves once a real transaction is in flight.
test('a coin cannot be lost by refreshing the page', () => {
  // state.set() writes to an in-memory singleton: nothing survives a reload.
  // The feed read its coins from there, so every coin the user launched
  // vanished on refresh — contract live, gas spent, feed empty, no way back.
  const tokens = read('../js/dex/tokens.js');
  assert.match(tokens, /localStorage\.setItem/,
    'the launched-coin index must be persisted, not left in memory');
  assert.match(tokens, /LAUNCHED_KEY\}\.\$\{DEX_CHAIN_ID\}/,
    'and it must be scoped per chain, so mainnet never shows Sepolia coins');
  assert.ok(!/^export function launchedTokens\(\) \{\n?\s*return Array\.isArray\(get\('dex\.launched'\)\)/m.test(tokens),
    'the feed must not read its coins from volatile state alone');
});

test('the launch form shows real progress and always releases its button', () => {
  // (a) The button had no spinner while doing the longest job in the Dex —
  //     solc over the network, then a deploy — which is what "no loading
  //     animation" meant. (b) It managed its own disabled state, so one path
  //     could leave it stuck forever.
  const create = read('../js/dex/create.js');
  assert.match(create, /withTxButton\(btn, t\('dex\.create\.sending'\)/,
    'the launch button must run through withTxButton, like every other Dex action');
  assert.ok(!/btn\.disabled = true/.test(create),
    'the button state belongs to withTxButton alone — two owners is how it sticks');
  assert.ok(!/btn\.disabled = false/.test(create),
    'and nothing may re-enable it behind withTxButton\'s back');

  // (c) A fee label that threw before the deploy ever started.
  assert.ok(!/FEE_TOTAL_BPS \/ 100\b/.test(create),
    'FEE_TOTAL_BPS is a BigInt; dividing it by a Number threw and killed the whole launch');
  assert.match(create, /Number\(FEE_TOTAL_BPS\)/,
    'the fee must be converted explicitly');
});

test('the launch waits for the transaction ethers actually gives it', () => {
  // ethers v6 exposes the deploy tx as deploymentTransaction(). The old code
  // read the PROPERTY deployTransaction, which is undefined — so waitForReceipt
  // polled a transaction with no .wait() for the full 2-minute confirm timeout,
  // then reported failure for a coin that was live on chain all along.
  const create = read('../js/dex/create.js');
  assert.match(create, /contract\.deploymentTransaction\(\)/,
    'the deploy must be read through the v6 accessor');
  assert.ok(!/waitForReceipt\(contract\.deployTransaction\b/.test(create),
    'the undefined property must not come back');

  // A confirm timeout is not proof of failure: ask the chain whether the code is
  // there before telling the user their coin is gone.
  assert.match(create, /provider\.getCode\(addr\)/,
    'a timed-out confirm must be checked against the chain, not assumed dead');
});

test('every contract read the coin page makes must exist in the ABI', () => {
  // balanceOf was missing from PUMP_ABI while the page called it. ethers had no
  // such method, the read threw, and because the reads shared one Promise.all
  // the price, market cap and graduation bar all went blank with it.
  const abi = read('../js/dex/pump-source.js');
  for (const sig of ['function balanceOf(address owner) view returns (uint256)',
                     'function quoteToken() view returns (address)',
                     'function virtualQuote() view returns (uint256)',
                     'function virtualTokens() view returns (uint256)',
                     'function realQuoteReserve() view returns (uint256)',
                     'function graduated() view returns (uint256)',
                     'function creator() view returns (address)',
                     'function totalFeesCreator() view returns (uint256)']) {
    assert.ok(abi.includes(sig.replace(' view returns (uint256)', sig.endsWith('uint256') ? ' view returns (bool)' : '')),
      `PUMP_ABI must carry ${sig}`);
  }
  // The floor is enforced by the contract, so the ABI must carry it too — and
  // the app must send a floor, not just display one.
  const trade = read('../js/dex/trade.js');
  assert.match(trade, /cs\.buy\(amount, minOut\)/,
    'the buy must send the quote amount AND the floor to the contract');
  assert.match(trade, /quote\.approve\(token\.address, amount\)/,
    'an ERC-20 curve needs an allowance before it can pull funds — approve exactly this trade\'s amount');
  assert.ok(!/approve\([^)]*MaxUint256|approve\([^)]*MAX_UINT/.test(trade),
    'never an unlimited approval');
  assert.match(trade, /cs\.sell\(tok, minOut\)/,
    'the sell must send the floor to the contract');
  assert.match(trade, /dex\.trade\.worstCase/,
    'and the floor must be shown, or "enforced" is invisible to the user');
});

// ── the button must not promise more than the contract does ────
test('graduation says what actually happens, and what it does not', () => {
  // The button calls withdraw(), which sends the backing to the creator's own
  // wallet. It does NOT create a pool, seed liquidity, or migrate anything —
  // the token and its curve simply stop existing as a market. Labelling it
  // "Move liquidity out" read as a migration the contract never performs, which
  // is the same class of lie as a quote the chain does not honour.
  const i18n = read('../js/i18n.js');
  const contract = read('../js/dex/pump-source.js');

  assert.ok(/dex\.trade\.graduate': 'Withdraw backing to your wallet'/.test(i18n),
    'the button must describe the withdrawal it performs');
  assert.ok(!/dex\.trade\.graduate': '[^']*liquiditas (out|pindah)/i.test(i18n),
    'the button must not imply a pool migration it does not do');
  assert.ok(!/dex\.trade\.graduate': '[^']*migrate/i.test(i18n),
    'and must not promise a migration');

  // So the claim must be checkable: withdraw() pays the caller, and the
  // graduation exit must stay gated on both graduation AND the creator.
  assert.match(contract, /function withdraw\(\) external nonReentrant returns \(uint256\) \{\s*require\(msg\.sender == creator, "creator"\);\s*require\(graduated, "not graduated"\);\s*uint256 fees = totalFeesCreator;/,
    'withdraw must remain creator-only and post-graduation');

  // What the creator may take has two cases, and the difference is other
  // people's money. With providers in the pool, the backing is a promise made to
  // strangers. With nobody in it there is no promise to keep — and paying out
  // only the fee would lock every buyer's quote in the contract for ever.
  assert.match(contract, /uint256 backing = totalLpShares == 0 \? lpValue\(\) : 0;/,
    'the backing may only leave when there is no liquidity provider to owe it to');
  assert.match(contract, /uint256 amount = fees \+ backing;\s*totalFeesCreator = 0;\s*realQuoteReserve -= backing;/,
    'the fee and the backing are taken together, and the fee is cleared last so lpValue still subtracts it');

  // The failure this guards against is silent: the contract holds more than the
  // creator is owed, the creator claims it, and a buyer who sold earlier cannot
  // get their money out. So the check is on the ORDER, not just the arithmetic.
  const withdrawBody = contract.slice(contract.indexOf('function withdraw()'), contract.indexOf('function _mintTo'));
  assert.ok(withdrawBody.indexOf('lpValue()') < withdrawBody.indexOf('totalFeesCreator = 0;'),
    'lpValue must be read BEFORE the fee is zeroed — read after, the fee is counted twice and the payout exceeds the balance');

  // …and the same in every language: a button that says "take it out" while
  // paying out the pool is the kind of lie this test exists to catch.
});

// ── the two things that make a buy box usable ──────────────────
test('the buy box shows a balance and can fill itself by percentage', () => {
  // Typing an amount out of thin air is the friction that made the old box feel
  // amateur. You know your balance, so the useful answer to "how much?" is a
  // fraction of it — the same affordance every real launchpad has, and the one
  // thing the first pass left out entirely.
  for (const pct of [25, 50, 75, 100]) {
    assert.ok(tradeJs.includes(`data-dex-pct="${pct}"`) || tradeJs.includes(`[25, 50, 75, 100]`),
      `the buy box must offer a ${pct}% quick-fill`);
    assert.ok(tradeJs.includes(`data-dex-sell-pct="${pct}"`) || tradeJs.includes(`[25, 50, 75, 100]`),
      `the sell box must offer a ${pct}% quick-fill`);
  }
  assert.ok(tradeJs.includes('id="dexTradeQuoteBal"'), 'the buy box must show the quote balance');
  assert.ok(tradeJs.includes('id="dexTradeTokenBal"'), 'the sell box must show the holding');

  // The buttons divide a balance that was READ. A percentage of a stale or
  // invented number is how someone ends up sending an amount they did not mean.
  assert.match(tradeJs, /qc\.balanceOf\(me\)/,
    'the balance must be the QUOTE COIN\'s, read from chain — native ETH is gas only');
  assert.match(tradeJs, /if \(state\.quoteBal <= 0n\) return;/,
    'a zero balance must leave the box alone rather than fill zero');
  assert.match(tradeJs, /if \(state\.mine <= 0n\) return;/,
    'and the same for the sell side');

  // …and the percentage must come off the balance, not out of thin air.
  assert.match(tradeJs, /state\.quoteBal \* pct\) \/ 100n/,
    'a quick-fill must be that fraction of the balance held');
  assert.ok(!/getBalance\(me\)/.test(tradeJs),
    'nothing may read a NATIVE balance as the trading balance again');
});

test('the read order cannot silently swap two values', () => {
  // Found in the browser: ethBal was bound to the ticker STRING, so the balance
  // rendered as "Balance: NaN" while everything else looked fine. Destructuring
  // order and Promise.all order are two lists a reader has to match by eye, so
  // the order is pinned here.
  // Compare the two lists by where each read sits in the source, rather than by
  // parsing them — comments and line breaks make a regex fragile, and a fragile
  // gate is a gate that fails for the wrong reason.
  const fn = tradeJs.slice(tradeJs.indexOf('const refresh = async'));
  const destructured = fn.slice(fn.indexOf('const ['), fn.indexOf('] = await Promise.all'));
  const list = fn.slice(fn.indexOf('await Promise.all(['), fn.indexOf('])', fn.indexOf('await Promise.all([')));

  // Each name the destructuring claims must appear in that position in the list.
  const slots = ['virtualQuote', 'virtualTokens', 'realQuoteReserve', 'graduated',
                 'balanceOf', 'quoteToken', 'name', 'symbol'];
  let cursor = 0;
  for (const slot of slots) {
    const at = list.indexOf(slot + '(', cursor);
    assert.ok(at > -1, `the read list must contain ${slot}`);
    cursor = at + 1;
  }
  assert.ok(destructured.includes('quoteAddr') && destructured.includes('name') && destructured.includes('sym'),
    'the destructuring must claim the quote token, the name and the ticker');
  assert.ok(!destructured.includes('ethBal'),
    'there is no native balance on a curve quoted in an ERC-20');
});
