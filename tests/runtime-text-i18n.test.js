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
// Confirmation sheets are the screens where a wrong word costs money, and they are
// built from object properties — `title:`, `k:`, `confirmText:` — which the
// textContent/innerHTML scan above cannot see: nothing is assigned to the DOM
// there, a value is handed to a renderer. Screenshot 06-dapp-connect-sheet.png
// showed the whole family in English on a wallet that speaks Indonesian.
//
// The pattern takes ANY first character. Its earlier form asked for a capital
// letter, and that single choice let "\u270d\ufe0f SIGN BRIDGE" through — four warning
// titles and every `k: 'To'` (two letters, and the pattern wanted three) stayed
// English while the gate stayed green. A gate that cannot see the thing it names
// is worse than no gate: it is a claim.
//
// `v:` is scanned too. Labels are not the only prose in a row: "none — a plain
// transfer" explained what the empty calldata meant, in English, to everyone.
const SHEET_MODULES = ['app', 'bridge', 'swap', 'eip7702-tools', 'send', 'deploy',
                       'native-dapp', 'walletconnect'];
// Proper nouns that are the same in both languages. Small and named, so a new
// entry is a visible decision rather than an escape hatch.
const SHEET_ALLOW = ['SAFE'];

test('the confirmation sheets carry no unwired literal of their own', () => {
  const bare = [];
  const prose = [];
  for (const mod of SHEET_MODULES) {
    const src = readFileSync(new URL(`../js/${mod}.js`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\b(title|confirmText|cancelText|k):\s*'([^']{2,90})'/g)) {
      if (SHEET_ALLOW.includes(m[2])) continue;
      bare.push(`${mod}.js ${m[1]}: '${m[2]}'`);
    }
    for (const m of src.matchAll(/\bv:\s*'([A-Za-z(][^']{6,90})'/g)) {
      const words = m[1].match(/[A-Za-z]{3,}/g) || [];
      if (words.length >= 2 && !m[1].startsWith('0x')) prose.push(`${mod}.js v: '${m[1]}'`);
    }
  }
  assert.deepEqual(bare, [], `sheet konfirmasi masih punya literal: ${bare.join(' | ')}`);
  assert.deepEqual(prose, [], `baris konfirmasi masih berisi kalimat Inggris: ${prose.join(' | ')}`);
});

// A row label that is a sentence has to go through t() as well, or the label is
// translated and its explanation is not — half an Indonesian screen.
test('every confirmation sheet module imports the translator it calls', () => {
  const missing = [];
  for (const mod of SHEET_MODULES) {
    const src = readFileSync(new URL(`../js/${mod}.js`, import.meta.url), 'utf8');
    if (src.includes("t('cf.") || src.includes("t('site.") || src.includes("t('sign.")) {
      if (!/from '\.\/i18n\.js'/.test(src)) missing.push(`${mod}.js`);
    }
  }
  assert.deepEqual(missing, [], `memanggil t() tanpa mengimpor penerjemah: ${missing.join(', ')}`);
});

// The connect sheet's capability list used to be one CSV line — "accounts, sign,
// send transactions" — where the irreversible one sat last with nothing marking it.
// Three of those capabilities cannot inform a decision if they are one string, so
// they are three rows and the sending one says plainly that it cannot be undone.
test('the connect sheet says what a site may ask, one row at a time', () => {
  const src = readFileSync(new URL('../js/native-dapp.js', import.meta.url), 'utf8');
  const at = src.indexOf("t('site.connectTitle'");
  assert.ok(at > 0, ' Judul connect harus lewat kamus');
  const body = src.slice(at, at + 900);
  for (const key of ['site.canSee', 'site.canSign', 'site.canSend']) {
    assert.match(body, new RegExp(`t\\('${key}'\\)`), `${key} harus punya barisnya sendiri`);
  }
  const dict = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const send = /'site\.canSendValue': '([^']+)'/.exec(dict);
  assert.ok(send, 'deskripsi "bisa mengirim" harus ada');
  assert.match(send[1], /cannot be undone/,
    'mengirim transaksi tidak bisa dibatalkan — itu harus tertulis, bukan tersirat');
});
