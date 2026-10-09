// Bear Tool — tests/token-detect-modal-lifecycle.test.js
//
// Two live E2E bugs (2026-10-09) in the Add Custom Token probe:
//
// B3 — the "not an ERC-20" branch called reset() (which HIDES #tokenDetect)
// and only then wrote tdNote: the explanation landed in a hidden element, so
// the user saw "Detecting…" vanish with no answer. The catch branch already
// re-shows the box; this pins the null branch doing the same.
//
// B4 — on('networkId', …) re-ran detect() after the modal markup was gone.
// closeModal() only toggles classes; openModal() overwrites innerHTML, so any
// later modal detached the form while the listener kept its closure alive →
// getElementById('tdSymbol') === null → unhandled-rejection TypeError on EVERY
// network switch (observed: 2 switches → 2 crashes in console). The listener
// must be named, unsubscribe via off(), and detect() must guard on
// box.isConnected before touching any element.
//
// Source gates, same device as eip7702-settings-ui.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const app = code('../js/app.js');
const state = code('../js/state.js');

test('B3: "not a token" branch re-shows #tokenDetect with its note', () => {
  const branch = app.match(/if \(sym == null && nm == null\)\s*\{[\s\S]{0,600}?\}/);
  assert.ok(branch, 'the sym==null&&nm==null branch must exist');
  const body = branch[0];
  assert.match(body, /tokenDetect'\)\.style\.display = ''/,
    'reset() hides the box — the branch must re-show it so the note is visible');
  assert.match(body, /No ERC-20 name\/symbol found/,
    'the user-facing explanation must stay in this branch');
  // Order: the re-show must come BEFORE the note is written, or the note is
  // written into an element that display:none is about to (re)apply.
  const showIdx = body.indexOf("tokenDetect').style.display = ''");
  const noteIdx = body.indexOf('No ERC-20 name/symbol found');
  assert.ok(showIdx !== -1 && noteIdx > showIdx,
    'box must be visible before the note is assigned');
});

test('B3: stale "Detecting…" row is cleared in the null branch', () => {
  const branch = app.match(/if \(sym == null && nm == null\)\s*\{[\s\S]{0,600}?\}/);
  assert.match(branch[0], /tdSymbol'\)\.textContent = '—'/,
    'a visible box must not keep the stale "Detecting…" placeholder');
});

test('B4: networkId listener is named so it can be unsubscribed', () => {
  assert.match(app, /const onNetworkChange = \(\) =>/,
    'the handler must be a named reference, not an inline arrow');
  assert.match(app, /on\('networkId', onNetworkChange\)/);
  assert.ok(!/on\('networkId',\s*\(\)\s*=>/.test(app),
    'an inline on(\'networkId\') arrow can never be off()-ed — no new ones');
});

test('B4: detect() guards on box.isConnected and self-unsubscribes', () => {
  const detect = app.match(/const detect = async \(\) => \{[\s\S]{0,700}?const addr/);
  assert.ok(detect, 'detect() must exist');
  const head = detect[0];
  assert.match(head, /if \(!box\.isConnected\)/,
    'guard must run before any getElementById — the markup may be gone');
  assert.match(head, /off\('networkId', onNetworkChange\)/,
    'the stale listener must remove itself the first time it sees the form gone');
});

test('B4: off() is imported from state.js', () => {
  assert.match(app, /import \{[^}]*\bon\b[^}]*\boff\b[^}]*\} from '\.\/state\.js'/s,
    'unsubscribe needs the off export');
  assert.match(state, /export function off\(/,
    'state.js must export off()');
});
