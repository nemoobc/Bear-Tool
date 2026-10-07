// Bear Tool — brand-asset.test.js
// One brand bear, one wallet mark. Identity slots do not improvise.
//
// History, because it explains why the checks read the way they do:
//
//   2026-10-05 — the pill was a bare 🐻 emoji (font metrics: size follows
//   font-size, sits on the baseline, different shape per platform) and the
//   account rows too. Fix: both drew assets/bear.svg in an explicit box.
//
//   2026-10-05 later — the pill became "wallet + bear": a wallet glyph with
//   the same bear peeking out of its pocket.
//
//   2026-10-06 (user: "logo bear + dompet bear, hilangkan logo dompet
//   pertahankan" + "di list wallet samping kiri kan ada logo bear ganti
//   jadi dompet") — the bear in the pocket is gone, and the account list's
//   left-hand icon is now the SAME wallet glyph instead of a bear. The
//   identity slots are: topbar = the brand file; pill + account rows = the
//   wallet mark. What these tests refuse to let back in: a second bear next
//   to the first (that header defect is why this file exists) and the bare
//   emoji (its metrics are the system font's, not ours).
//
// Decorative emoji in prose are a different matter — "Wallet unlocked! 🐻" is
// text, and belongs to the text. These checks are about identity slots only.
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

test('the topbar brand shows the brand asset, not an emoji', () => {
  const topbar = html.slice(html.indexOf('class="topbar-logo"'), html.indexOf('class="topbar-right"'));
  assert.ok(topbar.includes(BRAND), `the topbar brand must point at ${BRAND} — it is the ONE bear left`);
  assert.ok(!topbar.includes('\u{1F43B}'),
    'the topbar still draws a bare 🐻 emoji — it is a text glyph, so its size and baseline follow the system font');
});

test('the account pill is the wallet mark ALONE: glyph, no bear image', () => {
  assert.ok(html.indexOf('id="accountPill"') !== -1, 'the account pill must exist in index.html');
  const pill = html.slice(html.indexOf('id="accountPill"'));
  const box = pill.slice(0, pill.indexOf('</div>') + 6);
  assert.match(box, /pill-wallet/,
    'the pill icon must sit in a .pill-wallet box (positioning context for the glyph)');
  assert.match(box, /wallet-glyph/,
    'the wallet shape (inline SVG) must be rendered inside the pill');
  assert.match(box, /<svg[^>]*aria-hidden="true"/,
    'the wallet glyph is decoration and must be aria-hidden (the pill title + label say what it is)');
  // The 2026-10-06 order, pinned both ways: no bear img inside the pocket,
  // no leftover class pointing at the deleted rule, and no bare emoji.
  assert.ok(!box.includes(BRAND),
    'the pill must not carry the bear image — one bear lives in the topbar now');
  assert.ok(!box.includes('pill-bear'),
    '.pill-bear would be a class with no rule behind it — deletion must be complete');
  assert.ok(!box.includes('\u{1F43B}'),
    'the pill must not fall back to a bare 🐻 emoji');
  // Top-right pair in one header: exactly one bear asset in the whole header.
  const header = html.slice(html.indexOf('class="topbar-logo"'), html.indexOf('</header>'));
  const bears = header.match(/assets\/bear\.svg/g) || [];
  assert.equal(bears.length, 1,
    `the header must carry exactly ONE bear asset (the topbar's), found ${bears.length}`);
});

test('each account row shows the wallet mark on the left, not a bear', () => {
  // Anchor on the account-row template and read a bounded window from there.
  // Searching the whole file for 'asset-info' finds the DASHBOARD rows first —
  // they appear earlier and reuse the same class names — so the slice came back
  // empty and a check like this failed on a product that was already correct.
  const start = app.indexOf('class="asset-row ${i === idx');
  assert.notEqual(start, -1, 'the account-row template must exist in app.js');
  const row = app.slice(start, start + 500);
  assert.match(row, /class="asset-icon"><svg class="asset-wallet"/,
    'the left-hand identity slot of an account row must be the inline wallet SVG');
  assert.match(row, /<svg[^>]*aria-hidden="true"/,
    'the row icon is decoration beside the account name — aria-hidden');
  assert.ok(!row.includes(BRAND),
    'account rows must not reintroduce the bear image (user order: "list wallet… ganti jadi dompet")');
  assert.ok(!row.includes('\u{1F43B}'),
    'account rows must not fall back to a bare 🐻 emoji');
});

test('every identity mark is given an explicit box, not left to the font', () => {
  // An <svg>/<img> with no box floats in whatever space the text metrics
  // leave, and an inline one also leaves a baseline gap under it — which is
  // exactly the "sits a little too low" the emoji version had.
  assert.ok(css.includes('.asset-wallet'), '.asset-wallet must have a rule: an unsized icon follows the font');
  const rule = css.slice(css.indexOf('.asset-wallet'), css.indexOf('.asset-wallet') + 220);
  assert.match(rule, /width:\s*\d/, '.asset-wallet needs an explicit width');
  assert.match(rule, /height:\s*\d/, '.asset-wallet needs an explicit height');
  assert.match(rule, /display:\s*block/, '.asset-wallet needs display:block, or the inline baseline leaves a gap');
  // The pill's positioning context survives the bear's removal — without it
  // the glyph would position against the pill label instead of its own box.
  const pw = css.slice(css.indexOf('.pill-wallet'), css.indexOf('.pill-wallet') + 200);
  assert.match(pw, /position:\s*relative/, '.pill-wallet must stay the positioning context');
  // Deleted rules must be deleted: a surviving .pill-bear/.asset-bear rule is
  // half a removal, and half-removals ship as features. Comments are stripped
  // first — a comment SAYING a class was removed is the documentation of the
  // very deletion this check is about, not a leftover rule.
  const noComments = css
    .split('\n').filter((l) => !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.pill-bear\s*[{,]/.test(noComments), '.pill-bear rule must be gone with its markup');
  assert.ok(!/\.asset-bear\s*[{,]/.test(noComments), '.asset-bear rule must be gone with its markup');
});
