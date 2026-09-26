// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapps.test.js
// DApps browser: render, popular list, navigation
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dappsSrc = readFileSync(new URL('../js/dapps.js', import.meta.url), 'utf8');
// The browser moved into its own module; the browser assertions below are
// checked against that file, and the catalogue ones against dapps.js.
const browserSrc = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('dapps: exports renderDapps function', () => {
  assert.match(dappsSrc, /export\s+function\s+renderDapps/);
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
test('dapps: index.html has DApps view section', () => {
  assert.match(htmlSrc, /id="view-dapps"/);
});
test('dapps: index.html has DApps container', () => {
  assert.match(htmlSrc, /id="dappsContainer"/);
});

// ── the frame must not be a free gift to whatever loads in it ───────────
test('dapps: the in-app frame is hardened', () => {
  assert.match(browserSrc, /referrerpolicy="no-referrer"/, 'must not leak the wallet URL as a referrer');
  assert.match(browserSrc, /credentialless/, 'must run without ambient cookies or storage');
  assert.match(browserSrc, /allow-scripts allow-forms allow-popups allow-modals/,
    'sandbox must stay minimal: no allow-same-origin, no popups-to-escape-sandbox');
  assert.ok(!/sandbox="[^"]*allow-same-origin/.test(browserSrc), 'allow-same-origin would give the page our origin');
  assert.ok(!/sandbox="[^"]*escape-sandbox/.test(browserSrc), 'escaping the sandbox would defeat the sandbox');
  assert.match(browserSrc, /allow=""/, 'no clipboard, microphone or camera for a dApp');
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
