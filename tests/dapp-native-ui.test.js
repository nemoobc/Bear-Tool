// The native dApp browser's two structural bugs — and the proof harness
// built over them — pinned as source shapes. Neither can be exercised
// without an emulator + a live confirm, so the wiring is asserted here:
//   1. confirmations rendered UNDER the full-screen dapp overlay were
//      invisible and unclickable: every confirmation-bound RPC (connect,
//      sign, send) hung forever on a tap nobody could make. Fix: askUser()
//      hides the overlay around each confirm (depth-counted) via the
//      plugin's setVisible, Java restores it after.
//   2. the native branch of openDappBrowser() built NO UI — no toolbar, no
//      address bar — so the user was trapped in the dapp with no way back.
//      Fix: a native toolbar (dapp-back / dapp-close) drawn by the plugin.
// The E2E journey (tools/emulator-e2e.mjs) then drives the whole chain:
// fixture -> open -> provider -> eth_chainId -> confirm -> accounts -> back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'js', 'native-dapp.js'), 'utf8');
// Comments quote shapes for context; only code is judged.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const java = readFileSync(path.join(here, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'nemoobc', 'beartool', 'BearDappBrowserPlugin.java'), 'utf8');
const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');

test('every confirmTx in the dapp RPC path flashes to the wallet — all four, no naked one', () => {
  assert.equal((code.match(/askUser\(\(\) => confirmTx\(\{/g) || []).length, 4,
    'keempat konfirmasi native (connect/sign/typed/send) wajib lewat askUser — satu telanjang = modal terkubur di bawah overlay');
  assert.equal((code.match(/await confirmTx\(\{/g) || []).length, 0,
    'confirmTx tanpa askUser = prompt digambar di bawah dapp view: tak terlihat, tak bisa diklik, RPC hang selamanya');
  assert.match(code, /let confirmDepth = 0;/, 'kedalaman wajib dihitung — dua konfirmasi paralel tak boleh menampilkan overlay di bawah prompt pertama');
  assert.match(code, /confirmDepth \+= 1;/);
  assert.match(code, /confirmDepth -= 1;/);
  assert.match(code, /confirmDepth === 0/, 'restore hanya saat semua konfirmasi selesai');
  assert.match(code, /p\.setVisible\(\{ visible: false \}\)/);
  assert.match(code, /p\.setVisible\(\{ visible: true \}\)/);
});

test('the E2E hook can only open a URL, and only on native', () => {
  assert.match(code, /window\.__bearE2EOpenDapp = \(url\) => \(isNativeDappBrowser\(\)/,
    'hook wajib native-only — web memakai iframe browser, jangan biarkan hook menembusnya');
  assert.match(code, /dapp browser hook is native-only/,
    'penolakan web wajib berbunyi keras (rejected), bukan diam');
  // Same authority as a catalogue card tap: opens a URL, touches no wallet state.
  assert.match(code, /\? openNativeDapp\(url\)/,
    'hook hanya boleh membuka URL — bukan pintu ke signing atau state dompet');
});

test('the plugin restores the overlay and carries native controls the user can reach', () => {
  assert.match(java, /public void setVisible\(PluginCall call\)/,
    'setVisible adalah satu-satunya jalan flash-to-wallet — tanpanya confirmTx terkubur');
  assert.match(java, /call\.getBoolean\("visible", false\)/, 'default false = aman: tanpa argumen overlay tetap tersembunyi');
  assert.match(java, /\.setContentDescription\("dapp-back"\)/, 'tombol back wajib berlabel — a11y + pilihan uiautomator driver E2E');
  assert.match(java, /\.setContentDescription\("dapp-close"\)/);
  assert.match(java, /toolbar\.bringToFront\(\)/, 'toolbar wajib bringToFront — di bawah refreshLayout = tak terlihat lagi');
  assert.match(java, /setOnClickListener\(v -> doBack\(\)\)/, 'tombol toolbar dan plugin method wajib satu jalur doBack — dua logika = dua perilaku');
  assert.match(java, /setOnClickListener\(v -> doClose\(\)\)/);
  assert.match(java, /private void hideDappView\(\)/, 'sembunyikan = tutup SEMUA (refresh + toolbar + halaman), bukan sebagian');
  // The visible flag must guard on an open view, or it resurrects a closed browser.
  assert.match(java, /if \(dappView != null\) \{[\s\S]*refreshLayout\.setVisibility\(visible \? View\.VISIBLE : View\.GONE\)/,
    'setVisible wajib no-op saat browser belum pernah dibuka');
});

test('the fixture page can never hang the journey — every request races a deadline', () => {
  assert.match(fixture, /id="out"/, 'hasil dibaca driver dari #out lewat target CDP sendiri');
  assert.match(fixture, /eth_requestAccounts/, 'rantai wajib melewati konfirmasi pengguna');
  assert.match(fixture, /eth_chainId/);
  assert.match(fixture, /hasProvider/, 'keberadaan provider ter-inject = bukti injeksi berjalan');
  assert.match(fixture, /deadline\(/, 'tanpa bridge (mis. dibuka di browser biasa) halaman harus gagal BERISIK, bukan menggantung');
  assert.match(fixture, /done=(?:'|\+ ?'?)?ok|done', 'ok'/, 'penanda selesai ada');
  assert.match(fixture, /bear-rpc-fixture/, 'judul = identitas target CDP yang dicari driver');
});

test('cleartext is a DEBUG-only door — the fixture loads, production stays blocked', () => {
  const debugManifest = readFileSync(path.join(here, '..', 'android', 'app', 'src', 'debug', 'AndroidManifest.xml'), 'utf8');
  const mainManifest = readFileSync(path.join(here, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  // Run 38031909581 (2026-10-10): targetSdk 28+ refuses http://10.0.2.2 —
  // loadStart+loadEnd in the SAME millisecond, zero bytes reached the
  // server, and the journey died waiting for a confirm that could never be
  // asked. The fixture needs plain http (a second WebView does not trust
  // Capacitor's local certificate) — so the door opens in src/debug only.
  assert.match(debugManifest, /android:usesCleartextTraffic="true"/,
    'manifest debug wajib buka cleartext — tanpanya fixture tak pernah termuat');
  assert.doesNotMatch(mainManifest, /usesCleartextTraffic/,
    'produksi wajib TETAP memblokir cleartext — dapp nyata = https, pintu tes tak boleh ikut terbangun');
});

test('the fixture server log cannot hide behind buffering, and native failures get a real screen', () => {
  const driverSrc = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const wfRaw = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  assert.match(wfRaw, /python3 -u -m http\.server/,
    '-u wajib: banner & baris akses kebuffer = http-server.log kosong saat diagnosis (run 38031909581)');
  // A CDP screenshot only ever shows the wallet's DOM — the overlay, the
  // toolbar and a stuck native load live outside every page target.
  assert.match(driverSrc, /shotScreen\('99-failure-screen'\)/,
    'jalur gagal wajib menangkap layar UTUH via adb — 99-failure.png CDP memperlihatkan dashboard tenang saat dapp WebView macet');
});
