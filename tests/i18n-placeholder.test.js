// Interpolasi i18n punya FORMAT {{k}} (i18n.js __()), dan dua regresi M14
// (2026-10-13) lolos semua gerbang lokal karena tak ada yang memeriksa
// panggilan ↔ value:
//   1. app.js judul sheet: t('cf.authorise', { m: method }) tapi value
//      'Authorise' tanpa {{m}} → judul kehilangan nama method →
//      Playwright 18-dapp-browser 621/641 timeout (nunggu
//      'Authorise personal_sign').
//   2. 'os.key.bad' value pakai {code} single-brace → __() tak pernah
//      menggantinya → user melihat literal {code}.
// Gate ini memeriksa DUA arah: setiap t('key', {params}) wajib punya
// {{param}} di value en-nya, dan setiap key yang dirujuk data-i18n
// (tanpa params, via textContent) tak boleh menyisakan placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { jsModules } from './helpers/js-files.mjs';

const i18nSrc = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// Blok en berakhir tepat sebelum `  id: {` — struktur dipatok eksplisit,
// kalau struktur berubah harus sengaja diubah di sini juga.
const idAt = i18nSrc.indexOf('\n  id: {');
assert.ok(idAt > -1, 'i18n.js: penanda struktur "\\n  id: {" tidak ada — perbarui tes ini');
const enBlock = i18nSrc.slice(0, idAt);
const idBlock = i18nSrc.slice(idAt);
const parse = (block) =>
  Object.fromEntries([...block.matchAll(/'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
const en = parse(enBlock);
const idv = parse(idBlock);

/** Panggilan t('key', { … }) nyata — lookbehind menolak addEventListener('x', { … }. */
function paramCalls(src) {
  const out = [];
  for (const m of src.matchAll(/(?<![\w.])t\('([^']+)',\s*\{([^}]*)\}/g)) {
    const names = [...m[2].matchAll(/(\w+)\s*:/g)].map((p) => p[1]);
    out.push({ key: m[1], names, at: m[0].slice(0, 80) });
  }
  return out;
}

function jsFiles() {
  // Recursive — js/dex/*.js carries t() calls that must be held to the same
  // placeholder contract as every other module.
  return jsModules();
}

test('i18n: setiap t(key, params) punya {{param}} lengkap di value en', () => {
  const missing = [];
  let checked = 0;
  for (const f of jsFiles()) {
    const src = readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    for (const { key, names, at } of paramCalls(src)) {
      checked++;
      const val = en[key];
      if (val === undefined) { missing.push(`${f}: key tak ada di en → ${at}`); continue; }
      const ph = new Set([...val.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      for (const n of names) {
        if (!ph.has(n)) missing.push(`${f}: ${key} value tanpa {{${n}}} → ${JSON.stringify(val)}`);
      }
    }
  }
  assert.ok(checked >= 10, `ekspektasi ≥10 panggilan ber-params, dapat ${checked} — ekstraksi rusak?`);
  assert.deepEqual(missing, [], 'placeholder hilang = teks mentah / method hilang dari layar');
});

test('i18n: key yang dirujuk data-i18n tak menyisakan {{placeholder}} (textContent tanpa params)', () => {
  const sources = {
    ...Object.fromEntries(jsFiles().map((f) => [f, readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8')])),
    'index.html': readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
    ...Object.fromEntries(
      readdirSync(new URL('../src/views/', import.meta.url))
        .map((f) => [f, readFileSync(new URL(`../src/views/${f}`, import.meta.url), 'utf8')]),
    ),
  };
  const bad = [];
  for (const [name, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/data-i18n(?:-placeholder)?=["']([^"']+)["']/g)) {
      const val = en[m[1]];
      if (val !== undefined && /\{\{\w+\}\}/.test(val)) {
        bad.push(`${name}: data-i18n="${m[1]}" value berplaceholder ${JSON.stringify(val)}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'data-i18n di-render via textContent tanpa params — placeholder tampil mentah');
});

test("i18n: regresi M14 terkunci — judul sheet Authorise + os.key.bad", () => {
  // 1. Kunci judul method ada dan membawa {{m}} (kedua bahasa).
  for (const [dict, name] of [[en, 'en'], [idv, 'id']]) {
    const v = dict['cf.authorise.method'];
    assert.ok(v && /\{\{m\}\}/.test(v), `${name}: cf.authorise.method harus ada dan memuat {{m}}, dapat ${JSON.stringify(v)}`);
  }
  // 2. app.js memakai kunci judul itu — bukan kunci tombol polos.
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /title: t\('cf\.authorise\.method', \{ m: method \}\)/,
    'judul sheet permission wajib membawa method via kunci {{m}}');
  assert.doesNotMatch(app, /title: t\('cf\.authorise',/,
    "t('cf.authorise') tanpa params hanya untuk tombol — judul tanpa method = bug 621/641");
  // 3. os.key.bad: {{code}} di kedua bahasa, tanpa single-brace tersisa.
  for (const [dict, name] of [[en, 'en'], [idv, 'id']]) {
    const v = dict['os.key.bad'] || '';
    assert.match(v, /\{\{code\}\}/, `${name}: os.key.bad harus memakai {{code}}`);
    assert.doesNotMatch(v, /(?<!\{)\{code\}(?!\})/, `${name}: os.key.bad masih punya {code} single-brace`);
  }
});
