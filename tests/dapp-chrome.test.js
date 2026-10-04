// Bear Tool — dapp-chrome.test.js
//
// The browser chrome was re-laid-out to the shape OKX Wallet uses, taken from
// three screenshots of the real app rather than from a blog post:
//
//   TOP    [ ✕ ] [ 🔒 pill: url .... ] [ ★ ] [ 🔗 ] [ ⛓ chain badge ]
//   BOTTOM [ ‹ ] [ › ] [ ⟳ ] [ ⌂ ] [ ⋯ ]          ← five slots
//
// Two things must not regress while it looks like that.
//
//  1. The five navigation controls MOVED. Their ids did not change, and the
//     e2e suite clicks them by id — so every one of them is asserted to still
//     exist. A redesign that renames a control is a redesign that silently
//     orphans its tests.
//
//  2. window.open is dead weight here. Nothing in @capacitor/android overrides
//     WebChromeClient.onCreateWindow, so inside the APK that call returns null
//     and the click does nothing — which is exactly how "cannot browse" looked:
//     a sheet offering a button that never fired. Every use is now an anchor
//     with target=_blank, which both a desktop browser and the WebView honour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');

const shellStart = src.indexOf('const SHELL = `');
assert.ok(shellStart > -1, 'the chrome template exists');
const shell = src.slice(shellStart, src.indexOf('`;', shellStart));

// Ids of the DIRECT children of a block. Counting every id="…" in the slice
// would count #dbrNetIc — the span inside the badge — as a sibling of it, and
// the whole point of these assertions is which control sits where.
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
function topLevelIds(block) {
  const ids = [];
  let depth = 0;
  const re = /<(\/?)([a-z0-9]+)([^>]*)>/gi;
  let m;
  while ((m = re.exec(block))) {
    const [, close, tag, attrs] = m;
    if (close) { depth--; continue; }
    if (depth === 0) {
      const id = /id="([^"]+)"/.exec(attrs);
      if (id) ids.push(id[1]);
    }
    if (!VOID.has(tag.toLowerCase())) depth++;
  }
  return ids;
}

const topBar = shell.slice(shell.indexOf('class="dbr-top"'), shell.indexOf('class="dbr-tabs"'));
const bottomBar = shell.slice(shell.indexOf('class="dbr-bar"'));
const topIds = topLevelIds(topBar);
const bottomIds = topLevelIds(bottomBar);

test('top bar leads with ✕ and ends with the chain badge', () => {
  // Direct children with an id: the address pill is an un-id'd wrapper, so
  // #dbrSecure / #dbrUrl are asserted against it separately below.
  assert.deepEqual(topIds,
    ['dbrClose', 'dbrBm', 'dbrConnect', 'dbrNet'],
    '✕ first, then ★, 🔗, chain badge last');
  assert.ok(!topIds.includes('dbrBack'), 'navigation no longer crowds the top');
  // The verdict and the address share one pill, verdict first.
  assert.match(topBar, /<div class="dbr-urlwrap">\s*<span class="dbr-secure" id="dbrSecure"[\s\S]*?<input[^>]*id="dbrUrl"/,
    'status then address, inside the same pill');
  // The icon is inside the badge, not beside it.
  assert.match(topBar, /id="dbrNet"[^>]*>[\s\S]*?id="dbrNetIc"/, 'the icon is nested in the badge');
});

test('the bottom bar is exactly five controls, in order', () => {
  // The slice starts inside the wrapper tag, so #dbrBar itself is checked
  // against the whole shell rather than against its own cut edge.
  assert.match(shell, /id="dbrBar"[^>]*role="toolbar"/, 'the bar is a toolbar, not a stray row');
  assert.deepEqual(bottomIds,
    ['dbrBack', 'dbrFwd', 'dbrReload', 'dbrHome', 'dbrMenu'],
    'back, forward, reload, home, menu — five slots, one per action');
  assert.equal(topIds.length + bottomIds.length, 9,
    'the chrome did not sprout unaccounted controls');
});

test('every control the e2e suite clicks by id is still in the shell', () => {
  // The redesign moves these; it must never rename them.
  for (const id of ['dbrBack', 'dbrFwd', 'dbrReload', 'dbrHome', 'dbrMenu',
    'dbrBm', 'dbrUrl', 'dbrSecure', 'dbrConnect', 'dbrTabs', 'dbrStage',
    'dbrFrame', 'dbrBlocked', 'dbrHomePage', 'dbrLoading', 'dbrLoadingTxt',
    'dbrMenuPop', 'dbrBar']) {
    assert.match(shell, new RegExp(`id="${id}"`), `${id} was dropped by the redesign`);
  }
});

