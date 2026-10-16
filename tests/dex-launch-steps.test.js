// tests/dex-launch-steps.test.js
// DEX launch UX: the wizard must walk the user through 3 steps (detail → pair
// → confirm) with a second confirmation before any transaction is sent — like
// a memecoin launchpad, not a single "Go" button on a long form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const LAUNCH_KEYS = [
  'dex.launch.step.one', 'dex.launch.step.two', 'dex.launch.step.three',
  'dex.launch.label.tokenName', 'dex.launch.label.tokenSymbol', 'dex.launch.label.tokenImage',
  'dex.launch.label.socials', 'dex.launch.label.quoteCoin', 'dex.launch.label.supply',
  'dex.launch.chip.1m', 'dex.launch.chip.10m', 'dex.launch.chip.100m', 'dex.launch.chip.1b',
  'dex.launch.label.poolTokens', 'dex.launch.label.quoteAmount', 'dex.launch.label.lock',
  'dex.launch.label.creatorFee',
  'dex.launch.button.next', 'dex.launch.button.back', 'dex.launch.button.reviewLaunch',
  'dex.launch.confirm.title', 'dex.launch.confirm.body', 'dex.launch.confirm.confirm', 'dex.launch.confirm.cancel',
  'dex.launch.preview.openingPrice', 'dex.launch.preview.pair', 'dex.launch.preview.creatorTokens', 'dex.launch.preview.gasEst',
  'dex.launch.badge.fairLaunch', 'dex.launch.badge.antiSniper',
  'dex.launch.error.required', 'dex.launch.error.invalidSymbol',
];

test('launch wizard renders 3 locked steps (detail → pair → confirm)', () => {
  const html = read('../js/dex/launch.js');
  assert.match(html, /id="launch-step-1"/, 'step 1 panel: token details');
  assert.match(html, /id="launch-step-2"/, 'step 2 panel: pair & liquidity');
  assert.match(html, /id="launch-step-3"/, 'step 3 panel: confirm & launch');
  assert.match(html, /class="launch-stepper"/, 'stepper present');
  assert.match(html, /id="launchStep1Next"/, 'step 1 → 2');
  assert.match(html, /id="launchStep2Back"/, 'step 2 → 1 back');
  assert.match(html, /id="launchStep2Next"/, 'step 2 → 3');
  assert.match(html, /id="launchStep3Back"/, 'step 3 → 2 back');
  assert.match(html, /id="launchStep3Review"/, 'review button on step 3');
  assert.match(html, /id="launchConfirmOk"/, 'second confirmation before tx');
  assert.match(html, /id="launchConfirmCancel"/, 'cancel on review');
  assert.ok(!/id="dexCreateGo"/.test(html),
    'no single-tap Go button — the launch happens only from the review modal');
});

test('launch wizard carries launch.* i18n keys balanced EN vs ID', () => {
  const i18n = read('../js/i18n.js');
  const idStart = i18n.indexOf("'dex.launch.hint': 'Satu transaksi: deploy token");
  assert.ok(idStart !== -1, 'ID launch section present');
  const enCount = (i18n.slice(0, idStart).match(/dex\.launch\./g) || []).length;
  const idCount = (i18n.slice(idStart).match(/dex\.launch\./g) || []).length;
  assert.ok(enCount > 0, 'EN launch keys present');
  assert.equal(enCount, idCount, 'launch i18n keys balanced EN vs ID');
  for (const k of LAUNCH_KEYS) {
    assert.ok(new RegExp(`'${k}':`).test(i18n), `i18n key ${k} present`);
  }
});
