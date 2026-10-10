// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapps.test.js
// DApps browser: render, popular list, navigation
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './helpers/app-source.mjs';

const dappsSrc = readFileSync(new URL('../js/dapps.js', import.meta.url), 'utf8');
// The browser moved into its own module; the browser assertions below are
// checked against that file, and the catalogue ones against dapps.js.
const browserSrc = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');
// Shared helper that renders the tile-marks (dappMark lives here).
const uiSrc = readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
// Halaman = index.html + section view (M2: src/views/*.jsx).
const htmlSrc = appSource();

test('dapps: exports renderDapps function', () => {
  assert.match(dappsSrc, /export\s+function\s+renderDapps/);
});
test('dapps: the outward "new tab" split is web-only — native builds are all in-app', () => {
  // The APK opens every dApp in a full-page WebView (X-Frame-Options does not
  // apply one level up), so renderDapps must never advertise a New-tab section
  // or an ↗ badge on the native build — the UI says in-app for everything.
  assert.match(dappsSrc, /const native = isNativeDappBrowser\(\);/,
    'renderDapps harus kenal build native (APK) vs web');
  assert.match(dappsSrc, /data-frameable="\$\{native \|\| d\.frameable \? '1' : '0'\}"/,
    'kartu native = frameable 1 (in-app) — frameability adalah batas WEB saja');
  assert.match(dappsSrc, /native \|\| d\.frameable \? 'In-app' : '↗ New tab'/,
    'badge native = In-app untuk SEMUA kartu, tidak ada ↗ New tab');
  assert.match(dappsSrc, /const inTab = native \? \[\] : POPULAR_DAPPS\.filter/,
    'section "new tab" tidak dirender di native (list kosong)');
  assert.match(dappsSrc, /!list\.length \? '' :/,
    'section kosong = tidak ada markup sama sekali');
});
test('dapps: exports POPULAR_DAPPS', () => {
  assert.ok(dappsSrc.includes('POPULAR_DAPPS'), 'POPULAR_DAPPS must exist');
  assert.ok(dappsSrc.includes('export'), 'must be exported');
});
test('dapps: has at least 5 popular DApps', () => {
  const count = (dappsSrc.match(/\{ name:/g) || []).length;
  assert.ok(count >= 5, `Expected >=5 DApps, got ${count}`);
});
test('dapps: includes Uniswap', () => {
  assert.match(dappsSrc, /Uniswap/);
});
test('dapps: includes Aave', () => {
  assert.match(dappsSrc, /Aave/);
});
test('dapps: includes OpenSea', () => {
  assert.match(dappsSrc, /OpenSea/);
});
test('dapps: has in-app browser (iframe overlay)', () => {
  assert.match(dappsSrc, /openDappBrowser/, 'must have openDappBrowser function');
  assert.match(browserSrc, /export function openDappBrowser/, 'the browser module must own the real entry point');
  assert.match(browserSrc, /dapp-browser-overlay/, 'must create overlay');
  assert.match(browserSrc, /<iframe/, 'must use an iframe for in-app browsing');
});
test('dapps: has external tab fallback', () => {
  assert.match(browserSrc, /window\.open/, 'external button opens new tab');
});
test('dapps: no old standalone dappFrame id', () => {
  assert.ok(!browserSrc.includes('id="dappFrame"'), 'old dappFrame removed');
});
test('dapps: index.html has DApps nav item', () => {
  assert.match(htmlSrc, /data-view="dapps"/);
});
test('dapps: page has DApps view section', () => {
  assert.match(htmlSrc, /id="view-dapps"/);
});
test('dapps: page has DApps container', () => {
  assert.match(htmlSrc, /id="dappsContainer"/);
});

// ── the frame must not be a free gift to whatever loads in it ───────────
test('dapps: the in-app frame is hardened', () => {
  assert.match(browserSrc, /referrerpolicy="no-referrer"/, 'must not leak the wallet URL as a referrer');
  assert.match(browserSrc, /credentialless/, 'must run without ambient cookies or storage');
  assert.match(browserSrc, /'allow-scripts allow-forms allow-popups allow-modals'/,
    'sandbox must stay minimal at its base: no popups-to-escape-sandbox, no top navigation');
  // The markup itself never carries allow-same-origin — it is granted per
  // navigation by sandboxFor(), and only across origins. A literal in the
  // static sandbox attribute would be the unguarded version this file used to
  // refuse (and would hand a same-origin page this app's localStorage, where
  // the keystore lives). See dapp-browser-imports.test.js for the guard's unit
  // tests: cross-origin gets the flag, this origin never does.
  assert.ok(!/sandbox="[^"]*allow-same-origin/.test(browserSrc),
    'allow-same-origin must never be in the static markup — only behind the sandboxFor guard');
  assert.ok(!/sandbox="[^"]*escape-sandbox/.test(browserSrc), 'escaping the sandbox would defeat the sandbox');
  // 2026-10-07 (riset dApps / G1): the empty allow="" is gone. clipboard-write
  // is a DELEGATED permission (default allowlist 'self' — W3C Permissions
  // Policy §4.8; Chromium #40128045), so without the grant a cross-origin dApp
  // cannot copy its wc: pairing URI and the in-app connect path dead-ends.
  // Microphone, camera, geolocation and payment stay closed: they are never
  // granted here, and their default allowlist already excludes cross-origin.
  assert.match(browserSrc, /allow="clipboard-write"/,
    'the frame delegates clipboard-write — the wc: copy step needs it');
  assert.ok(!/allow="[^"]*(microphone|camera|geolocation|payment|fullscreen)/.test(browserSrc),
    'nothing but clipboard-write is ever granted to the frame');
  // The guard must actually be applied on every navigation, before the src.
  const navAt = browserSrc.indexOf('setAttribute(\'sandbox\', sandboxFor(');
  const srcAt = browserSrc.indexOf('el.frame.src = t.url');
  assert.ok(navAt !== -1, 'paint() must decide the sandbox per navigation');
  assert.ok(navAt < srcAt, 'the sandbox must be set BEFORE the src — after the load it is too late');
});

