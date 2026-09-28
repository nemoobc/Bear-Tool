// A module that references a symbol nobody defined.
//
// This exists because js/swap.js spent a long time calling UNISWAP_V2_ABI and
// UNISWAP_V3_ABI, neither of which was defined anywhere in js/. Every quote and
// every swap threw `ReferenceError`, on every chain, while the suite was green.
//
// The suite was green for two reasons, and both are worth naming. The fork swap
// test built its own V2 call with its own ABI, so it never touched the broken
// module; and the unit tests read js/swap.js as text, so a symbol that is
// referenced but undeclared looks exactly like a symbol that is fine. The
// registry test that went with the rewrite checked that swap.js no longer
// declared router ADDRESSES — and read that as proof the rewrite was complete,
// while the ABI constants had gone with the address tables.
//
// A gate made only of "this must not exist" assertions is half a gate. This one
// looks the other way: it requires that every screaming-snake identifier a module
// uses is actually declared. It is a lexical check, not a type check — it cannot
// know whether a name means what the code thinks — but the specific failure it
// hunts is a name that resolves to nothing at all, and that is decidable here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.join(here, '..', 'js');

// vendor/ holds third-party UMD builds with their own conventions; a lexical rule
// tuned for this codebase's modules would drown in their minified internals.
const modules = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();

// Module constants in this codebase are SCREAMING_SNAKE (UNISWAP_V2_ABI,
// NATIVE_SENTINEL, CACHE_TTL) and those are exactly the names that disappear
// silently: nothing at the call site says "this is defined elsewhere".
//
// The first version of this pattern required an underscore, which quietly excluded
// every single-word constant — TABLE among them. TABLE is defined once in
// js/errors.js and read on two lines, and deleting its declaration throws a
// ReferenceError the first time any error is explained. The mutation was not
// caught because the rule was never looking at that name shape at all: a gate that
// does not know what it covers reports "nothing found" the same way it reports
// "nothing wrong".
const NAME = /\b([A-Z][A-Z0-9_]{3,})\b/g;

// Names the platform provides, or that are conventional rather than local. Listed
// explicitly so the rule can be wide: a rule narrow enough to need no allowlist is
// also narrow enough to miss things, which is how the underscore-only version came
// to pass a deleted declaration.
const AMBIENT = new Set([
  'JSON', 'URL', 'URLSearchParams', 'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Error', 'TypeError',
  'RangeError', 'ReferenceError', 'Set', 'Map', 'WeakMap', 'Uint8Array', 'ArrayBuffer',
  'TextEncoder', 'TextDecoder', 'AbortController', 'Event', 'CustomEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'WebSocket', 'Headers', 'Request', 'Response',
  'Intl', 'Infinity', 'NaN', 'Target', 'TargetId', 'Clixml', 'Objs', 'Version',
]);

function stripCommentsAndStrings(src) {
  // A name inside a comment, a string, or a REGEX LITERAL is not a reference, and
  // counting those produces exactly the false positives that make a lint get
  // switched off. The regex case arrived with js/errors.js, whose matchers are
  // literal patterns like /TRANSFER_FROM_FAILED/ — shouting-snake text the rule was
  // certain was a missing constant.
  //
  // The one rule this must obey, and the reason the lossless invariant below
  // exists: blanking never removes a character and never turns a newline into a
  // space. An earlier version did both, which collapsed the line numbering — 2641
  // lines of app.js were read as 1014, and the detector reported "no undefined
  // symbols" over code it had never seen. Replacing a run with ' '.repeat(n)
  // destroys any newline inside it, so the replacement blanks character by
  // character and leaves \n alone.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const body = (open, close) => (m) => open + blank(m.slice(1, -1)) + close;
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
    .replace(/'(?:\\.|[^'\\\n])*'/g, body("'", "'"))
    .replace(/"(?:\\.|[^"\\\n])*"/g, body('"', '"'))
    .replace(/`(?:\\.|[^`\\])*`/g, body('`', '`'))
    .replace(/(^|[\s(=,:[!&|?{};+*%<>~^-])\/(?![*/])(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n])+\/[gimsuyd]*/g,
      (m, p1) => p1 + blank(m.slice(p1.length)));
}

function declaredIn(src, name) {
  // Every pattern is anchored on something that can actually introduce a binding.
  //
  // The first version of this file also had `{[^}]*NAME[^}]*}` for destructuring,
  // which is not a destructuring rule at all: `[^}]*` spans newlines, so it
  // matched any brace, then the name somewhere later, then any closing brace. In a
  // file with a few hundred braces that is nearly every name, which made the whole
  // detector a false gate — it passed while UNISWAP_V2_ABI was deleted from the
  // source. Found by deleting the symbol on purpose and re-running, which is the
  // only way a new gate is worth believing.
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\b`),
    new RegExp(`\\bclass\\s+${name}\\b`),
    // An import clause is bounded by its own braces, so this one is safe as-is.
    new RegExp(`\\bimport\\b[^;]*?\\{[^}]*\\b${name}\\b[^}]*\\}`),
    // Destructuring only counts when a declaration introduces it — and "only" has
    // to mean only. This was `const\\s*{[^}]*NAME`, which also matches
    // `for (const [re, say] of TABLE)`: there is a `const` followed by a bracket
    // and the name somewhere inside. That made every destructured binding look
    // declared, so deleting the declaration of TABLE from js/errors.js passed the
    // whole suite. Real destructuring puts a comma or a closing brace right after
    // the name, and nothing else.
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*?(?:^|[\\s,{])${name}\\s*(?:[,}])`),
    // A binding in a for-of / for-in head. The name has to BE the declaration:
    // `for (const NAME of xs)` binds NAME, while `for (const [a, b] of TABLE)`
    // only reads TABLE. Matching any name inside the header made the loop in
    // js/errors.js look like the declaration of its own table, so deleting that
    // table's declaration passed. Found by deleting it and re-running, again.
    new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${name}\\s+of\\b`),
    // An object-literal key is a definition: `DELEGATION_PREFIX: '0xef0100'` inside
    // the EIP7702 table, `ERC721_CRITERIA: 4` inside ITEM_TYPE. Those are read back
    // as EIP7702.DELEGATION_PREFIX, and flagging the defining line as an undefined
    // reference is the detector complaining about the one line that is correct.
    // The scan side already skips a `?` before the name, so a ternary branch
    // (`cond ? NAME : x`) cannot be mistaken for a key by this pattern.
    new RegExp(`(?:[{,]|^)\\s*${name}\\s*:`),
  ];
  return patterns.some((re) => re.test(src));
}

