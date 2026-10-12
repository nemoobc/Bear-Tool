// A seed word must never break across lines.
//
// Found by LOOKING at the emulator screenshot 02-seed-phrase.png (2026-12):
// on a 282px phone the two-column grid was narrow enough that `overflow-wrap:
// anywhere` split the words — "tornado" rendered as "tornad" / "o", "express"
// as "expres" / "s", "assault" and "endless" likewise.
//
// That is not a cosmetic defect on this particular screen. It says "Write these
// 12 words DOWN. Never share them. Never type them into any website." A person
// transcribing from that view can read a broken word as a different word, write
// the wrong phrase down, and the wallet never opens again. Nothing about the
// unit suite could see it: the markup and the word list were both correct, and
// only the rendered box was wrong.
//
// So this gate pins the rule: the seed word cell never wraps, and it elides
// (with …) rather than mutating the word if it is too wide for its cell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// Comments are stripped before a rule is judged. The block above explains WHY
// `overflow-wrap: anywhere` was removed and says so by name — a gate that reads
// its own explanation as a violation fails for the right reason at the wrong
// moment, which is the same shape of false signal as a gate that cannot fail.
const rule = (sel) => {
  const i = css.indexOf(sel + ' {');
  if (i < 0) return '';
  const end = css.indexOf('}', i);
  // Whole comment blocks go, not just the lines that open them: a wrapped
  // comment's middle lines look exactly like declarations.
  return css.slice(i, end).replace(/\/\*[\s\S]*?\*\//g, '');
};

test('a seed word never breaks across lines', () => {
  const span = rule('.seed-word > span');
  assert.ok(span, '.seed-word > span must exist — this is the element that holds the word');
  assert.doesNotMatch(span, /overflow-wrap:\s*anywhere|word-break:\s*break-all|word-wrap:\s*break-word/,
    'the seed word cell must not break mid-word; a wrapped word is a word written down wrong');
  assert.match(span, /white-space:\s*nowrap/,
    'the word must stay on one line');
});

test('a too-wide seed word is hidden with an ellipsis, never clipped silently', () => {
  const span = rule('.seed-word > span');
  assert.match(span, /text-overflow:\s*ellipsis/,
    'a word too wide for its cell shows … so the reader knows it was cut, instead of a silent crop');
  // The scroller is allowed; mutating the glyphs is not.
  assert.match(span, /overflow:\s*hidden/,
    'the cell clips rather than pushing the word out of the row');
});

test('the seed list is two columns of numbered words, rendered as whole words', () => {
  // The markup builds each cell from the word itself — no truncation, no
  // re-wrapping in JS that could hide the same defect from this CSS rule.
  assert.match(app, /<div class="seed-word"><b>\$\{i \+ 1\}\.<\/b><span>\$\{escapeHtml\(w\)\}<\/span><\/div>/,
    'setiap kata seed harus dirender sebagai satu span berisi kata utuh');
  // Longest BIP-39 word, for the record: "abandon" is 7; some lists carry longer.
  assert.ok(!/slice\(0,\s*\d+\)/.test((app.match(/seed-word[\s\S]{0,200}/) || [''])[0]),
    'kata seed tidak boleh dipotong di markup');
});

// Visual regression, emulator shot 32-send-guard.png (2026-12): the Send guard
// toast came up opaque over the bottom nav, hiding the "Activity" and "Swap"
// labels underneath it. `pointer-events: none` on the wrapper meant taps still
// reached them — which is exactly why it looked fine in every interaction test
// while being plainly wrong in a screenshot: nothing was blocked, so nothing
// failed. A toast is the one thing the user MUST read, so it clears the nav.
test('toasts clear the mobile bottom nav instead of covering it', () => {
  assert.match(css, /#toast-wrap\s*\{/, '#toast-wrap harus ada');
  // One regex instead of index arithmetic: pick the media query that actually
  // CONTAINS the toast rule, which index math gets wrong the moment the file has
  // a second phone breakpoint (and a wrong pick fails for the wrong reason).
  assert.match(css,
    /@media\s*\(max-width:\s*768px\)\s*\{\s*#toast-wrap\s*\{[^}]*bottom:\s*calc\(var\(--mobile-nav-h/,
    'toast harus berdiri di atas tinggi bottom-nav, bukan 20px di atas tepi layar');
  assert.match(css,
    /@media\s*\(max-width:\s*768px\)\s*\{\s*#toast-wrap\s*\{[^}]*env\(safe-area-inset-bottom/,
    'ruang aman perangkat ikut dihormati — tanpa itu toast tertutup gesture bar');
});
