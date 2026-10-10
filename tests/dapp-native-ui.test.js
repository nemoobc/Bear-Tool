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

test('Bridge.postMessage never touches the WebView — origin comes from a main-thread field', () => {
  const idx = java.indexOf('public void postMessage');
  assert.ok(idx > 0, 'Bridge.postMessage (jalur RPC dapp) harus ada');
  // Comments quote the forbidden shape (the origin line itself warns about
  // getUrl()); the detector judges code only — strip inline // tails.
  const region = java.slice(idx, idx + 1600).replace(/\/\/.*$/gm, '');
  // Run 38032829356 (2026-10-10): getUrl() from the JavaBridge thread threw
  // checkThread(), the SILENT catch ate it, and every dapp RPC waited forever
  // with no log line to explain the empty screen.
  assert.doesNotMatch(region, /getUrl\(\)/,
    'getUrl() dari thread JavaBridge = IllegalStateException via checkThread — seluruh RPC dapp mati diam-diam di catch');
  assert.match(region, /ev\.put\("origin", currentUrl\)/,
    'origin wajib dibaca dari field volatile yang ditulis onPageStarted (main thread) — tetap native-side, halaman tak bisa menamai originnya sendiri');
  assert.match(region, /rpcRequest dropped: /,
    'catch wajib meninggalkan jejak — drop tanpa log = diagnosis musta (run 38032829356)');
  assert.match(region, /e\.getClass\(\)\.getSimpleName\(\)/,
    'yang dicatat hanya class exception — payload halaman tak boleh masuk log (log injection)');
  assert.match(region, /Log\.w\("BearDappBrowser", "rpcRequest dropped: " \+ e\.getClass\(\)\.getSimpleName\(\)\)/,
    'bentuk log persis: prefix tetap + class exception — getMessage()/payload tak boleh ikut');
  assert.match(java, /volatile String currentUrl/, 'volatile: ditulis main thread, dibaca JavaBridge thread');
  assert.match(java, /currentUrl = url/, 'satu-satunya penulis = onPageStarted (lifecycle navigasi)');
});

test('the dApp page renders BELOW the toolbar — never underneath its own header band', () => {
  assert.match(java, /refreshLayout\.setPadding\(0, barH, 0, 0\)/,
    'padding di refreshLayout sendiri: margin lewat LayoutParams parent bisa hilang saat addView me-regenerate params');
  assert.match(java, /MATCH_PARENT, barH\)/, 'tinggi toolbar tetap (48dp * density) — jarak halaman = tinggi bar, tanpa menunggu measure');
  assert.match(java, /48 \* getActivity\(\)\.getResources\(\)\.getDisplayMetrics\(\)\.density/,
    'ukuran dp-density lewat getResources aktivitas — Plugin Capacitor tak mengekspos getResources() (compile error run 38033857612)');
});