for (const file of modules) {
  test(`js/${file} references no undefined screaming-snake constant`, () => {
    const raw = readFileSync(path.join(jsDir, file), 'utf8');
    const code = stripCommentsAndStrings(raw);
    const lines = code.split('\n');
    const problems = [];
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(NAME)) {
        const name = m[1];
        // A qualified name is a property, not a bare reference: EIP7702.ZERO_ADDRESS
        // is defined by the object it hangs off, so demanding a top-level
        // declaration for it reports a symbol that plainly exists. That false
        // positive appeared on the first run and would have been the fastest way
        // to get this file switched off.
        const before = lines[i].slice(0, m.index).replace(/\s+$/, '');
        if (before.endsWith('.') || before.endsWith('?.')) continue;
        // A `?` immediately before means this is a ternary branch, not a reference:
        // `cond ? NAME : x` mentions NAME without binding anything.
        if (before.endsWith('?')) continue;
        if (AMBIENT.has(name)) continue;
        if (declaredIn(code, name)) continue;
        // Report the first use only, so one missing symbol is one failure with
        // one location rather than a dozen.
        if (problems.some((p) => p.name === name)) continue;
        problems.push({ name, line: i + 1, text: raw.split('\n')[i].trim().slice(0, 100) });
      }
    }
    assert.equal(problems.length, 0,
      problems.length
        ? problems.map((p) => `  js/${file}:${p.line}  ${p.name}  —  ${p.text}`).join('\n')
        : '');
  });
}

test('the stripper is lossless: same length, only spaces differ', () => {
  // The invariant that matters more than any pattern above. A stripper feeds the
  // scan, and if it eats input then the scan silently sees less code than exists
  // — which is exactly what happened: a string pattern whose character class
  // included a newline replaced those newlines with spaces, the line numbering
  // drifted, and a real reference sat inside a region the strip had blanked. The
  // detector reported "no undefined symbols" over code it had never read.
  //
  // So the transformation is checked against its own input, on every module: the
  // output must be the same length as the source, and may differ from it only by
  // turning characters into spaces. That is a checkable property, and it fails the
  // moment the stripper starts deleting instead of blanking.
  const bad = [];
  for (const file of modules) {
    const raw = readFileSync(path.join(jsDir, file), 'utf8');
    const out = stripCommentsAndStrings(raw);
    if (out.length !== raw.length) {
      bad.push(`${file}: panjang ${raw.length} → ${out.length} (stripper menghapus ${raw.length - out.length} karakter)`);
      continue;
    }
    for (let i = 0; i < raw.length; i++) {
      if (out[i] !== raw[i] && out[i] !== ' ') {
        bad.push(`${file}: karakter di offset ${i} berubah dari ${JSON.stringify(raw[i])} menjadi ${JSON.stringify(out[i])}`);
        break;
      }
    }
    // Line count is the other half: the scan indexes by line, so blanking a
    // newline is worse than blanking a letter.
    if (out.split('\n').length !== raw.split('\n').length) {
      bad.push(`${file}: jumlah baris ${raw.split('\n').length} → ${out.split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the detector can see a symbol that is referenced but not declared', () => {
  // A detector that cannot fail is not a detector. This checks the checker on a
  // sample that contains exactly the bug it exists to find, without touching the
  // real source: if the rule ever stops matching, this goes red and says so.
  const sample = `
    const A = 1;
    const b = new Thing(UNISWAP_V2_ABI);
    const c = "SHOUTING_SNAKE in a string is not a reference";
    // const NOT_A_USE = 1;
  `;
  const code = stripCommentsAndStrings(sample);
  const used = [...code.matchAll(NAME)].map((m) => m[1]).filter((n) => !declaredIn(code, n));
  assert.deepEqual(used, ['UNISWAP_V2_ABI'],
    'deteksi gagal: nama di string/komentar ikut terhitung, atau nama yang benar-benar undefined lolos');
});
