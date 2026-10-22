// Bear Tool — the emulator E2E harness must be able to RECOVER.
//
// The recovery wrapper (tools/e2e-recover.sh) reruns the journey on a
// fresh emulator when the CI fleet kills the device mid-run. It has to
// give the rerun a FRESH APP, not just a fresh device: `adb install -r`
// keeps the app's data, so a relaunch after a mid-journey death found
// the wallet the dead attempt had already created — the app booted into
// the dashboard, the journey waited 60s for the welcome screen's
// #wCreate, and the recovery could not pass. One flaky CDP screenshot
// (run 39739574807) therefore killed the whole run, and the rerun was
// guaranteed to fail for a reason that had nothing to do with the app.
//
// The gate: the relaunch wipes the app data, and it does so BEFORE the
// app is started again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sh = fs.readFileSync(new URL('../tools/e2e-recover.sh', import.meta.url), 'utf8');

test('the recovery wipes the app data before it starts the app again', () => {
  const clear = sh.indexOf('pm clear com.nemoobc.beartool');
  assert.ok(clear > -1,
    'the relaunch must clear the app data — install -r keeps it, and a stale '
    + 'wallet makes the welcome screen unreachable for the next attempt');
  const start = sh.indexOf('am start -n com.nemoobc.beartool');
  assert.ok(start > -1, 'the relaunch starts the app');
  assert.ok(clear < start,
    'the wipe must come BEFORE the app starts — clearing after the launch '
    + 'leaves the stale session on screen for the first seconds of the run');
});

test('the recovery is bounded and only reruns on device death', () => {
  assert.match(sh, /ATTEMPTS=\d+/, 'the number of boots is a number, not a loop forever');
  assert.match(sh, /Page\.captureScreenshot/, 'a wedged screenshot counts as device death');
  assert.match(sh, /is_death "\$fatal"/, 'a journey bug is not a device death');
});
