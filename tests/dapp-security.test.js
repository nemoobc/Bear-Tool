// Security gates for the DApps surface.
//
// Every test here corresponds to a finding that shipped. The point of writing
// them down is that the NEXT blind-signing bug, or the next wedged request
// queue, is caught by a gate rather than by a reader with time to look.
//
// The shared failure mode across all of them: the wallet approved something the
// user was not shown, or could not recover from. Both are trust failures, and
// both are invisible in a test that only checks "does it return a value".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('js/app.js');
const exec = read('js/dapp-exec.js');
const native = read('js/native-dapp.js');
const wc = read('js/walletconnect.js');
const ui = read('js/ui.js');

// ── 1. blind signing ────────────────────────────────────────────────
// personal_sign accepts both [message, address] and the legacy
// [address, message]. The signer swapped them; the approval sheet read
// params[0] regardless — so a dApp using the legacy order got a dialog whose
// Message row was the user's own ADDRESS, and then signed a different string.
test('the approval sheet describes the payload the signer will sign', () => {
  assert.match(app, /splitSignParams\(params\)/,
    'the sheet must split the params with the same function the signer uses, '
    + 'or it describes a different payload from the one that gets signed');
  // The typed-data path legitimately reads params[1] ?? params[0] (v4 sends
  // [address, json]), so a blanket "no params[0]" ban would forbid the correct
  // thing. What must not come back is personal_sign reading params[0] raw.
  const signBranch = app.slice(app.indexOf("if (method === 'personal_sign')"));
  assert.match(signBranch.slice(0, 200), /splitSignParams/,
    'personal_sign must take its message from the split, not from a raw index');
});

