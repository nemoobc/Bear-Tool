// The emulator E2E harness must never lose a diagnosis again.
//
// Run 38006299499 (2026-10-10) lost everything it was built to collect, in
// three independent ways, and each one left a distinctive hole:
//
//   1. `console.error(...); process.exit(1)` in the driver's catch — stderr
//      to a pipe is async, exit() truncates the queued write. The log showed
//      "[e2e] create wallet" and then NOTHING: no FATAL, no report, no idea
//      where it died.
//   2. `adb logcat -d` with no bound, against a device that had already gone
//      offline → "- waiting for device -" for 36 minutes until the job's own
//      40-minute timeout killed the run.
//   3. CDP send() with no timeout and no socket close/error listener — a dead
//      WebView would hang every pending call forever.
//
// None of those failures produce a failing assertion by themselves; they
// produce silence. So the shapes that prevent them are asserted directly on
// the source and the workflow, the same way fork-conventions.test.js guards
// the failover loops it cannot exercise without a chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const driverRaw = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
// Strip full-line comments before asserting: the driver's own hardening notes
// QUOTE the forbidden pattern ("console.error(...); process.exit(1)") — a
// comment is documentation, not code, and a detector tripped by its own
// explanation teaches people to delete the explanation.
const driverSrc = driverRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const workflow = yaml.load(readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8'));
// The raw text as well: the screenrecord lines live inside a YAML block
// scalar that the parser hands back as one string, so the guards on them can
// only be read from the source.
const workflowRaw = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');

test('fatal paths flush before exit — console.error + process.exit lost the last run\'s message', () => {
  // The exact pair that swallowed the FATAL line must not come back.
  assert.doesNotMatch(driverSrc, /console\.error\([^)]*\)\s*;\s*process\.exit/,
    'console.error diikuti langsung process.exit memotong write stderr yang belum terflush');
  // The replacement: write with a callback that exits after the flush, plus a
  // report written synchronously first.
  assert.match(driverSrc, /process\.stderr\.write\('\[e2e\] FATAL[\s\S]{0,120}\(\) => process\.exit\(1\)/,
    'die() harus exit dari callback flush stderr, bukan memotongnya');
  // The fatal text may carry a diagnosis (step in flight + evidence + dropped
  // requests); what matters is that `fatal` is ASSIGNED before the report write.
  assert.match(driverSrc, /report\.fatal = msg[^;]*;[\s\S]{0,120}writeFileSync\(path\.join\(OUT, 'emulator-report\.json'\)/,
    'report wajib ditulis sinkron berisi `fatal` SEBELUM exit — file tidak punya race flush');
});

test('every step lands in steps.log synchronously, so a SIGKILL still shows the last move', () => {
  assert.match(driverSrc, /appendFileSync\(steplog/,
    'step wajib appendFileSync: stdout ke pipe bisa hilang saat kill');
  assert.match(driverSrc, /const steplog = path\.join\(OUT, 'steps\.log'\)/);
});

test('CDP calls are bounded and the socket rejects pending calls on close', () => {
  assert.match(driverSrc, /CDP_TIMEOUT_MS = 15_000/, 'setiap send() wajib punya timeout');
  // per-call timeout (screenshot rides boot churn at 25s) — still must name
  // the method and the budget actually used, or a hang is unreadable
  assert.match(driverSrc, /send\(method, params = \{\}, timeoutMs = CDP_TIMEOUT_MS\)/,
    'send() menerima batas per-panggilan, default 15s');
  assert.match(driverSrc, /CDP timeout \$\{timeoutMs\}ms: \$\{method\}/,
    'timeout harus menyebut method + budget aktual — tanpa itu hang-nya tak terbaca');
  assert.match(driverSrc, /ws\.on\('close'/, 'socket close harus reject semua pending call');
  assert.match(driverSrc, /ws\.on\('error'/, 'socket error harus reject semua pending call');
  assert.doesNotMatch(driverSrc, /Runtime\.evaluate.*timeout: 0/,
    'evaluate tidak boleh dipanggil tanpa batas');
});

test('a failed journey captures the stuck screen before reporting', () => {
  assert.match(driverSrc, /99-failure/,
    'shot(99-failure) di catch: layar yang macet = diagnosis');
});

// ── how android-emulator-runner REALLY executes `script` ──────────────────
// Source read 2026-10-10 (src/script-parser.ts + src/main.ts @v2): the input
// is split PER NEWLINE, `#` comment lines are DROPPED, and every line runs as
// its OWN `sh -c <line>` process — a non-zero exit on any line calls
// setFailed() and every remaining line is skipped (emulator killed). Three
// runs died on this: `set +e` that could only govern its own one-line
// process, `E2E_EXIT` that evaporated between lines, `adb logcat -d` hanging
// "- waiting for device -" with nothing able to bound it. These tests encode
// the executor's real semantics, not shell intuition.
const rawScript = workflow.jobs.emulator.steps.find((s) => s.with && s.with.script).with.script;
// Mirror parseScript(): drop comments and blanks — that is what actually runs.
const scriptLines = rawScript.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const script = scriptLines.join('\n');

test('the workflow is written for the executor it actually has (per-line sh -c)', () => {
  // `set +e` looks like safety and governs exactly one one-line process.
  assert.doesNotMatch(script, /set \+e/, 'set +e = no-op di executor per-baris');
  // Continuations are split into a broken trailing-backslash command.
  for (const line of scriptLines) {
    assert.ok(!line.endsWith('\\'), `baris berakhir backslash = syntax error ter-split: ${line.slice(0, 60)}`);
  }
  // State does not survive between lines: assignments-only lines and $! are lies.
  assert.doesNotMatch(script, /^\s*(E2E_EXIT|HEARTBEAT)=/m, 'variabel lintas baris tidak ada di executor ini');
  assert.doesNotMatch(script, /kill \$/, 'kill $VAR lintas baris = selalu kosong');
  assert.doesNotMatch(script, /exit \$/, 'exit $VAR lintas baris = exit proses sendiri yang kosong');
});

test('every adb line is self-guarded — one failing line kills the rest of the script', () => {
  for (const line of scriptLines) {
    if (!/^(adb |timeout \d+ adb )/.test(line)) continue;
    assert.ok(/\|\|/.test(line) || /&\s*$/.test(line),
      `baris adb tanpa guard = satu gagal, sisanya mati: ${line.slice(0, 70)}`);
  }
  // The E2E run must fail LOUDLY without ending the diagnostics: same-line
  // capture, output to a FILE (sync writes on POSIX — no lost FATAL), cat after.
  // The run goes through the recovery wrapper (10 of 19 fleet qemu deaths);
  // the wrapper owns the per-attempt bound (480s), the file append, and the
  // one relaunch cycle — the YAML line must stay one self-guarded call.
  assert.match(script, /timeout 2100 env E2E_OUT=emulator-artifacts bash tools\/e2e-recover\.sh \|\| echo E2E_FAILED_RC=\$\?/,
    'wrapper dibatasi 2100s luar (3 attempt x 480 + 2 recovery), rc ditangkap di baris yang sama');
  assert.match(script, /cat e2e-stdout\.log \|\| true/, 'output driver harus dibaca balik ke log step');
});

test('the workflow captures logcat at BOOT via a stream started before anything else', () => {
  // The device died ~30-60s after boot in every run; a dump taken later was
  // always 0 bytes. The only reliable capture is a stream started FIRST —
  // it keeps writing up to the exact moment the device vanishes.
  assert.ok(scriptLines[0].includes('adb logcat -v time > logcat-stream.txt'),
    'baris pertama wajib stream logcat — jendela device hidup hanya detik');
  assert.match(script, /logcat-boot\.txt/, 'dump sekunder tetap ada (device mungkin masih hidup)');
  assert.match(script, /logcat-stream\.txt/, 'stream = sumber utama diagnosis');
  assert.match(script, /emulator-heartbeat\.txt/, 'heartbeat adb+qemu+app: membedakan emulator mati vs adb wedged');
  // The boot-time [dApp diag] instrumentation was removed once pinned
  // (ba6ed69); its grep markers would print DIAG_LINE_NOT_FOUND forever —
  // stale probes are worse than none. The diagnosis lives in the report now
  // (report.native / consoleTrail over CDP).
  assert.doesNotMatch(script, /DIAG_LINE_NOT_FOUND/,
    'probe [dApp diag] sudah punah — jangan kembalikan mayatnya ke workflow');
});

test('the driver captures the native bridge state and the whole console trail', () => {
  assert.match(driverSrc, /report\.native = await page\.evaluate/,
    'diagnostik native dibaca langsung via CDP — jangan bergantung routing console→logcat');
  assert.match(driverSrc, /report\.consoleTrail/,
    'seluruh jejak console (semua level) ikut report — baris [dApp diag] harus terbaca dari artefak');
  assert.match(driverSrc, /Error injecting safe area CSS/,
    'noise upstream SystemBars.java (bukti: node_modules/@capacitor/android/.../SystemBars.java) masuk allowlist sadar, bukan luput');
  assert.match(driverSrc, /ping timeout 2500ms/, 'ping native wajib berbatas');
});

test('the workflow serves the dApp fixture to the emulator and keeps its server log', () => {
  const wfRaw = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  // The fixture must be reachable from the emulator over PLAIN http: a second
  // WebView does not trust Capacitor's local-server certificate, so
  // https://localhost would die at net::ERR_CERT before the first assertion.
  assert.match(wfRaw, /python3 -u -m http\.server 8080 --directory dist/,
    'server fixture wajib ada (-u, tanpa buffering), port 8080, menyajikan dist yang baru dibangun');
  // Same origin the driver opens — port drift = the journey dies at CDP attach.
  assert.match(driverSrc, /http:\/\/10\.0\.2\.2:8080\/dapp-rpc-fixture\.html/,
    'driver wajib membuka URL yang persis disajikan workflow (10.0.2.2 = host dari emulator)');
  // The server log survives the job: a fixture that never loaded has to be
  // diagnosable from the artifact, not guesswork.
  const uploadPaths = Object.values(workflow.jobs)
    .flatMap((job) => job.steps || [])
    .flatMap((step) => (step.with && (step.with.path || step.with.paths)) || [])
    .join('\n');
  assert.match(uploadPaths, /http-server\.log/, 'http-server.log wajib ikut artefak diagnosis');
});

test('the driver drives the native dApp browser end to end — open, confirm, read, back', () => {
  assert.match(driverSrc, /__bearE2EOpenDapp/, 'jalur pembukaan = hook native (kartu katalog menunjuk eksternal)');
  assert.match(driverSrc, /waitNativeButton\('dapp-confirm-ok'/, 'konfirmasi = SHEET NATIVE (plugin.confirm), bukan modal wallet #confirmYes');
  assert.match(driverSrc, /tapNativeButton\('dapp-confirm-ok'\)/, 'persetujuan = tap tombol native asli lewat uiautomator');
  assert.match(driverSrc, /connectCDP\('10\.0\.2\.2:8080'\)/, 'hasil fixture dibaca dari target CDP KEDUA (halaman dapp)');
  assert.match(driverSrc, /tapNativeButton\('dapp-back'\)/, 'kembali = tap tombol NATIVE asli lewat uiautomator — CDP tak melihat di luar WebView');
  assert.match(driverSrc, /hasProvider=true/, 'rantai bukti: provider ter-inject');
  // A local page parses before any queued evaluateJavascript, so a HEALTHY
  // late wallet records hasProvider=false then providerLate=N. Requiring the
  // literal hasProvider=true failed run 38131950877 where connect worked
  // perfectly (account0 + done=ok both present). The provider counts as seen
  // either way; account0 + done=ok remain the load-bearing proof.
  assert.match(driverSrc, /providerSeen = \/hasProvider=true\/\.test\(log\) \|\| \/providerLate=\\d\+\/\.test\(log\)/,
    'provider yang datang terlambat tetap dihitung "ada", bukan gagal');
  assert.match(driverSrc, /account0=0x[\s\S]{0,120}done=ok/,
    'bukti connect yang memikulnya: akun sampai + perjalanan selesai');
  assert.match(driverSrc, /account0=0x/, 'rantai bukti: akun dari konfirmasi');
  assert.match(driverSrc, /done=ok/, 'rantai bukti: siklus penuh selesai');
  // The sheet question is answered by what the SCREEN shows, not what the DOM
  // holds: a CDP click would work even behind the overlay.
  assert.match(driverSrc, /shotScreen\('06-dapp-connect-sheet'\)/, 'bukti jangkauan sheet = tangkapan layar SELURUH layar');
  // ...and "what the screen shows" is now read from the NATIVE VIEW TREE: a
  // gate on the page's document.visibilityState could NEVER fail — measured on
  // run 38161736957, the dApp page still reports 'visible' with its overlay
  // GONE (that is what hid the deep-link pair sheet from its own test).
  assert.match(driverSrc, /sheetView = await browserState\(\)/, 'visibilitas dApp dibaca dari view tree native');
  assert.match(driverSrc, /!report\.dapp\.sheetView \|\| report\.dapp\.sheetView\.visible !== true/,
    'dApp WAJIB TETAP TERLIHAT saat sheet native tampil — flash-to-wallet = bug (user report "pas connect langsung keluar")');
  assert.doesNotMatch(driverSrc, /sheetVisibility !== 'visible'/,
    'gate lama (visibilityState halaman) = gate palsu, dilarang kembali');
  // The account row cross-check ties the sheet (native layer) to the fixture.
  assert.match(driverSrc, /accountMatchesModal/, 'akun fixture wajib cocok dengan akun yang ditampilkan sheet native');
  // Read the sheet's own "Account" row, not the first 0x… on screen: the
  // accessibility dump spans the whole window, so the wallet dashboard behind
  // the modal contributes dozens of token addresses. "First 0x match" picked
  // USDT's 0xdAC1…1ec7 and failed a connect that had worked (run 38135917949).
  assert.match(driverSrc, /texts\.indexOf\('Account'\)/, 'ambil nilai baris "Account" milik sheet');
  assert.match(driverSrc, /rowAt \+ 1/, 'nilainya adalah teks tepat sesudah label');
  assert.match(driverSrc, /native sheet has no Account row/, 'baris Account hilang = gagal keras');
  assert.match(driverSrc, /did not return the wallet to view/, 'back palsu (tombol ketuk tapi layar tak pulih) wajib gagal');
});

test('a crashed uiautomator dump must never be read as a stale "button is gone"', () => {
  // Run 38127365427 captured the real failure: the platform dumper threw a
  // NullPointerException inside AccessibilityNodeInfoDumper.childNafCheck and
  // was SIGKILLed, leaving the PREVIOUS /sdcard/uidump.xml on the device. The
  // old helpers dumped and cat'd without deleting first, so they happily
  // searched that stale file and reported "confirm sheet never appeared" for a
  // sheet that was plainly on screen. The fix deletes before dumping and only
  // accepts a fresh, complete hierarchy.
  assert.match(driverSrc, /function dumpUi\(\)/, 'satu helper dump, dipakai semua pemakai uiautomator');
  assert.match(driverSrc, /rm', '-f', '\/sdcard\/uidump\.xml'/, 'file dump lama DIHAPUS dulu — file basi = sumber salah-taps');
  assert.match(driverSrc, /xml\.includes\('<hierarchy'\)/, 'hanya dump lengkap yang diterima; crash = kosong = retry, bukan "tak ada"');
  // Every uiautomator read must go through the guard, not the raw adb pair.
  const rawDumps = (driverSrc.match(/uiautomator', 'dump'/g) || []).length;
  assert.equal(rawDumps, 1, 'uiautomator dump hanya boleh dipanggil di dumpUi() — satu pintu, satu guard');
  const rawCats = (driverSrc.match(/cat', '\/sdcard\/uidump\.xml'/g) || []).length;
  assert.equal(rawCats, 1, 'file dump hanya dibaca sekali, di dalam dumpUi() — tak ada pemakai yang bisa baca basi');
});

test('the confirm button has a tap fallback when the platform dumper is dead', () => {
  // The sheet's OK button is native; uiautomator is the only outside eye, and
  // that eye is crash-prone on this app. The app logs the button's real
  // on-screen rect (tag BearToolE2E) when the sheet is laid out, so the driver
  // can press exactly where the app says it drew the button instead of giving
  // up or guessing coordinates. Same button, real tap — not a JS shortcut.
  assert.match(driverSrc, /function tapReportedRect\(tag\)/, 'fallback tekan-tombol berbasis rect milik app');
  assert.match(driverSrc, /logcat', '-d', '-s', 'BearToolE2E:I'/, 'rect dibaca dari log tag yang ditulis app');
  // The fallback must use the SAME real `input tap` primitive — never a JS
  // evaluate shortcut, which would bypass the native control it is meant to
  // prove reachable.
  const fn = driverSrc.slice(driverSrc.indexOf('function tapReportedRect'), driverSrc.indexOf('function tapReportedRect') + 700);
  assert.match(fn, /input', 'tap'/, 'fallback menekan lewat `input tap` asli, bukan evaluate JS');
  // The fallback must sit BEHIND the label attempt at every confirm tap.
  const confirmTaps = driverSrc.match(/!tapReportedRect\('confirm-ok-rect'\)/g) || [];
  assert.ok(confirmTaps.length >= 4,
    'tiap tap confirm (connect / sign / typed-data / reopen) punya fallback rect');
});

test('the wallet can walk back into a hidden browser through its own Tabs door', () => {
  assert.match(driverSrc, /tapNativeButton\('dapp-close'\)/, 'browser ditutup lewat ✕ native');
  assert.match(driverSrc, /dappTabsBtn/, 'view dApps punya entry Browser (tabs)');
  assert.match(driverSrc, /hiding the browser killed the tab session/, 'sesi WAJIB hidup setelah hide — blanking membunuh door tabs');
  assert.match(driverSrc, /.dapp-tabs-row./, 'chooser tab dirender di modal wallet');
  assert.match(driverSrc, /walletTabsReopened/, 'reopen dari wallet dibuktikan lewat target CDP yang masih live');
});

test('the dapp block is a truth machine — CDP polls the DOM and the page keeps its own voice', () => {
  // Run 38040858378: provider reported 'resolved' but the fixture looked dead
  // on a 20s-old screenshot. The judgment now comes from the DOM over CDP,
  // before the wallet even answers, with the dapp page's console and
  // exceptions captured — the view has no WebChromeClient, so this is the
  // only voice it will ever have.
  assert.match(driverSrc, /attach the fixture page over its own CDP target/,
    'attach datang SEBELUM nunggu modal — tanpa itu path fatal tak pernah punya suara dapp');
  assert.match(driverSrc, /const pollOut = async/, 'poll #out via CDP — DOM, bukan pixel');
  assert.match(driverSrc, /chainId=\|error=\|done=/,
    'poll discriminate: chainId (jalan) / error (deadline berteriak) / done — satu dari ketiganya WAJIB muncul');
  assert.match(driverSrc, /report\.dapp\.href/, 'location.href ikut tercatat — dokumen yang dieval harus bisa dibuktikan');
  assert.match(driverSrc, /dappEvents\.push\('exception: /,
    'exception halaman dapp menyeberang ke report — Uncaught di dapp view selama ini hilang tanpa jejak');
  assert.match(driverSrc, /fixture never saw eth_chainId/,
    'kegagalan chainId melempar dengan #out + href + console dapp dalam pesan — diagnosis dari error message, bukan dari tebakan');
  // the old strict gates survive the restructure
  assert.match(driverSrc, /accountMatchesModal/, 'cross-check akun tetap ada');
  assert.match(driverSrc, /tapNativeButton\('dapp-back'\)/, 'tombol back native tetap diuji');
});

test('the heartbeat carries memory and the qemu identity — a dead run must be judgeable', () => {
  // Runs 38040231871/38042207486/38042758668: the emulator vanished mid-run
  // (qemu 2→1, device gone, no app FATAL, script ran to completion). Whether
  // the host was out of memory or qemu itself crashed must come from the
  // artifact, not from a hunch — every 10s tick now records `free -m`
  // available RAM plus the full cmdline of every qemu process (which one
  // survives, which one vanished).
  assert.match(rawScript, /free=\[\$\(free -m/,
    'tiap tick heartbeat merekam RAM tersedia — OOM host harus terbukti dari artefak');
  assert.match(rawScript, /pgrep -af qemu/,
    'identitas lengkap proses qemu per tick — qemu=2→1 kini bisa ditelusuri siapa mati');
});

test('the emulator job runs on a PINNED image — a floating -latest hides every death', () => {
  // Four runs (38040231871…38045063225) lost qemu with identical code and a
  // healthy host — deaths clustered on the 24.04.5 fleet while earlier runs
  // on the same label lived. Once pinned, a fleet regression becomes a
  // visible bisect decision instead of a rerun lottery.
  const job = workflow.jobs.emulator;
  assert.ok(job['runs-on'], 'emulator job wajib punya runs-on');
  assert.ok(!String(job['runs-on']).includes('latest'),
    'runs-on dilarang ubuntu-latest — image melayang membuat kematian emulator tak bisa dibedakan dari bug');
});

test('the driver reads the truth probes before judging the chain', () => {
  // run 38046569239 died at the new truth-machine step with a clean bill of
  // health except the missing settle — probe data must ride into the report
  // so the next dead run is decidable from the artifact alone.
  assert.match(driverSrc, /report\.dapp\.probe = await dpage\.evaluate/,
    'probe dijalankan SEBELUM poll chainStage — kegagalan tetap membawa bukti');
  assert.match(driverSrc, /selfSettle: t/, 'hasil self-settle masuk report (mesin then-chain hidup/mati)');
  assert.match(driverSrc, /head\.sameFn/, 'identitas instance (page vs Java) masuk report');
});

test('a fleet qemu death is recovered in-workflow — 3 bounded boots, death signatures only', () => {
  // Runs 5,7,8,9,13,15,16,17,18,19 lost their emulator at random (qemu
  // <defunct> then gone, 10–14GB RAM free, no OOM, no app FATAL, both
  // pinned images) — 10 of 19. A dead fleet is not a test result: the
  // wrapper reruns the journey ONCE on a fresh emulator, and only when the
  // fatal matches a death signature. A journey bug exits with the driver's
  // RC before any relaunch — the retry is reserved for the fleet.
  const recPath = path.join(here, '..', 'tools', 'e2e-recover.sh');
  const rec = readFileSync(recPath, 'utf8');
  const syntax = spawnSync('bash', ['-n', recPath]);
  assert.equal(syntax.status, 0, 'bash -n: ' + syntax.stderr);

  // classification gates — every observed death signature, nothing else
  assert.match(rec, /is_death\(\)/, 'klasifikasi tanda-mat wajib ada');
  for (const sig of ['not found', 'device offline', 'socket closed', 'CDP connect failed', 'Page.captureScreenshot']) {
    assert.match(rec, new RegExp(sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'signature kematian harus dikenali: ' + sig);
  }
  assert.match(rec, /journey failure, not a fleet death/,
    'gagal journey TIDAK boleh memakai retry — exit dengan RC driver');
  assert.match(rec, /exit "\$rc"/, 'jalur non-mati keluar sebelum relaunch');

  // the relaunch mirrors the action's own cmdline (heartbeat evidence) —
  // same AVD + port keeps adb serial + the action's post-step emu kill valid
  assert.match(rec, /-avd test/, 'AVD identik dengan yang dipakai action');
  assert.match(rec, /-port 5554/, 'port identik — serial emulator-5554 tetap');
  assert.match(rec, /adb wait-for-device/, 'menunggu device kembali');
  assert.match(rec, /sys\.boot_completed/, 'menunggu boot SELESAI, bukan sekadar muncul');
  assert.match(rec, /install -r "\$APK"/, 'APK dipasang ulang (boot = -no-snapshot, bersih)');
  assert.match(rec, /am start -n com\.nemoobc\.beartool/, 'app dijalankan ulang');
  assert.match(rec, /logcat -v time >> logcat-stream\.txt/,
    'logcat menyambung ke device baru — bukti run penyintas ikut terkumpul');
  // bounded: a counter, not faith — ATTEMPTS boots max (run 38058320932
  // burned attempt 1 AND its relaunch inside one run; two boots ≈ 75%, three
  // ≈ 87% at the observed ~50% per-boot death rate)
  assert.match(rec, /ATTEMPTS=3/, 'tiga boot maksimum — naik hanya dengan bukti angka');
  assert.match(rec, /\$attempt" -ge "\$ATTEMPTS"/, 'loop keluar saat habis — tanpa counter = loop tanpa dasar');
  assert.match(rec, /while :; do/, 'siklus = loop bercounter, bukan duplikasi kode');
  assert.match(rec, /journey failure, not a fleet death/,
    'gagal journey TIDAK boleh memakai retry — exit dengan RC driver');

  // the workflow routes through the wrapper; the raw driver is not callable
  // from YAML anymore (one self-contained line, no state across sh -c)
  const yaml = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  assert.match(yaml, /bash tools\/e2e-recover\.sh/, 'workflow memanggil wrapper');
  assert.doesNotMatch(yaml, /node tools\/emulator-e2e\.mjs/,
    'driver telanjang di YAML = melewati klasifikasi — dilarang');
  assert.match(yaml, /timeout 2100/, 'wrapper dibatasi luar (3x480 + 2 recovery)');
});

test('the E2E boots a BARE image — GMS FontsProvider collateral kills are a closed class', () => {
  // Run 38059524261, logcat 14:30:02.442+: gms.persistent died spontaneously
  //   Killing com.nemoobc.beartool (adj 0): depends on provider
  //   com.google.android.gms/.fonts.provider.FontsProvider in dying proc
  //   com.google.android.gms.persistent (adj -10000)
  // — four seconds into the fixture, the whole app SIGKILL'd, renderer gone,
  // CDP evaluate timing out (the exact wedge signature). The app uses NO
  // GMS/Firebase at runtime: google-services plugin is build-time only, zero
  // firebase/gms references in js/, java/, AndroidManifest. The bare AOSP
  // image removes the provider dependency, its death, and the Google-app
  // background churn in one move — the app must not die because a stranger
  // process did.
  const yml = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  assert.match(yml, /target: default/, 'image bare — tanpa GMS, tanpa FontsProvider, tanpa kill berantai');
  assert.doesNotMatch(yml, /target: google_apis/,
    'google_apis mengembalikan kelas kill ini — hanya boleh kembali dengan bukti logcat baru');
  assert.match(yml, /FontsProvider/, 'alasan ditulis di workflow — keputusan butuh jejak');
});

test('href and probe wait for the fixture document — a passing report must not say about:blank', () => {
  // Run 38061409481 PASSED (pass:true, full journey) but its forensics lied:
  // the attach beat the navigation commit, so href recorded about:blank and
  // the probe died "Execution context was destroyed" — useless data in the
  // one artifact future readers trust most. Stabilization is pinned here:
  // poll location.href off about:blank, retry only on context destruction
  // (a genuine eval failure must not spin), THEN capture href.
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
  assert.match(driver, /while \(\(location\.href \|\| 'about:blank'\) === 'about:blank'/,
    'polling ke luar about:blank sebelum href+probe');
  assert.match(driver, /destroyed: \/destroyed\/i\.test/,
    'retry HANYA saat konteks hancur — kegagalan eval asli tidak boleh diulang');
  assert.match(driver, /i < 3;/, 'retry berbatas 3× — tanpa batas = loop tanpa dasar');
  // order: stabilization block must precede the href capture
  const stab = driver.indexOf("=== 'about:blank'");
  const href = driver.indexOf('report.dapp.href = await');
  assert.ok(stab > 0 && href > stab, 'stabilisasi mendahului capture href');
});

test('screenshots get their own 25s budget — a boot-churn readback stall is not a test result', () => {
  // Run 38062223439: seed-screen Page.captureScreenshot timed out at the 15s
  // CDP default while app AND renderer were alive (MediaProvider scan +
  // Gralloc churn at boot). cdp.send takes a per-call timeout; the screenshot
  // gets 25s to ride the stall out — everything else keeps the 15s default,
  // so a genuinely wedged compositor still fails FAST via the wrapper.
  const driver = readFileSync(path.join(here, '..', 'tools', 'emulator-e2e.mjs'), 'utf8');
  assert.match(driver, /Page\.captureScreenshot', \{ format: 'png' \}, 25000/,
    'screenshot memakai 25000ms — bukan default 15000');
  // and the wrapper recovers it if 25s is not enough either
  const rec = readFileSync(path.join(here, '..', 'tools', 'e2e-recover.sh'), 'utf8');
  assert.match(rec, /\*"Page\.captureScreenshot"\*/, 'stall kompositor = signature yang boleh di-recover');
});

test('a dead emulator can no longer end the run GREEN — the report is the verdict', () => {
  // Run 38121129070 concluded SUCCESS while its own artifact read
  // pass:false / fatal:"CDP connect failed … emulator-5554 not found": all 3
  // recover boots hit fleet qemu deaths. Every YAML script line is
  // `|| echo ..._RC=$?`-guarded (android-emulator-runner runs one sh -c per
  // line, a non-zero exit kills the rest), so nothing consumed the driver's
  // exit code or its report. A gate that cannot fail is a false gate — the
  // E2E must turn the job red.
  const yml = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  assert.match(yml, /name: Assert the E2E actually passed/, 'langkah asersi wajib ada');
  assert.match(yml, /emulator-artifacts\/emulator-report\.json/,
    'verdict dibaca dari report driver, bukan exit code yang tertelan');
  assert.match(yml, /if\(!r\.pass\)[\s\S]{0,120}process\.exit\(1\)/,
    'job GAGAL (exit 1) saat report.pass != true');
  // Order matters: the assertion sits before the upload, and the upload is
  // `always()` so a red run still ships its evidence.
  const assertIdx = yml.indexOf('Assert the E2E actually passed');
  const uploadIdx = yml.indexOf('Upload diag artifacts');
  assert.ok(assertIdx > 0 && uploadIdx > assertIdx, 'asersi harus sebelum upload artifact');
});

test('the chainChanged verdict reads the LAST event, not the one from connect', () => {
  // Run 38156823295: the native switch to Polygon WORKED — localStorage read
  // "polygon" and the fixture's own log ended with `chainChanged=0x89` — yet the
  // job went red. The provider announces the chain the dApp connected ON (0x1)
  // BEFORE the picker's switch, so the polled dump holds `chainChanged=0x1`
  // first and `chainChanged=0x89` last; the check took the FIRST match and
  // demanded 0x1. "Did the switch reach the page?" must read the LAST recorded
  // value. Pin both halves: the wrong shape is gone and the wait-for-0x89 loop
  // is present.
  assert.doesNotMatch(driverSrc,
    /report\.dapp\.chainChanged = \(String\(chgText\)\.match\(\/chainChanged=/,
    'tidak boleh ambil match PERTAMA chainChanged (0x1 dari connect menutupi 0x89)');
  assert.match(driverSrc,
    /const all = String\(chgText\)\.match\(\/chainChanged=\(0x\[0-9a-fA-F\]\+\)\/g\) \|\| \[\]/,
    'kumpulkan SEMUA chainChanged');
  assert.match(driverSrc, /all\[all\.length - 1\]\.replace\(\/\^chainChanged=\/, ''\)/,
    'ambil kejadian TERAKHIR');
  assert.match(driverSrc, /chgLast === '0x89' \|\| Date\.now\(\) > chgDeadline/,
    'tunggu sampai 0x89 (atau deadline) sebelum menuduh');
});

// A failure that only says "timeout waiting for #x" points at a selector, not a
// cause. Run 38260123665 produced exactly that and cost a full build+emulator
// cycle to turn into "the Receive sheet rendered nothing". The driver now carries
// three things so a failure explains itself: Network.enable (so loadingFailed is
// ever emitted), the request failures themselves, and the console/network
// evidence gathered since the last step marker.
test('a fatal failure explains itself: step in flight, evidence, dropped requests', () => {
  // Network domain must be on, or the dropped-request half of the story is absent.
  assert.match(driverSrc, /cdp\.send\('Network\.enable'\)/,
    'Network.enable wajib dipanggil — tanpa itu Network.loadingFailed tak pernah terkirim');
  assert.match(driverSrc, /Network\.loadingFailed/,
    'driver harus menangkap request yang gagal');
  assert.match(driverSrc, /report\.netFailures/,
    'request gagal harus masuk report, bukan dibuang');
  assert.match(driverSrc, /report\.lastStep/,
    'driver harus tahu langkah mana yang sedang jalan saat gagal');
  // The evidence window is closed at the NEXT step marker, so a failing step
  // arrives with its own evidence rather than the whole run's noise.
  assert.match(driverSrc, /report\.stepLog\.push/,
    'bukti per langkah harus ditutup saat langkah berikutnya dimulai');
  // And die() quotes it.
  assert.match(driverSrc, /step in flight:/,
    'pesan kegagalan harus menyebut langkah yang sedang jalan');
  assert.match(driverSrc, /dropped requests/,
    'pesan kegagalan harus menyebut request yang gagal');
  // Finally: the workflow must ship the recording, or a run that fails on a
  // gesture can only be read from stills.
  assert.match(workflowRaw, /screenrecord/,
    'emulator.yml harus merekam layar — video satu-satunya bukti gerakan');
  assert.match(workflowRaw, /bear-e2e\.mp4/,
    'rekaman harus ikut terunggah sebagai artifact');
  // Every adb line in that script is its own `sh -c`, so a line that can fail
  // has to guard itself — an unguarded screenrecord would kill the rest.
  const wfCode = workflowRaw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const line of wfCode.split('\n').filter((l) => /screenrecord|ad[bp] .*bear-e2e/.test(l))) {
    assert.match(line, /\|\| echo/,
      `baris rekaman tanpa guard: ${line.trim()} — satu baris gagal mematikan sisa skrip`);
  }
});
