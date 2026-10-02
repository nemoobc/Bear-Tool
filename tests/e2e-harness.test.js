// Bear Tool — tests/e2e-harness.test.js
//
// The suite runs in two places: against a localhost server, and against the
// deployed site (BEAR_BASE_URL pointing at github.io/Bear-Tool/). Those two
// disagree about one small thing — what a leading slash means.
//
//   new URL('/',  'http://localhost:8080')                  → http://localhost:8080/
//   new URL('/',  'https://nemoobc.github.io/Bear-Tool/')   → https://nemoobc.github.io/      ← 404
//   new URL('./', 'https://nemoobc.github.io/Bear-Tool/')   → https://nemoobc.github.io/Bear-Tool/
//
// So the deployed run once landed on "There isn't a GitHub Pages site here",
// and every spec failed on a missing wallet-creation button that had nothing
// to do with the app. The failure was indistinguishable from a broken build —
// which is the whole reason it is pinned here: the harness deciding where the
// app lives is a decision, and an unpinned decision regresses silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helpers = readFileSync(new URL('../tests/e2e/helpers.js', import.meta.url), 'utf8');
// Order matters, and getting it wrong once already made this test lie.
// helpers.js line 8 mentions `src/views/*.jsx` inside a line comment — strip
// the /* */ pairs FIRST and that stray slash-star opens a block comment that
// swallows the next 340 lines, goto() included, and the assertion fails on
// code that is sitting right there. Line comments go first, so that one is
// gone before any block-comment pairing happens.
const code = helpers
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the harness navigates relative to the base URL, never to the origin', () => {
  assert.ok(!code.includes(`page.goto('/')`), "goto('/') resolves against the origin and drops /Bear-Tool/");
  assert.ok(code.includes(`page.goto('./'`), "goto('./') keeps the deployed path");
});

test("resolving './' lands on the app in both places the suite runs", () => {
  // The actual arithmetic, asserted rather than assumed — if a future base URL
  // arrives with no trailing slash, './' still has to mean "here".
  assert.equal(new URL('./', 'http://localhost:8080').href, 'http://localhost:8080/');
  assert.equal(new URL('./', 'https://nemoobc.github.io/Bear-Tool/').href,
    'https://nemoobc.github.io/Bear-Tool/');
  // The exact failure being pinned: the deployed run got THIS.
  assert.equal(new URL('/', 'https://nemoobc.github.io/Bear-Tool/').href,
    'https://nemoobc.github.io/');
});
