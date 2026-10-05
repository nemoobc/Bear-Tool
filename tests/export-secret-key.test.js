// Bear Tool — export-secret-key.test.js
//
// LIVE REQUEST (user, 2026-10-03): "di export wallet tambahin nampilin
// private key" — the export modal showed only the decrypted secret (the seed
// phrase), and a phrase never says which account's key it is for. The modal
// now shows the ACTIVE account's private key beside it, derived with the same
// signerFromSecret() the app signs with — and only when the derived key really
// belongs to the active account (a silently wrong key is worse than none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('export modal shows the active account private key with its own copy button', () => {
  assert.match(app, /signerFromSecret\(secret,\s*idx\)/,
    'derive the active account key the way the signer does');
  assert.match(app, /data-copy="\$\{escapeHtml\(pk\)\}">[\s\S]{0,400}Copy private key/,
    'private key gets a dedicated copy button (SVG icon, no emoji)');
  assert.match(app, /data-copy="\$\{escapeHtml\(pk\)\}"/,
    'the copy button carries the key itself via the global copy handler');
});

test('seed phrase stays, private-key-only wallets are not duplicated', () => {
  assert.match(app, /data-copy="\$\{escapeHtml\(mnemonic\)\}">[\s\S]{0,400}Copy seed phrase/,
    'the phrase is still exported (SVG icon, no emoji)');
  assert.match(app, /isPkOnly/,
    'a wallet imported via private key must not render two identical cards');
});

test('a key that does not match the active account is not shown', () => {
  assert.match(app, /w\.address\.toLowerCase\(\) === String\(want\)\.toLowerCase\(\)/,
    'address-match guard before any key reaches the screen');
  assert.match(app, /Private key could not be derived/,
    'the modal says so when the guard refuses');
});
