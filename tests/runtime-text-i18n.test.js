// The dictionary is not optional UI polish — without it the app speaks two
// languages at once, in the same screen.
//
// The views wired 79 labels to the dictionary in one pass (i18n-screen-labels).
// But a whole second channel exists that nobody had scanned: the modules write
// straight into the DOM. So the NFT screen said "Listing..." and, two lines
// later, "Isi kontrak (atau link asset) + token ID dulu" — English and Indonesian
// in the same view, regardless of the language setting. Settings' own toggle
// hint had the same problem, written twice under one key so the second wording
// silently won and the first could never appear.
//
// This gate closes that channel: a user-visible literal assigned to textContent
// or innerHTML is a sentence somebody will read, so it goes through t(key).
//
// What it deliberately does not police:
//   - interpolated data (an address, a price, a token symbol) — not a sentence;
//   - a literal with no letters (a spinner glyph, "…", "—");
//   - markup-only assignments where every word already comes from the dictionary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MODULES = ['app', 'send', 'swap', 'walletconnect', 'eip7702-tools', 'nft', 'nft-intel', 'ui'];

// A string is a sentence if it has a word of two or more letters. That skips
// "×", "—", "…" and bare symbols, and catches everything a person reads.
const WORD = /[A-Za-z]{2,}/;

// t('…') or __t('…') must have been used, or the literal is prose in disguise.
const IS_TRANSLATED = /\b(t|__t)\(\s*'[^']+'/;

const offenders = (src) => {
  const out = [];
  const re = /(?:textContent|innerHTML)\s*=\s*(`|')(?:(?!\1)[^\\]|\\.)*\1/g;
  for (const m of src.matchAll(re)) {
    const lit = m[0];
    // Only the literal itself: template holes are data, and the sentence around
    // them is exactly what has to be translated.
    const body = lit.slice(lit.indexOf('=') + 1).trim();
    // Judge the WORDS, not the string: markup is a picture, a ${hole} is data,
    // and neither is a sentence. Only what a person reads outside the tags counts
    // — an <svg> built from numbers is not an unwired label, and flagging it
    // teaches you to skim the report.
    const words = body
      .replace(/<[^>]*>/g, ' ')
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(/[`'"]/g, ' ');
    if (!WORD.test(words)) continue;
    if (IS_TRANSLATED.test(lit)) continue;                        // already wired
    const line = src.slice(0, m.index).split('\n').length;
    out.push(`${line}: ${body.replace(/\s+/g, ' ').slice(0, 58)}`);
  }
  return out;
};

test('no module writes an unwired sentence straight into the page', () => {
  const all = [];
  for (const mod of MODULES) {
    let src;
    try {
      src = readFileSync(new URL(`../js/${mod}.js`, import.meta.url), 'utf8');
    } catch {
      continue; // module does not exist under that name; nothing to police
    }
    for (const o of offenders(src)) all.push(`${mod}.js ${o}`);
  }
  assert.deepEqual(all, [],
    `teks ini masuk ke layar tanpa melewati kamus:\n  ${all.join('\n  ')}`);
});

// The detector has to be able to see a sentence, or the gate above is a lamp
// with no bulb. Both directions are checked on purpose: a plain English literal
// is caught, and a wired one is not.
test('the runtime-text detector spots an unwired sentence and ignores a wired one', () => {
  const plain = "msg.textContent = 'Connecting to the relay...';";
  assert.deepEqual(offenders(plain), [`1: 'Connecting to the relay...'`]);

  const wired = "msg.textContent = t('wc.connecting');";
  assert.deepEqual(offenders(wired), []);

  // Data only: numbers and symbols, no sentence. The literal that DID have a word
  // in it — `Chain ${d.chain} · ${d.symbol}` in js/app.js — is correctly flagged,
  // which is how it ended up as t('net.chainLabel', …); a fixture that claimed it
  // was harmless would have taught the detector to ignore the very case it exists
  // to catch.
  const interpolated = "out.textContent = `${amount} ${symbol}`;";
  assert.deepEqual(offenders(interpolated), [], 'data, bukan kalimat');

  const symbols = "box.innerHTML = '…';";
  assert.deepEqual(offenders(symbols), [], 'tanpa kata, bukan kalimat');
});

// Every key the runtime path reaches for has to exist in both languages, or a
// switch to Indonesian leaves a bare key name on screen. i18n-keys-resolve
// proves that for the markup; this proves it for t('…') calls in the modules.
test('every t() key used by a module resolves in both languages', () => {
  const dict = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const missing = [];
  for (const mod of MODULES) {
    let src;
    try {
      src = readFileSync(new URL(`../js/${mod}.js`, import.meta.url), 'utf8');
    } catch { continue; }
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      const key = m[1];
      if (key.includes('{{')) continue;
      const hits = (dict.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
      if (hits === 0) missing.push(`${mod}.js -> ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], `kunci hilang dari kamus: ${[...new Set(missing)].join(', ')}`);
});