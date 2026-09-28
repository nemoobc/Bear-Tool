// The gate must actually run what the project claims to run.
//
// tests/e2e/ held 21 Playwright specs, and `test:e2e` was in package.json, and
// `test:all` — the project's own gate, what `npm run verify` calls — did not
// include it. Nothing failed, nothing warned, and the specs had never been
// executed by anyone. They looked like part of the suite in every way a reader
// checks, which is why they went unnoticed.
//
// This is the same failure the project already produced twice, in a different
// costume:
//
//   1. `npm run check` was a shell loop. npm runs scripts through cmd.exe on
//      Windows, which failed it with "(f was unexpected at this time.)" before
//      checking a single file — so verify could not run on the box the tests ran
//      on, and nothing said so.
//   2. `test:e2e` was `bash tests/e2e/run.sh`, and run.sh used python3, curl,
//      seq and a backgrounded subshell. Same class, same silence.
//
// A gate is not the set of scripts in package.json. It is the subset that runs,
// in order, without a shell the platform lacks. That is what this file checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};

test('the gate runs the browser specs, not just the unit and fork ones', () => {
  // The assertion that would have caught 21 specs sitting unused.
  assert.match(scripts['test:all'] || '', /test:e2e/,
    'test:all tidak menjalankan test:e2e — spec browser jadi yatim');
  assert.match(scripts.verify || '', /test:all/,
    'verify harus culminating di test:all, bukan melewatinya');
});

test('the browser specs exist, so requiring them in the gate is not vacuous', () => {
  // The mirror image: a gate that names a suite which does not exist is just as
  // broken as one that omits a suite that does. Both read as coverage.
  const dir = path.join(root, 'tests', 'e2e');
  assert.ok(existsSync(dir), 'tests/e2e tidak ada');
  const specs = readdirSync(dir).filter((f) => f.endsWith('.spec.js'));
  assert.ok(specs.length >= 15,
    `hanya ${specs.length} spec browser —ambang turun dari 21, ada yang terhapus?`);
});

test('no npm script depends on a POSIX shell', () => {
  // The exact shape that made both failures. A shell script in package.json is
  // not portable, and its failure lands before any test runs, so the suite looks
  // fine and the gate quietly does nothing.
  const offenders = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (/\bbash\b|\bsh\s+\S+\.sh\b|&&?\s*\.{0,2}\S+\.sh\b/.test(body)) {
      offenders.push(`${name}: ${body}`);
    }
  }
  assert.deepEqual(offenders, [],
    `script ini butuh shell POSIX, dan tidak akan jalan di cmd.exe:\n  ${offenders.join('\n  ')}`);

  // …and the replacement must exist, so "no shell" does not mean "nothing runs".
  assert.match(scripts['test:e2e'] || '', /node\s+tools\/e2e\.mjs/,
    'test:e2e harus runner Node — tools/e2e.mjs');
  assert.ok(existsSync(path.join(root, 'tools', 'e2e.mjs')), 'tools/e2e.mjs hilang');
});

test('the syntax gate covers the spec files too', () => {
  // A .spec.js is code. If the checker only walks js/ and tests/*.js, the specs
  // are the largest body of unparsed code in the project — which is what happened
  // before check.mjs learned to recurse.
  const checker = read('tools/check.mjs');
  assert.match(checker, /withFileTypes/, 'check.mjs harus menelusuri direktori');
  const listed = readdirSync(path.join(root, 'tools')).includes('e2e.mjs');
  assert.ok(listed);
  // The e2e specs are ESM for Playwright, and node --check parses them as CommonJS
  // by default, so they are listed rather than asserted parseable. What matters is
  // that they are inside the walk.
  assert.match(checker, /tests/);
});
