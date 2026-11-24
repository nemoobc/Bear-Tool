// Regression: a value flag on the e2e runner must not leak into spec filtering.
//
// 2026-11-24: `node tools/e2e.mjs --workers 4` reported "specs=3" and ran only
// the specs whose path contained the digit 4. The forwarding pass knew
// `--workers` takes a value; the spec-filter pass had a shorter, separate list
// and treated `4` as a user-supplied filter. The run then failed in 04-send for
// a reason that had nothing to do with the change under test.
//
// The runner executes on import, so this checks its source text and replays the
// exact filter with the set parsed from it — no spawn, no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../tools/e2e.mjs', import.meta.url), 'utf8');

function valueFlags() {
  const m = /const VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m, 'e2e.mjs must declare one VALUE_FLAGS set');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

// Mirrors the runner's `terms` line. If that line changes shape, the test must
// fail rather than keep asserting against a stale copy of the logic.
function terms(argv, flags) {
  assert.match(src, /!VALUE_FLAGS\.has\(argv\[i - 1\]\)/,
    'spec filtering must use the shared VALUE_FLAGS set');
  return argv.filter((a, i) => !a.startsWith('--') && !flags.has(argv[i - 1]));
}

test('every value flag is filtered from spec terms and forwarded once', () => {
  const flags = valueFlags();
  for (const f of ['--workers', '--retries', '--timeout', '--output', '--grep', '--project', '--reporter']) {
    assert.ok(flags.has(f), `${f} takes a value and must be in VALUE_FLAGS`);
  }
  assert.doesNotMatch(src, /takesValue/,
    'the old second list must be gone — two lists are how this bug happened');

  const spaced = terms(['--workers', '4'], flags);
  assert.deepEqual(spaced, [], '`--workers 4` must not select the specs containing "4"');
  assert.deepEqual(terms(['--reporter', 'list', '04-send'], flags), ['04-send'],
    'a real spec filter after a value flag must still work');
  assert.deepEqual(terms(['01-wallet-create'], flags), ['01-wallet-create'],
    'a bare spec filter must still work');

  // The forwarding loop consumes the value too, so Playwright sees one pair.
  assert.match(src, /if \(VALUE_FLAGS\.has\(a\) && v && !v\.startsWith\('--'\)\) \{ args\.push\(v\); i\+\+; \}/,
    '--workers and its value must still be passed to Playwright together');
});
