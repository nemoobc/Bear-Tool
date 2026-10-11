// The Receive modal is where "one recovery phrase, every chain" becomes
// visible to a person. It used to show exactly one address — the EVM one —
// which is how a multi-account wallet quietly tells a user they have no Bitcoin
// address. These pin the shape of that screen so it cannot quietly shrink back.
//
// Everything rendered here comes from js/coin-trees.js, whose addresses are
// proven against published vectors in tests/coin-trees.test.js. What is pinned
// HERE is the wiring: that the modal asks that module (not a hardcoded string),
// renders every chain it gets, labels an unavailable chain as unavailable
// rather than blank, and keeps the EVM address exactly where it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');
const css = readFileSync(path.join(here, '..', 'css', 'cartoon.css'), 'utf8');

const slice = (from, to) => {
  const i = app.indexOf(from);
  assert.notEqual(i, -1, `app.js must contain ${from}`);
  const j = to ? app.indexOf(to, i) : app.length;
  return app.slice(i, j > i ? j : app.length);
};

test('the receive modal lists every non-EVM chain the wallet can derive', () => {
  const fn = slice('function nonEvmReceiveRows()', 'function receiveAddressCard');
  assert.match(app, /import \{ nonEvmAddresses \} from '\.\/coin-trees\.js'/,
    'alamat non-EVM HARUS datang dari coin-trees.js — bukan string yang diketik di UI');
  assert.match(fn, /nonEvmAddresses\(secret, Number\(wallet\.getActiveAccountIndex\(\) \|\| 0\)\)/,
    'turunkan dari mnemonic sesi + akun yang sedang aktif');
  assert.match(fn, /wallet\.getSession\(\)/, 'butuh seed aktif; tanpa itu tidak ada yang dikarang');
  // Every chain coin-trees.js can return must have a row here — a chain that
  // works but is never rendered is a feature nobody can reach.
  for (const [key, label] of [['bitcoin', 'Bitcoin'], ['solana', 'Solana'], ['xrp', 'XRP']]) {
    assert.match(fn, new RegExp(`\\['${key}', '${label}'`), `${label} punya baris di receive`);
  }
});

test('an unavailable chain reads as unavailable — never a blank or a fake address', () => {
  const card = slice('function receiveAddressCard', 'function showReceiveModal');
  assert.match(card, /if \(!addr\)/, 'alamat kosong = belum tersedia');
  assert.match(card, /Not available yet/, 'ada kalimat yang menjelaskan');
  assert.match(card, /escapeHtml\(reason \|\| 'coming soon'\)/, 'alasan sebenar ikut tampil');
  assert.doesNotMatch(card.slice(0, card.indexOf('if (!addr)')),
    /data-copy=/, 'tidak ada tombol copy untuk alamat yang tidak ada');
});

test('the EVM address is unchanged and still first — the common case must not move', () => {
  const modal = slice('function showReceiveModal');
  assert.match(modal, /<h2>Receive \$\{escapeHtml\(evmLabel\)\}<\/h2>/, 'judul tetap sama');
  assert.match(modal, /data-copy="\$\{escapeHtml\(addr\)\}">Copy Address<\/button>/,
    'tombol Copy Address milik EVM tetap persis seperti sebelumnya');
  // The other chains come AFTER it, under a divider — never above.
  const evmAt = modal.indexOf('Copy Address');
  const chainsAt = modal.indexOf('${chainsHtml}');
  assert.ok(chainsAt > evmAt, 'chain lain menyusul DI BAWAH alamat EVM');
  assert.match(modal, /receive-other-title">Other chains — same recovery phrase/,
    'dan diberi tahu bahwa ini satu frasa pemulihan yang sama');
});

test('each chain is its own card, with its own copy button and QR', () => {
  const card = slice('function receiveAddressCard', 'function showReceiveModal');
  assert.match(card, /qrcode\(0, 'M'\)/, 'QR per chain, bukan cuma untuk EVM');
  assert.match(card, /data-copy="\$\{escapeHtml\(addr\)\}">Copy \$\{escapeHtml\(label\)\} address<\/button>/,
    'setiap chain punya tombol copy-nya sendiri');
  assert.match(card, /aria-label="QR code for \$\{escapeHtml\(label\)\}"/,
    'QR diberi label yang menyebut chain-nya (a11y)');
});

