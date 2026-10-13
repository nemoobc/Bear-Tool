// Gerbang untuk kelas bug "add token" yang dilaporkan user (2026-10-13).
//
// ebc2c8a (refactor hapus non-EVM) menghapus DEFINISI activeChainLabel dari
// app.js tapi meninggalkan DUA pemanggilannya (label sheet #tdNetwork dan
// catatan tok.readFrom). ReferenceError membunuh setup modal Add Token tepat
// SEBELUM addEventListener('input') terpasang, jadi menempel alamat kontrak
// tak pernah memicu deteksi — sheet terbuka, kolom terisi, "Detecting…"
// tak pernah muncul. Tertangkap Playwright 12-parity #6 sebagai
// tdSymbol "—" (nilai template, tak pernah diubah), dan dari trace:
// console error "activeChainLabel is not defined".
//
// Varian laten dari kelas yang sama ikut dikunci di sini: bekas `currentChain`
// (dihapus di commit yang sama) masih dipakai sebagai fallback di
// activeChainId() — selamat dari short-circuit `||` selama chainId bernilai
// truthy, lalu meledak di jaringan tak dikenal. Global yang sudah mati tidak
// boleh dirujuk lagi: hanya currentChainId (dapp-exec) yang boleh ada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('add-token: activeChainLabel didefinisikan sebelum dipakai', () => {
  assert.match(app, /const activeChainLabel = \(\) =>/,
    'app.js harus mendefinisikan activeChainLabel — tanpa ini setup modal Add Token mati');
  // Kedua pemanggil tetap ada: label jaringan di sheet + catatan "Read from".
  assert.match(app, /t\('net\.label'\) \+ ' ' \+ activeChainLabel\(\)/,
    'baris #tdNetwork memakai label jaringan aktif');
  assert.match(app, /t\('tok\.readFrom', \{ net: activeChainLabel\(\) \}\)/,
    'catatan deteksi menyebut jaringan yang benar dibaca');
});

test('add-token: label = nama jaringan + chain id (bukan global yang sudah mati)', () => {
  // Definisi harus turunan activeNetName/activeChainId — bukan kembalinya
  // referensi ke global non-EVM yang sudah dihapus.
  assert.match(app, /const activeChainLabel = \(\) => `\$\{activeNetName\(\)\} \(chain \$\{activeChainId\(\)\}\)`/,
    'activeChainLabel harus menyusun nama + chain id dari network.js');
  assert.match(app, /const activeChainId = \(\) => getNetworkById\(get\('networkId'\)\)\?\.chainId \|\| 0/,
    'fallback chainId = 0 (jujur, "tak dikenal") — bukan rujukan global yang sudah dihapus');
});

test('add-token: bekas global non-EVM tidak dirujuk lagi', () => {
  // currentChain (tanpa Id) adalah global yang dihapus ebc2c8a — rujukan
  // apa pun kecuali currentChainId (dapp-exec) = ReferenceError siap saji.
  const bare = [...app.matchAll(/\bcurrentChain(?!Id)\b/g)];
  assert.deepEqual(bare.map((m) => m.input.slice(m.index - 40, m.index + 30)), [],
    'currentChain (bukan currentChainId) masih dirujuk di app.js');
  // Seluruh js/: nama yang sudah mati tidak boleh hidup lagi.
  for (const f of readdirSync(new URL('../js/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    for (const dead of ['isNonEvmNetwork', 'NON_EVM_CHAINS', 'nonEvmSend', 'chain-btc', 'chain-sol', 'chain-xrp']) {
      assert.ok(!src.includes(dead), `${f}: bekas non-EVM "${dead}" masih muncul`);
    }
  }
});
