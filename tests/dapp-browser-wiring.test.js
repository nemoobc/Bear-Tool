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

test('navigate refuses only the transmitted part — a fragment callback still loads', () => {
  const fnStart = browserSrc.indexOf('function navigate(rawUrl, name)');
  assert.ok(fnStart > -1, 'navigate() must exist');
  const fnBody = browserSrc.slice(fnStart, fnStart + 3200);
  assert.match(fnBody, /isSecretishUrl\(transmittedPart\(url\)\)/,
    'the secret gate must run on what the request actually carries — browsers never send "#", ' +
    'so an #id_token=… OAuth callback loads while ?password=… is refused');
  assert.ok(!/const sec = isSecretishUrl\(url\);/.test(fnBody),
    'scanning the whole URL here blocked every fragment-based login callback');
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

test('Core.init is awaited — core ≥2.25 types it Promise<Core>', () => {
  // User report 2026-10-08 "gabisa connect wallet": storing the un-awaited
  // Promise as `core` leaves core.logger undefined, so WalletKit.init dies
  // at this.logger.trace("Initialized") and every pairing ends with
  // "Cannot read properties of undefined (reading 'trace')".
  assert.match(wcSrc, /await Core\.init\(/, 'Core.init() must be awaited');
  assert.doesNotMatch(
    wcSrc,
    /const core = Core\.init\(/,
    'the Promise itself must never be handed to WalletKit'
  );
});

test('announceAccountsChanged wakes a sleeping kit instead of staying mute', () => {
  // After a page reload the sessions survive in storage but kit is null
  // until something pairs — a switch in that window used to announce to
  // nobody. The function must kick ensureKit() and re-run once.
  const i = wcSrc.indexOf('export function announceAccountsChanged');
  assert.ok(i > -1, 'announceAccountsChanged exists');
  const block = wcSrc.slice(i, i + 900);
  assert.match(block, /if \(!kit\)/, 'sleeping kit is detected');
  assert.match(block, /ensureKit\(\)/, 'sleeping kit is woken');
  assert.doesNotMatch(block, /if \(!kit \|\|[^)]*\) return;/, 'and never just returns mute');
});

test('WC session events use the wire field `name`, never `type`', () => {
  // Live proof 2026-10-08: emit() with event:{type:...} is rejected by
  // sign-client ("Missing or invalid. emit() event") — the validator reads
  // event.name — so connected dApps never heard a switch. Pinned for both
  // emitters.
  assert.match(wcSrc, /event: \{ name: 'accountsChanged'/, 'accountsChanged keyed by name');
  assert.match(wcSrc, /event: \{ name: 'chainChanged'/, 'chainChanged keyed by name');
  assert.doesNotMatch(wcSrc, /event: \{ type:/, 'no event:{type:} shape left anywhere');
});

test('a re-pair replaces the dApp\'s stale sessions instead of stacking ghosts', () => {
  // Live count 2026-10-08: three sessions for one dApp after two reloads —
  // each lingered 7 days, cluttered the session sheet and sent switch
  // announcements to topics nobody hears. Stale topics are collected BEFORE
  // approve (killing the just-approved session would be worse) and
  // disconnected after it.
  const i = wcSrc.indexOf('async function handleProposal');
  assert.ok(i > -1, 'handleProposal exists');
  const block = wcSrc.slice(i, i + 3000);
  const collect = block.indexOf('getActiveSessions');
  const approve = block.indexOf('approveSession({');
  const drop = block.indexOf('disconnectSession');
  assert.ok(collect > -1, 'prior sessions are collected');
  assert.ok(approve > -1, 'session is approved');
  assert.ok(drop > -1, 'stale sessions are disconnected');
  assert.ok(collect < approve, 'collected BEFORE approve — otherwise the fresh session dies too');
  assert.ok(drop > approve, 'disconnected AFTER approve');
});

test('announce keeps session accounts in step with the active account', () => {
  // The event moves the dApp's UI; without updateSession, eth_accounts keeps
  // answering approve-time addresses — a dApp re-reading its session snaps
  // back to a wallet the user already left.
  const i = wcSrc.indexOf('export function announceAccountsChanged');
  assert.ok(i > -1, 'announceAccountsChanged exists');
  const block = wcSrc.slice(i, i + 3400);
  assert.match(block, /updateSession\(/, 'session namespaces are rewritten with the active address');
  assert.match(block, /session accounts not updated/, 'a failed sync is logged, never silent');
});
