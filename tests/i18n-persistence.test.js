// Bear Tool — i18n-persistence.test.js
// Where the language actually comes from — and what is only a mirror of it.
//
// I spent a pass convinced the language reset to English on every reload: setLang
// writes bear.lang, and a scan for localStorage keys found bear.lang written and
// never read. That looked like a lost preference.
//
// It was wrong, and the reason is worth keeping. There are TWO keys:
//
//   bear.settings.lang   the source of truth. The #setLang handler writes it and
//                        calls saveSettings(); app.js reads it at boot and calls
//                        setLang(). Persistence works, and 07-settings-i18n.spec.js
//                        has a test that reloads the page and checks for "Dasbor".
//   bear.lang            a mirror, written by setLang and asserted by
//                        e2e-probe.test.js and that same spec. Nothing reads it.
//
// So the scan was right about the key and wrong about the conclusion: "written and
// never read" is not "broken" when a second key carries the real value. The
// regression I nearly shipped — seeding currentLang from bear.lang at module load
// — would have added a second source of truth to the boot path and changed
// nothing visible, because boot immediately overwrites it from bear.settings.
//
// These tests pin the real mechanism, so the next person to run that scan starts
// from the truth instead of from my mistake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

test('the language is restored from bear.settings at boot, not from a bare default', () => {
  assert.match(app, /setLang\(get\('settings'\)\.lang \|\| 'en'\)/,
    'boot must restore the stored language from bear.settings — this is what makes the choice survive a reload');
  assert.match(app, /s\.lang = e\.target\.value;[\s\S]{0,120}saveSettings\(\)/,
    'the #setLang handler must write settings.lang and persist it');
});

test('bear.lang stays a mirror, written on every change', () => {
  // Not the source of truth, but two specs assert it is written, so removing it
  // would break them. It is a mirror and the boot path must not start reading it.
  assert.match(i18n, /localStorage\.setItem\('bear\.lang'/,
    'setLang must keep mirroring the language to bear.lang — specs assert that write');
  assert.doesNotMatch(i18n, /localStorage\.getItem\('bear\.lang'/,
    'i18n.js must not read bear.lang at module load: boot restores from bear.settings, ' +
    'and seeding from the mirror would make two keys decide the same thing');
});

test('the module does not read storage to decide its starting language', () => {
  const init = i18n.slice(i18n.indexOf('let currentLang'), i18n.indexOf('let currentLang') + 120);
  assert.doesNotMatch(init, /localStorage/,
    `currentLang is initialised from storage — that reads the mirror, not the setting: ${init.trim()}`);
});
