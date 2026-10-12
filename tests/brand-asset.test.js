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

// Visual regression found by LOOKING at the emulator screenshot
// 34-network-picker.png (2026-12): "BNB Smart Chain" wrapped onto THREE lines in
// the 282px network card, so that card was twice the height of its neighbours and
// "Chain 56 · BNB" spilled onto a second line. No unit test could see it — it is
// a layout fact, and nothing measured the box.
//
// Two fixes came after that, and the second one was just as wrong as the first:
//   1. min-width:0 so the name would elide  -> the name elided to "BNB S…",
//      "Arbitr…", "Ether…" and the subtitle to "Chain 1·…". A picker that cannot
//      read out the chain you are about to switch to is worse than a tall card.
//   2. this grid: the name gets a row to itself across the full card width, and
//      the subtitle and the type badge share the line under it.
//
// What is assertable from source is the SHAPE of that layout — which slot each
// piece occupies. Whether a name fits is measured on the device instead
// (tools/emulator-e2e.mjs, "network names are clipped in the picker"), because
// that is a property of a real card, not of a stylesheet.
test('a network row gives the chain name its own full-width line', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');

  const row = /\.asset-row\[data-net\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(row, 'baris jaringan harus punya aturan sendiri');
  assert.match(row[1], /display:\s*grid/,
    'nama dan badge tak bisa berbagi satu baris: badge "Mainnet" memakan ~73px dari ~187px');
  assert.match(row[1], /grid-template-areas:[\s\S]*logo[\s\S]*name[\s\S]*name/,
    'nama harus membentang penuh di barisnya, bukan berbagi lebar dengan badge');
  assert.match(row[1], /grid-template-areas:[\s\S]*symbol[\s\S]*badge/,
    'badge pindah ke baris subjudul — di situ ia tidakconditionally menyingkirkan nama');
  assert.match(row[1], /grid-template-columns:[^;]*minmax\(0,\s*1fr\)/,
    'kolom teks harus boleh menyusut (minmax(0,1fr)); kalau tidak, nama meluber');

  // The info wrapper hands its children to the grid; without this the areas name
  // the logo and the badge but neither text element is ever placed.
  assert.match(css, /\.asset-row\[data-net\][^}]*\.asset-info\s*\{\s*display:\s*contents/,
    '.asset-info harus jadi display:contents agar nama & subjudul benar-benar jadi sel grid');
  assert.match(css, /\.asset-row\[data-net\][^}]*\.asset-name\s*\{\s*grid-area:\s*name/);
  assert.match(css, /\.asset-row\[data-net\][^}]*\.asset-symbol\s*\{\s*grid-area:\s*symbol/);
  assert.match(css, /\.asset-row\[data-net\][^}]*\.badge\s*\{[^}]*justify-self:\s*end/,
    'badge menempel kanan di barisnya sendiri');

  // Still one line, still clipped visibly rather than pushing the row apart: the
  // ellipsis is the floor for absurdly narrow screens, not the plan. The device
  // measurement above is what says whether it is ever reached.
  for (const part of ['asset-name', 'asset-symbol']) {
    // Every rule mentioning this part, joined: the placement rule says
    // `grid-area: name` and a separate grouped rule carries min-width / nowrap /
    // ellipsis. Reading only the first one made this gate fail on a layout that
    // was correct — a gate that cries wolf about correct code teaches you to
    // ignore it.
    const blocks = [...css.matchAll(new RegExp(`\\.asset-row\\[data-net\\][^{;]*\\.${part}[^{;]*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]).join('\n');
    assert.ok(blocks, part + ' harus punya aturan di baris jaringan');
    assert.match(blocks, /min-width:\s*0/, part + ' harus boleh menyusut');
    assert.match(blocks, /white-space:\s*nowrap/, part + ' tidak boleh membungkus jadi kartu tinggi');
    assert.match(blocks, /text-overflow:\s*ellipsis/, part + ' terpotong harus kelihatan');
  }

  // Scoped, not global: .asset-name is shared with the dashboard asset list, where
  // a long token name SHOULD wrap.
  const bare = /^\s*\.asset-name\s*\{[^}]*(text-overflow|white-space)\s*:/m;
  assert.doesNotMatch(css, bare,
    'jangan membuat semua asset name elide — daftar aset di dashboard masih boleh wrap');
});
