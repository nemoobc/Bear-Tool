// node --check on every source file, in JavaScript.
//
// This replaced a shell loop — `for f in js/*.js; do node --check "$f"; done` —
// which npm runs through cmd.exe on Windows, where it dies with
// "(f was unexpected at this time.)" before checking anything. So the project's
// own `verify` path could not run on the machine the tests are run on, and
// nothing said so: the check either failed loudly in a place nobody looked, or
// was skipped. A syntax gate that does not run is not a gate.
//
// Exits non-zero and names every bad file, so the failure says which file.

import { readdirSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const TARGETS = ['js', 'tests', 'tools'];

// Recursive, and it has to be. The flat version listed only the top level of js/
// and tests/, so tests/fork/*.js and tests/e2e/*.js were never parsed — and those
// directories hold every fork test, which is where new files actually go. A fork
// test with a syntax error was reported as "check: 88 file OK" and only surfaced
// on the Windows box, where node refused to load it.
//
// A coverage gap in a gate is worse than a missing gate: this one counted the
// files it skipped as files it passed.
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(rel);
  }
};
for (const dir of TARGETS) walk(dir);

// --list prints the files and exits. It exists so a test can compare the gate's
// own coverage against the filesystem in one process: running the full check from
// inside a unit test spawns one node per file, and measuring that cost 142 seconds
// to learn a number that takes milliseconds to obtain. Checking coverage by
// re-running the check is the slow way to ask a question about the file list.
//
// writeSync, NOT console.log: stdout behind a PIPE (exactly what the coverage
// test's spawnSync creates) is written ASYNCHRONOUSLY, and process.exit(0)
// drops whatever has not flushed — under full-suite load the gate reported
// 175 of 204 files (one partial pipe write) and the coverage test went red
// on a correct gate. A synchronous fd write cannot be cut off by the exit.
if (process.argv.includes('--list')) {
  const buf = Buffer.from(files.map((rel) => rel + '\n').join(''), 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off, buf.length - off);
  process.exit(0);
}

const bad = [];
for (const rel of files) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad.push({ rel, msg: (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | ') });
  }
}

if (bad.length) {
  console.error(`check: ${bad.length} file tidak lolos syntax`);
  for (const b of bad) console.error(`  ${b.rel}\n      ${b.msg}`);
  process.exit(1);
}
console.log(`check: ${files.length} file OK`);
