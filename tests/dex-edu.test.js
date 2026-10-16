// Bear Tool — tests/dex-edu.test.js
// R16: three explainers (LP, price impact, LP lock) + a glossary, reachable
// from the surfaces where the words actually appear. The rule under test:
// every "?" opens real copy in both languages, and the copy names the
// tradeoffs honestly — impact is not slippage, locked is not safe, LP is a
// position and not a yield promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { t, setLang } = await import('../js/i18n.js');
const { openEdu } = await import('../js/dex/core.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every explainer + glossary term exists in both languages', () => {
  const keys = [
    'dex.edu.lp.title', 'dex.edu.lp.body',
    'dex.edu.impact.title', 'dex.edu.impact.body',
    'dex.edu.lock.title', 'dex.edu.lock.body',
    'dex.edu.glossary.title', 'dex.edu.glossary.body',
    'dex.edu.glossaryLink', 'dex.edu.close',
  ];
  for (const g of ['lp', 'impact', 'slip', 'lock', 'min', 'fee']) keys.push(`dex.edu.g.${g}.n`, `dex.edu.g.${g}.d`);
  for (const lang of ['en', 'id']) {
    setLang(lang);
    for (const k of keys) {
      assert.ok(t(k).length > 0 && t(k) !== k, `${k} must be translated (${lang})`);
    }
  }
  setLang('en');
});

test('the copy names the tradeoffs instead of selling a promise', () => {
  setLang('en');
  assert.match(t('dex.edu.impact.body'), /not slippage/i, 'impact must say it is NOT slippage');
  assert.match(t('dex.edu.lock.body'), /Read the date/i, 'the lock text must send eyes to the date, not the word');
  assert.match(t('dex.edu.lp.body'), /not a yield promise/i, 'LP must not read as a yield promise');
  setLang('id');
  assert.match(t('dex.edu.impact.body'), /bukan slippage/i, 'ID: impact ≠ slippage');
  assert.match(t('dex.edu.lock.body'), /tanggal/i, 'ID: the lock text points at the date');
  setLang('en');
});

test('each trade surface carries its "?" and wires it to its own topic', () => {
  const lp = read('../js/dex/lp.js');
  assert.ok(lp.includes('id="dexLpEdu"'), 'the LP panel must carry the "?" button');
  assert.match(lp, /openEdu\('lp'\)/, 'and it must open the LP explainer');
  const ts = read('../js/dex/trade-sheet.js');
  assert.ok(ts.includes('data-ts-edu'), 'the trade sheet must carry the "?" button');
  assert.match(ts, /openEdu\('impact'\)/, 'and it must open the impact explainer');
  const tp = read('../js/dex/token-page.js');
  assert.ok(tp.includes('data-edu-lock'), 'the safety chips must carry the "?" button');
  assert.match(tp, /openEdu\('lock'\)/, 'and it must open the lock explainer');
});

test('openEdu survives without a modal shell — null, never a crash', () => {
  assert.equal(openEdu('lp'), null, 'no DOM here; the guard returns before touching it');
  assert.equal(openEdu('not-a-topic'), null, 'an unknown topic falls back, still no crash');
});

test('the glossary is reachable from every explainer (pinned in core.js)', () => {
  const src = read('../js/dex/core.js');
  assert.match(src, /data-edu-glossary/, 'each explainer carries the glossary link');
  assert.match(src, /openEdu\('glossary'\)/, 'and the link opens it');
  assert.match(src, /data-close-modal/, 'the sheet closes through the app’s one modal path');
});
