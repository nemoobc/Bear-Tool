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
  assert.match(script, /timeout 480 env E2E_OUT=emulator-artifacts node tools\/emulator-e2e\.mjs > e2e-stdout\.log 2>&1 \|\| echo E2E_FAILED_RC=\$\?/,
    'driver dibatasi 480s, output ke FILE, rc ditangkap di baris yang sama');
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
  assert.match(wfRaw, /python3 -m http\.server 8080 --directory dist/,
    'server fixture wajib ada, port 8080, menyajikan dist yang baru dibangun');
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
