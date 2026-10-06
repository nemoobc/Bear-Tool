// Bear Tool — tests/eip7702-settings-ui.test.js
//
// The Settings screen changed shape, and the module tests next door cannot
// catch it: eip7702-support.test.js proves the probe classifies correctly,
// but says nothing about whether Settings ever CALLS it.
//
// So these are source gates — the same device dapp-chrome.test.js uses for
// ids that only appear after React renders. They read the real files and pin
// the wiring: a handler that exists but is never bound is exactly the class
// of bug that ships as "the button does nothing".
//
// History: this file used to carry the Approval Manager's wiring pins too
// (auto-scan on view open, Revoke All sequencing, per-row revoke reusing the
// shared helper). Those tests were deleted WITH the feature in M3 — the user
// ordered "fitur approvals hapus ganti fitur discord". A gate for a feature
// that no longer exists would pin nothing but its own ghosts; the removal
// itself is pinned in settings-shape.test.js (view gone, nav gone, scanner
// gone) and in ui-nav.test.js (Discord takes the slot on every surface).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// Comments are stripped from code but not from JSX/CSS: prose in those files
// is documentation to keep, while a comment in app.js mentioning a symbol must
// not count as that symbol being wired.
// Line comments before block pairs: helpers.js taught this order the hard way
// — a `/*` inside prose (src/views/*.jsx) opens a block that swallows real
// code, and an assertion then fails on code that is present.
const code = (p) => raw(p)
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const app = code('../js/app.js');
const probe = code('../js/eip7702-support.js');
const settings = raw('../src/views/settings.jsx');
const css = raw('../css/cartoon.css');

// ── Settings: the check exists, and someone actually triggers it ────────────
test('settings offers the EIP-7702 check with a results container', () => {
  assert.ok(settings.includes('id="btn7702Check"'), 'button rendered');
  assert.ok(settings.includes('id="eip7702Results"'), 'somewhere for answers to land');
  assert.match(settings, /Check all networks/, 'the button says what it does');
  assert.ok(settings.includes('Read-only'), 'the copy must promise what the probe actually does');
});

test('the button is bound, and bound to the function that exists', () => {
  assert.ok(app.includes(`on('#btn7702Check', 'click', runEip7702Check)`), 'bound once, at startup');
  assert.match(app, /async function runEip7702Check\(/, 'handler defined');
  const binding = app.indexOf(`on('#btn7702Check'`);
  const definition = app.indexOf('async function runEip7702Check(');
  assert.ok(binding > -1 && definition > -1, 'both halves present');
});

test('every network gets asked, including ones the user added', () => {
  // NETWORKS alone would silently skip custom networks — and the app lets
  // people add them, so they would be the ones most in need of an answer.
  assert.match(app, /\[\.\.\.NETWORKS, \.\.\.getCustomNetworks\(\)\]/, 'built-ins and customs');
  assert.ok(app.includes('checkAllNetworks'), 'the walker is imported and called');
  assert.ok(app.includes('import { checkAllNetworks'), 'imported from the module under test');
});

test('only an endpoint that said yes is offered as a link', () => {
  // The feature's whole promise: show WHICH RPC supports 7702. A link to an
  // endpoint that would reject the transaction hands the reader a dead end.
  assert.match(app, /\.filter\(\(x\) => x\.status === EIP7702_STATUS\.SUPPORT\)/,
    'links are filtered on SUPPORT, not printed for every endpoint');
  assert.ok(app.includes('target="_blank"'), 'link opens away from the wallet tab');
  assert.ok(app.includes('rel="noopener noreferrer"'), 'and cannot reach back into it');
  assert.ok(app.includes('escAttr('), 'URLs pass through attribute escaping, not html escaping alone');
});

test('the check button disables itself while it runs, and comes back', () => {
  assert.match(app, /btn\.disabled = true; btn\.textContent = 'Checking…'/, 'locked during');
  assert.match(app, /finally \{\s*\n\s*if \(btn\) \{ btn\.disabled = false/, 'released even on throw');
});

test('#btnClearEipResults hanya muncul kalau ≥1 jaringan benar-benar di-check', () => {
  // `scanned` dulu diisi literal `true` setelah panggilan tidak melempar, jadi
  // tombol Delete results selalu muncul — termasuk ketika nihil jaringan di-check
  // dan tidak ada output sama sekali.
  const start = app.indexOf('async function runEip7702Check(');
  const end = app.indexOf('function renderActivity(', start);
  assert.ok(start > -1 && end > start, 'runEip7702Check harus ditemukan');
  const body = app.slice(start, end);

  assert.match(body, /const results = await checkAllNetworks\(/,
    'nilai kembalian checkAllNetworks harus dibaca');
  assert.match(body, /scanned = Array\.isArray\(results\) && results\.length > 0/,
    'scanned = ada minimal SATU hasil, bukan literal true');
  assert.doesNotMatch(body, /scanned = true/,
    'flag yang selalu benar membuat reveal tidak pernah bisa menolak');
  assert.match(body, /if \(clearBtn\) clearBtn\.hidden = !scanned/,
    'reveal tetap memakai flag itu');
  assert.match(body, /catch \(e\) \{[\s\S]{0,300}clearBtn\.hidden = !scanned/,
    'jalur gagal tetap lewat finally yang memakai flag yang sama');
  // checkAllNetworks mengembalikan satu hasil per jaringan yang ditelusuri
  // (js/eip7702-support.js:175-183) — kontrak yang diandalkan di atas.
  const probe = raw('../js/eip7702-support.js');
  assert.match(probe, /export async function checkAllNetworks[\s\S]{0,300}return results;/,
    'walker must return the results, or `results.length` is meaningless');
});

test('the rendered verdicts use pills that exist in the stylesheet', () => {
  for (const cls of ['eip7702-ok', 'eip7702-no', 'eip7702-q', 'eip7702-pill', 'eip7702-rpc']) {
    assert.ok(css.includes(cls), `css carries .${cls}`);
  }
  assert.ok(app.includes('eip7702-${cls}'), 'app builds the same class names it styles');
});

// ── The probe module keeps its hard-won boundaries ──────────────────────────
test('the probe still refuses to sign, broadcast or guess', () => {
  assert.ok(probe.includes('eth_estimateGas'), 'estimate only');
  assert.ok(!probe.includes('eth_call'), 'discarded: not discriminative');
  assert.ok(!probe.includes('requestsHash'), 'discarded: false negative on Arbitrum');
  assert.match(probe, /from: '0x0000000000000000000000000000000000000000'/, 'zero address');
});
