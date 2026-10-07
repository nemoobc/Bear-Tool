// Bear Tool — dapp-chrome.test.js
//
// The browser chrome was re-laid-out to the shape OKX Wallet uses, taken from
// three screenshots of the real app rather than from a blog post; refreshed
// 2026-10-07 (rombak): the ★ button is gone, the address pill is dead-center,
// the tab counter stays right, and the ⋯ menu is a floating bubble.
//
//   TOP    [ ✕ ] [ 🔒 pill: url, centered .... ] [ 🔗 ] [ ⛓ chain badge ] [ ▢n ]
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
    // The slice starts INSIDE its wrapper's opening tag, so that wrapper's own
    // close is the first </…> seen. Without the floor it drove depth to -1 and
    // every id that followed (the load bar, added 2026-10-05) fell out of the
    // count while its children counted as top-level.
    if (close) { depth = Math.max(0, depth - 1); continue; }
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

test('top bar leads with ✕, centers the pill, ends with the load bar', () => {
  // Direct children with an id: the address pill is an un-id'd wrapper, so
  // #dbrSecure / #dbrUrl are asserted against it separately below.
  // The chain badge still closes the BUTTONS; after it come the tab-count
  // button (OKX's switcher opener) and the load bar's track — neither is a
  // navigation control, both were added on purpose. The ★ is gone (2026-10-07).
  // #dbrExt (↗, 2026-10-07) is the permanent escape hatch: a frame that renders
  // nothing cannot be detected (the error page fires "load"), so the way out of
  // an embedding refusal lives in the toolbar, one press away, never behind a menu.
  assert.deepEqual(topIds,
    ['dbrClose', 'dbrExt', 'dbrConnect', 'dbrNet', 'dbrTabsBtn', 'dbrLoadbar'],
    '✕ first, then ↗, 🔗, chain badge, tab count, load bar — no star');
  assert.ok(!topIds.includes('dbrBm'), 'the bookmark star was removed from the toolbar');
  assert.ok(!topIds.includes('dbrBack'), 'navigation no longer crowds the top');
  // The verdict and the address share one pill, verdict first.
  assert.match(topBar, /<div class="dbr-urlwrap">\s*<span class="dbr-secure" id="dbrSecure"[\s\S]*?<input[^>]*id="dbrUrl"/,
    'status then address, inside the same pill');
  // The icon is inside the badge, not beside it.
  assert.match(topBar, /id="dbrNet"[^>]*>[\s\S]*?id="dbrNetIc"/, 'the icon is nested in the badge');
});

test('css: the pill is centered and the icons are pinned right', () => {
  // The address must sit at the visual center REGARDLESS of how wide the left
  // ✕ and the right icon cluster are — absolute centering, not flex luck.
  assert.match(css, /\.dbr-urlwrap\s*\{[^}]*position: absolute/, 'the pill is taken out of the flow');
  assert.match(css, /\.dbr-urlwrap\s*\{[^}]*left: 50%[^}]*transform: translateX\(-50%\)/,
    'dead center: left:50% then pull back half its own width');
  // margin-right:auto on the FIRST button only — one auto margin pulls the
  // whole icon cluster (🔗 ⛓ tab count) to the right edge.
  assert.match(css, /\.dbr-top\s*\{[^}]*position: relative/, 'the bar is the pill\'s positioning box');
  assert.match(css, /\.dbr-top > #dbrClose\s*\{[^}]*margin-right: auto/,
    'the ✕ pins the icons right without wrapping them in a group');
});

test('the bottom bar is exactly five controls, in order', () => {
  // The slice starts inside the wrapper tag, so #dbrBar itself is checked
  // against the whole shell rather than against its own cut edge.
  assert.match(shell, /id="dbrBar"[^>]*role="toolbar"/, 'the bar is a toolbar, not a stray row');
  assert.deepEqual(bottomIds,
    ['dbrBack', 'dbrFwd', 'dbrReload', 'dbrHome', 'dbrMenu'],
    'back, forward, reload, home, menu — five slots, one per action');
  assert.equal(topIds.length + bottomIds.length, 11,
    'the chrome did not sprout unaccounted controls (6 top ids incl. ↗, tab count, load bar + 5 bottom)');
});

