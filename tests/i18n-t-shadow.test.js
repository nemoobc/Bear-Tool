// `t` is the i18n function. A LOCAL binding named `t` in the same scope turns
// every `t('key')` call in that scope into a runtime
// `TypeError: t is not a function` — the exact failure that took the whole
// fork suite red at 8a33773 (2026-10-13): doSend()'s confirm sheets called
// t('cf.…') AFTER `const t = token`, and the fork tests are the only runner
// that executes doSend end-to-end (Playwright caught the sibling in
// 11-onchain-fork). The fix was renaming every shadow (tkn/tok/typ/…); this
// gate keeps `t` meaning ONE thing in the modules that import it. No AST
// dependency needed — the rule is absolute, and `t(` calls are the function
// itself, never a shadow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../js/', import.meta.url);
const IMPORTS_T = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\/i18n\.js'/;
const SHADOWS = [
  [/\b(?:const|let|var)\s+t\b/, 'declaration: const/let/var t'],
  [/\(\s*t\s*[,)]/, 'parenthesised parameter: (t) or (t, …)'],
  [/[\s(,]t\s*=>/, 'bare arrow parameter: t =>'],
  [/function\s+[A-Za-z0-9_]+\(\s*t\s*[,)]/, 'function parameter: f(t)'],
  [/\bfor\s*\(\s*(?:const|let|var)\s+t\b/, 'for-binding: for (const t …'],
  [/\bcatch\s*\(\s*t\s*\)/, 'catch parameter: catch (t)'],
];

test('i18n: a module that imports t never shadows it with a local binding', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const importing = files.filter((f) => IMPORTS_T.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(importing.length >= 8,
    `expected the known i18n modules, found ${importing.length}: ${importing.join(', ')}`);
  const offenders = [];
  for (const f of importing) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const [re, label] of SHADOWS) {
      const m = src.match(re);
      if (m) offenders.push(`${f}: ${label} → ${m[0].trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [],
    't must mean the translation function only — a shadow crashes every t() call in that scope');
});

test('i18n: the doSend confirm path really calls t() (the crash site stays covered)', () => {
  // The gate above is worthless if the calls disappear entirely: pin the
  // exact lines that crashed on the fork so a silent "fix" by deletion fails.
  const send = readFileSync(new URL('../js/send.js', import.meta.url), 'utf8');
  assert.match(send, /title: t\('cf\.mainnet\.transaction'\)/, 'mainnet confirm title goes through i18n');
  assert.match(send, /confirmText: t\('cf\.confirm\.send'\)/, 'send confirm label goes through i18n');
  const at = send.indexOf('export async function doSend()');
  assert.ok(at > -1, 'doSend exists');
  const body = send.slice(at, at + 6500);
  assert.doesNotMatch(body, /(?<![\w.$])t\s*=\s*/, 'no `t =` rebinding inside doSend');
  assert.match(body, /t\('cf\.network'\)/, 'i18n t() calls coexist safely with tkn');
});