// The load bar: a real page load reports no progress to an embedding frame,
// so the bar runs a phase (0→70% while loading, snap to 100% on load, hide on
// failure). Every lifecycle hook must be wired or the bar would lie forever.
test('dapps: load bar is wired to every load outcome', () => {
  assert.match(browserSrc, /id="dbrLoadbar"/, 'the track must exist in the shell');
  assert.match(browserSrc, /id="dbrLoadbarFill"/, 'the fill must exist in the shell');
  assert.match(browserSrc, /loadbarStart\(\)/, 'navigation must start the bar (armLoadTimeout)');
  assert.match(browserSrc, /loadbarDone\(\)/, 'a finished load must complete the bar');
  assert.match(browserSrc, /loadbarFail\(\)/, 'a failed load must hide the bar, not freeze it');
  // Start is armed exactly inside armLoadTimeout, before the phases.
  const armAt = browserSrc.indexOf('function armLoadTimeout');
  const startAt = browserSrc.indexOf('loadbarStart()', armAt);
  const phaseAt = browserSrc.indexOf('LOAD_PHASE_MS.slow', armAt);
  assert.ok(armAt !== -1 && startAt > armAt && startAt < phaseAt,
    'the bar must start when the watchdog is armed — before the phases run');
  // Done must sit inside the frame "load" listener.
  const loadAt = browserSrc.indexOf("addEventListener('load'");
  const doneAt = browserSrc.indexOf('loadbarDone()', loadAt);
  assert.ok(loadAt !== -1 && doneAt > loadAt && doneAt < loadAt + 400,
    'the load listener must complete the bar');
});

// The tab switcher grid — OKX's card layout with MetaMask's 20-tab ceiling.
test('dapps: tab grid switcher is wired end to end', () => {
  assert.match(browserSrc, /id="dbrTabsBtn"/, 'the top-bar count button must exist');
  assert.match(browserSrc, /id="dbrTabGrid"/, 'the grid dialog must exist');
  assert.match(browserSrc, /const MAX_TABS = 20/, 'the ceiling is MetaMask\'s, pinned');
  assert.match(browserSrc, /tabs\.length >= MAX_TABS/, 'addTab must enforce the ceiling');
  assert.match(browserSrc, /el\.tabsBtn\?\.addEventListener\('click', \(\) => toggleTabGrid\(\)\)/,
    'the count button must open the grid');
  assert.match(browserSrc, /toggleTabGrid\(true\)/, 'closing a card re-renders the open grid');
  // Escape must close the grid before it closes the whole browser.
  const escAt = browserSrc.indexOf("e.key === 'Escape'");
  const gridAt = browserSrc.indexOf('toggleTabGrid(false); return;', escAt);
  const closeAt = browserSrc.indexOf('close();', escAt);
  assert.ok(gridAt !== -1 && closeAt !== -1 && gridAt < closeAt,
    'Escape must dismiss the grid first, the overlay second');
  // The count must track the tabs.
  assert.match(browserSrc, /el\.tabsBtn\.textContent = String\(tabs\.length\)/,
    'the button must show how many tabs are open');
});

