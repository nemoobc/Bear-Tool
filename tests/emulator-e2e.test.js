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

test('fatal paths flush before exit — console.error + process.exit lost the last run\'s message', () => {
  // The exact pair that swallowed the FATAL line must not come back.
  assert.doesNotMatch(driverSrc, /console\.error\([^)]*\)\s*;\s*process\.exit/,
    'console.error diikuti langsung process.exit memotong write stderr yang belum terflush');
  // The replacement: write with a callback that exits after the flush, plus a
  // report written synchronously first.
  assert.match(driverSrc, /process\.stderr\.write\('\[e2e\] FATAL[\s\S]{0,120}\(\) => process\.exit\(1\)/,
    'die() harus exit dari callback flush stderr, bukan memotongnya');
  assert.match(driverSrc, /report\.fatal = msg;[\s\S]{0,120}writeFileSync\(path\.join\(OUT, 'emulator-report\.json'\)/,
    'report wajib ditulis sinkron berisi `fatal` SEBELUM exit — file tidak punya race flush');
});

test('every step lands in steps.log synchronously, so a SIGKILL still shows the last move', () => {
  assert.match(driverSrc, /appendFileSync\(steplog/,
    'step wajib appendFileSync: stdout ke pipe bisa hilang saat kill');
  assert.match(driverSrc, /const steplog = path\.join\(OUT, 'steps\.log'\)/);
});

test('CDP calls are bounded and the socket rejects pending calls on close', () => {
  assert.match(driverSrc, /CDP_TIMEOUT_MS = 15_000/, 'setiap send() wajib punya timeout');
  assert.match(driverSrc, /CDP timeout \$\{CDP_TIMEOUT_MS\}ms: \$\{method\}/,
    'timeout harus menyebut method — tanpa itu hang-nya tak terbaca');
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
  assert.match(script, /timeout 1300 env E2E_OUT=emulator-artifacts bash tools\/e2e-recover\.sh \|\| echo E2E_FAILED_RC=\$\?/,
    'wrapper dibatasi 1300s luar, rc ditangkap di baris yang sama');
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
  assert.match(driverSrc, /#confirmYes/, 'konfirmasi connect diklik di HALAMAN WALLET');
  assert.match(driverSrc, /connectCDP\('10\.0\.2\.2:8080'\)/, 'hasil fixture dibaca dari target CDP KEDUA (halaman dapp)');
  assert.match(driverSrc, /tapNativeButton\('dapp-back'\)/, 'kembali = tap tombol NATIVE asli lewat uiautomator — CDP tak melihat di luar WebView');
  assert.match(driverSrc, /hasProvider=true/, 'rantai bukti: provider ter-inject');
  assert.match(driverSrc, /account0=0x/, 'rantai bukti: akun dari konfirmasi');
  assert.match(driverSrc, /done=ok/, 'rantai bukti: siklus penuh selesai');
  // The flash-to-wallet question is answered by what the SCREEN shows, not
  // what the DOM holds: a CDP click would work even behind the overlay.
  assert.match(driverSrc, /shotScreen\('06-dapp-connect-modal'\)/, 'bukti jangkauan modal = tangkapan layar SELURUH layar');
  // The account row cross-check ties the two WebViews together.
  assert.match(driverSrc, /accountMatchesModal/, 'akun fixture wajib cocok dengan akun yang dimodalkan wallet');
  assert.match(driverSrc, /did not return the wallet to view/, 'back palsu (tombol ketuk tapi layar tak pulih) wajib gagal');
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

test('a fleet qemu death is recovered in-workflow — one rerun, death signatures only', () => {
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
  for (const sig of ['not found', 'device offline', 'socket closed', 'CDP connect failed']) {
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
  assert.match(rec, /run_driver; rc2=\$\?\s*\nexit "\$rc2"/,
    'persis SATU siklus kedua, hasil akhir = RC attempt kedua');

  // bounded: exactly one recovery, never a loop
  assert.equal((rec.match(/run_driver;/g) || []).length, 2,
    'run_driver dipanggil tepat 2× (awal + 1 recovery) — tanpa loop');

  // the workflow routes through the wrapper; the raw driver is not callable
  // from YAML anymore (one self-contained line, no state across sh -c)
  const yaml = readFileSync(path.join(here, '..', '.github', 'workflows', 'emulator.yml'), 'utf8');
  assert.match(yaml, /bash tools\/e2e-recover\.sh/, 'workflow memanggil wrapper');
  assert.doesNotMatch(yaml, /node tools\/emulator-e2e\.mjs/,
    'driver telanjang di YAML = melewati klasifikasi — dilarang');
  assert.match(yaml, /timeout 1300/, 'wrapper dibatasi luar (480+240+480 sisa)');
});
