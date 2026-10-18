// Bear Tool — eip7702-revoke.test.js
// Revoke EIP-7702 delegation from the Tools card: static guards that the
// revoke path is real (authorize to ZERO_ADDRESS + type-4 tx), the UI
// elements exist, and the flow is wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t } from '../js/i18n.js';
import { appSource } from './helpers/app-source.mjs';

const toolsSrc = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
// Halaman = index.html + section view (M2: src/views/*.jsx).
const html = appSource();

test('revoke: Tools card has check + revoke controls in HTML', () => {
  for (const id of ['revokeTarget', 'revokeKey', 'btnCheckDelegation', 'btnRevokeDelegation', 'revokeStatus', 'revokeStatusText']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must exist in the page markup (index.html + src/views)`);
  }
});

test('revoke: the Check-address box starts EMPTY (user report 2026-10-18)', () => {
  // renderHelperStatus used to stuff the active wallet address into
  // #revokeTarget on every render. The box is for checking OTHER addresses;
  // the empty field still checks the active wallet via the existing
  // `|| get('address')` fallbacks — the prefill bought nothing and hid the
  // input the user wanted to type into.
  assert.doesNotMatch(toolsSrc, /rev\.value = get\('address'\)/,
    'renderHelperStatus must not prefill #revokeTarget');
  assert.match(toolsSrc, /\$\('#revokeTarget'\)\?\.value\.trim\(\) \|\| get\('address'\)/,
    'empty field still checks the active wallet (fallback kept)');
  assert.doesNotMatch(html, /id="revokeTarget"[^>]*data-auto-fill/,
    'no auto-fill attribute may creep back onto the check-address input');
});

test('revoke: revokeDelegation is exported and wired', () => {
  assert.match(toolsSrc, /export async function revokeDelegation\(/, 'revokeDelegation must be exported');
  assert.match(toolsSrc, /btnRevokeDelegation.*addEventListener\('click', revokeDelegation\)/, 'revoke button must be bound');
  assert.match(toolsSrc, /btnCheckDelegation.*addEventListener\('click', checkDelegation\)/, 'check button must be bound');
});

test('revoke: revoke path sends a real type-4 tx to ZERO_ADDRESS', () => {
  assert.match(toolsSrc, /EIP7702\.ZERO_ADDRESS/, 'revoke must authorize to the zero address');
  assert.match(toolsSrc, /authorizeSync\(\{ chainId: net\.chainId, address: EIP7702\.ZERO_ADDRESS, nonce: authNonce \}\)/, 'must build the authorization (conditional nonce)');
  assert.match(toolsSrc, /authorizationList: \[authorization\]/, 'must send a type-4 transaction');
  assert.match(toolsSrc, /confirmText: t\('cf\.revoke'\), danger: true/,
    'revoke must still be confirmed explicitly, and marked dangerous');
  assert.equal(t('cf.revoke'), 'Revoke', 'tombol tetap "Revoke" di en');
  assert.doesNotMatch(toolsSrc, /requireType/,
    'the typed gate is gone app-wide; nothing may reintroduce it as a dead option');
  assert.match(toolsSrc, /getDelegation\(provider, target\)/, 'must check the current delegation first');
  assert.match(toolsSrc, /No active delegation on this address/, 'must refuse to revoke when nothing is delegated');
});

test('revoke: check path reads on-chain delegation', () => {
  assert.match(toolsSrc, /getDelegation\(provider, addr\)/, 'check must query the delegation');
  assert.match(toolsSrc, /t\('eip7702\.plainEoa'\)/, 'check must report plain EOA state');
  assert.match(toolsSrc, /t\('eip7702\.delegatedTo'/, 'check must report the delegated implementation');
});