test('an XRP deposit shows its DestinationTag as its own copyable field', () => {
  // Exchanges put "Tag" in a separate box from "Address", and a deposit sent
  // with the wrong tag is routinely uncredited. The tag must therefore be a
  // labelled row with its OWN copy button, not a footnote — and it must come
  // from the derivation, never be typed or counted.
  const rows = slice('function nonEvmReceiveRows()', 'function receiveAddressCard');
  assert.match(rows, /destinationTag: row\.destinationTag/, 'tag diteruskan ke kartu');
  const card = slice('function receiveAddressCard', 'function showReceiveModal');
  assert.match(card, /tag !== undefined && tag !== null && tag !== ''/, 'hanya tampil kalau ada');
  assert.match(card, /receive-tag-label">Destination tag</, 'ada label yang menyebut "Destination tag"');
  assert.match(card, /data-copy="\$\{escapeHtml\(String\(tag\)\)\}"/, 'tag punya tombol copy sendiri');
  assert.match(card, /aria-label="Copy destination tag for/, 'tombol tag punya nama yang bisa dibaca screen reader');
  // The chain map must pass the tag through, not swallow it.
  assert.match(app, /receiveAddressCard\(\{\s*\n\s*label: c\.name, sublabel: c\.sym, addr: c\.address, reason: c\.reason, tag: c\.destinationTag,/,
    'showReceiveModal meneruskan tag ke kartu');
});

test('the receive-only chains also live in the Network list, each with its mark', () => {
  // "harusnya ada di list network" (report 2026-10-11): BTC/SOL/XRP are no
  // longer only a blob under the EVM address — the Network list carries them as
  // their own logo rows that open Receive focused on that chain.
  assert.match(app, /function nonEvmNetSection\(\)/, 'ada section receive-only di modal jaringan');
  assert.match(app, /\$\{nonEvmNetSection\(\)\}/, 'dan benar-benar dipasang di daftar');
  assert.match(app, /data-net-non-evm="\$\{escapeHtml\(c\.key\)\}"/, 'tiap baris punya key chain-nya');
  assert.match(app, /tokenLogoHTML\(c\.sym, 32, \{ remote: false \}\)/, 'tiap baris memakai mark chain-nya');
  assert.match(app, /const focusNonEvm = \['BTC', 'SOL', 'XRP'\]\.includes\(requested\) \? requested : null;/,
    'membuka Receive dari baris non-EVM memberi judul chain itu, bukan chain EVM aktif');
  assert.doesNotMatch(app, /data-net="\$\{escapeHtml\(c\.key\)\}"/, 'baris receive-only BUKAN network switch');
  // The receive cards themselves wear the chain mark.
  const card = slice('function receiveAddressCard', 'function showReceiveModal');
  assert.match(card, /tokenLogoHTML\(sublabel, 30, \{ remote: false \}\)/, 'kartu receive pakai logo chain');
  assert.match(css, /\.receive-chain-logo\s*\{/, 'dan CSS-nya ada');
  assert.ok(css.includes('.receive-chain-name'), 'nama+logo dibungkus flex');
});

test('the styles those cards rely on exist', () => {
  for (const sel of ['.receive-chain', '.receive-chain-head', '.receive-chain-sub',
    '.receive-addr', '.receive-chain-off', '.receive-divider', '.receive-other-title',
    '.receive-tag-row', '.receive-tag-label', '.receive-tag-value']) {
    assert.ok(css.includes(sel), `css/cartoon.css harus punya ${sel}`);
  }
  // Long bech32/XRP addresses must not push a copy button off a narrow phone.
  assert.match(css, /\.receive-addr\s*\{[^}]*word-break|overflow-wrap/,
    'alamat panjang wajib membungkus');
});