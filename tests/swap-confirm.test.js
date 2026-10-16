// Bear Tool — tests/swap-confirm.test.js
//
// The sign-confirmation button said "Confirm & Swap" while the dialog itself
// is already titled "✍️ SIGN SWAP" — a second verb on a button whose only job
// is confirming (user, 2026-10-06: "confirm and swap ganti confirm aja").
// Keep the mainnet danger dialog ("Swap") as it is; this pins the sign one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t } from '../js/i18n.js';

const swapSrc = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');

test('the sign dialog button reads Confirm, not Confirm & Swap', () => {
  // The key carries the word now (M14): pin the call AND its English value —
  // the user request was about the text on the button, not about the syntax.
  assert.match(swapSrc, /confirmText: t\('cf\.confirm'\),/,
    'the SIGN SWAP dialog confirms');
  assert.equal(t('cf.confirm'), 'Confirm', 'tombol sign tetap "Confirm" di en');
  assert.doesNotMatch(swapSrc, /Confirm & Swap/,
    'the extra verb is gone (user request 2026-10-06)');
});

const uiSrc = fs.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');

test('the sign dialog leads with pay and the quote receive estimate', () => {
  // "ask tx swap bridge itu ga ada pay eth receive brp gitu" (report
  // 2026-10-16): the pay amount becomes the headline, the quote's own
  // output estimate becomes the subhead, and the on-chain minimum gets a
  // row. The estimate is a display string; execution still binds on
  // amountInWei (swap-freshness).
  assert.match(swapSrc, /quoteData\.outEstimate = fmtAmount\(result\.outAmount, toDecimals\)/);
  assert.match(swapSrc, /headline: `\$\{amt\} \$\{dispSym\(from\)\}`/);
  assert.match(swapSrc, /subhead: swapRecvLine/);
  assert.match(swapSrc, /k: t\('cf\.receive\.min'\)/);
});

test('the wallet modal renders the money line like the native sheet', () => {
  assert.match(uiSrc, /headline = null, subhead = null, \.\.\.money/,
    'confirmTx accepts the money line without leaking it into totalPriceRow');
  assert.match(uiSrc, /headline, subhead, resolve: resolveOnce/);
  assert.match(uiSrc, /class="tx-headline"/);
  assert.match(uiSrc, /class="tx-subhead"/);
});
