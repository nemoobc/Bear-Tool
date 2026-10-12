// The Receive sheet shows exactly ONE network — the ACTIVE one. BTC/SOL/XRP are
// pickable networks (user 2026-10-11: "itu chain btc,sol,xrp bukan receive
// dijadiin satu" → pilih: "jadi network aktif yang bisa dipilih"), so the sheet
// reads the active network instead of appending every other chain under the EVM
// address ("Other chains — same recovery phrase" — the exact mixing removed).
//
// Everything rendered here comes from js/coin-trees.js, whose addresses are
// proven against published vectors in tests/coin-trees.test.js. What is pinned
// HERE is the wiring: that the sheet asks that module (not a hardcoded string),
// titles itself after the chain it shows, renders THAT chain's address (never
// the EVM one under a "Receive BTC" title), reports an unavailable chain
// instead of a blank, and carries XRP's destination tag.
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

test('the receive rows derive every non-EVM chain from the session seed', () => {
  const fn = slice('function nonEvmReceiveRows()', 'function showReceiveModal');
  assert.match(app, /import \{ nonEvmAddresses \} from '\.\/coin-trees\.js'/,
    'alamat non-EVM HARUS datang dari coin-trees.js — bukan string yang diketik di UI');
  assert.match(fn, /nonEvmAddresses\(secret, Number\(wallet\.getActiveAccountIndex\(\) \|\| 0\)\)/,
    'turunkan dari mnemonic sesi + akun yang sedang aktif');
  assert.match(fn, /wallet\.getSession\(\)/, 'butuh seed aktif; tanpa itu tidak ada yang dikarang');
  // Every chain the module can return must have a row here — a chain that works
  // but is never reachable is a feature nobody can use.
  for (const [key, label] of [['bitcoin', 'Bitcoin'], ['solana', 'Solana'], ['xrp', 'XRP']]) {
    assert.match(fn, new RegExp(`\\['${key}', '${label}'`), `${label} punya baris`);
  }
});

