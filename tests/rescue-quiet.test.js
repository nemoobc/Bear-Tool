// Bear Tool — rescue-quiet.test.js
// Source guard for the 2026-10-20 user request ("solc solidity-nya jangan
// ditampilkan"): the tools flow does not toast compiler chatter, and the
// compiler's own strings + statuses never mention "Solidity"/"solc" to the
// user. The functional side lives in solc-sanitize / solc-worker tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t } from '../js/i18n.js';

const toolsSrc = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
const solcSrc = fs.readFileSync(new URL('../js/solc.js', import.meta.url), 'utf8');
const workerSrc = fs.readFileSync(new URL('../js/solc-worker.js', import.meta.url), 'utf8');
const i18nSrc = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

test('tools flow: compile statuses never reach the raw toast anymore', () => {
  assert.doesNotMatch(toolsSrc, /onStatus: \(\w+\) => toast\(m, 'info'\)/,
    'compileSource must not forward worker messages straight into toasts');
  assert.match(toolsSrc, /compileChatterShown/, 'chatter must be shown at most once');
});

test('user-facing compiler strings contain no jargon ("Solidity"/"solc")', () => {
  // Only the i18n dictionary keys named *solidity* (deploy page language
  // labels) may contain the word; every ACTIVE status/error string stays clean.
  for (const [where, src, timeout] of [
    ['solc.js', solcSrc, false],
    ['solc-worker.js', workerSrc, false],
  ]) {
    const offending = src.split('\n')
      .filter((l) => { const s = l.trim(); return !s.startsWith('//') && !s.startsWith('/*') && !s.startsWith('*'); })
      .filter((l) => /'Loading Solidity|Solidity compiler (ready|did not|is busy|loaded)|Solidity compiler crashed|failed to load the Solidity/i.test(l));
    assert.deepEqual(offending, [], where + ' masih bicara jargon: ' + offending.join(' || '));
  }
});

test('i18n: tools.compile.status exists in BOTH locales, jargon-free', () => {
  assert.equal(typeof t('tools.compile.status'), 'string');
  assert.ok(t('tools.compile.status').length > 10);
  for (const lang of ['en', 'id']) {
    assert.match(i18nSrc, new RegExp("'tools\\.compile\\.status': '[^']*'"),
      'key wajib ada di kedua locale');
  }
  assert.doesNotMatch(t('tools.compile.status'), /solc|solidity/i);
});

test('helper deploy failures land in the activity log with a technical detail', () => {
  assert.match(toolsSrc, /deployContract\(signer, abi, bytecode, constructorArgs = \[\]\) \{\s*\n\s*try \{/,
    'deployContract wraps in try/catch');
  assert.match(toolsSrc, /type: 'deploy-helper', status: 'failed', ts: Date\.now\(\), detail: 'helper deploy failed: '/,
    'the activity entry records the short technical reason');
});