test('a resolve is never silent — the provider reports its outcome and Java logs it', () => {
  const prov = readFileSync(path.join(here, '..', 'js', 'native-provider.js'), 'utf8');
  // Run 38034404898: the dapp view has no WebChromeClient, so a failed
  // evaluateJavascript logs NOTHING anywhere — the resolve vanished with
  // every hop quiet. The receiver now answers for itself.
  assert.match(prov, /return 'unknown-id'/, 'pending map tanpa id wajib teriak, bukan diam');
  assert.match(prov, /return 'resolved'/, 'sukses = status eksplisit untuk di-log sisi native');
  assert.match(prov, /return 'error-sent'/, 'reject juga berstatus — error path tak boleh ambigu');
  const region = java.slice(java.indexOf('public void resolve'), java.indexOf('public void resolve') + 1800);
  assert.match(region, /try \{ return String\(window\.__bearNativeResolve\(/, 'eval dibungkus try/catch yang MENGEMBALIKAN status — callback null membisu');
  assert.match(region, /resolve#" \+ id \+ "->"/, 'setiap resolve mengeluarkan satu baris Log.d ber-ID');
  assert.match(region, /catch \(e\) \{ return 'ERR '/, 'exception evaluateJavascript wajib berubah jadi string yang tercatat');
});

test('the fatal path carries the console too — a failed run reports what the wire saw', () => {
  const driverSrc = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The failure report of 38034404898 had consoleTrail=0 while logcat held
  // the CORS errors: the transfer lived only in the verdict, which a fatal
  // run never reaches.
  assert.match(driverSrc, /function collectConsole\(cdp\)/, 'transfer jadi fungsi drain (splice = idempoten)');
  assert.equal((driverSrc.match(/collectConsole\(cdp\)/g) || []).length, 3,
    'definisi + DUA panggilan: verdict sukses DAN catch fatal');
  assert.match(driverSrc, /cdp\.events\.splice\(0\)/, 'drain sekali — dipanggil dua kali tak boleh menghitung ganda');
});

test('the truth probes exist — a "resolved" that never settles must be decidable', () => {
  // Two independent runs (38040858378, 38046569239): resolve#1->"resolved"
  // from Java, fixture page alive, zero exceptions, deadline screams 30s.
  // The fixture stores ITS instance (Java echoes the same identity on its
  // side) and settles a page-registered promise WITHOUT native — machinery
  // and transport are now separable, whoever is lying.
  const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');
  assert.match(fixture, /window\.__pageResolve = window\.__bearNativeResolve;/,
    'fixture menyimpan instan resolve-nya sendiri — identity dibandingkan DUA sisi hop');
  assert.match(fixture, /window\.__bearE2EProbe = function/,
    'probe self-settle: page menyelesaikan promise-nya SENDIRI tanpa native — mesin vs transport');
  assert.match(fixture, /window\.__bearNativeResolve\(2, \{ result: '0xAB' \}\)/,
    'probe memakai resolve instance yang sama persis');
  const region = java.slice(java.indexOf('public void resolve'), java.indexOf('public void resolve') + 1800);
  assert.match(region, /window\.__pageResolve === window\.__bearNativeResolve/,
    'baris resolve# ikut melaporkan apakah konteks Java = konteks fixture (|same=)');
});

test('the provider injection closes the commit race — three hooks, each proves it landed', () => {
  // Run 38047794274: the fixture parsed window.ethereum = missing while the
  // previous run injected fine. onPageStarted is pre-commit (evaluate can
  // hit the OLD document), onPageFinished is post-parser (too late for
  // eager dApps). onPageCommitVisible is the deterministic point: committed
  // document, parser still on the network.
  assert.match(java, /public void onPageCommitVisible\(WebView view, String url\)/,
    'hook commit-visible di pasang — post-commit, pre-parser');
  const hooks = ['start', 'commit', 'finish'];
  for (const stage of hooks) {
    assert.match(java, new RegExp('injectProvider\\(view, "' + stage + '", url\\)'),
      'injeksi jalan di hook ' + stage + ' — tiga titik, script idempoten');
  }
  assert.match(java, /inject@" \+ stage \+ "->"/,
    'setiap hook membuktikan landing (inject@stage->true/false) — miss tak lagi bisu');
});

test('every @PluginMethod binds to ITS public PluginCall method — no orphans', () => {
  // Run 38048894477: a helper method was inserted between @PluginMethod and
  // open(). Java binds the orphaned annotation to the NEXT declaration
  // (injectProvider, private); open() vanishes from the native-injected
  // PluginHeaders and the JS core's method resolver throws
  // '"BearDappBrowser.open()" is not implemented on android' — while
  // addListener (base method, no annotation) keeps working, which is what
  // made the failure look impossible.
  const noComments = java.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const lines = noComments.split('\n');
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/@PluginMethod\s*\(?[^)]*\)?\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    assert.match(lines[j] || '', /public\s+[\w<>\[\], .]+\s+\w+\s*\(\s*PluginCall/,
      '@PluginMethod yatim — deklarasi berikutnya harus public …(PluginCall), dapat: ' + (lines[j] || 'END'));
    checked++;
  }
  assert.ok(checked >= 3, 'minimal 3 @PluginMethod terdeteksi, dapat: ' + checked);
  // the specific casualty of run 38048894477
  assert.match(noComments, /@PluginMethod\s*\n\s*public void open\s*\(\s*PluginCall/,
    'open() HARUS berpasangan langsung dengan @PluginMethod');
});

test('the exact Promise.all member is tracked — inner-settled vs outer-pending must be visible', () => {
  // Runs 38040858378/38046569239/38050667944: Java logged resolve#1->"resolved"
  // (same instance, same context, pending[1] found) while Promise.all timed
  // out. selfSettle proved the machinery works when the page calls it — so the
  // last question is whether the OUTER promise (the one Promise.all waits on)
  // followed the inner resolve. __id1 tracks that exact promise; the driver
  // reads its end state plus provider.chainId (written by request()'s own
  // .then) only in the failure branch — the dead run carries its own autopsy.
  const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');
  assert.match(fixture, /var p1 = window\.ethereum\.request\(\{ method: 'eth_chainId' \}\);/,
    'fixture menyimpan promise yang DIPAKAI Promise.all');
  assert.match(fixture, /window\.__id1 = \{ settled: false, value: null \};/,
    'tracker __id1 terpasang pada promise yang sama');
  assert.match(fixture, /Promise\.all\(\[\s*p1,/,
    'Promise.all menunggu p1 yang terlacak, bukan ekspresi anonim');
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
  assert.match(driver, /report\.dapp\.final = await dpage\.evaluate/,
    'driver membaca keadaan akhir HANYA di cabang gagal — bukti ikut terkirim');
  assert.match(driver, /id1: window\.__id1/, 'id1 masuk final');
  assert.match(driver, /ethChainId.*ethereum\.chainId/, 'provider.chainId masuk final (cb .then jalan/tidak)');
});
