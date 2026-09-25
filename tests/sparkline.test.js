// Bear Tool — sparkline SVG must be valid.
// Regression: the per-asset sparkline built points as `${poly}|| '${poly}'`,
// so every asset card emitted malformed SVG ("Expected number" in the console,
// blank chart in the UI). Assert no stray concatenation reaches the attribute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('app: sparkline polyline points are a clean coordinate list', () => {
  const hits = [...src.matchAll(/points="\$\{([^}]+)\}([^"]*)"/g)]
    .filter((m) => !/^\s*$/.test(m[2]));
  assert.deepEqual(hits.map((m) => m[1] + ' -> ' + m[2]),
    [], 'polyline points attribute must not concatenate anything after the list');
});

test('app: no pipe-pipe debug leftover in any points attribute', () => {
  assert.ok(!/points="[^"]*\|\|/.test(src),
    'found a double-pipe inside a points attribute — that is invalid SVG');
});

test('app: every interpolated points attribute holds exactly one expression', () => {
  // The invariant that actually matters: whatever feeds `points="…"` must be a
  // single expression. Two of them is how `${poly}|| '${poly}'` happened.
  const attrs = [...src.matchAll(/points="([^"]*)"/g)].map((m) => m[1]);
  const interpolated = attrs.filter((a) => a.includes('${'));
  for (const a of interpolated) {
    const count = (a.match(/\$\{/g) || []).length;
    assert.equal(count, 1, `points="${a}" interpolates ${count} expressions; expected 1`);
  }
  assert.ok(interpolated.length > 0, 'expected at least one interpolated sparkline');
});
