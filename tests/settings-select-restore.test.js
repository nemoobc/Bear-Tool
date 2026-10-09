// Bear Tool — tests/settings-select-restore.test.js
//
// Every Settings dropdown that PERSISTS a value must also READ IT BACK on
// boot, or the control lies about the state it controls. Auto-lock already
// had its own read-back line (added for a prior live report); currency and
// language were missing it, so a reload left bear.settings saying
// currency="idr"/lang="id" while the selects showed "usd"/"en" — the app
// rendered IDR and Indonesian labels under a panel that claimed otherwise.
//
// These are source gates (same device as eip7702-settings-ui.test.js): they
// read the real files and pin the wiring, because a handler that saves but
// never restores is exactly the bug that ships as "setting doesn't stick".
// Found by live E2E 2026-10-09 (reload persistence sweep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const app = code('../js/app.js');
const settings = readFileSync(new URL('../src/views/settings.jsx', import.meta.url), 'utf8');

test('auto-lock select still reads back the saved value', () => {
  assert.match(app, /autoLockEl\.value = String\(get\('settings'\)\.autoLock/,
    'auto-lock read-back must not regress — it is the model the others follow');
});

test('currency select reads back bear.settings.currency on boot', () => {
  assert.match(app, /currencyEl\.value = get\('settings'\)\.currency/,
    '#setCurrency must be assigned from the saved settings, else a reload '
    + 'shows the markup default (usd) while the app renders the saved one (idr)');
  // The read-back must live in the same bind pass as auto-lock's (bindViews),
  // i.e. after loadSettings() populated state — not only in the change handler.
  const bindIdx = app.indexOf('function bindViews()');
  const currencyIdx = app.search(/currencyEl\.value = get\('settings'\)\.currency/);
  assert.ok(bindIdx !== -1 && currencyIdx > bindIdx,
    'currency read-back must run inside/after bindViews(), not before loadSettings()');
});

test('language select reads back bear.settings.lang on boot', () => {
  assert.match(app, /langEl\.value = get\('settings'\)\.lang/,
    '#setLang must be assigned from the saved settings, else a reload shows '
    + '"en" while translate() already switched the UI to Indonesian');
});

test('settings.jsx exposes all three persisted selects uncontrolled', () => {
  // Uncontrolled (no React value=) — the DOM assignment above is the restore
  // path; a controlled select would swallow .value writes on re-render.
  for (const id of ['setCurrency', 'setLang', 'setAutoLock']) {
    assert.match(settings, new RegExp(`<select[^>]*id="${id}"`),
      `${id} must exist as a <select>`);
    const tag = settings.match(new RegExp(`<select[^>]*id="${id}"[^>]*>`))[0];
    assert.ok(!/\svalue=/.test(tag.replace('defaultValue', '')),
      `${id} must stay uncontrolled (no value=) for the read-back to stick`);
  }
});
