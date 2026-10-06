// Bear Tool — tests/swap-confirm.test.js
//
// The sign-confirmation button said "Confirm & Swap" while the dialog itself
// is already titled "✍️ SIGN SWAP" — a second verb on a button whose only job
// is confirming (user, 2026-10-06: "confirm and swap ganti confirm aja").
// Keep the mainnet danger dialog ("Swap") as it is; this pins the sign one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const swapSrc = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');

test('the sign dialog button reads Confirm, not Confirm & Swap', () => {
  assert.match(swapSrc, /confirmText: 'Confirm',/,
    'the SIGN SWAP dialog confirms');
  assert.doesNotMatch(swapSrc, /Confirm & Swap/,
    'the extra verb is gone (user request 2026-10-06)');
});
