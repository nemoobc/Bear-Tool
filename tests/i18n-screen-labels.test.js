// A screen label is user-visible text. When a view ships it as a bare literal —
// <label htmlFor="sendTo">To address</label> — a user who switches the app to
// Indonesian still reads "To address". Nothing fails: JSX has no idea a string
// should be translated, and applyTranslations only overwrites textContent for
// elements carrying data-i18n, so an unwired label silently stays English.
//
// This is the same class as the wired-but-missing-key bug that
// i18n-keys-resolve.test.js covers, one step earlier: that test proves a key
// that IS wired exists; this one proves the labels people type money into are
// wired at all. It was missed because Send/Swap/Bridge carried no data-i18n.
//
// Scope: the three screens that move funds (send, swap, bridge). The broader
// app still has unwired labels — this file names the rule for the screens where
// a wrong word costs money, so the gap cannot reopen silently; the rest is
// tracked separately rather than pretended solved here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jsxToHtmlSpelling } from './helpers/app-source.mjs';

// Tags whose text the user reads. VALUE (inputs) excluded — placeholders have
// their own data-i18n-placeholder channel; a literal <button>/<label> body is
// exactly what we want flagged.
const TAGS = /<(label|button|h1|h2|h3|h4|summary|legend)\b([^>]*)>([^<]{2,})<\/\1>/g;

const unwired = (src) => {
  const out = [];
  for (const m of src.matchAll(TAGS)) {
    const attrs = m[2];
    const text = m[3].trim();
    if (!/[A-Za-z]/.test(text)) continue;        // numbers/symbols only
    if (text.includes('{') || text.includes('}')) continue; // {expr} = filled at runtime
    if (/data-i18n(-[a-z]+)?=/.test(attrs)) continue;
    out.push(text.replace(/\s+/g, ' ').slice(0, 40));
  }
  return out;
};

const readView = (v) =>
  jsxToHtmlSpelling(readFileSync(new URL(`../src/views/${v}.jsx`, import.meta.url), 'utf8'));

test('the screens that move money have no unwired label', () => {
  for (const v of ['send', 'swap', 'bridge']) {
    const bad = unwired(readView(v));
    assert.deepEqual(bad, [], `${v}.jsx shows English that never translates: ${bad.join(' | ')}`);
  }
});

test('the detector would actually flag a bare label (it is not a vacuous pass)', () => {
  // A gate that cannot fail is worse than none: it hides the bug it exists for.
  // Feed the detector exactly the line that was in the tree and it must catch it.
  const sample = '<label htmlFor="sendTo">To address</label>';
  assert.deepEqual(unwired(sample), ['To address']);
  // And the fixed line must pass.
  const wired = '<label htmlFor="sendTo" data-i18n="send.to">To address</label>';
  assert.deepEqual(unwired(wired), []);
});
