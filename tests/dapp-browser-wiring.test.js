// dApp browser wiring + WalletConnect discoverability.
//
// The user's report: clicking a site's Connect button "does not connect".
// Inside the sandboxed cross-origin frame no provider can ever appear
// (dapp-browser.js header states the limit) — the one real path from this
// wallet is pairing the dApp via a `wc:` URI, and that path was buried:
// menu only, no omnibox handling, no paste helper, no hint where the Connect
// click actually happens. These tests pin the wiring (every el.* binding has
// a shell element — a missing id silently kills a handler) and the new
// discoverable routes.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const browserSrc = src('js/dapp-browser.js');
const wcSrc = src('js/walletconnect.js');

const shell = browserSrc.match(/const SHELL = `([\s\S]*?)`;/)?.[1];
assert.ok(shell, 'SHELL template must exist to audit wiring');

const shellIds = new Set([...shell.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const elRefs = [...browserSrc.matchAll(/overlay\.querySelector\('#([^']+)'\)/g)].map((m) => m[1]);

test('every el.* binding resolves to an element in the SHELL template', () => {
  assert.ok(elRefs.length >= 15, `expected the full binding block, found ${elRefs.length} refs`);
  const orphan = elRefs.filter((id) => !shellIds.has(id));
  assert.deepStrictEqual(orphan, [], `el.* refs with no matching id: ${orphan.join(', ')}`);
});

test('omnibox accepts a wc: URI and routes it to the pairing sheet', () => {
  const fnStart = browserSrc.indexOf('function navigate(rawUrl, name)');
  assert.ok(fnStart > -1, 'navigate() must exist');
  const fnBody = browserSrc.slice(fnStart, fnStart + 400);
  assert.match(
    fnBody,
    /wc:/,
    'navigate() must intercept wc: URIs BEFORE classifyInput turns them into a search'
  );
  assert.ok(
    fnBody.indexOf('wc:') < fnBody.indexOf('classifyInput'),
    'the wc: check must come before classifyInput — after it the URI is a search query'
  );
  assert.match(browserSrc, /openPairWalletConnect\(/, 'navigate routes to the pairing sheet');
});

test('pairing sheet: prefill argument + Paste-from-clipboard button', () => {
  assert.match(
    wcSrc,
    /export function openPairWalletConnect\((\s*prefill|\s*uri|\s*\w*\s*=?\s*''|\s*\w+\s*=\s*['"])/,
    'openPairWalletConnect accepts a prefilled URI'
  );
  assert.match(wcSrc, /id="wcPairPaste"/, 'the sheet exposes a Paste button');
  assert.match(wcSrc, /readText/, 'Paste reads the clipboard');
  assert.match(wcSrc, /catch/, 'a refused clipboard must fail gracefully, not throw');
});

test('browser shell carries a visible Pair (WalletConnect) hint strip', () => {
  assert.ok(shellIds.has('dbrWcHint'), 'hint strip element exists');
  assert.ok(shellIds.has('dbrWcPair'), 'Pair button exists in the strip');
  assert.ok(elRefs.includes('dbrWcHint'), 'hint strip is bound in build()');
  assert.ok(elRefs.includes('dbrWcPair'), 'Pair button is bound in build()');
  assert.match(browserSrc, /wcPair[\s\S]{0,200}addEventListener/, 'Pair button has a click handler');
  assert.match(browserSrc, /write\(LS\.wcHint, 'dismissed'\)/, 'dismissing the strip persists (localStorage, not the runtime state singleton)');
  assert.match(shell, /WalletConnect/, 'the strip says the actual mechanism');
});

test('menu keeps the WalletConnect row (regression pin)', () => {
  assert.match(browserSrc, /\['wc', '🔗 Pair via WalletConnect'/, 'menu row still present');
  assert.match(browserSrc, /data-act="wc"/, 'blocked/home fallback buttons still present');
});

test('wc: URI validation stays in front of any socket', () => {
  assert.match(wcSrc, /isValidWcUri/, 'pair() input validated before ensureKit');
  const goBlock = wcSrc.slice(wcSrc.indexOf('go.onclick'), wcSrc.indexOf('go.onclick') + 600);
  assert.ok(
    goBlock.indexOf('isValidWcUri') < goBlock.indexOf('ensureKit'),
    'validation must run before ensureKit opens the relay socket'
  );
});