test('a sign payload is shown as text, not as a byte array', () => {
  // String(hexToBytes(hex)) renders "104,101,108,108,111" — a user approving
  // that has no idea they are approving "hello".
  const renderer = read('js/sign-render.js');
  assert.match(renderer, /TextDecoder/, 'hex that decodes as text must be decoded and shown as text');
  assert.match(renderer, /binary/i, 'anything else must be labelled binary, not presented as numbers');
  assert.ok(!/String\(hexToBytes\(/.test(native),
    'the native sheet must not render a sign payload via String(bytes)');
  assert.ok(!/String\(hexToBytes\(/.test(wc),
    'nor may the WalletConnect sheet');
});

// ── 2. invisible characters ─────────────────────────────────────────
// U+202E renders text in a different order from its bytes, so a message can
// display as one thing and be signed as another — at the exact moment of
// approval. One sheet had the guard; the other two did not.
test('every approval sheet strips bidirectional and invisible characters', () => {
  const renderer = read('js/sign-render.js');
  assert.match(renderer, /\\u202a-\\u202e/, 'bidi overrides must be stripped');
  assert.match(renderer, /\\u200b-\\u200f/, 'zero-width characters must be stripped');
  // One implementation, three call sites: two copies drifted and the drift was
  // the vulnerability.
  assert.equal((renderer.match(/function stripInvisible/g) || []).length, 1,
    'there must be exactly ONE stripInvisible implementation');
  for (const [name, src] of [['native-dapp.js', native], ['walletconnect.js', wc]]) {
    assert.ok(!/function stripInvisible\s*\(/.test(src),
      `${name} must use the shared stripInvisible, not its own copy`);
  }
  assert.match(native, /renderSignMessage/, 'the native sheet must use the shared renderer');
  assert.match(wc, /hexToPreview = renderSignMessage/, 'WalletConnect must delegate too');
});

// ── 3. native signing required a connection it never checked ────────
// connectedOrigins was written by eth_accounts and read by nothing. Every
// signing and spending path prompted unconditionally, so any page in the
// WebView could obtain a signature without ever having been connected —
// contradicting the file's own header.
test('every native signing and spending path requires a prior connection', () => {
  // The gate must be a NEGATIVE conditional that REFUSES, not any use of the
  // set. The first version of this test searched for the string anywhere and
  // compared indexes, so neutering the gate to `if (false) {` still passed — the
  // search then found the unrelated read in eth_accounts and called it a day.
  // What is asserted here is the shape of one whole refusal.
  const gateRe = /if \(!connectedOrigins\.has\(site\)\) \{[\s\S]{0,400}?respondError\(\{[^}]*code:\s*4100/;
  const m = native.match(gateRe);
  assert.ok(m, 'there must be a refusal: if (!connectedOrigins.has(site)) { ... respondError({ code: 4100 ... })');

  const gate = m.index;
  // Compared against the FIRST PROMPT AFTER THE GATE, not the first prompt in
  // the file: eth_accounts prompts BEFORE it on purpose — that prompt is the
  // thing that adds the site to connectedOrigins in the first place.
  const firstPrompt = native.indexOf('await askConfirm({', gate);
  assert.ok(firstPrompt > gate,
    'every prompt after the gate must come later than the gate itself');

  // …and each of the three dangerous methods must be handled past that gate.
  const after = native.slice(gate);
  for (const meth of ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']) {
    assert.ok(after.indexOf(`method === '${meth}'`) > -1,
      `${meth} must be handled after the connection gate`);
  }
});

// ── 4. one failed WalletConnect request wedged the whole session ─────
// The engine's request queue clears only inside respond() or on expiry (days).
// handleRequest had three awaits that throw in ordinary use and none were
// caught at the emit site, so insufficient funds was enough to kill every
// later request from every paired dApp — silently, until an app restart.
test('every WalletConnect session request ends in a response, even on failure', () => {
  const handler = wc.slice(wc.indexOf("w.on('session_request'"));
  const block = handler.slice(0, handler.indexOf('});'));
  assert.match(block, /\.catch\(/, 'the emit site must catch');
  assert.match(block, /respondError\(/,
    'and must RESPOND with an error — a toast alone leaves the queue active');
  assert.match(block, /-32603|code:/, 'with a JSON-RPC error code the dApp can read');
});

// ── 5. two dialogs at once destroyed one of them ────────────────────
// confirmTx awaits a gas estimate before painting, so two requests always
// interleave; the second sheet's innerHTML detached the first sheet's buttons
// and overwrote the single onClose slot, leaving the first promise unable to
// ever settle. Promise.all([sign(x), sign(y)]) is ordinary dApp code.
test('confirmation sheets are queued, never painted on top of each other', () => {
  assert.match(ui, /modalQueue/, 'there must be a queue');
  assert.match(ui, /drainModalQueue/, 'and something that drains it');
  // The release must be in closeModal, not in the button handler: a sheet
  // closed by ✕, the backdrop or Escape would otherwise hold the queue for
  // ever and every later confirm would wait on a flag that never cleared.
  const close = ui.slice(ui.indexOf('export function closeModal()'));
  const closeBody = close.slice(0, close.indexOf('\n}'));
  assert.match(closeBody, /modalBusy = false/,
    'closeModal must release the queue — it is the only path every exit shares');
});

// ── 6. a page could make the description throw ──────────────────────
// describeSignCall ran on entirely page-supplied data with no try/catch around
// it, and sat in the argument list of the confirmTx call: a cyclic object or a
// non-numeric `value` killed the request with no prompt shown at all.
test('describing a request cannot throw on page-supplied data', () => {
  const fn = app.slice(app.indexOf('function describeSignCall'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /catch/, 'the whole body must be guarded');
  assert.ok(!/JSON\.stringify\(p\)/.test(body) || /safeJson/.test(body),
    'stringifying page data must go through a guarded helper');
  assert.match(app, /safeJson,? ?\}? from '\.\/sign-render\.js'|safeJson[^\n]*from '\.\/sign-render\.js'/,
    'the guarded JSON helper must be the shared one, not a private copy that can rot');
  assert.match(read('js/sign-render.js'), /export function safeJson/,
    'and it must actually be exported');
});

// ── 7. wrong-typed storage bricked the browser ──────────────────────
test('stored values are shape-checked before they reach a caller', () => {
  const br = read('js/dapp-browser.js');
  assert.match(br, /Array\.isArray\(v\) \? v : fb/,
    'a non-array where an array is expected must fall back, not pass through');
  assert.match(br, /Array\.isArray\(fb\)/,
    'the check has to be driven by what the caller expects');
});

// ── 8. the focus hook stacked ───────────────────────────────────────
test('the WalletConnect focus listener is registered once, for the app', () => {
  const adds = (wc.match(/window\.addEventListener\('focus'/g) || []).length;
  assert.equal(adds, 1, 'one registration; N opens used to stack N listeners and re-pair the same URI N times');
  assert.match(wc, /__bearWcFocusHook/, 'the single hook must point at the currently-open sheet');
  assert.ok(!/removeEventListener\('focus', onWcReturn\)/.test(wc),
    'the old self-removing handler is what let them accumulate');
});

// ── 9. the Security Center stated things the code contradicted ──────
// A page that says "a one-time grant is standing authorisation" when the code
// deliberately asks every single time is worse than saying nothing: people
// over-trust a page, or stop using the wallet.
test('the Security Center makes no claim the code contradicts', () => {
  const sec = read('js/security-center.js');
  const home = read('js/dapp-browser.js');

  assert.ok(!/after that grant it can call them without asking you again/.test(sec),
    'every sign and send is confirmed per call — do not tell users otherwise');
  assert.ok(!/<strong>Not possible\.<\/strong>/.test(sec),
    'the native build DOES inject the provider into a dApp WebView');
  assert.match(sec, /clipboard-write/,
    'the iframe is granted clipboard-write, so say so');
  assert.match(home, /clipboard-write/,
    'and the home screen must not contradict it either');
  assert.match(br_has_iface(home), /clipboard-write/, 'the frame really is granted it');
});

function br_has_iface(home) { return home; }

// ── 10. the shared renderer must stay shared ────────────────────────
test('every sheet that shows a signed message imports the shared renderer', () => {
  for (const [name, src] of [['app.js', app], ['native-dapp.js', native], ['walletconnect.js', wc]]) {
    assert.match(src, /from '\.\/sign-render\.js'/, `${name} must import the shared renderer`);
  }
  assert.ok(!/function renderSignMessage/.test(app),
    'app.js must not keep a private copy');
  assert.ok(!/function renderSignMessage/.test(native),
    'native-dapp.js must not keep a private copy');
});