test('the new chrome ids are wired, not decorative', () => {
  assert.match(src, /close: overlay\.querySelector\('#dbrClose'\)/, 'close is bound');
  assert.match(src, /net: overlay\.querySelector\('#dbrNet'\)/, 'chain badge is bound');
  assert.match(src, /el\.close\.addEventListener\('click', \(\) => close\(\)\)/, '✕ closes');
  assert.match(src, /el\.net\.addEventListener\('click', switchNetworkFromBrowser\)/, 'badge opens the picker');
});

test('the chain badge tracks the active network', () => {
  assert.match(src, /function paintNetwork\(\)/, 'there is a painter');
  assert.match(src, /getNetworkById\(get\('networkId'\)\)/, 'it reads the real network, not a copy');
  assert.match(src, /on\('networkId', paintNetwork\)/, 'and follows changes while the browser is open');
  assert.match(src, /net\.icon/, 'icon comes from the NETWORKS table');
  assert.match(src, /net\.color/, 'colour comes from the NETWORKS table');
});

test('the network picker is not hidden behind the browser', () => {
  // .modal-overlay is z-index 1000, this overlay 9000 — a straight click would
  // put the sheet behind the browser and read as a broken button.
  assert.match(src, /overlay\.style\.zIndex = '999'/, 'browser steps under the modal');
  assert.match(src, /overlay\.style\.zIndex = ''/, 'and is restored afterwards');
});

test('no executable window.open remains', () => {
  // Every occurrence must be prose. A live one is a button that does nothing
  // inside the APK, which is the bug this whole file guards.
  const live = src.split('\n')
    .map((line, i) => [line, i + 1])
    .filter(([line]) => line.includes('window.open'));
  for (const [line, n] of live) {
    const t = line.trimStart();
    assert.ok(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'),
      `js/dapp-browser.js:${n} still calls window.open: ${line.trim().slice(0, 70)}`);
  }
  assert.match(src, /function openExternal\(url\)/, 'one shared escape hatch exists');
  assert.match(src, /a\.target = '_blank'/, 'target=_blank — honoured by the WebView too');
  assert.match(src, /a\.rel = 'noopener noreferrer'/, 'and opened without an opener');
});

test('a site that refuses framing still offers WalletConnect', () => {
  // The project id is already wired in walletconnect.js; the dead-end sheet is
  // where it has to be reachable, because the page itself never loads.
  assert.ok((src.match(/data-act="wc"/g) || []).length >= 2,
    'both refusal screens offer pairing, not just the timeout one');
  assert.match(src, /import \{ openPairWalletConnect \} from '\.\/walletconnect\.js'/);
});

test('the bottom bar is drawn and thumb-sized', () => {
  assert.match(css, /\.dbr-bar\s*\{/, 'bar styles exist');
  assert.match(css, /\.dbr-bbtn\s*\{/, 'slot styles exist');
  assert.match(css, /min-height: var\(--touch-min, 44px\)/, 'four-slot height for thumbs');
  assert.match(css, /\.dbr-net-ic\s*\{/, 'chain badge is styled');
  assert.match(css, /--net-color/, 'badge takes the chain colour as a custom property');
  assert.ok(!/\.dbr-top[^}]*flex-wrap: wrap/.test(css), 'the top bar must not wrap');
});

test('home categories wear OKX-style icon tiles; bookmark chips keep the pill face', () => {
  // Same face-lift on the overlay home ("rombak UI/UX dApps, ikon OKX"). The
  // base .dbr-chip class is shared by the category row AND the bookmark/recent
  // chips, so only the .dbr-chip-cat modifier may restyle — a blanket change
  // would repaint rows that are fine as pills.
  assert.match(src, /class="dbr-chip dbr-chip-cat[^"]*"/,
    'the category row carries the tile modifier (bookmark chips must not)');
  assert.ok(src.includes('dbr-chip-ic'), 'each category chip carries an icon tile span');
  assert.ok(/dbr-chip-cat[^>]*--cat:/.test(src), 'tile colour rides as --cat inline');

  // CSS: tile faces exist for both surfaces, and cards wear a logo tile too.
  assert.match(css, /\.dbr-chip-ic\s*\{/, 'browser tile face style must exist');
  assert.match(css, /\.dbr-chip-cat\.on\s*\{/, 'active category paints the tile');
  assert.match(css, /\.dapp-chip-ic\s*\{/, 'view chips get the same tile face');
  assert.match(css, /\.dapp-icon\s*\{[^}]*border-radius/,
    'catalogue cards wear a logo tile, not a bare emoji');

  // The dark-theme forced-dark text list exists because the active chip's LABEL
  // used to sit on a honey fill. The fill moved into the icon tile; keeping the
  // label in that list would paint it #2D2A32 on the dark background.
  const at = css.indexOf('.theme-dark :is(');
  const darkList = css.slice(at, css.indexOf(') {', at));
  assert.ok(at > -1 && !darkList.includes('.dapp-chip.active'),
    'the active chip label no longer sits on a fill — drop it from the forced-dark list');
});
