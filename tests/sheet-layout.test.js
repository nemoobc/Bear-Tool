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
const i18n = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const java = fs.readFileSync(new URL(
  '../android/app/src/main/java/com/nemoobc/beartool/BearDappBrowserPlugin.java', import.meta.url), 'utf8');

test('web confirm sheet: a wrapping value keeps its distance from the label', () => {
  const row = css.match(/\.tx-detail \.row \{[^}]*\}/);
  assert.ok(row, 'the .tx-detail .row rule exists');
  assert.match(row[0], /gap:\s*\d+px/,
    'without a gap a wrapped value starts flush against the label — '
    + '"Est. cost0.02…" in the deploy confirm, "Message…" in the sign sheet');
});

test('swap header: label and balance are not one run of text', () => {
  const rule = css.match(/\.swap-balance \{[^}]*\}/);
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