// The report sheet must be reversible: at 20s it may be WRONG (Aave loads at
// ~38s), so "Show the page" lets the user look behind it and the ⚠ chip is the
// way back until a real "load" retires both.
test('dapps: the did-not-load report can be dismissed and reopened', () => {
  assert.match(browserSrc, /data-act="peek"/, 'the sheet must offer "Show the page"');
  assert.match(browserSrc, /id="dbrPeak"/, 'the ⚠ chip must exist');
  assert.match(browserSrc, /el\.peak\.onclick = \(\) => showDidNotLoad\(\)/, 'the chip reopens the report');
  assert.match(browserSrc, /const LOAD_PHASE_MS = \{[^}]*timeout: 20000/,
    '20s: slow enough for a heavy dApp, inside the e2e 25s window');
  // Both paths that mean "a real page state began" must retire the chip.
  const loadAt = browserSrc.indexOf("addEventListener('load'");
  assert.ok(browserSrc.indexOf('el.peak.hidden = true', loadAt) - loadAt < 500,
    'a finished load hides the chip');
  assert.match(browserSrc, /if \(el\.peak\) el\.peak\.hidden = true; \/\/ a new navigation/,
    'a new navigation hides it too');
});

test('dapps: every navigation goes through the security gate', () => {
  assert.match(browserSrc, /inspectUrl\(/, 'the gate must be called');
  assert.match(browserSrc, /VERDICT\.DANGER/, 'danger must be handled');

  // The DANGER branch must pass canProceed:false, and the sheet must only draw
  // a "continue" button when it was told it may. Together those two are what
  // stop a homograph from having an "open anyway" button.
  const from = browserSrc.indexOf('if (v.verdict === VERDICT.DANGER)');
  const dangerBranch = browserSrc.slice(from, browserSrc.indexOf('if (v.verdict', from + 10));
  assert.match(dangerBranch, /canProceed: false/, 'a DANGER verdict must not be passable');
  assert.ok(!/canProceed: true/.test(dangerBranch), 'a DANGER verdict must not offer a way past it');
  assert.match(browserSrc, /canProceed \? '<button class="btn btn-sm btn-primary" data-act="proceed"/,
    'the continue button must be conditional on being allowed to');
});

test('dapps: a pasted secret is refused and never stored', () => {
  assert.match(browserSrc, /isSecretishUrl/, 'URLs that look like a seed phrase must be checked');
  assert.match(browserSrc, /sanitizeForStore/, 'history and bookmarks must be sanitised');
});

test('dapps: kartu pakai tile-mark deterministik, bukan emoji mentah (daftar & browser chrome)', () => {
  // name/category/url sudah lewat escapeHtml; emoji `d.icon` sebelumnya
  // tertanam mentah ke innerHTML dan bisa kosong (2026-10-10: kartu dApps
  // tampil tanpa logo). Sekarang KEDUA tampilan memakai dappMark() — tile
  // gradien + inisial yang SELALU render, warna dari kategori.
  assert.match(dappsSrc, /dappMark\(d\.name, catStyle\(d\.category\)\.color/,
    'renderDapps harus memakai tile-mark (warna kategori + inisial)');
  assert.ok(!/\$\{d\.icon\}/.test(dappsSrc),
    'd.icon tidak boleh dipasang lagi di js/dapps.js');
  assert.match(browserSrc, /dappMark\(d\.name, catFace\(d\.category \|\| ''\)\.color/,
    'cardHTML harus memakai tile-mark yang sama');
  assert.ok(!/\$\{d\.icon \|\|/.test(browserSrc),
    'd.icon tidak boleh dipasang lagi di js/dapp-browser.js');
  // …dengan helper yang benar-benar diimpor di kedua modul.
  assert.match(dappsSrc, /import \{ escapeHtml, dappMark \} from '\.\/ui\.js'/);
  assert.match(browserSrc, /import \{ escapeHtml, toast, dappMark \} from '\.\/ui\.js'/);
  // Dan helper itu sendiri ada + aman buat markup (nama di-escape, ada fallback).
  assert.match(uiSrc, /export function dappMark\(name, color, size = 40\)/,
    'dappMark harus tinggal di ui.js supaya dua modul pakai satu sumber');
  assert.match(uiSrc, /escapeHtml\(color \|\| '#94A3B8'\)/,
    'warna kategori harus di-escape sebelum masuk style inline');
});
