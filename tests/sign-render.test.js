// sign-render.js — the PREVIEW must match the SIGNED payload byte for byte.
//
// S1 (2026-10-16): an odd-length "0x…" string used to be previewed as
// "(binary, 1.5 bytes)" here, while the WalletConnect / native converters
// FLOORED the last nibble off (signing different bytes) and the shared
// signPayload (dapp-exec.js) treats it as literal text (what MetaMask does).
// Three behaviours for one payload. Now there is one: not-even-length hex is
// not hex, it is the literal string, and the sheet shows that string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSignMessage } from '../js/sign-render.js';

test('renderSignMessage: even-length hex that decodes as text is shown AS TEXT', () => {
  assert.equal(renderSignMessage('0x68656c6c6f'), 'hello');
});

test('renderSignMessage: even-length hex that is not text is labelled binary', () => {
  assert.equal(renderSignMessage('0xdeadbeef'), '(binary, 4 bytes)');
});

test('renderSignMessage: odd-length hex is the LITERAL string the signer signs', () => {
  assert.equal(renderSignMessage('0xabc'), '0xabc',
    'no such thing as half a byte — signPayload signs the literal string, so the sheet shows it');
  assert.equal(renderSignMessage('0x'), '0x',
    'fewer than one byte is not a byte string either');
});

test('renderSignMessage: non-hex strings pass through (invisibles stripped)', () => {
  assert.equal(renderSignMessage('login to site'), 'login to site');
  assert.equal(renderSignMessage('a\u202eb'), 'ab', 'bidi overrides are stripped, never rendered');
});