test('every control the e2e suite clicks by id is still in the shell', () => {
  // The redesign moves these; it must never rename them. #dbrBm is the one
  // control DELIBERATELY dropped (the toolbar star, 2026-10-07) — bookmarking
  // moved into the ⋯ menu, so its absence is asserted, not overlooked.
  for (const id of ['dbrBack', 'dbrFwd', 'dbrReload', 'dbrHome', 'dbrMenu',
    'dbrUrl', 'dbrSecure', 'dbrExt', 'dbrConnect', 'dbrTabs', 'dbrStage',
    'dbrFrame', 'dbrBlocked', 'dbrHomePage', 'dbrLoading', 'dbrLoadingTxt',
    'dbrMenuPop', 'dbrBar']) {
    assert.match(shell, new RegExp(`id="${id}"`), `${id} was dropped by the redesign`);
  }
  assert.ok(!shell.includes('dbrBm'), 'the star button is gone — bookmarking lives in the ⋯ menu');
  assert.ok(!/id="dbrBm"/.test(src), 'no leftover #dbrBm wiring in the module');
  assert.match(src, /\['bm', isBookmarked\(t\?\.url\)/, 'the ⋯ menu still offers bookmark toggle');
});

// Hidden means hidden — for the whole sheet, not per component. The tab grid
// intercepted every click on the report behind it through its own hidden
// attribute, because .dbr-tabgrid's display:flex outranked the UA sheet. The
// lock is global on purpose: the next display:flex written beside a hidden
// element must not be able to repeat it.
test('css: the hidden attribute outranks every author display rule', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/,
    'one global lock — a component-specific exception is the bug coming back');
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
  // Every app modal must stack above .dapp-browser-overlay: at the old 1000
  // vs 9000 the picker (and the WC pair sheet) opened BEHIND the browser and
  // read as a broken button — the iframe swallowed every click.
  const zOf = (sel) => Number(
    (css.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{[^}]*z-index:\\s*(\\d+)', 's')) || [])[1]
  );
  const modalZ = zOf('.modal-overlay');
  const browserZ = zOf('.dapp-browser-overlay');
  assert.ok(modalZ > browserZ,
    `modal (${modalZ}) stacks above the browser overlay (${browserZ})`);
  assert.ok(!/style\.zIndex/.test(src),
    'no per-call z-index dance — the stack order lives in one place, the CSS');
});

