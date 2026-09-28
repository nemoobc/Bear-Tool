// Bear Tool — token-mark-class.test.js
// CSS must target the class the renderer actually emits.
//
// token-logo.js draws every token mark as `class="token-mark"`, or
// `class="token-logo-img token-mark"` when a remote logo is cached. The picker's
// stylesheet said `token-logo-mark` — a class nothing renders, anywhere. The class
// was renamed and three rules were left behind, so:
//
//   - those rules did nothing at all
//   - `.token-mark`, the class that IS rendered, had no styling whatsoever
//   - 16-picker-casing.spec.js counted artwork with `.token-logo-mark` and read
//     zero, then failed with "every row needs a logo" while every row had one
//
// A stylesheet naming a class nothing produces is invisible: it cannot fail a test
// and it cannot be seen in a screenshot. This pins the two together, and pins it
// by planting a check that would catch the next rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
const logo = readFileSync(new URL('../js/token-logo.js', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../js/token-picker.js', import.meta.url), 'utf8');

test('the mark class the CSS styles is the class the renderer emits', () => {
  assert.match(logo, /class="token-mark"/,
    'token-logo.js must render the mark as .token-mark — if the name changes, this is what says so');
  assert.match(logo, /class="token-logo-img token-mark"/,
    'the cached-image path must carry the same class, or the two kinds of mark style differently');
  assert.match(css, /\.token-mark\s*\{/,
    'the stylesheet must have a rule for .token-mark');
  assert.match(css, /\.token-row-logo \.token-mark/,
    'the picker rows must be styled by class they really carry');
});

test('no stylesheet rule targets a token-mark class the renderer never emits', () => {
  // Anything in the token-logo-* / token-mark family that appears in the CSS has
  // to be produced by the renderer, or it is a rule that cannot do anything.
  const produced = new Set([
    ...(logo.match(/token-logo-[a-z]+/g) || []),
    ...(logo.match(/token-mark/g) || []),
    ...(picker.match(/token-logo-[a-z]+/g) || []),
  ]);
  const inCss = new Set(css.match(/\.token-logo-[a-z]+/g) || []);
  // `.token-logo-img` and `.token-mark` are produced; strip the leading dot.
  const known = new Set([...produced].map((c) => '.' + c));
  for (const sel of inCss) {
    assert.ok(known.has(sel),
      `${sel} is styled but nothing renders it — a dead rule that cannot fail anything and cannot be seen`);
  }
});

test('the picker rows really put a mark inside .token-row-logo', () => {
  assert.match(picker, /<span class="token-row-logo">\$\{logoHtml\(/,
    'a token row must render its mark through the shared renderer, so it looks the same as the dashboard');
});

test('the artwork check counts the mark that is actually rendered', () => {
  // The spec used `.token-row-logo img, .token-row-logo .token-logo-mark`. With
  // no remote logo cached the mark is an inline <svg class="token-mark">, which
  // matches neither — so the count was zero and the assertion blamed the UI.
  const spec = readFileSync(new URL('../tests/e2e/16-picker-casing.spec.js', import.meta.url), 'utf8');
  assert.doesNotMatch(spec, /token-logo-mark/,
    'the picker spec counts artwork with a class nothing renders');
  assert.match(spec, /\.token-mark/,
    'it must count the mark the renderer emits');
});
