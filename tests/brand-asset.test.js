// Bear Tool — brand-asset.test.js
// The bear that identifies the wallet must be the wallet's own asset.
//
// The account pill and each account row drew a bare 🐻 instead of
// assets/bear.svg. A bare emoji is a text glyph, so it inherits the system font's
// metrics: its size comes from whatever `font-size` happens to be in scope, it
// sits on the text baseline rather than being centred, and its shape is whatever
// the platform's emoji font draws. It is not the logo that ships in the topbar,
// and it is not the same on Windows, Android or iOS. A user comparing the two
// bears in one screen sees two different bears.
//
// Decorative emoji in prose are a different matter — "Wallet unlocked! 🐻" is
// text, and belongs to the text. These checks are about identity slots only: the
// places whose job is to say "this is Bear Tool".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');

const BRAND = 'assets/bear.svg';

test('the brand asset the markup points at actually exists', () => {
  assert.ok(existsSync(new URL(`../${BRAND}`, import.meta.url)),
    `${BRAND} is referenced but not in the repository — an identity slot pointing at a missing file renders blank or a broken-image glyph`);
});

test('the top-right account pill shows the brand asset, not an emoji', () => {
  const pill = html.slice(html.indexOf('id="accountPill"'));
  assert.ok(pill.length, 'the account pill must exist in index.html');
  const row = pill.slice(0, pill.indexOf('</div>') + 6);
  assert.ok(!row.includes('\u{1F43B}'),
    'the account pill still draws a bare 🐻 emoji instead of the brand asset — it is a text glyph, so its size and baseline follow the system font');
  assert.ok(row.includes(BRAND),
    `the account pill must show ${BRAND}, the same bear the topbar shows`);
  // The pill already carries a text label, so the image is decoration. Without
  // this a screen reader announces the bear and then the account, in that order.
  assert.match(row, /<img[^>]*alt=""/,
    'the brand image in the pill must have alt="" — the label beside it says what the pill is');
});

test('each account row shows the brand asset, not an emoji', () => {
  // Anchor on the account-row template and read a bounded window from there.
  // Searching the whole file for 'asset-info' finds the DASHBOARD rows first —
  // they appear earlier and reuse the same class names — so the slice came back
  // empty and this check failed on a product that was already correct.
  const start = app.indexOf('class="asset-row ${i === idx');
  assert.notEqual(start, -1, 'the account-row template must exist in app.js');
  const row = app.slice(start, start + 400);
  assert.ok(!row.includes('\u{1F43B}'),
    'account rows still draw a bare 🐻 emoji in the identity slot');
  assert.ok(row.includes(BRAND),
    `the account row icon must use ${BRAND}, the same asset the topbar shows`);
  assert.match(row, /<img[^>]*alt=""/,
    'the account row image is decoration next to the account name, so it needs alt=""');
});

test('every brand image is given an explicit box, not left to the font', () => {
  // An <img> with no width/height is sized by its intrinsic ratio, and an inline
  // one also leaves a baseline gap under it — which is exactly the "sits a little
  // too low" the emoji version had, just with a different cause.
  for (const sel of ['.pill-bear', '.asset-bear']) {
    assert.ok(css.includes(sel), `${sel} must have a rule: an unsized brand image floats in whatever space the text metrics leave`);
    const rule = css.slice(css.indexOf(sel), css.indexOf(sel) + 220);
    assert.match(rule, /width:\s*\d/, `${sel} needs an explicit width, or its size follows the font`);
    assert.match(rule, /height:\s*\d/, `${sel} needs an explicit height`);
    assert.match(rule, /display:\s*block/, `${sel} needs display:block, or the inline baseline leaves a gap under it`);
  }
});

test('the account pill and the topbar brand render the same file', () => {
  // Two bears in one header is the defect. Same asset, same treatment.
  const topbar = html.slice(html.indexOf('class="topbar-logo"'), html.indexOf('class="topbar-right"'));
  assert.ok(topbar.includes(BRAND), 'the topbar brand must point at the brand asset');
  const pill = html.slice(html.indexOf('id="accountPill"'), html.indexOf('id="accountPill"') + 320);
  assert.ok(pill.includes(BRAND), 'the account pill must point at the same brand asset');
});
