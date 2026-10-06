// Bear Tool — dapp-catalog-truth.test.js
//
// README said "10 curated DApps" while the catalogue shipped 18, named
// Compound as frameable while the code said frameable:false, and named Lido as
// clickjacking-protected while the code said frameable:true — three stale
// claims in one row, each the kind a user taps on and then files a bug about.
// The prose is written for humans; the catalogue is the machine's truth. This
// test makes the second answer the first's grader: every number and name the
// feature table (README:28) and the framing section (README ~:330) print must
// be derivable from POPULAR_DAPPS at test time. A catalogue edit that changes
// a count or a frameable flag fails here until the docs move with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POPULAR_DAPPS } from '../js/dapps.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const row28 = readme.split('\n').find((l) => l.includes('**DApps** | Web3 DApps browser'));
assert.ok(row28, 'the DApps feature row must exist in the README table');

const frameable = POPULAR_DAPPS.filter((d) => d.frameable === true).map((d) => d.name);
const external = POPULAR_DAPPS.filter((d) => d.frameable === false).map((d) => d.name);

test('catalogue is well-formed: unique names and urls, every entry has a category', () => {
  const names = POPULAR_DAPPS.map((d) => d.name);
  const urls = POPULAR_DAPPS.map((d) => d.url);
  assert.equal(new Set(names).size, names.length, 'duplicate dApp name');
  assert.equal(new Set(urls).size, urls.length, 'duplicate dApp url');
  for (const d of POPULAR_DAPPS) {
    assert.ok(d.url.startsWith('https://'), `${d.name} must be https`);
    assert.ok(d.category, `${d.name} has no category`);
    assert.ok(typeof d.frameable === 'boolean', `${d.name} must declare frameable explicitly`);
  }
  assert.equal(frameable.length + external.length, POPULAR_DAPPS.length,
    'frameable must be a boolean on every entry, not undefined falling into a bucket');
});

test('README feature row: "N curated DApps" equals the shipped catalogue length', () => {
  const m = row28.match(/(\d+) curated DApps/);
  assert.ok(m, 'the feature row must state a curated count');
  assert.equal(Number(m[1]), POPULAR_DAPPS.length,
    `README claims ${m[1]} curated DApps, POPULAR_DAPPS has ${POPULAR_DAPPS.length}`);
});

test('README feature row: the frameable list equals the code frameable:true set', () => {
  const m = row28.match(/permit framing \(([^)]*)\)/);
  assert.ok(m, 'the feature row must name the sites that permit framing');
  const said = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepStrictEqual(said, [...frameable].sort(),
    'README frameable list drifted from js/dapps.js frameable:true');
});

test('README feature row: the "other N" count equals the non-frameable set size', () => {
  const m = row28.match(/the other (\d+) ship/);
  assert.ok(m, 'the feature row must count the sites that ship clickjacking protection');
  assert.equal(Number(m[1]), external.length,
    `README claims ${m[1]} protected sites, frameable:false has ${external.length}`);
});

test('README framing section: the opening sentence names exactly the frameable set', () => {
  const line = readme.split('\n').find((l) => l.includes('allow cross-origin framing'));
  assert.ok(line, 'the framing section must open with the frameable list');
  const said = [...line.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1].trim()).sort();
  assert.deepStrictEqual(said, [...frameable].sort(),
    'the framing section drifted from js/dapps.js frameable:true');
});
