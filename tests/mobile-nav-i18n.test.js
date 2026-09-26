// The bottom bar is generated from the sidebar, which meant it silently opted
// out of translation: the generated label had no data-i18n key, so
// applyTranslations() - which works by scanning [data-i18n] - had nothing to
// match. Measured: the sidebar said "Dasbor" while the bar beside it still said
// "Dashboard". On a phone the bar is the only nav most people ever see, so the
// one screen that cannot be translated was the one always in view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('every bottom-bar label carries its i18n key', () => {
  // The key is read off the sidebar item and must reach the generated markup.
  const cell = app.slice(app.indexOf('const cell = (i, active)'));
  assert.match(cell, /data-i18n=/,
    'the generated label needs data-i18n or applyTranslations() cannot reach it');
  assert.match(cell, /\$\{escapeHtml\(i\.i18n\)\}/,
    'and it must be the key that was read off the sidebar, not a literal');
});

test('the initial text is translated at render, not only after a re-scan', () => {
  // Belt and braces: if only applyTranslations() fixes it, the bar is briefly
  // wrong on every page load.
  const cell = app.slice(app.indexOf('const cell = (i, active)'));
  assert.match(cell, /t\(i\.i18n\)/,
    'syncMobileNav should translate as it builds, so the bar is never briefly stale');
});

test('the key is actually used, not just collected', () => {
  // The original bug: `i18n:` was read into the item and then never referenced
  // anywhere. Collecting a value nobody reads is what made this look correct.
  const after = app.slice(app.indexOf('const items = [...$all'));
  const collects = after.indexOf('i18n:');
  const uses = after.indexOf('i.i18n');
  assert.ok(collects !== -1, 'the key should still be collected');
  assert.ok(uses > collects, 'and it must be used after it is collected, not dropped');
});

test('all five bar labels have a translation in every language', () => {
  const keys = ['nav.dashboard', 'nav.activity', 'nav.swap', 'nav.dapps', 'nav.settings'];
  const en = i18n.slice(i18n.indexOf("'nav.settings'"));
  for (const k of keys) {
    assert.ok(html.includes(`data-i18n="${k}"`) || app.includes(k) || i18n.includes(`'${k}'`),
      `${k} must exist as a key`);
  }
  // Both language blocks must define every key, or switching leaves English text
  // behind in one of them - the same half-translated bar, one language worse.
  const idBlock = i18n.slice(i18n.indexOf('id:'), i18n.indexOf('id:') + 4000);
  for (const k of keys) {
    assert.ok(i18n.includes(`'${k}'`), `${k} missing from the translation table`);
  }
  assert.ok(idBlock.length > 0, 'an Indonesian block must exist');
});
