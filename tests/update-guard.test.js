// Bear Tool — tests/update-guard.test.js
//
// A tab open across a rebuild keeps running the old bundle, so a fix lands
// and the user still sees the old bug (phantom regressions — the 2026-10-04
// flip report). update-guard.js polls the served index.html and banners a
// Reload when the hashed entry no longer matches this tab. These tests pin
// the parsing rules, the stale-detection behaviour and the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const guardSrc = fs.readFileSync(new URL('../js/update-guard.js', import.meta.url), 'utf8');
const appSrc = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const i18nSrc = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const { entryHash, currentEntryHash, startUpdateGuard } =
  await import('../js/update-guard.js');

const realHtml = `<!doctype html>
<html><head>
<link rel="stylesheet" crossorigin href="./assets/index--nuzHGS2.css">
<link rel="modulepreload" crossorigin href="./assets/app-DHr44Azv.js">
<script type="module" crossorigin src="./assets/index-CUIL2SK1.js">
</head><body></body></html>`;

test('update-guard: entryHash reads the MODULE script entry, not other index-* assets', () => {
  assert.equal(entryHash(realHtml), 'index-CUIL2SK1.js');
  // A lazy index-*.js chunk in a <link> must not be mistaken for the entry
  // even when it appears before the script tag.
  const withLazyFirst = '<link rel="modulepreload" href="./assets/index-B7d5cDPi.js">'
    + '<script type="module" src="./assets/index-CUIL2SK1.js"></script>';
  assert.equal(entryHash(withLazyFirst), 'index-CUIL2SK1.js');
});

test('update-guard: entryHash is null where there is no hashed build', () => {
  assert.equal(entryHash(''), null);
  assert.equal(entryHash('<script type="module" src="/src/main.jsx"></script>'), null);
  assert.equal(entryHash(null), null);
});

test('update-guard: currentEntryHash reads the loaded module script', () => {
  const doc = {
    querySelector: () => ({ getAttribute: () => './assets/index-CUIL2SK1.js' }),
  };
  assert.equal(currentEntryHash(doc), 'index-CUIL2SK1.js');
  const devDoc = { querySelector: () => ({ getAttribute: () => 'src/main.jsx' }) };
  assert.equal(currentEntryHash(devDoc), null);
  assert.equal(currentEntryHash(null), null, 'no document → null, guard must stay inert');
});

test('update-guard: detects a newer entry and stops after the one-time banner', async () => {
  const calls = [];
  let stale = 0;
  const guard = startUpdateGuard({
    current: 'index-OLD.js',
    delayMs: 10_000_000, intervalMs: 10_000_000, // never auto-fire in tests
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, text: async () => realHtml }; // index-CUIL2SK1 ≠ index-OLD
    },
    onStale: () => { stale += 1; },
  });
  try {
    assert.equal(await guard.check(), true, 'mismatched entry must count as stale');
    assert.equal(stale, 1, 'exactly one banner');
    assert.equal(calls[0].url, 'index.html');
    assert.equal(calls[0].init && calls[0].init.cache, 'no-cache',
      'poll must revalidate (304-capable), not re-download blindly');
    assert.equal(await guard.check(), false, 'guard stops after detecting — no banner loop');
    assert.equal(stale, 1, 'banner stays one-time');
  } finally {
    guard.stop();
  }
});

test('update-guard: same entry → silent; fetch failure → silent; no build → inert', async () => {
  let stale = 0;
  const same = startUpdateGuard({
    current: 'index-CUIL2SK1.js',
    delayMs: 10_000_000, intervalMs: 10_000_000,
    fetchImpl: async () => ({ ok: true, text: async () => realHtml }),
    onStale: () => { stale += 1; },
  });
  try {
    assert.equal(await same.check(), false, 'up-to-date tab must stay quiet');
    assert.equal(stale, 0);
  } finally {
    same.stop();
  }

  const failing = startUpdateGuard({
    current: 'index-OLD.js',
    delayMs: 10_000_000, intervalMs: 10_000_000,
    fetchImpl: async () => { throw new Error('offline'); },
    onStale: () => { stale += 1; },
  });
  try {
    assert.equal(await failing.check(), false, 'offline must not throw, not banner');
    assert.equal(stale, 0);
  } finally {
    failing.stop();
  }

  let fetched = 0;
  const inert = startUpdateGuard({
    current: null, // dev build: no hashed entry to compare
    delayMs: 10_000_000, intervalMs: 10_000_000,
    fetchImpl: async () => { fetched += 1; return { ok: true, text: async () => realHtml }; },
    onStale: () => { stale += 1; },
  });
  inert.stop();
  assert.equal(await inert.check(), false, 'inert guard never reports stale');
  assert.equal(fetched, 0, 'inert guard must not poll at all');
  assert.equal(stale, 0);
});

test('update-guard: wired into boot + i18n keys exist in BOTH locales', () => {
  assert.match(appSrc, /import \{ startUpdateGuard \} from '\.\/update-guard\.js';/,
    'app.js must import the guard');
  assert.match(appSrc, /startUpdateGuard\(\);/,
    'app.js must start the guard once during boot');
  assert.match(guardSrc, /location\.reload\(\)/, 'banner button must reload the page');
  assert.ok(!/innerHTML\s*=/.test(guardSrc.split('function showBanner')[1] || ''),
    'banner is built with createElement, not innerHTML');

  const occurrences = (re) => (i18nSrc.match(re) || []).length;
  assert.equal(occurrences(/'update\.msg':/g), 2, "update.msg defined in en AND id");
  assert.equal(occurrences(/'update\.reload':/g), 2, "update.reload defined in en AND id");
});
