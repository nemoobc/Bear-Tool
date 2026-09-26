// The splash is a full-screen fixed overlay at z-index 9999. It is the first
// thing on screen and the last thing dismissed, which makes it the single most
// dangerous element in the app: if anything throws before its dismissal is armed,
// the overlay stays and swallows every click in the wallet.
//
// That is not hypothetical. One null.addEventListener — a Settings button that
// had been deleted from the markup while its listener stayed — threw inside
// bindViews(), which runs during module evaluation. That aborted the whole of
// app.js: no provider, no navigation, no bindings, and the splash sat on top
// eating every click while the DOM underneath looked perfectly alive. The user
// reported it as "the website is stuck", and it was.
//
// Three layers guard it, and this file is what stops any of them being removed
// by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../js/theme.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the splash overlay really is a full-screen click trap, which is why it matters', () => {
  assert.match(html, /id="intro"/, 'the splash must exist');
  // Not a wish, a measurement: these are the properties that made the failure
  // total. If any of them changes, this test should be looked at.
  const rules = [...css.matchAll(/#intro\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const fixed = rules.find((b) => /position:\s*fixed/.test(b));
  assert.ok(fixed, 'the splash must be fixed to cover the viewport');
  assert.match(css, /#intro\s*\{[^}]*z-index:\s*9999/, 'and above everything');
});

test('dismissal is armed before anything that can throw', () => {
  // The CALL, not the import. `armIntroDismissal` appears in the import line
  // first, and measuring from there reported the ordering as broken when it was
  // correct — which is how a test teaches you to distrust it.
  const call = /try \{ armIntroDismissal\(\); \}/.exec(app);
  assert.ok(call, 'app.js must arm the dismissal explicitly');
  const at = call.index;
  const bindNav = app.indexOf('try { bindNav(); }');
  const bindViews = app.indexOf('try { bindViews(); }');
  assert.ok(bindNav > -1 && bindViews > -1, 'the guarded bind calls must still be there');
  assert.ok(at < bindNav && at < bindViews,
    'the dismissal has to be armed FIRST — when it came after the binds, one throw in a bind left the splash up forever with nothing on screen saying why');
});

test('a throwing bind cannot take the app down with it', () => {
  // Optional chaining on the listener registration, and a try/catch around each
  // bind. Both matter: the first stops the throw, the second means a bind that
  // fails for any other reason still leaves the rest of the app alive.
  assert.match(app, /try \{ bindNav\(\); \} catch/,
    'each bind must be guarded — one broken view should not brick the wallet');
  assert.match(app, /try \{ bindViews\(\); \} catch/);
  assert.match(app, /const on = \(sel, ev, fn\) => \$\(sel\)\?\.addEventListener\(ev, fn\)/,
    'and the registrations inside a bind must tolerate a missing element');
});

test('no unguarded listener registration is left in the bind path', () => {
  // The specific shape that caused this: $('#x').addEventListener(...) with no
  // guard, on an element that some edit could remove.
  const bind = app.slice(app.indexOf('function bindViews()'));
  const unguarded = [...bind.matchAll(/^\s*\$\('#([\w-]+)'\)\.addEventListener/gm)].map((m) => m[1]);
  assert.deepEqual(unguarded, [],
    `these will throw on a missing element and abort module evaluation: ${unguarded.join(', ')}`);
});

test('the CSS backstop frees the screen even with no JavaScript at all', () => {
  // The last layer. If theme.js never loads — a syntax error, a blocked module,
  // a 404 — the splash still goes away on its own, because this is CSS.
  assert.match(css, /@keyframes intro-force-hide/, 'there must be a CSS-only dismissal');
  assert.match(css, /#intro\s*\{[^}]*animation:[^}]*intro-force-hide/,
    'and it must be applied to the splash itself');
  assert.match(css, /intro-force-hide[^}]*forwards|forwards[^}]*intro-force-hide/,
    'with forwards — without it the overlay snaps back when the animation ends');
  assert.match(css, /#intro\.hidden, #intro\.intro-fade \{ animation: none; \}/,
    'and it must stand down when the script has already hidden it, so the two do not fight');
});

test('reduced motion still gets the splash out of the way immediately', () => {
  assert.match(theme, /prefers-reduced-motion/, 'reduced motion must skip the animation');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}#intro/,
    'and the CSS backstop must shorten too, not just the script');
});

test('the dismissal function is reusable and idempotent', () => {
  assert.match(theme, /export function armIntroDismissal/, 'it must be exported so boot can arm it early');
  assert.match(theme, /dismissArmed/, 'arming twice must not double-register handlers');
  assert.match(theme, /let finished = false;/, 'and finish() must be safe to call repeatedly');
});
