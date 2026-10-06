// Bear Tool — tests/bridge-confirm.test.js
//
// Button and confirm-dialog wording for the bridge (user, 2026-10-06:
// "excetuce bridge gabti bridge", "confirm bridge ganti confirm") — the same
// trim the swap dialog got: the dialog title already says BRIDGE, so the
// button confirms instead of repeating the verb. Pins the view button, the
// mainnet danger dialog, and the sign dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeJs = fs.readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
const bridgeView = fs.readFileSync(new URL('../src/views/bridge.jsx', import.meta.url), 'utf8');

test('the exec button reads Bridge, not Execute Bridge', () => {
  assert.match(bridgeView, /id="btnBridgeExec" disabled>Bridge</,
    'the visible button is just Bridge');
  assert.doesNotMatch(bridgeView, /Execute Bridge/,
    'the extra verb is gone from the view');
});

test('both bridge dialogs confirm instead of repeating the verb', () => {
  assert.match(bridgeJs, /confirmText: 'Bridge', danger: true/,
    'the mainnet danger dialog');
  assert.match(bridgeJs, /confirmText: 'Confirm',/,
    'the SIGN BRIDGE dialog confirms');
  assert.doesNotMatch(bridgeJs, /Execute Bridge|Confirm & Bridge/,
    'neither old label survives');
});
