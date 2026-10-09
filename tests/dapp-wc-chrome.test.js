// Bear Tool — tests/dapp-wc-chrome.test.js
//
// The dApp browser opens sites the way a REAL browser does: direct frame
// navigation (no relayed/rewritten HTML — the proxy experiment is gone; every
// free CORS relay was dead on 2026-10-09: 401 key-gated, 429, 500, timeouts),
// and sites that ship frame-ancestors 'self' (Uniswap) route to the notice
// sheet that opens a real browser tab instead of a silent blank frame.
//
// Connecting is REAL WalletConnect: the pairing hint is actually SHOWN when
// it applies, the bar shows WC sessions (not only injected-provider sites),
// the pair modal has no stray Close button, and one button disconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const browser = code('../js/dapp-browser.js');
const wc = code('../js/walletconnect.js');

test('navigation is DIRECT — no proxy render path survives in the browser', () => {
  assert.ok(!existsSync(new URL('../js/dapp-proxy.js', import.meta.url)),
    'the proxy module is deleted, not dormant');
  assert.ok(!existsSync(new URL('../public/bear-sw.js', import.meta.url)),
    'the relay service worker goes with it');
  assert.ok(!browser.includes('renderProxiedPage'), 'no relayed HTML render');
  assert.ok(!browser.includes('startProxiedLoad'), 'no proxied load path');
  assert.ok(!browser.includes('proxyModeOn'), 'no proxy toggle left to mislead');
  assert.match(browser, /el\.frame\.src = t\.url/,
    'paint loads the URL straight into the frame');
});

test('sites that refuse framing route to the real-browser notice sheet', () => {
  assert.match(browser, /frameable === false/,
    'the gate consults the curated frameable flag');
  assert.match(browser, /framedOut\s*=\s*catalog\.find/,
    'URL → catalog entry match (same rule dapps.js tiles use)');
  assert.match(browser, /return !!openExternalNotice\(url, framedOut\.name/,
    'handled by the notice sheet — never a blank frame');
  assert.match(browser, /pair it back with WalletConnect/,
    'the notice names the connect path it opens');
});

test('the pairing hint is actually SHOWN for loaded cross-origin pages', () => {
  assert.match(browser, /el\.wcHint\.hidden = sameOrigin \|\| connected \|\| read\(LS\.wcHint\) === 'dismissed' \|\| !\/\^https\?:\/i\.test\(t\.url\)/,
    'D1: the strip had no un-hide path — hint must appear when it applies');
});

test('the bar covers WalletConnect sessions, not only injected sites', () => {
  assert.match(browser, /wcOrigins\.has\(origin\)/, 'D2: bar reads WC session cache');
  assert.match(browser, /🔗 WalletConnect/, 'the label tells the user WHICH path is live');
  assert.match(browser, /disconnectWcOrigin/, 'the same button disconnects a WC session');
});

test('walletconnect exposes per-origin session bookkeeping', () => {
  assert.match(wc, /export function wcActiveOrigins/);
  assert.match(wc, /export function wcSessionForOrigin/);
  assert.match(wc, /export async function disconnectWcOrigin/);
});

test('pair modal has no top-right Close button — Cancel is the way out', () => {
  const i = wc.indexOf('function openPairWalletConnect');
  assert.ok(i > 0, 'openPairWalletConnect exists');
  const body = wc.slice(i, wc.indexOf('function', i + 10));
  assert.ok(!body.includes('modal-close'),
    'the Close ✕ was removed on request (2026-10-09) — do not resurrect it');
  assert.match(body, />Cancel</, 'Cancel remains the dismiss path');
});