test('the sheet shows exactly ONE chain: the ACTIVE network', () => {
  const modal = slice('function showReceiveModal');
  assert.match(modal, /<h2>Receive \$\{escapeHtml\(label\)\}<\/h2>/, 'satu judul, satu chain');
  // The ACTIVE network decides the chain — never the token ticker. A BSC token
  // whose symbol is "BTC" (BTCB) used to reach the Bitcoin branch by name.
  assert.match(modal, /const nonEvm = isNonEvmNetwork\(net\)/,
    'chain non-EVM ditentukan oleh NETWORK AKTIF');
  assert.match(modal, /nonEvmReceiveRows\(\)\.find\(\(c\) => c\.sym === net\.symbol\)/,
    'ambil SATU baris — chain aktif, bukan semuanya');
  assert.doesNotMatch(modal, /\['BTC', 'SOL', 'XRP'\]\.includes\(/,
    'ticker token tidak boleh menentukan chain');
  // The old multi-chain dump is gone, root and branch — including the helper it
  // needed, so no dead code can quietly grow back into it. Checked against the
  // RENDERED template: the comment above this code quotes the removed wording.
  const tmpl = modal.slice(modal.indexOf('openModal(`'));
  assert.doesNotMatch(tmpl, /Other chains/, 'blok "Other chains" sudah dibuang');
  assert.doesNotMatch(tmpl, /chainsHtml/, 'tidak ada lagi render semua chain sekaligus');
  assert.doesNotMatch(app, /receiveAddressCard/, 'helper kartu per-chain sudah dihapus');
});

test('a non-EVM network shows ITS address, not the EVM one', () => {
  const modal = slice('function showReceiveModal');
  assert.match(modal, /const label = nonEvm \? nonEvm\.name/, 'judul memakai nama chain-nya');
  assert.match(modal, /const addr = nonEvm \? \(nonEvm\.address \|\| ''\) : \(address \|\| get\('address'\)\)/,
    'alamat mengikuti chain yang ditampilkan — bukan selalu alamat EVM');
  assert.match(modal, /const tag = nonEvm \? nonEvm\.destinationTag/, 'tag XRP ikut kalau ada');
});

test('an unavailable chain reads as unavailable — never a blank or a fake address', () => {
  const modal = slice('function showReceiveModal');
  const tmpl = modal.slice(modal.indexOf('openModal(`'));
  assert.match(tmpl, /!addr \?/, 'alamat kosong = belum tersedia');
  assert.match(tmpl, /Not available yet/, 'ada kalimat yang menjelaskan');
  assert.match(tmpl, /escapeHtml\(reason \|\| 'coming soon'\)/, 'alasan sebenar ikut tampil');
  // QR and copy button live ONLY in the "has an address" branch — a chain with
  // no address must not offer either.
  const offAt = tmpl.indexOf('!addr ?');
  assert.ok(tmpl.indexOf('receive-qr') > offAt, 'QR hanya di cabang ada-alamat');
  assert.ok(tmpl.indexOf('data-copy=') > offAt, 'tombol copy hanya di cabang ada-alamat');
});

test('the shown chain gets a QR and a copy button labelled with the chain', () => {
  const modal = slice('function showReceiveModal');
  assert.match(modal, /qrcode\(0, 'M'\)/, 'QR untuk chain yang ditampilkan');
  const tmpl = modal.slice(modal.indexOf('openModal(`'));
  assert.match(tmpl, /aria-label="QR code for \$\{escapeHtml\(label\)\}"/,
    'QR diberi label yang menyebut chain-nya (a11y)');
  assert.match(tmpl, /data-copy="\$\{escapeHtml\(addr\)\}">Copy Address<\/button>/,
    'tombol Copy Address membawa alamat chain itu');
});

test('an XRP deposit shows its DestinationTag as its own copyable field', () => {
  // Exchanges put "Tag" in a separate box from "Address", and a deposit sent
  // with the wrong tag is routinely uncredited. The tag must therefore be a
  // labelled row with its OWN copy button, not a footnote — and it must come
  // from the derivation, never be typed or counted.
  const rows = slice('function nonEvmReceiveRows()', 'function showReceiveModal');
  assert.match(rows, /destinationTag: row\.destinationTag/, 'tag diteruskan dari derivasi');
  const modal = slice('function showReceiveModal');
  assert.match(modal, /tag !== undefined && tag !== null && tag !== ''/, 'hanya tampil kalau ada');
  assert.match(modal, /receive-tag-label">Destination tag</, 'ada label yang menyebut "Destination tag"');
  assert.match(modal, /data-copy="\$\{escapeHtml\(String\(tag\)\)\}"/, 'tag punya tombol copy sendiri');
  assert.match(modal, /aria-label="Copy destination tag for/, 'tombol tag punya nama yang bisa dibaca screen reader');
});

test('the same-seed chains are pickable networks inside the mainnet list', () => {
  // "harusnya ada di list network" → "bukan receive only" → "jadi network aktif
  // yang bisa dipilih" (user 2026-10-11). BTC/SOL/XRP are rows of the SAME list
  // as the EVM mainnets, and picking one makes it the active network.
  assert.match(app, /function nonEvmNetRows\(\)/, 'ada baris chain same-seed');
  // Anchors use the DOM id attributes, not '#netListMainnet': that CSS-style
  // form only appears in the search handler further down the file.
  const mainnet = app.indexOf('id="netListMainnet"');
  const testnet = app.indexOf('id="netListTestnet"');
  const injected = mainnet > -1 ? app.indexOf('${nonEvmNetRows()}', mainnet) : -1;
  assert.ok(mainnet > -1 && injected > mainnet && (testnet === -1 || injected < testnet),
    'baris non-EVM dirender DI DALAM daftar MAINNET, bukan di seksi sendiri');
  assert.doesNotMatch(app, /id="netListNonEvm"/, 'tidak ada lagi seksi/bucket terpisah');
  assert.doesNotMatch(app, /RECEIVE-ONLY/, 'tidak ada lagi label "RECEIVE-ONLY"');
  assert.doesNotMatch(app, /· receive only/, 'subtitle tidak lagi bilang "receive only"');
  assert.match(app, /activateNetwork\(\(el\.dataset\.netNonEvm \|\| ''\)\.toLowerCase\(\)\)/,
    'tap satu baris = jadikan network AKTIF');
  const rowsFn = app.slice(app.indexOf('function nonEvmNetRows()'), app.indexOf('function showReceiveModal'));
  assert.match(rowsFn, /isCurrent[\s\S]*?✓ Current/, 'baris yang aktif menandai dirinya Current');
  assert.match(app, /data-net-non-evm="\$\{escapeHtml\(c\.key\)\}"/, 'tiap baris punya id chain-nya');
  assert.doesNotMatch(app, /data-net="\$\{escapeHtml\(c\.key\)\}"/, 'baris non-EVM BUKAN switch EVM (data-net)');
});

test('the styles the receive sheet uses exist — and the dead ones stay dead', () => {
  for (const sel of ['.receive-qr', '.receive-addr', '.receive-chain-off',
    '.receive-tag-row', '.receive-tag-label', '.receive-tag-value']) {
    assert.ok(css.includes(sel), `css/cartoon.css harus punya ${sel}`);
  }
  // Long bech32/XRP addresses must not push a copy button off a narrow phone.
  assert.match(css, /\.receive-addr\s*\{[^}]*word-break|overflow-wrap/,
    'alamat panjang wajib membungkus');
  // The one-chain-per-sheet rule retired these; they must not linger.
  for (const dead of ['.receive-divider', '.receive-other-title', '.receive-chain-name',
    '.receive-chain-logo', '.receive-chain-head', '.receive-chain-sub']) {
    assert.ok(!css.includes(dead), `${dead} sudah tidak dipakai — hapus dari CSS`);
  }
});
