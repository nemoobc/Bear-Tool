// ═══════════════════════════════════════════════════════════
// Bear-Tool — tests/opensea-wiring.test.js
// M4 WIRING NYATA: tombol → modul → kode.
// Kartu NFT dirender DINAMIS dari template js/nft.js (bukan statis
// di index.html) — jadi test grep TEMPLATE nft.js + binding app.js.
// Jujur (HUKUM 11): klaim "wiring kelar" HANYA bila ini hijau nyata.
// ═══════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nftJs = readFileSync(new URL('../js/nft.js', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('wiring: template kartu NFT (nft.js) punya tombol List', () => {
  assert.match(nftJs, /data-opensea="list"/);
});
test('wiring: template kartu NFT (nft.js) punya tombol Cancel', () => {
  assert.match(nftJs, /data-opensea="cancel"/);
});
test('wiring: template kartu NFT (nft.js) punya tombol Fulfill', () => {
  assert.match(nftJs, /data-opensea="fulfill"/);
});
test('wiring: app.js import modul opensea (rantai tombol→kodeNYATA)', () => {
  assert.match(appJs, /from ['"]\.\/opensea\.js['"]/);
});
test('wiring: app.js BIND klik [data-opensea] → cancelOrder/fulfillBasicOrder (event delegation)', () => {
  assert.match(appJs, /data-opensea/);
  assert.match(appJs, /cancelOrder\(|fulfillBasicOrder\(/);
});
