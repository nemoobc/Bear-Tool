// Bear Tool — dex-css-coverage.test.js
//
// A whole layer of the Dex trade page shipped with NO CSS: .dex-mkt (the
// market header its own comment calls "sticky"), .dex-orderbox/.dex-order
// (the buy & sell tickets), .dex-actionbar (the sticky bottom buy/sell bar
// the comment promises will stay "under the thumb"), .btn-sell, the welcome
// banner, the token-card address + chevron, and the trade stat label/value
// pairs. They were written as class="…" hooks with no rule anywhere in css/,
// so all of it rendered as plain stacked blocks with an unstyled Sell button.
//
// Nothing caught it because every other Dex test reads BEHAVIOUR or ids, and a
// class with no rule simply renders unstyled instead of throwing. So this test
// closes the gap the way it actually bit: scan the Dex markup for the classes
// it owns, and require each one to resolve to a CSS rule. A new surface that
// forgets its stylesheet fails here instead of shipping naked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const css = ['css/dex.css', 'css/cartoon.css', 'css/exchange.css']
  .map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8'))
  .join('\n');

/** Does some rule's selector mention `cls` as a whole class token? */
const hasRule = (cls) => {
  const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\.' + esc + '(?![A-Za-z0-9_-])').test(css);
};

/** Every class="…" literal in a file (skips template/interpolated tokens). */
function classesIn(file) {
  const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    for (const raw of m[1].split(/\s+/)) {
      if (!raw) continue;
      // Interpolated fragments (`${…}`) are built elsewhere and not checkable here.
      if (raw.includes('$') || raw.includes('{') || raw.includes('=')) continue;
      out.add(raw);
    }
  }
  return [...out];
}

// The Dex surfaces that were missing styles, plus the deploy preview that
// sits beside them. Scoped to the dex-/deploy-preview namespaces so an
// unrelated shared utility (btn, small, mt-8) is never this test's business.
const OWNS = (c) => c.startsWith('dex-') || c.startsWith('deploy-preview') || c === 'btn-sell';

const sources = [
  ...readdirSync(new URL('../js/dex', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'js/dex/' + f),
  'js/deploy.js',
];

test('every Dex markup class resolves to a CSS rule', () => {
  const missing = [];
  for (const file of sources) {
    for (const cls of classesIn(file)) {
      if (OWNS(cls) && !hasRule(cls)) missing.push(`${file}: .${cls}`);
    }
  }
  assert.deepEqual(missing, [],
    'these classes are rendered in Dex markup but styled nowhere:\n' + missing.join('\n'));
});

test('the trade page\'s previously-unstyled layer is still styled', () => {
  // Pin the specific hooks that shipped naked — if any loses its rule, the
  // page goes plain again and only a screenshot would notice.
  for (const cls of [
    'dex-mkt', 'dex-orderbox', 'dex-order', 'dex-order-buy', 'dex-order-sell',
    'dex-order-head', 'dex-order-side', 'dex-actionbar', 'btn-sell',
    'dex-welcome', 'dex-welcome-in', 'dex-welcome-title', 'dex-welcome-logo', 'dex-welcome-sub',
    'dex-launchbar-txt', 'dex-launchbar-sub',
    'dex-card-id', 'dex-card-addr', 'dex-card-go',
    'dex-stat-lb', 'dex-stat-v', 'dex-block-head', 'dex-mkt-desc',
  ]) {
    assert.ok(hasRule(cls), `.${cls} must have a CSS rule — it rendered unstyled before`);
  }
});
