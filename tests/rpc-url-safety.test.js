// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/rpc-url-safety.test.js
// Which RPC URL may sit in front of a signing wallet.
//
// The old rule demanded https:// unconditionally, which meant the app's own fork
// workflow — run-fork-all.sh and its anvils on localhost — could not be used
// through the UI at all. The failure was silent: "Custom RPC added" never
// appeared, nothing was stored, and the balance stayed at zero with no clue
// why. Loosening it to "anything goes" would be worse: a transaction signed in
// this wallet is broadcast in clear over plain HTTP to whatever answers.
//
// So the exemption is narrow and deliberate — loopback only.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// app.js touches the DOM at import time, so the rule is lifted out and evaluated
// on its own rather than pulling the whole module into a Node test.
const decl = src.match(/export function isSafeRpcUrl[\s\S]*?\n}/);
assert.ok(decl, 'isSafeRpcUrl must be exported');
const isSafeRpcUrl = new Function('return (' + decl[0].replace('export function', 'function') + ');')();

test('https is always allowed — that is the whole point', () => {
  assert.equal(isSafeRpcUrl('https://rpc.ankr.com/eth'), true);
  assert.equal(isSafeRpcUrl('https://cloudflare-eth.com'), true);
  assert.equal(isSafeRpcUrl('HTTPS://EXAMPLE.COM'), true, 'scheme comparison is case-insensitive');
});

test('plain http is allowed for loopback, which is the fork workflow', () => {
  assert.equal(isSafeRpcUrl('http://localhost:18545'), true);
  assert.equal(isSafeRpcUrl('http://127.0.0.1:8545'), true);
  assert.equal(isSafeRpcUrl('http://[::1]:8545'), true);
  assert.equal(isSafeRpcUrl('http://app.localhost:8545'), true, 'subdomains of localhost are still loopback');
});

test('plain http to anything remote is refused', () => {
  // A transaction is broadcast in clear to whoever answers. This is the case
  // the rule exists for, so it is asserted per host, not in aggregate.
  for (const u of [
    'http://rpc.ankr.com/eth',
    'http://evil.example.com',
    'http://192.168.1.10:8545',
    'http://10.0.0.5:8545',
    'http://localhost.evil.com',
  ]) assert.equal(isSafeRpcUrl(u), false, u);
});

test('a lookalike host cannot borrow the loopback exemption', () => {
  // "localhost.evil.com" ends with neither ".localhost" nor equals "localhost".
  assert.equal(isSafeRpcUrl('http://localhost.evil.com'), false);
  assert.equal(isSafeRpcUrl('http://notlocalhost'), false);
  assert.equal(isSafeRpcUrl('http://127.0.0.1.evil.com'), false);
});

test('a typo or a bare host is refused rather than half-accepted', () => {
  for (const u of ['htp://localhost', 'localhost:8545', 'ws://localhost:8546', '/rpc', '']) {
    assert.equal(isSafeRpcUrl(u), false, JSON.stringify(u));
  }
});

test('junk input does not throw', () => {
  for (const u of [null, undefined, 0, {}, [], 'http://', 'http://:']) {
    assert.doesNotThrow(() => isSafeRpcUrl(u), JSON.stringify(u));
  }
});

test('the save handler actually calls the rule instead of the old inline test', () => {
  // Otherwise the fix would sit in the file unused while the handler still
  // rejected every localhost URL.
  assert.match(src, /if \(!isSafeRpcUrl\(rpc\)\)/, 'the handler must use the shared rule');
  assert.ok(!/if \(!\/\^https:\\\/\\\/\/\/\.test\(rpc\)\)/.test(src), 'the old unconditional https test must be gone');
  assert.match(src, /Custom RPC added for/, 'the success path must still exist');
});
