// A data-i18n attribute pointing at a key that does not exist does not fail
// loudly. It renders the key itself, so the user reads "settings.lang" where a
// label should be. That is exactly what happened while grouping the Settings
// page: the Language label was wired to settings.lang when the table has always
// called it settings.language, and the testnet label was wired to a key nobody
// had added.
//
// The suite was green throughout. Nothing about a missing key is an error to
// JavaScript, so it has to be checked here instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// The table is two objects; the Indonesian one starts at its `id:` marker.
const split = src.indexOf('\n  id:');
const enBlock = src.slice(0, split);
const idBlock = src.slice(split);
const keysOf = (b) => new Set([...b.matchAll(/^\s*'([a-z][\w.-]*)'\s*:/gm)].map((m) => m[1]));
const EN = keysOf(enBlock);
const ID = keysOf(idBlock);

const usedInHtml = [...new Set([...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]))];

test('the split actually found two language blocks', () => {
  assert.ok(split > 0, 'could not locate the Indonesian block — this test would pass vacuously');
  assert.ok(EN.size > 40, `English block looks too small: ${EN.size}`);
  assert.ok(ID.size > 40, `Indonesian block looks too small: ${ID.size}`);
});

test('every data-i18n key in the markup exists in English', () => {
  const missing = usedInHtml.filter((k) => !EN.has(k));
  assert.deepEqual(missing, [], `these render as their own key name: ${missing.join(', ')}`);
});

test('every data-i18n key in the markup exists in Indonesian', () => {
  const missing = usedInHtml.filter((k) => !ID.has(k));
  assert.deepEqual(missing, [], `English would show where Indonesian was meant: ${missing.join(', ')}`);
});

test('the two language tables have exactly the same keys', () => {
  const onlyEn = [...EN].filter((k) => !ID.has(k)).sort();
  const onlyId = [...ID].filter((k) => !EN.has(k)).sort();
  assert.deepEqual(onlyEn, [], `defined in English only: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyId, [], `defined in Indonesian only: ${onlyId.join(', ')}`);
});

test('a translation is not blank and not the key itself', () => {
  for (const [k, v] of [...src.matchAll(/^\s*'([a-z][\w.-]*)'\s*:\s*'([^']*)'/gm)]) {
    assert.ok(v.trim().length > 0, `${k} is empty`);
    assert.notEqual(v, k, `${k} maps to itself`);
  }
});

test('no key uses a dot-prefixed or empty segment', () => {
  for (const k of EN) {
    assert.ok(!/\.\./.test(k) && !k.startsWith('.') && !k.endsWith('.'), `malformed key: ${k}`);
  }
});
