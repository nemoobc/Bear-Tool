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

test('the workflow takes logcat at BOOT, while the device is still alive', () => {
  // The device died ~50s after boot in every run before this one; the diag
  // line fires at boot, so the early dump is the only one guaranteed to land.
  const script = workflow.jobs?.emulator?.steps?.find((s) => s.with?.script)?.with?.script
    || workflow.jobs?.emulator?.steps?.find((s) => s.run?.includes?.('adb install'))?.run
    || '';
  assert.ok(script, 'emulator.yml: script step tidak ditemukan');
  assert.match(script, /logcat-boot\.txt/, 'logcat awal (pre-E2E) wajib ada');
  assert.match(script, /set \+e/, 'set +e: satu perintah gagal tidak boleh mematikan diagnosis');
  assert.match(script, /emulator-heartbeat\.txt/,
    'heartbeat adb/qemu/app — tanpa ini "- waiting for device" 36 menit tak bisa didiagnosis');
});

test('no unbounded adb command may remain in the emulator script', () => {
  const script = workflow.jobs?.emulator?.steps?.find((s) => withScript(s))?.with?.script || '';
  function withScript(s) { return typeof s?.with?.script === 'string' && s.with.script.includes('adb install'); }
  assert.ok(script, 'script step tidak ditemukan');
  // Every logcat/screencap/pull runs through `timeout`.
  for (const line of script.split('\n')) {
    if (/^\s*adb (logcat|shell screencap|pull)/.test(line)) {
      assert.match(line, /^\s*timeout \d+ adb /,
        `perintah tanpa timeout dilarang (job hang 36 menit gara-gara ini): ${line.trim()}`);
    }
  }
  assert.match(script, /timeout 480 env E2E_OUT/,
    'driver E2E wajib dibatasi 8 menit — hang apa pun harus berhenti, bukan makan 40 menit job');
  assert.match(script, /E2E_EXIT=\$E2E_EXIT/,
    'exit code di-echo oleh SHELL (echo shell selalu tercetak, tidak kena race node)');
});
