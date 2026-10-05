// Bear Tool — item 12: locked wallet → actions that NEED the key raise the
// unlock password prompt automatically (no "press the bear first" step and no
// dead "wallet locked" error the user cannot act on from that screen).
//
// Three entry points sign with the ACTIVE wallet's key and therefore must
// route through requireUnlock() when locked:
//   1. revokeDelegation()   — target IS the active wallet and no key was pasted
//                             (get('signer') is null while locked → the old
//                             code crashed on .connect(provider)).
//   2. opensea cancel/fulfill — threw 'OpenSea: wallet locked' instead of
//                             offering the password prompt.
//   3. walletconnect handleRequest — answered 5100 to the dApp but never
//                             showed the local prompt, so the user was stuck.
// Pasted-key paths (foreign target / sponsor key) still work while locked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');

function fnBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} must exist`);
  // top-level function: next "\nexport " or "\nasync function" after it
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return next === -1 ? rest : src.slice(start, start + 1 + next);
}

test('item 12: revokeDelegation prompts unlock when target = active wallet, locked, no key', () => {
  const tools = read('js/eip7702-tools.js');
  const body = fnBody(tools, 'revokeDelegation');
  const isSelfIdx = body.indexOf('isSelf');
  const guardIdx = body.search(/isSelf && !get\('unlocked'\) && !addressFromKey\(key\)\) \{ requireUnlock\(\)/);
  const signerIdx = body.indexOf("get('signer').connect(provider)");
  assert.ok(isSelfIdx > -1, 'target = active wallet is computed once');
  assert.ok(guardIdx > -1, 'locked + self + no pasted key → requireUnlock() (password prompt)');
  assert.ok(signerIdx > -1, 'the signer path still exists for unlocked wallets');
  assert.ok(guardIdx < signerIdx, 'the prompt fires BEFORE get("signer").connect(null) would crash');
  // a pasted key must still be able to sign while locked
  assert.match(body, /else \{\s*\n\s*targetSigner = new ethers\.Wallet\(key, provider\);/,
    'foreign target with pasted key keeps working while locked');
});

test('item 12: OpenSea cancel/fulfill raise the unlock prompt instead of a dead error', () => {
  const os = read('js/opensea.js');
  assert.match(os, /import \{ get, requireUnlock \} from '\.\/state\.js';/,
    'opensea.js imports requireUnlock');
  for (const fn of ['cancelOrder', 'fulfillBasicOrder']) {
    const body = fnBody(os, fn);
    const guardIdx = body.indexOf("if (!get('unlocked')) { requireUnlock(); return; }");
    assert.ok(guardIdx > -1, `${fn}: locked → password prompt`);
    const throwIdx = body.indexOf("throw new Error('OpenSea: wallet locked')");
    assert.ok(throwIdx === -1 || guardIdx < throwIdx,
      `${fn}: prompt comes before the residual locked error`);
  }
});

test('item 12: walletConnect request shows the local prompt AND answers the dApp', () => {
  const wc = read('js/walletconnect.js');
  assert.match(wc, /import \{[^}]*\brequireUnlock\b[^}]*\} from '\.\/state\.js';/,
    'walletconnect.js imports requireUnlock');
  const start = wc.indexOf('async function handleRequest(');
  assert.ok(start > -1, 'handleRequest exists');
  const body = wc.slice(start, start + 600);
  assert.match(body, /if \(!signer\) \{\s*\n\s*\/\/ Item 12[\s\S]{0,200}requireUnlock\(\);/,
    'locked → local password prompt first');
  assert.match(body, /code: 5100/, 'the dApp still gets the locked error (it retries)');
  const unlockIdx = body.indexOf('requireUnlock()');
  const errIdx = body.indexOf('5100');
  assert.ok(unlockIdx > -1 && errIdx > -1 && unlockIdx < errIdx,
    'prompt fires before the dApp error response');
});

test('item 12: every signing entry point in js/ either guards unlock or takes a pasted key', () => {
  // Audit: functions that reach get('signer') unconditionally must have a
  // requireUnlock guard somewhere before it, or an explicit null check.
  const files = ['app.js', 'bridge.js', 'deploy.js', 'eip7702-tools.js', 'opensea.js',
    'send.js', 'swap.js', 'walletconnect.js'];
  for (const f of files) {
    const src = read(`js/${f}`);
    const usesSigner = /get\('signer'\)\s*\.\s*connect|get\('signer'\);\s*\n\s*if \(!signer\)/.test(src);
    if (!usesSigner) continue;
    assert.ok(src.includes('requireUnlock()'),
      `${f}: signs with the active wallet → must route through requireUnlock()`);
  }
});
