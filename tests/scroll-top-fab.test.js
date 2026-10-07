// Bear Tool — tests/scroll-top-fab.test.js
//
// The scroll-to-top FAB ("fitur: scroll kebawah ada icon anak panah bulat").
// Three claims worth a gate:
//
//   1. The button exists in the STATIC shell (index.html) — the React tree
//      only owns #app-root, and a FAB inside it would vanish on view switch.
//   2. The hidden state leaves the tab order (tabindex -1 + aria-hidden) —
//      an invisible focusable button is an a11y failure, not a polish item.
//   3. Boot actually binds it, and the scroll handler is rAF-throttled —
//      an unthrottled scroll listener does one style write per event on a
//      trackpad spin, which is how "smooth" UIs start dropping frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = (p) => readFileSync(path.join(root, p), 'utf8');

test('the FAB lives in the static shell with an honest hidden state', () => {
  const html = raw('index.html');
  const m = html.match(/<button[^>]*id="scrollTopFab"[\s\S]*?<\/button>/);
  assert.ok(m, '#scrollTopFab button is in index.html (outside the React root)');
  assert.match(m[0], /aria-label="Back to top"/, 'it has a name screen readers can use');
  assert.match(m[0], /aria-hidden="true"[^>]*tabindex="-1"/,
    'starts hidden AND unfocusable — visible-only focus is the a11y contract');
  assert.match(m[0], /<svg[\s\S]*aria-hidden="true"/, 'the arrow icon is decorative, not announced');
});

test('CSS shows the FAB only after scrolling, clear of the mobile nav', () => {
  const css = raw('css/cartoon.css');
  const fab = css.slice(css.indexOf('.scroll-top-fab {'), css.indexOf('/* ═══════════ MOBILE BOTTOM NAV'));
  assert.match(fab, /position: fixed/, 'it floats over the page');
  assert.match(fab, /border-radius: 50%/, 'round, per spec ("icon anak panah bulat")');
  assert.match(fab, /\.scroll-top-fab\.show\s*{[^}]*opacity: 1[^}]*pointer-events: auto/s,
    'the .show class reveals it');
  assert.ok(!/\.scroll-top-fab\s*{[^}]*opacity: 1/s.test(fab.split('.scroll-top-fab.show')[0]),
    'base state is hidden — no FAB at scrollTop 0');
  assert.match(fab, /z-index: 900/, 'above the mobile nav (100), below the browser overlay (9000)');
  assert.match(fab, /@media \(max-width: 768px\)[\s\S]*?bottom: calc\(var\(--mobile-nav-h/,
    'on phones it clears the fixed bottom nav');
});

test('boot binds the FAB: rAF-throttled scroll, smooth scroll home', () => {
  const app = raw('js/app.js');
  assert.match(app, /try \{ initScrollTopFab\(\); \} catch/,
    'boot calls it inside the non-stranding try/catch row');
  const fn = app.slice(app.indexOf('function initScrollTopFab'), app.indexOf('function switchView'));
  assert.match(fn, /window\.scrollY > 400/, 'shows past the fold, not at 0');
  assert.match(fn, /requestAnimationFrame\(sync\)/, 'scroll handler is rAF-throttled');
  assert.match(fn, /fab\.setAttribute\('aria-hidden', show \? 'false' : 'true'\)/,
    'hidden state tracks visibility');
  assert.match(fn, /fab\.tabIndex = show \? 0 : -1/, 'focusable exactly when visible');
  assert.match(fn, /scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/, 'click = smooth scroll to top');
  assert.match(fn, /\{ passive: true \}/, 'scroll listener never blocks scrolling');
});
