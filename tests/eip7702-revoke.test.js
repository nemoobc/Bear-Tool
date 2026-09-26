// Bear Tool — eip7702-revoke.test.js
// Revoke EIP-7702 delegation from the Tools card: static guards that the
// revoke path is real (authorize to ZERO_ADDRESS + type-4 tx), the UI
// elements exist, and the flow is wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const toolsSrc = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('revoke: Tools card has check + revoke controls in HTML', () => {
  for (const id of ['revokeTarget', 'revokeKey', 'btnCheckDelegation', 'btnRevokeDelegation', 'revokeStatus', 'revokeStatusText']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must exist in index.html`);
  }
});

test('revoke: revokeDelegation is exported and wired', () => {
  assert.match(toolsSrc, /export async function revokeDelegation\(/, 'revokeDelegation must be exported');
  assert.match(toolsSrc, /btnRevokeDelegation.*addEventListener\('click', revokeDelegation\)/, 'revoke button must be bound');
  assert.match(toolsSrc, /btnCheckDelegation.*addEventListener\('click', checkDelegation\)/, 'check button must be bound');
});

test('revoke: revoke path sends a real type-4 tx to ZERO_ADDRESS', () => {
  assert.match(toolsSrc, /EIP7702\.ZERO_ADDRESS/, 'revoke must authorize to the zero address');
  assert.match(toolsSrc, /authorizeSync\(\{ chainId: net\.chainId, address: EIP7702\.ZERO_ADDRESS, nonce \}\)/, 'must build the authorization');
  assert.match(toolsSrc, /authorizationList: \[authorization\]/, 'must send a type-4 transaction');
  assert.match(toolsSrc, /confirmText: 'Revoke', danger: true/,
    'revoke must still be confirmed explicitly, and marked dangerous');
  assert.doesNotMatch(toolsSrc, /requireType/,
    'the typed gate is gone app-wide; nothing may reintroduce it as a dead option');
  assert.match(toolsSrc, /getDelegation\(provider, target\)/, 'must check the current delegation first');
  assert.match(toolsSrc, /No active delegation on this address/, 'must refuse to revoke when nothing is delegated');
});

test('revoke: check path reads on-chain delegation', () => {
  assert.match(toolsSrc, /getDelegation\(provider, addr\)/, 'check must query the delegation');
  assert.match(toolsSrc, /Plain EOA \(no delegation\)/, 'check must report plain EOA state');
  assert.match(toolsSrc, /Delegated to/, 'check must report the delegated implementation');
});