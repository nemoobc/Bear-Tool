// Bear Tool — sheet layout gates.
//
// Three screens carry text a user READS BEFORE they consent or act:
// the web confirm sheet (.tx-detail), the swap header label/value, and
// the NATIVE Android confirm sheet (BearDappBrowserPlugin). All three
// had the same class of defect: a value that had to WRAP was either
// glued to its label or clamped short — the permission sentence ended
// at "once sent it cannot be u…" (emulator 2026-10-22), i.e. the one
// consequence the sheet exists to name was cut off on the sheet the
// user presses "Connect" on.
//
// The native sheet is Java, so it cannot be unit-tested here; the gate
// reads the source and checks the two things that decide the outcome:
// a long value is STACKED (full width) instead of sharing a line with
// its label, and the clamp is deep enough for the longest sentence the
// wallet actually shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
// Comments are prose ABOUT the CSS (they quote the old broken declarations
// as evidence). Match against declarations only, or a comment describing a
// fixed bug fails the gate that forbids it.
const decl = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const i18n = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const java = fs.readFileSync(new URL(
  '../android/app/src/main/java/com/nemoobc/beartool/BearDappBrowserPlugin.java', import.meta.url), 'utf8');

test('web confirm sheet: a wrapping value keeps its distance from the label', () => {
  const row = decl(css).match(/\.tx-detail \.row \{[^}]*\}/);
  assert.ok(row, 'the .tx-detail .row rule exists');
  assert.match(row[0], /gap:\s*\d+px/,
    'without a gap a wrapped value starts flush against the label — '
    + '"Est. cost0.02…" in the deploy confirm, "Message…" in the sign sheet');
});

test('web confirm sheet: a long label folds, it never pushes the row out', () => {
  // Regression, measured at 320px (2026-10-23): `.k` was `flex: 0 0 auto`
  // (shrink:0), so the label kept its FULL unwrapped width. A label like
  // "Stays until you revoke it in Settings → Security" drove the row's
  // scrollWidth to 463 against a 260 clientWidth — label AND value pushed
  // out of the card ("ask tx: still comes out of the box"). Then the value
  // was the other casualty: an `auto` label track with no floor under the
  // value let a long label starve the value to 0px (invisible). Grid with a
  // positive min on the value track is what closes both.
  const row = decl(css).match(/\.tx-detail \.row \{[^}]*\}/);
  assert.ok(row, 'the .tx-detail .row rule exists');
  assert.match(row[0], /display:\s*grid/,
    'a flex row cannot both hug a short label and contain a long one — '
    + 'shrink:0 overflows, shrink:1 slivers the label to ~23px');
  const tracks = row[0].match(/grid-template-columns:\s*([^;]+);/);
  assert.ok(tracks, 'the two tracks are declared');
  const cols = [...tracks[1].matchAll(/minmax\(([^,]+),\s*([^)]+)\)/g)]
    .map((m) => [m[1].trim(), m[2].trim()]);
  assert.equal(cols.length, 2, 'label track + value track');
  assert.notEqual(cols[1][0], '0', 'a 0 min lets a long label collapse the value to 0px — '
    + 'the value the sheet exists to show disappears');

  const k = decl(css).match(/\.tx-detail \.row \.k \{[^}]*\}/);
  assert.ok(k, 'the label rule exists');
  assert.doesNotMatch(k[0], /flex:\s*0\s+0\s+auto/,
    'shrink:0 on the label is the overflow: the label never wraps, it runs out of the card');
  assert.match(k[0], /overflow-wrap:\s*anywhere/,
    'a label longer than its column must fold inside it');

  // The value floor must stay small. Measured on a 320px device (CI emulator,
  // 2026-10-24): a 6em floor (≈86px) left so little room that the label column
  // shrank to ~40px and every label broke mid-word ("Symb o l", "Tra nsac
  // tions"). 4em (≈58px) keeps the value readable while leaving a label enough
  // width to wrap at its SPACE instead of per-letter. A floor past ~5em starts
  // re-creating that defect on the narrowest sheet — lock it down.
  const valueMin = cols[1][0];
  const emMatch = valueMin.match(/^([\d.]+)em$/);
  assert.ok(emMatch, `the value floor is an em length, got "${valueMin}"`);
  assert.ok(Number(emMatch[1]) >= 3 && Number(emMatch[1]) <= 5,
    `a value floor of ${valueMin} is out of band: below ~3em the value starves, `
    + 'above ~5em the label breaks mid-word on a narrow sheet');
});

