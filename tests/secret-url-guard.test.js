// The guard that decides whether a pasted address may be opened at all.
//
// It is not a "do not save to history" hint: dapp-browser.js REFUSES to navigate
// when this returns secret. That makes two things matter equally — it must
// catch key material, and it must not block ordinary URLs.
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
import { isSecretishUrl } from '../js/security.js';

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
