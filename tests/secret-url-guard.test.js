// The guard that decides whether a pasted address may be opened at all.
//
// It is not a "do not save to history" hint: dapp-browser.js REFUSES to
// navigate when the TRANSMITTED part (scheme, host, path, query) returns
// secret — that request would hand the key to the server. A fragment never
// reaches the server, so a #id_token=… callback loads, and persistence then
// drops it (saveSession/rememberHistory/bookmarks all gate on this function).
// That makes two things matter equally — it must catch key material, and it
// must not block ordinary URLs.
//
// Both halves were wrong before this file existed:
//   - a private key after '#' slipped through, because '#' was missing from the
//     boundary class, and the fragment is where people actually paste things
//   - a mnemonic encoded as %20 or + slipped through, because a browser encodes
//     a pasted phrase the moment it hits the address bar, and the word-run regex
//     needed literal whitespace
//   - and once decoding was added, "twelve or more words" blocked legitimate
//     URLs with long queries, so the count is now pinned to the lengths BIP-39
//     actually produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretishUrl, transmittedPart } from '../js/security.js';

const P12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const P15 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const P24 = Array(23).fill('abandon').join(' ') + ' about';
const enc = encodeURIComponent;
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('every BIP-39 length is caught, encoded or not', () => {
  for (const [label, phrase] of [['12', P12], ['15', P15], ['24', P24]]) {
    assert.equal(isSecretishUrl('https://x.com/?s=' + enc(phrase)).secret, true,
      `${label}-word mnemonic must be caught URL-encoded`);
    assert.equal(isSecretishUrl('https://x.com/?s=' + phrase).secret, true,
      `${label}-word mnemonic must be caught plain`);
    assert.equal(isSecretishUrl('https://x.com/?s=' + phrase.replace(/ /g, '+')).secret, true,
      `${label}-word mnemonic must be caught plus-encoded`);
    assert.equal(isSecretishUrl('https://x.com/#' + enc(phrase)).secret, true,
      `${label}-word mnemonic must be caught in a fragment`);
  }
});

test('a private key is caught wherever it is pasted', () => {
  for (const u of [
    'https://x.com/#' + PK,
    'https://x.com/?k=' + PK,
    'https://x.com/' + PK,
    'https://x.com/?k=' + PK.slice(2),   // bare hex, no 0x
  ]) {
    assert.equal(isSecretishUrl(u).secret, true, `must catch ${u.slice(0, 40)}…`);
  }
});

test('an explicit secret parameter is caught whatever its value', () => {
  for (const u of ['https://x.com/?seed=hello', 'https://x.com/?privatekey=x', 'https://x.com/#password=1']) {
    assert.equal(isSecretishUrl(u).secret, true, u);
  }
});

test('ordinary dApp and explorer traffic is never blocked', () => {
  for (const u of [
    'https://app.uniswap.org/swap?chain=ethereum',
    'https://app.aave.com/',
    'https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'https://docs.etherscan.io/contracts/token/erc20-20',
    'https://app.uniswap.org/swap?outputCurrency=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  ]) {
    assert.equal(isSecretishUrl(u).secret, false, `must NOT block ${u}`);
  }
});

test('a long ordinary query is not mistaken for a mnemonic', () => {
  // 13 and 11 words: not mnemonic lengths, so they open.
  assert.equal(isSecretishUrl('https://example.com/search?q=' + enc(
    'the quick brown fox jumps over the lazy dog and then runs away')).secret, false);
  assert.equal(isSecretishUrl('https://x.com/?q=' + enc(
    'how to send crypto to a friend safely')).secret, false);
  // 12 words of two characters each: right count, wrong word shape.
  assert.equal(isSecretishUrl('https://x.com/?q=' + enc(
    'aa bb cc dd ee ff gg hh ii jj kk ll')).secret, false);
});

test('known limitation, pinned so it cannot change silently', () => {
  // A 15-word lowercase phrase of 3-8 letter words is SHAPE-IDENTICAL to a real
  // 15-word mnemonic. Telling them apart needs the 2048-word BIP-39 list, which
  // this module deliberately does not carry. The cost of that choice is that such
  // a URL is refused with an explanation rather than opened. Pinned here so the
  // trade-off is visible, and so a future wordlist shows up as this test
  // changing rather than as a mystery.
  const fifteen = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
  assert.equal(isSecretishUrl('https://x.com/?q=' + enc(fifteen)).secret, true);
  assert.match(isSecretishUrl('https://x.com/?q=' + enc(fifteen)).why, /BIP-39/,
    'and the message must say why, not just refuse');
});

test('empty and null are safe', () => {
  for (const v of ['', null, undefined]) {
    assert.equal(isSecretishUrl(v).secret, false, String(v));
  }
});

test('a refusal always explains itself', () => {
  const r = isSecretishUrl('https://x.com/?s=' + enc(P12));
  assert.equal(r.secret, true);
  assert.ok(r.why && r.why.length > 20, 'a refusal with no reason is indistinguishable from a bug');
});

test('a secret-parameter refusal names the parameter, not the separator', () => {
  // Seen live: the message said `("?")` — group 1 was the [?&#] boundary, so
  // the user was told the question mark was the secret. Name it instead.
  for (const u of ['https://x.com/?password=hunter2', 'https://x.com/#access_token=abc', 'https://x.com/?a=1&api_key=k']) {
    const r = isSecretishUrl(u);
    assert.equal(r.secret, true, u);
    const m = /parameter \("([^"]+)"\)/.exec(r.why);
    assert.ok(m, `why must quote a name: ${r.why}`);
    assert.notEqual(m[1], '?', 'the separator is not a parameter name');
    assert.ok(/[a-z0-9_]/i.test(m[1]) && m[1] !== '=', `expected a real name, got "${m[1]}"`);
  }
});

test('only the transmitted part blocks navigation; the fragment loads', () => {
  // Browsers never send a "#". Everything before it goes to the server —
  // that half must be clean — and everything after it stays on the device,
  // which is exactly why OAuth puts its tokens there.
  assert.equal(transmittedPart('https://x.com/#id_token=abc'), 'https://x.com/');
  assert.equal(isSecretishUrl(transmittedPart('https://x.com/#id_token=abc')).secret, false,
    'a fragment callback loads — the token never leaves the device');
  assert.equal(isSecretishUrl(transmittedPart('https://x.com/?password=hunter2#x')).secret, true,
    'a secret in the query is transmitted and still refuses');
  assert.equal(isSecretishUrl(transmittedPart('https://x.com/' + 'ab'.repeat(32))).secret, true,
    'a bare key in the path is transmitted and still refuses');
});