test('web confirm sheet: a long value breaks at spaces, not mid-number', () => {
  // The same sheet, second defect ("ask tx is not tidy"): `.v` carried
  // `word-break: break-all`, which fills every line by splitting at ANY
  // character, so the deploy confirm read "0.14523702778899" / "0096 POL…"
  // — the number torn in half even though a space was available.
  // `overflow-wrap: anywhere` keeps a word whole while it fits and only
  // splits it when the line would overflow, so numbers and addresses both
  // stay readable and a space-less hex still folds inside the card.
  const v = decl(css).match(/\.tx-detail \.row \.v \{[^}]*\}/);
  assert.ok(v, 'the value rule exists');
  assert.doesNotMatch(v[0], /word-break:\s*break-all/,
    'break-all splits a number mid-digit even when a space could break instead');
  assert.match(v[0], /overflow-wrap:\s*anywhere/,
    'anywhere still folds a space-less address/hex so it cannot overflow the card');
  assert.match(v[0], /min-width:\s*0/,
    'a flex/grid value needs min-width:0 to shrink below its content and wrap');
});

test('swap header: label and balance are not one run of text', () => {
  const rule = decl(css).match(/\.swap-balance \{[^}]*\}/);
  assert.ok(rule, 'the .swap-balance rule exists');
  assert.match(rule[0], /display:\s*inline-flex/, 'the two spans must be a flex row, not inline text');
  assert.match(rule[0], /gap:\s*\d+px/, 'and they need a gap — JSX drops the whitespace between them');
});

test('native sheet: a long value is stacked under its label', () => {
  const start = java.indexOf('private void addSheetRow');
  const end = java.indexOf('private void finishConfirm');
  assert.ok(start > -1 && end > start, 'addSheetRow exists');
  const body = java.slice(start, end);
  assert.match(body, /setOrientation\(LinearLayout\.VERTICAL\)/,
    'a long value must take the full width under its label — side by side the label '
    + 'eats half the sheet and the sentence is cut');
});

test('native sheet: the clamp is deep enough for the permission sentence', () => {
  const start = java.indexOf('private void addSheetRow');
  const end = java.indexOf('private void finishConfirm');
  const body = java.slice(start, end);
  const clamp = body.match(/setMaxLines\((\d+)\)/);
  assert.ok(clamp, 'the long-value branch sets a line clamp');
  const lines = Number(clamp[1]);
  assert.ok(lines >= 3, `the clamp must allow a wrapped sentence, got ${lines}`);

  // The longest sentence the connect sheet shows, and what the sheet can
  // hold: 13sp text in the sheet's usable width fits ~30 characters a line
  // (measured on the emulator sheet: ~5.9px a character, ~300dp of usable
  // width once the value is stacked). The emulator screenshot is the real
  // proof; this gate keeps the number honest.
  const longest = ['site.canSendValue', 'site.canSignValue', 'site.canSeeValue']
    .map((k) => {
      const m = i18n.match(new RegExp(`'${k}':\\s*'([^']*)'`));
      return m ? m[1] : '';
    })
    .sort((a, b) => b.length - a.length)[0] || '';
  assert.ok(longest.length > 40, 'the permission sentences are long enough to matter');
  const capacity = lines * 30;
  assert.ok(capacity >= longest.length,
    `the clamp hides the end of "${longest.slice(0, 24)}…" — ${lines} lines hold ~${capacity} chars, `
    + `the sentence is ${longest.length}`);
});
