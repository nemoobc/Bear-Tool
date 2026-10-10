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
  // (2026-10-10 run 38063650949: the target id is the request's OWN __bearId —
  // a racing dapp makes seq order unknowable, and the old hardcoded 2
  // killed eth_requestAccounts' pending entry instead of the probe's)
  assert.match(fixture, /window\.__bearNativeResolve\(pr\.__bearId, \{ result: '0xAB' \}\)/,
    'probe memakai resolve instance yang sama persis, dengan id milik request-nya');
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
  assert.match(fixture, /Promise\.race\(\[\s*p1,/,
    'Promise.race menunggu p1 yang terlacak, bukan ekspresi anonim');
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
  assert.match(driver, /report\.dapp\.final = await dpage\.evaluate/,
    'driver membaca keadaan akhir HANYA di cabang gagal — bukti ikut terkirim');
  assert.match(driver, /id1: window\.__id1/, 'id1 masuk final');
  assert.match(driver, /ethChainId.*ethereum\.chainId/, 'provider.chainId masuk final (cb .then jalan/tidak)');
});

test('the fixture waits out the parser race and RECORDS it — providerLate is a first-class fact', () => {
  // Runs 38047794274/38056613084: all three native hooks logged
  // inject@<stage>->"true" while the fixture's parse-time window.ethereum
  // read came up empty — a local page parses in ~0ms and beats every queued
  // evaluateJavascript. The E2E must survive that (real dApps tolerate late
  // providers — EIP-6963), and the race must stay MEASURABLE: providerLate=0
  // = injection won, N = the parser did. A fixture that silently waits would
  // hide the very bug this line exists to expose.
  const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');
  assert.match(fixture, /rec\('providerLate', waited\)/,
    'lateness provider dicatat sebagai fakta output (bukan disembunyikan)');
  assert.match(fixture, /waited >= 3000\)\s*\{\s*rec\('error', 'no window\.ethereum'\)/,
    'tunggu DIBATASI 3s — tanpa provider tetap gagal jujur, tidak menggantung');
  assert.match(fixture, /function main\(\) \{/,
    'rantai RPC pindah ke main() — hanya jalan SETELAH provider ada');
  assert.match(fixture, /setTimeout\(poll, 50\)/, 'polling 50ms — jauh di bawah latensi injeksi mana pun');
  // main() must enclose the probes and the chain (parse-time registration of
  // __id1/__pageResolve would race the provider again)
  const mainIdx = fixture.indexOf('function main()');
  const pollIdx = fixture.indexOf('(function poll()');
  assert.ok(mainIdx > 0 && pollIdx > mainIdx, 'main() dibuka sebelum poll IIFE');
  assert.match(fixture.slice(mainIdx, pollIdx), /window\.__pageResolve = window\.__bearNativeResolve/,
    'probe registrations di DALAM main() — setelah provider, bukan di parse time');
  assert.match(fixture.slice(mainIdx, pollIdx), /Promise\.race\(\[\s*p1,/,
    'rantai race di DALAM main()');
});

test('the deadline joins by RACE, never by ALL — Promise.all([p1, deadline]) can never fire .then', () => {
  // THE root cause of runs 38046569239/38050667944's "mystery" (and the
  // apparent contradiction resolve#1->"resolved|same=true" vs
  // error=eth_chainId timeout 30000ms): deadline NEVER resolves — it only
  // rejects at +30s — and Promise.all needs EVERY member to resolve. So
  // .then was structurally unreachable, .catch always fired at 30s, and a
  // perfect native hop looked broken. First settler wins = race. This shape
  // must never come back: it fails in 30s while every probe says green.
  const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');
  // comment lines stripped first — the fix's own comment QUOTES the bug shape
  const code = fixture.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /Promise\.all\(\[[\s\S]{0,160}deadline/,
    'Promise.all + deadline = .then must never run — the exact bug that faked a transport failure');
  assert.match(fixture, /Promise\.race\(\[\s*p1,\s*deadline\(30000, 'eth_chainId'\)/,
    'chainId menempuh race terhadap deadline-nya');
  // value semantics follow race: .then receives the VALUE, not [value, ...]
  assert.match(fixture, /\]\)\.then\(function \(chainId\) \{\s*rec\('chainId', chainId\)/,
    'race memberikan nilai langsung — r[0] gaya Promise.all dilarang di sini');
  assert.match(fixture, /rec\('account0', \(\(accounts \|\| \[\]\)\[0\]/,
    'accounts race: nilai array langsung, bukan indeks tuple');
});

test('the probe settles by the request\'s OWN __bearId — hardcoded ids land on someone else\'s pending entry', () => {
  // Run 38063650949: race fix made the fixture FAST (providerLate=0) — the
  // dapp issued eth_requestAccounts (id 2) while the driver's probe was
  // still in flight, and the probe's hardcoded resolve(2,'0xAB') killed the
  // connect promise: account0='0' (that is '0xAB'[0]), accountsAgain='',
  // done=ok — a corrupted answer wearing a success costume.
  const provider = readFileSync(path.join(here, '..', 'js', 'native-provider.js'), 'utf8');
  assert.match(provider, /Object\.defineProperty\(p, '__bearId', \{ value: reqId \}\)/,
    'provider mengekspos __bearId non-enumerable di promise-nya sendiri');
  const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');
  assert.match(fixture, /__bearNativeResolve\(pr\.__bearId, \{ result: '0xAB' \}\)/,
    'probe settle by id milik request-nya sendiri');
  assert.match(fixture, /pr\.__bearId == null/,
    'id tak terlihat = probe gagal jujur (no-bearId), bukan menebak angka');
  assert.doesNotMatch(fixture, /__bearNativeResolve\(2,/,
    'id hardcode dilarang — urutan seq tak bisa ditebak saat dapp ngebut');
});

test('open() gates the scheme at native — non-http(s) never reaches loadUrl (MetaMask parity)', () => {
  // Before: open() rejected only an EMPTY url, so javascript:/data:/file:/wc:
  // went straight into loadUrl(). MetaMask Mobile's in-app browser only ever
  // loads http/https; every other shape must be refused HERE, on the main
  // thread, with a message the dApp can read — not an error page, not script
  // execution inside the view.
  // NOTE the guard region is read from RAW java: the /\/\/.*/ comment stripper
  // below eats `//` inside the "http://" string literals and produces a
  // mutated open() that no guard can match (http: then garbage).
  const region = java.slice(java.indexOf('public void open'), java.indexOf('public void open') + 1200);
  assert.match(region, /!u\.startsWith\("http:\/\/"\) && !u\.startsWith\("https:\/\/"\)/,
    'guard wajib menolak SEMUA scheme selain http/https — satu pengecualian = pintu celah');
  assert.match(region, /call\.reject\("unsupported scheme/,
    'penolakan wajib membawa pesan terbaca dApp (bukan diam)');
  assert.match(region, /opens http\/https URLs only/,
    'pesan wajib menjelaskan apa yang BOLEH — detail yang bisa ditindaki dApp');
  const noComments = java.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(noComments, /if \(!u\.startsWith\("http:/,
    'deteksi guard hadir dalam bentuk ter-strip komentar (belum diperiksa ketat — strip memotong \"\/\/\" literal)');
});

test('the wallet-side open mirror gates the same shapes — fast toast, no plugin round-trip', () => {
  const noComments = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(noComments, /!trimmed\.startsWith\('http:\/\/'\) && !trimmed\.startsWith\('https:\/\/'\)/,
    'openNativeDapp menolak non-http(s) — mirror JS dari gerbang Java (startsWith, bukan regex, biar stripper scope.test tak memotong \\/\\/)');
  assert.match(noComments, /'unsupported scheme "' \+ scheme \+ '" — the dApp browser opens http\/https URLs only'/,
    'pesan JS identik — hook E2E juga kena gerbang (uji scheme = uji jalur ini)');
  assert.match(noComments, /toast\(msg, 'error'\)/,
    'wanprestasi tak boleh senyap: toast muncul di wallet');
});

test('read-only RPC is forwarded to the wallet provider — no modal, bounded deadline (MetaMask parity)', () => {
  // A real dApp reads balances, calls and blocks through window.ethereum as
  // much as it signs. Before: every read method fell through to 4200
  // "not supported" — MetaMask answers them from the active node.
  const noComments = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(noComments, /const NATIVE_READ_METHODS = new Set\(\[/,
    'whitelist read methods wajib ada — daftar eksplisit, bukan wildcard');
  assert.match(noComments, /'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount'/,
    'inti read eth_* wajib terdaftar');
  assert.match(noComments, /'eth_call', 'eth_estimateGas'/,
    'call + estimate ikut — pembacaan selengkap node');
  assert.match(noComments, /'eth_getLogs', 'eth_syncing', 'eth_getProof'/,
    'logs + syncing + proof ikut — pembacaan selengkap node');
  assert.match(noComments, /NATIVE_READ_METHODS\.has\(method\)/,
    'pertanyaan read dipilah lewat whitelist TERSENDIRI — sign/spend tetap lewat cabang eksplisitnya');
  assert.match(noComments, /provider\.send\(method, msg\.params \|\| \[\]\)/,
    'forward memakai provider wallet sendiri (ethers JsonRpcProvider)');
  assert.match(noComments, /new Promise\(\(_, reject\) => setTimeout\(\(\) => reject/, 
    'deadline PALSU==bounded: halaman tak bisa membuka bridge selamanya');
  assert.match(noComments, /READ_DEADLINE_MS\)/,
    'deadline read dipakai di race');
  assert.match(noComments, /code: \(e && e\.code\) \|\| -32003/, 
    'error node diteruskan dengan code-nya — dApp bisa membedakan kasus');
});

test('the sign fixture races every request and proves sign + read on a SECOND in-app URL', () => {
  const f2 = readFileSync(path.join(here, '..', 'public', 'dapp-sign-fixture.html'), 'utf8');
  assert.match(f2, /bear-sign-fixture/, 'judul = identitas target CDP pencarian driver');
  assert.match(f2, /personal_sign/, 'fixture meminta personal_sign — modal sign pertama');
  assert.match(f2, /eth_signTypedData_v4/, 'typed data — modal sign kedua (EIP-712)');
  assert.match(f2, /personalSign/, 'hasil ttd dicatat sebagai fakta output');
  assert.match(f2, /typedSign/);
  assert.match(f2, /eth_blockNumber/, 'read forwarding diuji dari halaman nyata');
  assert.match(f2, /eth_getBalance/);
  assert.match(f2, /deadline\(/, 'semua request berdeadline — tanpa wallet gagal berisik, tak menggantung');
  assert.match(f2, /done', 'ok'/, 'penanda selesai');
});

test('the driver exercises the whole matrix: scheme gate, second URL sign, real https site, back loop', () => {
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // scheme refusal verified at runtime — not just source-pinned
  assert.match(driver, /'javascript:alert\(1\)', 'data:text\/html,<b>injected<\/b>', 'file:\/\/\/system\/build\.prop', 'wc:/,
    'driver menguji 4 bentuk berbahaya sekaligus');
  assert.match(driver, /report\.dapp\.schemes\[bad\.split\(':'\)\[0\]\]/,
    'hasil refusal dicatat per-scheme');
  // fixture #2: second in-app URL re-injected with provider, two confirms
  assert.match(driver, /dapp-sign-fixture\.html/,
    'driver membuka URL kedua di WebView yang sama (in-app, bukan tab/browser baru)');
  assert.match(driver, /report\.dapp\.href2/,
    'komit dokumen kedua diverifikasi (href diterima)');
  assert.match(driver, /personalSign=0x\[0-9a-fA-F\]\{130\}/,
    'ttd personal_sign harus 65-byte (0x + 130 hex)');
  assert.match(driver, /typedSign=0x\[0-9a-fA-F\]\{130\}/,
    'ttd typed data juga 65-byte');
  // real external https site: title + provider + live RPC
  assert.match(driver, /'https:\/\/example\.com'/, 
    'situs https EKSTERNAL nyata menjadi bukti all-url in-app');
  assert.match(driver, /report\.dapp\.externalTitle/,
    'judul situs eksternal dibaca — bukti halaman beneran termuat');
  assert.match(driver, /externalRpc/,
    'RPC live di situs eksternal diverifikasi (chainId + blockNumber)');
  // back now walks the whole history (fixture1 → fixture2 → example.com)
  assert.match(driver, /report\.dapp\.backTaps/,
    'back loop menghitung tap — history 3 halaman, bukan 1');
  assert.match(driver, /for \(let i = 0; i < 5; i\+\+\) \{/,
    'loop back dibatasi (5) — tak bisa berputar selamanya');
});
