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
import { t } from '../js/i18n.js';

const bridgeJs = fs.readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
const bridgeView = fs.readFileSync(new URL('../src/views/bridge.jsx', import.meta.url), 'utf8');

test('the exec button reads Bridge, not Execute Bridge', () => {
  // Matches the button by id + its visible word with ANY attributes allowed in
  // between (the button now carries data-i18n). The point is the LABEL — "Bridge",
  // not "Execute Bridge" — so pinning attribute order would fail the moment an
  // unrelated attribute is added without changing what the test protects.
  assert.match(bridgeView, /id="btnBridgeExec"[^>]*>Bridge</,
    'the visible button is just Bridge');
  assert.doesNotMatch(bridgeView, /Execute Bridge/,
    'the extra verb is gone from the view');
});

test('both bridge dialogs confirm instead of repeating the verb', () => {
  // M14 routed these labels through the dictionary, so the source holds a key
  // instead of the word. BOTH halves are pinned: the call is there, and the
  // English text it resolves to is the word the dialog has always shown.
  assert.match(bridgeJs, /confirmText: t\('cf\.bridge'\), danger: true/,
    'the mainnet danger dialog');
  assert.match(bridgeJs, /confirmText: t\('cf\.confirm'\),/,
    'the SIGN BRIDGE dialog confirms');
  assert.equal(t('cf.bridge'), 'Bridge', 'tombol danger tetap "Bridge" di en');
  assert.equal(t('cf.confirm'), 'Confirm', 'tombol sign tetap "Confirm" di en');
  assert.doesNotMatch(bridgeJs, /Execute Bridge|Confirm & Bridge/,
    'neither old label survives');
});