test('Escape lets an open app modal keep the browser alive', () => {
  // Regression 2026-10-07: Escape in the WC pair sheet closed the pair AND
  // the whole browser underneath it — this handler never asked whether a
  // modal owned the press.
  const keydown = src.slice(src.indexOf("document.addEventListener('keydown'"));
  assert.match(keydown, /modalOverlay.*classList\.contains\('open'\)/,
    'the Escape branch bails while #modalOverlay is open');
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

// The ⋯ menu was re-laid-out as an OKX-style floating bubble (2026-10-07):
// anchored bottom-right above the control bar, large radius, blurred glass,
// deep shadow, and a corner scale-in. What must never regress is that it is
// STILL a popup floating over the stage with its rows intact.
test('the ⋯ menu is a floating bubble anchored above the control bar', () => {
  const at = css.indexOf('.dbr-menu {');
  assert.ok(at > -1, '.dbr-menu rule exists');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /position: absolute/, 'it floats');
  assert.match(rule, /bottom: calc\(64px/, 'anchored above the bottom bar, not the top');
  assert.ok(!/top: 50px/.test(rule), 'the old top-anchored dropdown is gone');
  assert.match(rule, /border-radius: 18px/, 'a bubble, not a card');
  assert.match(rule, /backdrop-filter: blur/, 'glass blur');
  assert.match(rule, /box-shadow: 0 18px 50px/, 'deep shadow — it reads as floating');
  assert.match(css, /@keyframes dbr-menu-in/, 'it animates in from its corner');
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.dbr-menu\s*\{\s*animation: none/,
    'and respects reduced motion');
  // Rows keep their menu semantics.
  assert.match(src, /role="menuitem" data-mi=/, 'rows are menu items');
});

// The timeout sheet was walled off over a page that was actually ALIVE: Aave
// renders while its load event still takes ~38s, and at the 20s timeout the
// report covered the middle of a working dApp. The panel stays; everything
// outside it clicks through to the page behind it.
test('the did-not-load sheet does not wall off a page rendering behind it', () => {
  assert.match(css, /\.dbr-blocked\s*\{[^}]*pointer-events:\s*none/,
    'the sheet layer lets clicks through to the frame');
  assert.match(css, /\.dbr-report\s*\{[^}]*pointer-events:\s*auto/,
    'the panel itself keeps every one of its buttons');
  // The wording must admit the slow case instead of accusing the site — the
  // old "never rendered here" was false the moment the page WAS rendering.
  assert.match(src, /did not finish loading in time/,
    'the report admits a slow load as a first-class outcome');
  assert.match(src, /if you can see\s+the page behind this sheet/,
    'the report points at the visible page instead of denying it');
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

// ── the sheets that say "no" and the pill that says "where you are" ──────

test('the refusal sheet always states the reason for THIS attempt', () => {
  // Regression pin: the blocked panel once kept whatever the PREVIOUS attempt
  // left on screen — refusing javascript:alert() could show a homograph
  // warning about some other site. The sheet is rewritten whole, from the
  // reason passed to THIS call.
  const fn = src.slice(src.indexOf('function schemeSheet('), src.indexOf('/** The pre-load sheet'));
  assert.ok(fn.length > 0, 'schemeSheet must exist');
  assert.ok(fn.includes('el.blocked.innerHTML = `'), 'the panel is fully rewritten, never patched');
  assert.match(fn, /escapeHtml\(reason\)/, "the current attempt's reason is what shows");
  assert.ok(fn.includes('el.blocked.hidden = false'), 'the panel is shown');
  assert.ok(fn.includes('el.frame.hidden = true'), 'the frame stays behind it');
});

test('reportSheet: a DANGER verdict removes the proceed button even if a caller lied', () => {
  // Defence in depth: navigate() already refuses canProceed for DANGER, but
  // the button must be physically absent here too — one caller mistake away
  // from "Open anyway" on a homograph must not be survivable.
  const at = src.indexOf('function reportSheet(');
  const fn = src.slice(at, src.indexOf('// ═══', at));
  assert.ok(fn.length > 0, 'reportSheet must exist');
  assert.match(fn, /\$\{canProceed \? '<button[^>]*data-act="proceed"/,
    'the proceed button only exists behind canProceed');
  assert.match(fn, /if \(v\.verdict === VERDICT\.DANGER\) el\.blocked\.querySelector\('\[data-act="proceed"\]'\)\?\.remove\(\)/,
    'DANGER strips the button downstream regardless of what the caller passed');
});

test('the secure pill knows every verdict and shows what it saw', () => {
  const fn = src.slice(src.indexOf('function paintSecure('), src.indexOf('function paint('));
  assert.ok(fn.length > 0, 'paintSecure must exist');
  for (const v of ['KNOWN', 'CAUTION', 'DANGER', 'BLOCKED']) {
    assert.ok(fn.includes(`[VERDICT.${v}]`), `the pill must map VERDICT.${v} — an unmapped verdict paints an empty pill`);
  }
  assert.match(fn, /verdict\.signals\.map/, 'the tooltip lists every signal, not just the worst one');
  assert.match(fn, /el\.secure\.textContent/, 'the verdict is painted where the user looks');
});

test('back and forward stay inside the stack and persist the move', () => {
  const fn = src.slice(src.indexOf('function back()'), src.indexOf('function isBookmarked('));
  assert.match(fn, /t\.i <= 0\) return/, 'back at the first entry is a no-op');
  assert.match(fn, /t\.i >= t\.hist\.length - 1\) return/, 'forward at the last entry is a no-op');
  assert.equal((fn.match(/saveSession\(\)/g) || []).length, 2, 'both directions persist the pointer');
  assert.equal((fn.match(/loadedUrl = ''/g) || []).length, 2, 'both forget what the frame was showing');
});

// G1 (riset dApps 2026-10-07): clipboard-write is a DELEGATED permission —
// the default allowlist is 'self', so a cross-origin dApp inside this frame
// cannot copy the wc: pairing URI out of a WalletConnect modal unless THIS
// parent grants it. Without the grant the in-app connect path
// (Connect -> WalletConnect -> copy the wc: link -> pair here) dead-ends at
// the copy step and the dApp is unusable. Sources: W3C Permissions Policy
// §4.8 default allowlists; Chromium issue 40128045 ("the Clipboard API is
// therefore currently not accessible to cross-origin iframes"); MDN
// Clipboard API. A silently emptied allow="" is exactly the regression this
// pins.
test('the frame delegates clipboard-write so a dApp can copy its wc: URI', () => {
  const iframe = shell.slice(shell.indexOf('<iframe'), shell.indexOf('</iframe>'));
  assert.ok(iframe.length > 0, 'the SHELL carries the dApp frame');
  assert.match(iframe, /allow="clipboard-write"/, 'the iframe grants clipboard-write');
  assert.doesNotMatch(iframe, /allow=""/, 'the allow attribute is never left empty');
});

test('↗ #dbrExt: the permanent escape hatch from a frame that renders nothing', () => {
  // Measured 2026-10-07: Chromium fires a normal "load" for its X-Frame-Options
  // error page (google.com: LOAD at 5.6s), so no watchdog can catch the refusal
  // — the frame just sits there showing a sad-page icon. The way out therefore
  // cannot depend on detection: it is a toolbar button that is always there.
  assert.match(shell, /id="dbrExt"[^>]*hidden/,
    'the ↗ exists and starts hidden — the home stage has no URL to open');
  assert.match(src,
    /el\.ext\?\.addEventListener\('click', \(\) => \{ const t = active\(\); if \(t\?\.url\) openExternal\(t\.url\); \}\)/,
    'the ↗ opens the active tab through openExternal (target=_blank anchor, not window.open)');
  assert.match(src, /if \(el\.ext\) el\.ext\.hidden = true;/, 'paint(): home hides the ↗');
  assert.match(src, /if \(el\.ext\) el\.ext\.hidden = false;/, 'paint(): a real page shows the ↗');

  // The CAUTION sheet carries the same door, so a non-catalogue URL never
  // forces the user through the frame first: both exits sit side by side.
  const at = src.indexOf('function reportSheet(');
  assert.ok(at > -1, 'reportSheet exists');
  const fn = src.slice(at, src.indexOf('function openExternal', at));
  assert.match(fn, /data-act="ext">↗ Open in a new tab</,
    'the pre-load sheet offers ↗ next to "Open anyway"');
  assert.match(fn, /querySelector\('\[data-act="ext"\]'\)\?\.addEventListener\('click'/,
    'the sheet ↗ button is wired');
  assert.match(fn, /querySelector\('\[data-act="ext"\]'\)\?\.remove\(\)|data-act="ext"/,
    'the door exists in the template');
});
