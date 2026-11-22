// Regression: an error shown WHILE a modal is open has to be visible.
//
// Device repro 2026-11-22: unlock with a wrong password created the correct
// toast ("That password did not unlock this wallet...") and the user still saw
// nothing. Both layers were position:fixed, but #toast-wrap was z-index 2000
// and the unlock modal's .modal-overlay was 9500 with a dark background — the
// toast was rendered behind the sheet that had asked for the password. Happy
// path looked fine because the modal closes before its success toast appears.
//
// Text-level checks are deliberate: a DOM stub cannot measure stacking, and a
// browser test would need a device. The three numbers below are the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainError } from '../js/errors.js';

const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function body(selector) {
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g');
  const list = [...css.matchAll(re)].map((m) => m[1]);
  assert.ok(list.length, `${selector} rule must exist in cartoon.css`);
  // #intro also appears in a reduced-motion rule with only `display:none`.
  // The stacking declaration lives in the fixed full-screen rule.
  return list.find((b) => /position:\s*fixed/.test(b)) ?? list[0];
}

function zIndex(selector) {
  const m = /z-index:\s*(\d+)/.exec(body(selector));
  assert.ok(m, `${selector} must declare a z-index`);
  return Number(m[1]);
}

test('toast outranks an open modal but stays below the splash', () => {
  const toast = zIndex('#toast-wrap');
  const modal = zIndex('.modal-overlay');
  const splash = zIndex('#intro');
  assert.ok(toast > modal,
    `toast (${toast}) must sit above the modal overlay (${modal}) — otherwise every error raised while a sheet is open is invisible`);
  assert.ok(toast < splash,
    `toast (${toast}) must stay below the first-paint splash (${splash})`);
  assert.match(body('#toast-wrap'), /pointer-events:\s*none/,
    'raising the toast must not turn it into a click trap over the modal');
  assert.match(body('.modal-overlay'), /background:\s*rgba\(45,\s*42,\s*50,\s*0\.6\)/,
    'the overlay really is opaque enough to hide whatever sits under it');
  assert.match(html, /id="toast-wrap"/);
  assert.match(html, /id="modalOverlay"/);
});

test('a failed unlock still produces a plain-language error toast', () => {
  // The unlock sheet calls toast(..., 'error'); toast() runs every error
  // through explainError. Guard both ends: the call site and the translation.
  assert.match(app, /toast\('Wrong password: '\s*\+\s*e\.message,\s*'error'\)/,
    'the unlock catch must still raise an error toast');
  const said = explainError('Wrong password: OperationError');
  assert.match(said, /password/i);
  assert.doesNotMatch(said, /OperationError|0x[0-9a-f]{8,}/,
    'the raw decrypt failure must never reach the user');
});
