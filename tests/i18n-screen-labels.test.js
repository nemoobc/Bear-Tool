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
// Scope: once only the three money screens (send, swap, bridge). A scan of all
// ten views then found 79 more unwired labels — 47 of them on Deploy alone,
// including the paragraphs that explain what a rescue or a delegation actually
// does before the reader signs anything. In Indonesian those stayed English, so
// the app announced itself in one language and explained itself in another. The
// gate now covers every view, with the handful of strings that genuinely are not
// translatable listed by name below.
const ALLOW = new Set([
  // Router and provider names — they are brand names, not words.
  'KyberSwap', '1inch', 'ParaSwap', 'SushiSwap', 'Uniswap V3', 'Uniswap V2', 'LI.FI', 'OpenSea',
  // Language names, each written in its own language so a speaker finds them.
  'English', 'Bahasa Indonesia',
  // Currency labels: the code and its symbol ARE the label.
  'USD $', 'EUR €', 'IDR Rp', 'CNY ¥',
  // Standards and sentinels that are spelled the same in both languages.
  'ERC-20', 'ERC-721', 'MAX',
  // A section heading that is only an emoji plus a brand name.
  '🌊 OpenSea',
]);

const VIEWS = ['dashboard', 'activity', 'swap', 'send', 'dapps', 'deploy', 'nft', 'bridge', 'settings', 'discord'];
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jsxToHtmlSpelling } from './helpers/app-source.mjs';

// Tags whose text the user reads. VALUE (inputs) excluded — placeholders have
// their own data-i18n-placeholder channel; a literal body is exactly what we
// want flagged.
//
// div / span / p / option / a are here because Deploy keeps its explanations in
// plain <div className="small"> and <p> — the paragraphs that say what a rescue
// or a delegation does before anyone signs. Leaving those tags out made this gate
// incapable of failing on them, which is the one failure mode a gate must not
// have: it reported "all wired" while the longest help text in the app was
// unreachable.
const TAGS = /<(label|button|h1|h2|h3|h4|summary|legend|div|span|p|option|a|th)\b([^>]*)>([^<]{2,})<\/\1>/g;

const unwired = (src) => {
  const out = [];
  for (const m of src.matchAll(TAGS)) {
    const attrs = m[2];
    const text = m[3].trim();
    if (!/[A-Za-z]/.test(text)) continue;        // numbers/symbols only
    if (text.includes('{') || text.includes('}')) continue; // {expr} = filled at runtime
    if (/data-i18n(-[a-z]+)?=/.test(attrs)) continue;
    if (ALLOW.has(text)) continue;               // named, with a reason, above
    out.push(text.replace(/\s+/g, ' ').slice(0, 40));
  }
  return out;
};

const readView = (v) =>
  jsxToHtmlSpelling(readFileSync(new URL(`../src/views/${v}.jsx`, import.meta.url), 'utf8'));

test('no screen shows a label that never translates', () => {
  for (const v of VIEWS) {
    const bad = unwired(readView(v));
    assert.deepEqual(bad, [], `${v}.jsx shows English that never translates: ${bad.join(' | ')}`);
  }
});

// The allowlist is a decision, so it is held to being a decision: every entry has
// to be a string the views actually contain. A stale entry is a hole nobody
// re-checks, and an entry that grew to cover real prose would hide a regression
// perfectly — "Deploy contract" is not a brand name.
test('every allowed string is still a string the app really shows', () => {
  const shipped = VIEWS
    .map((v) => readView(v))
    .join('\n')
    .replace(/\s+/g, ' ');
  const stale = [...ALLOW].filter((a) => !shipped.includes(a));
  assert.deepEqual(stale, [], `allowlist menyebut teks yang sudah tidak ada: ${stale.join(' | ')}`);
  for (const a of ALLOW) {
    assert.ok(a.length <= 22, `"${a}" terlalu panjang untuk namabrand — daftarkan kuncinya, bukan teks panjangnya`);
  }
});

// A label that JS rewrites after render is a label with two authors. When "Balance"
// lived inside the string js/swap.js wrote, switching language made
// applyTranslations() replace the whole span and the balance the user was reading
// vanished back to an em dash — in English, until the next quote.
test('a runtime-written balance does not carry its own English label', () => {
  const swap = readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
  assert.doesNotMatch(swap, /textContent = `Balance:/,
    'label "Balance" harus elemen tersendiri yang diterjemahkan; JS hanya menulis nilainya');
  const view = readView('swap');
  for (const id of ['swapFromBalance', 'swapToBalance']) {
    const m = new RegExp(`<span[^>]*id="${id}"[^>]*>([^<]*)</span>`).exec(view);
    assert.ok(m, id + ' harus ada');
    assert.ok(!/Balance/i.test(m[1]), id + ' tidak boleh memuat label — hanya nilainya');
  }
  assert.match(view, /data-i18n="swap\.balance"/,
    'label saldo harus punya kunci sendiri');
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

// The i18n channel is textContent. An element carrying data-i18n therefore has to
// be text-only: applyTranslations() overwrites its content, and anything inside it
// goes with it. That is not hypothetical — it happened twice while wiring this
// file's own labels. Putting data-i18n on a dashboard quick-action <button>
// replaced the button's SVG icon; putting it on the activity list wrapper replaced
// the whole JS-rendered list with the word "No transactions yet". And two
// OpenSea guide paragraphs had shipped with <em> and <code> inside for months:
// switching language silently flattened them, so the screen looked different after
// a switch than before it.
test('no data-i18n element carries child markup that a language switch would erase', () => {
  for (const v of VIEWS) {
    const src = readView(v);
    const offenders = [];
    for (const m of src.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*data-i18n="[^"]+"[^>]*)>([\s\S]*?)<\/\1>/g)) {
      if (m[3].includes('<') && /<\w+/.test(m[3])) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${v}.jsx:${line} <${m[1]}> memuat <${(m[3].match(/<(\w+)/) || [])[1]}>`);
      }
    }
    assert.deepEqual(offenders, [], `data-i18n menimpa markup: ${offenders.join(' | ')}`);
  }
});
