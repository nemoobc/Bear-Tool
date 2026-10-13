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
import { t } from '../js/i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'js', 'native-dapp.js'), 'utf8');
// Comments quote shapes for context; only code is judged.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const java = readFileSync(path.join(here, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'nemoobc', 'beartool', 'BearDappBrowserPlugin.java'), 'utf8');
const fixture = readFileSync(path.join(here, '..', 'public', 'dapp-rpc-fixture.html'), 'utf8');

test('the four consent prompts prefer the NATIVE sheet and keep the wallet-modal fallback', () => {
  assert.equal((code.match(/await askConfirm\(\{/g) || []).length, 4,
    'keempat konfirmasi native (connect/sign/typed/send) wajib lewat askConfirm — sheet native di ATAS dApp, dApp tidak boleh hilang');
  assert.equal((code.match(/await confirmTx\(\{/g) || []).length, 0,
    'confirmTx telanjang = prompt digambar di bawah dapp view: tak terlihat, tak bisa diklik, RPC hang selamanya');
  assert.match(code, /async function askConfirm\(\{ title, rows, confirmText \}\)/,
    'helper ada: sheet native dulu, modal wallet tinggal fallback');
  assert.match(code, /await p\.confirm\(\{ title, rows: safe, confirmText/,
    'sheet native dipanggil lewat plugin.confirm (Java menggambar di atas overlay)');
  assert.match(code, /return askUser\(\(\) => confirmTx\(\{ title, rows, confirmText \}\)/,
    'fallback tetap lewat askUser — web/plugin lama tak boleh menggantung');
  // askUser masih hidup untuk network picker + fallback web — tapi penjaganya
  // STATE, bukan counter: openModal menyala lagi saat sheet sudah terbuka (pair
  // sheet → prompt unlock) dan counter akan melenceng, meninggalkan browser
  // tersembunyi selamanya (tanpa cara membukanya kembali).
  assert.match(code, /let confirmCount = 0;/);
  assert.match(code, /let modalOpen = false;/);
  assert.match(code, /const aside = modalOpen \|\| confirmCount > 0;/,
    'dua alasan menyembunyikan browser: konfirmasi RPC DAN modal wallet apa pun (pair sheet deep-link)');
  assert.match(code, /if \(aside === browserAside\) return;/,
    'idempoten: panggilan berulang tak boleh menggeser visibilitas');
  assert.match(code, /p\.setVisible\(\{ visible: !aside \}\)/,
    'satu jalur visibilitas — bukan dua yang bisa berperang');
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

test('the native confirm sheet exists, draws above the dapp, and cannot hang the wallet', () => {
  assert.match(java, /public void confirm\(PluginCall call\)/, 'plugin.confirm = sheet native untuk connect/sign/send');
  assert.match(java, /showNativeConfirm\(call, title, rows, confirmText, cancelText\)/,
    'jalur confirm() → showNativeConfirm() di UI thread');
  assert.match(java, /setBackgroundColor\(0x99000000\)/, 'scrim redup: dApp TETAP kelihatan di belakang (gaya OKX, bukan flash-to-wallet)');
  assert.match(java, /root\.addView\(sheet, new android\.widget\.FrameLayout\.LayoutParams\([\s\S]*Gravity\.BOTTOM\)/,
    'sheet = bottom-sheet di atas overlay');
  assert.match(java, /setContentDescription\("dapp-confirm-ok"\)/, 'tombol confirm berlabel — a11y + pilihan E2E');
  assert.match(java, /setContentDescription\("dapp-confirm-cancel"\)/);
  // Full width: the actions used to sit on a HORIZONTAL row at 50% each, so
  // neither box ever spanned the sheet (user report 2026-10-11: "cancel sama
  // confirm kotaknya ngga full harusnya full"). Stacked vertically, each
  // MATCH_PARENT — the same shape the web confirm dialog now uses.
  assert.match(java, /btns\.setOrientation\(LinearLayout\.VERTICAL\)/,
    'aksi sheet bertumpuk vertikal, bukan berdampingan 50%');
  assert.doesNotMatch(java, /LinearLayout\.HORIZONTAL\);\s*\n\s*btns\.setPadding/,
    'baris HORIZONTAL lama tidak boleh kembali');
  assert.match(java, /btns\.addView\(cancel, new LinearLayout\.LayoutParams\(ViewGroup\.LayoutParams\.MATCH_PARENT/,
    'cancel = lebar penuh');
  assert.match(java, /btns\.addView\(ok, new LinearLayout\.LayoutParams\(ViewGroup\.LayoutParams\.MATCH_PARENT/,
    'confirm = lebar penuh');
  assert.match(java, /removeView\(confirmRoot\)[\s\S]*c\.resolve\(r\)/, 'teardown melepas view + resolve pending — tidak ada promise menggantung');
  assert.match(java, /finishConfirm\(false\);[\s\S]*closeTabPanel\(\)/, 'menutup browser membatalkan prompt yang sedang tampil');
  assert.match(java, /finishConfirm\(false\);[\s\S]*super\.handleOnDestroy\(\)/, 'destroy juga membatalkan pending');
});

test('the connect sheet names the account it is exposing, and makes the page behind it inert', () => {
  // 1) The sheet must SAY which key the site is about to see. "Site" + "Gets"
  // alone leaves a multi-account wallet user approving a blind request — and the
  // E2E cross-check (accountMatchesModal) has nothing honest to compare against,
  // because it used to "pass" only by scraping unrelated wallet token addresses
  // out of the same accessibility dump.
  const app = readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');
  // The title is a key since M14. indexOf() returning -1 used to slice ONE
  // trailing character, and every assertion below it would then have been made
  // against nothing — so the anchor is asserted first, out loud.
  const anchor = "title: t('cf.connect.this.site')";
  const at = app.indexOf(anchor);
  assert.ok(at > 0, 'jangkar judul sheet connect tidak ada di app.js');
  const consent = app.slice(at);
  assert.match(consent, /k: t\('cf\.account'\), v: wallet\.shortAddress\(get\('address'\)\)/,
    'sheet connect wajib menampilkan alamat akun yang diekspos (format 0x1234…5678)');
  assert.equal(t('cf.account'), 'Account', 'label akun tetap "Account" di en');
  assert.equal(t('cf.connect.this.site'), '🔗 Connect this site?', 'judul tetap sama di en');
  // 2) A consent sheet is a MODAL: what is behind it must stop being reachable
  // for a screen reader exactly as it stops being touchable behind the scrim.
  assert.match(java, /private void setBackgroundA11yInert\(boolean inert\)/, 'satu helper untuk mode inert/aktif');
  assert.match(java, /IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS/, 'halaman belakang = NO_HIDE_DESCENDANTS saat modal tampil');
  assert.match(java, /IMPORTANT_FOR_ACCESSIBILITY_AUTO/, 'dan dikembalikan AUTO saat modal ditutup');
  assert.match(java, /setBackgroundA11yInert\(true\);/, 'sheet tampil = halaman belakang jadi inert');
  assert.match(java, /setBackgroundA11yInert\(false\);/, 'sheet ditutup = halaman bisa dibaca lagi (a11y tak boleh rusak permanen)');
  // Both live WebViews are behind the sheet — the wallet AND the dApp page.
  assert.match(java, /getBridge\(\)\.getWebView\(\)[\s\S]{0,200}setImportantForAccessibility\(mode\)/,
    'wallet WebView ikut inert');
  assert.match(java, /if \(dappView != null\) dappView\.setImportantForAccessibility\(mode\)/,
    'dApp WebView ikut inert');
  // 3) The button reports its real rect for a driver whose platform dumper keeps
  // crashing — a diagnostic, and the only honest way to learn where the app
  // actually drew the control from the outside.
  assert.match(java, /android\.util\.Log\.i\("BearToolE2E", "confirm-ok-rect "/,
    'sheet meng-log rect tombol OK (tag BearToolE2E)');
  assert.match(java, /ok\.post\(\(\) -> \{[\s\S]{0,400}getLocationOnScreen\(loc\)/,
    'rect diambil setelah layout (post), bukan sebelum');
});

test('a visible load bar exists and every page state controls it', () => {
  assert.match(java, /progressBar = new android\.widget\.ProgressBar\(getContext\(\), null, android\.R\.attr\.progressBarStyleHorizontal\)/,
    'bar progres horizontal (indeterminate) = indikator loading web (report "loading web ga ada")');
  assert.match(java, /lp\.topMargin = barH/, 'bar dipasang TEPAT di bawah toolbar');
  assert.match(java, /showLoadingBar\(\);/, 'onPageStarted menyalakan bar');
  assert.match(java, /addressField\.setBackgroundColor\(ADDRESS_IDLE\);[\s\S]{0,120}hideLoadingBar\(\);/,
    'onPageFinished memadamkan bar (saat bar alamat kembali idle)');
  assert.match(java, /if \(view == dappView\) hideLoadingBar\(\);/,
    'halaman error juga memadamkan bar — load mati tak boleh meninggalkan spinner abadi');
  assert.match(java, /hideLoadingBar\(\);   \/\/ a tab switch/, 'ganti tab memadamkan bar tab sebelumnya');
});

test('the wallet can reopen any open tab from its own DApps page', () => {
  assert.match(java, /public void getTabs\(PluginCall call\)/, 'getTabs = daftar tab hidup untuk tombol Tabs wallet');
  assert.match(java, /ret\.put\("open", dappView != null\)/, 'status open = ada browser (sesi bertahan walau overlay tersembunyi)');
  assert.match(java, /public void selectTab\(PluginCall call\)/, 'selectTab = aktifkan tab + tampilkan browser');
  assert.match(code, /export async function nativeTabs\(\)/, 'helper wallet → nativeTabs ada');
  assert.match(code, /export async function openNativeTab\(index\)/, 'helper wallet → openNativeTab ada');
  const dapps = readFileSync(path.join(here, '..', 'js', 'dapps.js'), 'utf8');
  assert.match(dapps, /renderTabsEntry\(container\)/, 'view dApps memanggil renderTabsEntry');
  assert.match(dapps, /dappTabsBtn/, 'entry "Browser" punya tombol berlabel');
  assert.match(dapps, /openNativeTab\(Number\(row\.dataset\.i\) \|\| 0\)/, 'klik row → selectTab native');
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
  // A top MARGIN, not a padding: SwipeRefreshLayout paints its pull-to-refresh
  // spinner at the top of its OWN bounds, and with a top padding that strip sat
  // under the z-topmost toolbar — the user's spinner was invisible
  // (report 2026-10-11). The margin keeps the whole band below the bar.
  assert.match(java, /lp\.topMargin = barH/,
    'margin atas = tinggi bar: spinner pull-to-refresh tampil DI BAWAH toolbar');
  assert.match(java, /stack\.addView\(t\.wrap, barInsetParams\(\)\)/,
    'wrapper masuk stack dengan inset bar (margin), bukan padding');
  assert.match(java, /applyBarInset\(refreshLayout\)/,
    'inset di-assert ulang di setActiveTab (params bisa di-regenerate)');
  assert.doesNotMatch(java, /refreshLayout\.setPadding\(0, barH/,
    'padding lama mengubur spinner di bawah toolbar — dilarang kembali');
  assert.match(java, /stack\.setBackgroundColor\(PAGE_BG\)/,
    'band halaman opaque: dashboard cartoon tak boleh tembus saat dApp loading');
  assert.match(java, /MATCH_PARENT, barH\)/, 'tinggi toolbar tetap (48dp * density) — jarak halaman = tinggi bar, tanpa menunggu measure');
  assert.match(java, /int barH = \(int\) \(48 \* density\)/,
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

test('the native toolbar is fully OPAQUE, cartoon-styled — no bleed-through, no dark island', () => {
  // Two user reports, one fix each direction:
  //   2026-10-11 "tembus soalnya"        → every surface 0xFF opaque (0xCC/0x33
  //     alphas showed the dashboard through the bar).
  //   2026-10-11 "tampilan dalam daaps kayak luar daaps jadi iconnya cartoon
  //     warnanya jangan gelap"           → the chrome is now the wallet's own
  //     cartoon palette (cream bar, ink text, honey accents), never the dark
  //     OKX island — while STAYING 0xFF opaque.
  assert.match(java, /static final int BAR_BG = CREAM/, 'bar bg = cream kartun, opaque (0xFFFFF8E7)');
  assert.match(java, /static final int ADDRESS_IDLE = 0xFFFFFFFF/, 'address idle = putih opaque');
  assert.match(java, /static final int ADDRESS_LOADING = 0xFFFFE7A8/, 'address loading = tint honey opaque');
  assert.match(java, /bar\.setBackgroundColor\(BAR_BG\)/, 'bar memakai palet opaque, bukan literal transparan');
  assert.doesNotMatch(java, /0xCC1A1A2E/, 'alpha 0xCC pada bar = tembus — dilarang kembali');
  assert.doesNotMatch(java, /0x33222244/, 'alpha 0x33 pada address = nyaris transparan — dilarang kembali');
  assert.doesNotMatch(java, /0xFF161622/, 'chrome gelap OKX-lama tidak boleh kembali');
  assert.doesNotMatch(java, /0xFF0E0E16/, 'page band gelap tidak boleh kembali');
});

test('cartoon chrome: emoji icons, cream surfaces, ink text, honey accent (user 2026-10-11)', () => {
  // Toolbar icons are colour emoji — the literal "cartoon" the user asked for.
  assert.match(java, /backBtn\.setText\("\\u2B05\\uFE0F"\)/, 'back → ⬅️');
  assert.match(java, /forwardBtn\.setText\("\\u27A1\\uFE0F"\)/, 'forward → ➡️');
  assert.match(java, /netBtn\.setText\("\\uD83C\\uDF10"\)/, 'network → 🌐');
  assert.match(java, /tabBtn\.setText\("\\uD83D\\uDCD1"\)/, 'tabs → 📑');
  assert.match(java, /reloadBtn\.setText\("\\uD83D\\uDD04"\)/, 'reload → 🔄');
  assert.match(java, /closeBtn\.setText\("\\u274C"\)/, 'close → ❌');
  assert.match(java, /menuBtn\.setText\("\\uD83D\\uDC3E"\)/, 'menu → 🐾 (bear paw, on-brand)');
  // Surfaces ride the wallet palette.
  assert.match(java, /private static final int CREAM = 0xFFFFF8E7/, 'cream = --cream');
  assert.match(java, /private static final int INK = 0xFF2D2A32/, 'ink = --ink');
  assert.match(java, /private static final int INK_SOFT = 0xFF6B6478/, 'ink-soft = --ink-soft');
  assert.match(java, /private static final int ACCENT = HONEY/, 'tombol OK = honey (teks ink di atasnya)');
  assert.match(java, /ok\.setTextColor\(INK\)/, 'teks OK = ink di atas honey (kontras ~10:1)');
  assert.match(java, /okBg\.setColor\(ACCENT\)/, 'fill OK = ACCENT (honey)');
  assert.match(java, /confirmTitleView\.setTextColor\(INK\)/, 'judul sheet = ink');
  assert.match(java, /bg\.setStroke\(\(int\) \(2 \* density\), INK\)/, 'sheet kartun: stroke ink di tepi');
  assert.match(java, /panel\.setBackgroundColor\(CREAM\)/, 'panel tab = cream');
  assert.match(java, /row\.setBackgroundColor\(i == activeTab \? HONEY : 0x00000000\)/, 'tab aktif = honey tile');
  assert.match(java, /badgeBg\.setColor\(HONEY\)/, 'badge tab = honey');
  assert.match(java, /t\.wrap\.setColorSchemeColors\(HONEY, ORANGE, BERRY\)/, 'progress bar = palet kartun');
  assert.match(java, /int\[\] palette = \{ HONEY, MINT, BERRY, SKY, ORANGE, GRAPE \}/,
    'warna tile situs = palet kartun, bukan ungu-gelap OKX');
  assert.match(java, /ib\.setColor\(tileColorForGlyph\(glyph\)\)/, 'tile ikon menu = warna kartun per-glyph');
});

test('a user-closed native browser must not resurrect when a wallet sheet closes', () => {
  // The tab session SURVIVES a hide on purpose (the wallet's Tabs entry reopens
  // it). That is exactly why the dismissal needs its own bit: without it the
  // wallet's sheet-restore call (setVisible(true)) woke a browser the user had
  // closed — "keluar nyoba fitur lain keluar malah langsung balik di dalam web
  // daapsnya dalamnya" (report 2026-10-11).
  assert.match(java, /private boolean userClosed = false;/,
    'flag dismissal hidup di plugin');
  assert.match(java, /userClosed = true;/,
    'doClose()/doBack() menandai browser sudah ditinggalkan user');
  assert.match(java, /userClosed = false;/,
    'open()/selectTab() membersihkan flag — buka ulang eksplisit tetap boleh');
  assert.match(java,
    /if \(dappView != null && Boolean\.TRUE\.equals\(visible\) && userClosed\) \{\s*\n\s*call\.resolve\(\);\s*\n\s*return;/,
    'setVisible(true) DIABAIKAN setelah user menutup browser — resolve tetap, overlay tidak hidup lagi');
  assert.match(java, /out\.put\("closed", userClosed\)/,
    'viewState melaporkan dismissal, jadi gate E2E bisa membedakan tertutup vs di balik sheet');
});

test('tabs: multi-tab lives on its own WebView and the last tab can never be closed', () => {
  assert.match(java, /private class Tab \{/, 'tab = unit kerja (WebView + wrapper sendiri)');
  assert.match(java, /private Tab newTab\(\)/, 'factory tab baru');
  assert.match(java, /private void setActiveTab\(int i\)/, 'satu jalur pindah tab');
  assert.match(java, /private void closeTab\(int i\)/, 'menutup tab lewat satu jalur');
  assert.match(java, /if \(tabs\.size\(\) <= 1\) \{ closeTabPanel\(\); return; \}/,
    'tab terakhir tak boleh ditutup — lantai browser');
  assert.match(java, /private void openTabPanel\(\)/, 'sheet tab dibangun dari daftar tab');
  // The page may only be pushed down by the bar on the ACTIVE tab; and only
  // the active tab owns the RPC origin (a background tab must not steal it).
  assert.match(java, /if \(view == dappView\) \{[\s\S]*currentUrl = url/,
    'hanya tab AKTIF menulis currentUrl — origin RPC milik halaman yang terlihat');
  // Every tab gets its own client + bridge, so RPC works from any active tab.
  assert.match(java, /t\.view\.addJavascriptInterface\(new Bridge\(\), "BearNativeBridge"\)/,
    'setiap tab punya bridge sendiri');
  assert.match(java, /destroy\(\)/, 'tab yang ditutup melepas WebView-nya');
});

test('the toolbar exposes native controls the E2E (and a real user) can reach', () => {
  assert.match(java, /\.setContentDescription\("dapp-tabs"\)/, 'tombol tabs berlabel');
  assert.match(java, /\.setContentDescription\("dapp-tab-new"\)/, 'tombol tab baru berlabel');
  assert.match(java, /\.setContentDescription\("dapp-tab-row-" \+ i\)/, 'baris tab berlabel per-indeks');
  assert.match(java, /\.setContentDescription\("dapp-tab-close-" \+ i\)/, 'tutup-tab berlabel per-indeks');
  assert.match(java, /\.setContentDescription\("dapp-network"\)/, 'chip network berlabel');
  // Tab count is a BADGE over the ⧉ icon (OKX "2"), not glyph text: "⧉ 12"
  // would squeeze the address out of a 48dp bar. Hidden at one tab.
  assert.match(java, /\.setContentDescription\("dapp-tabs-count"\)/, 'badge jumlah tab berlabel — a11y + pilihan E2E');
  assert.match(java, /tabCountBadge\.setText\(n > 99 \? "99\+" : String\.valueOf\(n\)\)/, 'badge menampilkan jumlah tab (dibat 99+)');
  assert.match(java, /tabCountBadge\.setVisibility\(n > 1 \? View\.VISIBLE : View\.GONE\)/, 'satu tab = tanpa badge');
});

test('the ⋯ overflow menu is a real sheet — every row does the thing it says', () => {
  assert.match(java, /setContentDescription\("dapp-menu"\)/, 'tombol ⋯ di toolbar berlabel');
  assert.match(java, /private void showDappMenu\(\)/, 'menu membuka sheet');
  assert.match(java, /Gravity\.BOTTOM/, 'sheet menempel di bawah seperti OKX');
  assert.match(java, /root\.setBackgroundColor\(0x99000000\)/, 'scrim redup — dApp tetap kelihatan di belakang');
  assert.match(java, /root\.setOnClickListener\(v -> closeDappMenu\(\)\)/, 'tap di luar menutup');
  // Four icon actions + three rows, each with its own labelled tap target so
  // the E2E driver can reach them without guessing coordinates.
  for (const [desc, what] of [
    ['dapp-menu-copy', 'Copy URL'], ['dapp-menu-fav', 'Favourite'],
    ['dapp-menu-refresh', 'Refresh'], ['dapp-menu-share', 'Share'],
    ['dapp-menu-desktop', 'Switch to desktop mode'],
    ['dapp-menu-history', 'Transaction history'],
    ['dapp-menu-clearcache', 'Clear cache'],
  ]) {
    assert.match(java, new RegExp('"' + desc + '"'), what + ' punya contentDescription');
  }
  // The actions must be real, not decorative.
  assert.match(java, /ClipboardManager[\s\S]*setPrimaryClip/, 'Copy URL benar-benar ke clipboard');
  assert.match(java, /ACTION_SEND/, 'Share membuka chooserIntent');
  assert.match(java, /ACTION_VIEW[\s\S]*startActivity/, 'desktop mode membuka browser luar');
  assert.match(java, /clearCache\(true\)/, 'Clear cache membersihkan WebView');
  // Reminder is deliberately absent: Bear Tool has no reminder store, and a
  // row that looks alive but does nothing is worse than a missing row. (The
  // word appears only in the comment explaining why it is gone.)
  assert.doesNotMatch(java, /setContentDescription\("dapp-menu-reminder"\)/,
    'tidak boleh ada baris reminder tanpa implementasi');
  // The sheet can never outlive the browser it describes.
  assert.match(java, /closeDappMenu\(\);\s*\n\s*closeTabPanel\(\);/, 'hide menutup menu juga');
});

test('tab cards lead with a site tile, the way OKX leads with the logo', () => {
  assert.match(java, /hostInitial\(t\)/, 'kartu tab diawali inisial host');
  assert.match(java, /private static int tileColor\(Tab t\)/, 'warna tile stabil per situs');
  // Deterministic: same host, same tile — a card that reshuffles its colour on
  // every open is noise, not identity.
  assert.match(java, /GradientDrawable\.OVAL/, 'tile bulat seperti logo situs');
  assert.match(java, /Math\.abs\(h\) % palette\.length/, 'warna diturunkan dari hash host');
});

test('change network: the ◆ chip asks the WALLET, and setChain fans chainChanged into every tab', () => {
  // The wallet owns the network list — the toolbar never switches by itself.
  assert.match(java, /ev\.put\("command", "openNetworkPicker"\)/, 'chip meminta wallet membuka picker-nya');
  assert.match(java, /@PluginMethod\s*\n\s*public void setChain\s*\(\s*PluginCall/,
    'setChain berpasangan langsung dengan @PluginMethod (tanpa yatim)');
  assert.match(java, /netBtn\.setText\(label\)/, 'chip ikut label chain baru');
  // chainHex is wallet-supplied but STILL validated before entering evaluateJavascript.
  assert.match(java, /chainHex\.matches\("0x\[0-9a-fA-F\]\+"\)/,
    'hanya literal 0x-hex yang masuk JS — string sembarang dilarang');
  assert.match(java, /__bearNativeNotify\(\{event:'chainChanged',data:'/, 'chainChanged adalah peristiwa yang dikirim');
  assert.match(java, /for \(Tab t : tabs\) \{[\s\S]*evaluateJavascript/, 'fan-out ke SEMUA tab — tab latar pun dengar');
});

test('the wallet glue wires the picker + chain sync and honours a dApp switch request', () => {
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /export async function syncNativeChain\(\)/, 'push chain ke toolbar native');
  assert.match(code, /plugin\.setChain\(\{ chainId: chainHex\(n\.chainId\), label:/, 'satu jalur push chain');
  assert.match(code, /p\.addListener\('walletCommand'/, 'listener perintah wallet terpasang di boot');
  assert.match(code, /async function handleWalletCommand\(ev\)/, 'handler perintah wallet');
  assert.match(code, /cmd !== 'openNetworkPicker'/, 'hanya perintah yang dikenal yang dijalankan');
  assert.match(code, /const \{ showNetworkModal \} = await import\('\.\/app\.js'\)/,
    'picker wallet dipanggil lewat dynamic import (app.js tak boleh jadi siklus statis)');
  assert.match(code, /on\('networkId', \(\) => \{ syncNativeChain\(\); \}\)/,
    'perubahan network wallet = satu-satunya pemicu sinkronisasi chip native');
  // The dapp overlay is restored when the WALLET modal closes — the modal
  // mounts into #modalOverlay (ui.js openModal adds "open"). Body's
  // "modal-open" class is only ever removed here, so observing IT never fired
  // and the overlay stayed hidden for the full ceiling. Pin the overlay watch.
  assert.match(code, /document\.getElementById\('modalOverlay'\)/,
    'handler harus mengamati #modalOverlay, bukan body.modal-open yang tak pernah ditambah');
  assert.match(code, /overlay\.classList\.contains\('open'\)/,
    'modal dianggap tertutup saat #modalOverlay kehilangan class "open"');
  assert.ok(!/document\.body\.classList\.contains\('modal-open'\)/.test(code),
    'jangan kembali ke penjaga body.modal-open — itu bug (tak pernah dipasang)');
  // A dApp asking to switch to a chain the wallet already knows now switches.
  assert.match(code, /const target = Number\.isFinite\(want\) \? getNetwork\(want\) : null/,
    'switch request mencari chain yang dikenal');
  assert.match(code, /activateNetwork\(target\.id\)/, 'switch lewat satu chokepoint (activateNetwork)');
});

test('app.js exposes the network modal and the fixture records chainChanged', () => {
  const app = readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');
  assert.match(app, /export function showNetworkModal\(\)/, 'showNetworkModal diekspor untuk picker native');
  assert.match(fixture, /ethereum\.on\('chainChanged'/, 'fixture merekam chainChanged sebagai bukti E2E');
  assert.match(fixture, /rec\('chainChanged', id\)/, 'nilai chain baru masuk #out');
});

test('the E2E driver really exercises tabs and the network picker', () => {
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Two independent WebViews must show up as two CDP page targets.
  assert.match(driver, /async function cdpTargetUrls\(\)/, 'daftar target CDP = mata tab ganda');
  assert.match(driver, /tapNativeButton\('dapp-tab-new'\)/, 'menambah tab lewat tombol native asli');
  assert.match(driver, /tapNativeButton\('dapp-tab-close-1'\)/, 'menutup tab lewat tombol native asli');
  assert.match(driver, /report\.dapp\.tabs\.hasFixture && report\.dapp\.tabs\.hasExample/,
    'dua target (fixture + example) = bukti multi-WebView, bukan cuma klaim');
  // Network: chip → wallet picker → a real switch → chainChanged in the page.
  assert.match(driver, /tapNativeButton\('dapp-network'\)/, 'chip network di-tap sungguhan');
  assert.match(driver, /await page\.wait\('#netSearchInput', 15000\)/, 'modal Networks wallet wajib terbuka');
  assert.match(driver, /document\.querySelector\('\[data-net="polygon"\]'\)/, 'pilih chain LAIN (switch nyata)');
  assert.match(driver, /chainChanged never reached the dApp \(want 0x89\)/, 'chainChanged wajib sampai ke halaman dApp (0x89)');
});

test('BrowserClient overrides only real WebViewClient methods (no WebChromeClient callback)', () => {
  // 2026-10-11: a stray @Override on onReceivedTitle — a WebChromeClient
  // callback, NOT a WebViewClient one — made :app:compileDebugJavaWithJavac
  // fail with "does not override or implement a method from a supertype", and
  // that one Java error took down BOTH CI jobs (APK 38119662698 + emulator
  // 38119666755) before a single emulator boot. The dapp view deliberately has
  // NO WebChromeClient, so the title is read from onPageFinished's getTitle();
  // onReceivedTitle must never be re-declared here — it can only break the
  // build, never compile.
  assert.ok(!/onReceivedTitle\s*\(/.test(java),
    'BrowserClient tidak boleh declare onReceivedTitle (itu callback WebChromeClient → gagal compile)');
  assert.match(java, /t\.title = view\.getTitle\(\)/, 'judul tab dibaca dari onPageFinished getTitle()');
  // Guard against the exact CI failure class: every @Override in this file must
  // name a method that actually exists as an override target.
  const overrides = [...java.matchAll(/@Override\s+[^\n]*?(?:public|protected)\s+[^\n]*?\b(\w+)\s*\(/g)].map((m) => m[1]);
  const allowed = new Set(['onPageStarted', 'onPageCommitVisible', 'onPageFinished', 'onReceivedError', 'handleOnDestroy', 'onCreate', 'onDestroy', 'onStart', 'onStop']);
  for (const name of overrides) {
    assert.ok(allowed.has(name), `@Override tak dikenal bisa gagal compile: ${name}`);
  }
});

test('ui.js reports modal visibility, and native-dapp.js is the one that acts on it', () => {
  // The missing half of the flash-to-wallet story: askUser covered confirmTx
  // and the ◆ picker, but the WalletConnect PAIR SHEET — reachable by a `wc:`
  // deep link from a browser, or ?wc= on web — opens its modal directly, so the
  // sheet landed UNDER the native browser: the user tapped "Bear Tool" and saw
  // the dApp (nothing to pair with, nothing to click). ui.js owns the two
  // choke points (openModal/closeModal); native-dapp.js owns setVisible.
  const uiSrc = readFileSync(path.join(here, '..', 'js', 'ui.js'), 'utf8');
  const uiCode = uiSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(uiCode, /export function setModalVisibilityHook\(fn\)/,
    'ui.js menyediakan hook-nya (bebas jembatan: native-dapp.js yang tahu caranya)');
  assert.match(uiCode, /notifyModalVisibility\(true\);[\s\S]*?\n/,
    'openModal melaporkan sheet tampil');
  assert.match(uiCode, /notifyModalVisibility\(false\);/,
    'closeModal melaporkan sheet hilang');
  // swallow: a visibility hint must never be why a money-path modal fails
  assert.match(uiCode, /try \{ modalVisibilityHook\?\.\(open\); \} catch \{/,
    'hook meledak = modal tetap jalan (try/catch wajib)');
  // the hook is STATE (a boolean from the caller), not a counter ui.js keeps
  assert.match(uiCode, /let modalVisibilityHook = null;/);
  assert.match(code, /setModalVisibilityHook\(\(open\) => \{[\s\S]{0,120}modalOpen = !!open;/,
    'native-dapp.js mendaftarkan hook dan menyimpannya sebagai state boolean');
  assert.match(code, /applyBrowserVisibility\(\);\s*\n\s*\}\);/,
    'setiap laporan langsung diterapkan ke plugin (setVisible)');
});

test('the E2E proves the wc: deep link the way a listing uses it: OS resolves, sheet fills, browser steps aside', () => {
  // What a WalletConnect-registry listing hands users is a link that ends as a
  // bare `wc:…` URI (docs/WC-REGISTRY-LISTING.md). The redirect half is covered
  // by the live /wc page + tests/wc-registry-listing.test.js; only an emulator
  // can prove the OS→app half, and it must run WITHOUT -n so the manifest's
  // intent-filter is what resolves it (a listing that dead-ends on "no app
  // found" is the whole failure mode).
  const driverSrc = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
  const dcode = driverSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(dcode, /step\('walletconnect: a bare wc: URI resolves to Bear Tool and fills the pair sheet'\)/,
    'langkah deep-link ada di journey emulator');
  const region = dcode.slice(
    dcode.indexOf("step('walletconnect: a bare wc: URI"),
    dcode.indexOf("step('native bridge diagnostics')"),
  );
  // The pairing URI the OS is handed: 64-hex topic + @2 + relay + 64-hex symKey.
  assert.match(region, /const wcUri = 'wc:' \+ 'ab12cd34'\.repeat\(8\) \+ '@2\?relay-protocol=irn&symKey=' \+ 'ef56ab78'\.repeat\(8\);/,
    'URI berbentuk wc:<64hex>@2?relay-protocol=irn&symKey=<64hex> — bentuk yang sama dengan yang dihasilkan dApp');
  assert.match(region, /am', 'start', '-W', '-a', 'android\.intent\.action\.VIEW', '-d', `'\$\{wcUri\}'`/,
    'am start memakai -W (tunggu aktivitas) dan mengutip URI (device shell memakan & tanpa kutip)');
  assert.doesNotMatch(region, /'-n'/,
    'TANPA -n: resolusi wajib kerja manifest, bukan eksplisit ke paket kita');
  assert.match(region, /unable to resolve/,
    'resolusi gagal = uji gagal keras, bukan lolos');
  assert.match(region, /if \(wcSheet\.value !== wcUri\)/,
    'URI wajib sudah terisi di sheet (itu inti deep link — tanpa clipboard)');
  // Present ≠ seen: the sheet lives in the wallet webview under the native view.
  assert.match(region, /withSheet\.native\.visible !== false/,
    'sheet wajib BENAR-BENAR di atas layar (plugin viewState, bukan DOM)');
  assert.match(region, /afterCancel\.native\.visible !== true/,
    'browser wajib kembali setelah sheet ditutup (restore hilang = dompet tanpa browser)');
  assert.match(dcode, /const browserState = \(\) => page\.evaluate[\s\S]{0,400}viewState\(\{\}\)/,
    'bukti visibilitas diambil dari hierarki view native (plugin.viewState), bukan dari klaim app');
  assert.match(region, /native: await browserState\(\)/,
    'langkah deep-link memakai probe view tree yang sama');
  assert.match(region, /document\.visibilityState/,
    'pembacaan silang tetap ikut laporan — TAPI diagnostik, bukan gate (halaman tak pernah flip ke hidden)');
  assert.match(region, /ov = document\.querySelector\('#modalOverlay\.open'\)/,
    'sheet dianggap terbuka hanya bila overlay BENAR-BENAR open — closeModal menyisakan markup-nya');
  // The plugin method the driver calls must exist and answer from the VIEW tree.
  assert.match(java, /public void viewState\(PluginCall call\)/,
    'plugin.viewState = satu-satunya saksi visibilitas nyata');
  assert.match(java, /out\.put\("visible", dappView != null && stack != null && stack\.getVisibility\(\) == View\.VISIBLE\)/,
    'visible dibaca dari getVisibility() — bukan flag yang ditulis app');
  assert.match(java, /out\.put\("open", dappView != null\)/,
    'open = ada sesi browser (sesi bertahan walau overlay tersembunyi)');
});

