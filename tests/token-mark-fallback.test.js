// Bear Tool — token-mark-fallback.test.js
// A dead remote logo must degrade to the token's own mark, not to "?".
//
// tokenLogoHTML() emits <img class="token-logo-img token-mark"
// data-mark-fallback="ETH" …> and guardTokenLogos() already does the right thing
// with that attribute: on an error it swaps the <img> for the generated mark of
// the symbol the row belongs to.
//
// renderAssets() then attached a second, worse handler to the same elements:
//
//     const i = Number(img.dataset.idx || 0);            // computed, never used
//     img.outerHTML = tokenLogoHTML('', 32, {remote:false});
//
// Passing '' discards the symbol, so markSvg fell back to its "?" initial. ETH's
// hand-tuned disc — the one in the MARKS table, and the one the same file renders
// when nothing is cached — was thrown away precisely when the remote image failed,
// which is the moment the fallback matters. The attribute holding the correct
// symbol was right there, unused.
//
// Two error handlers on one element also both try to replace it, so which one
// wins is a matter of registration order rather than intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const logo = readFileSync(new URL('../js/token-logo.js', import.meta.url), 'utf8');

// The asset list is the only place that renders token rows.
const renderAssets = app.slice(
  app.indexOf('function renderAssets('),
  app.indexOf('// Click handlers', app.indexOf('function renderAssets('))
);

test('the asset list delegates its logo fallback to guardTokenLogos', () => {
  assert.match(renderAssets, /guardTokenLogos\(/,
    'renderAssets attaches its own error handler instead of using guardTokenLogos, ' +
    'which already replaces a dead remote logo with the generated mark for that symbol');
});

test('no ad-hoc handler discards the symbol on a logo error', () => {
  assert.doesNotMatch(renderAssets, /tokenLogoHTML\(''\s*,/,
    "an error handler renders tokenLogoHTML('') — an empty symbol — so the fallback is a '?' disc instead of the token's own mark");
  assert.doesNotMatch(renderAssets, /dataset\.idx/,
    'dataset.idx is computed and never used; the symbol is already on the element as data-mark-fallback');
});

test('one fallback owns the failure, and it is the one that knows the symbol', () => {
  const handlers = (renderAssets.match(/addEventListener\(\s*'error'/g) || []).length;
  assert.equal(handlers, 0,
    'renderAssets still attaches an error listener of its own; two handlers both replace the same element and the winner is decided by registration order');
  // And the delegated helper must be the one that reads the symbol.
  assert.match(logo, /data-mark-fallback/, 'token-logo.js must keep writing the fallback symbol');
  assert.match(logo, /markSvg\(img\.dataset\.markFallback/, 'guardTokenLogos must use it, not an empty string');
});
