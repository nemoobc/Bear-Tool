// Bear Tool — solc-sanitize.test.js
// Functional unit for the 2026-10-20 user request: the toast stream must stop
// showing solc jargon ("Loading Solidity compiler…") and raw excerpt dumps.
// The compiler now (a) starts from the VENDORED bytes, (b) speaks neutral
// lines, and (c) on errors emits one short line with the dump parked on
// err.detail for the activity log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compilerUrlList,
  injectCompiler,
  resetCompiler,
  sanitizeCompileMessage,
  compileContract,
  SOLC_URL,
  SOLC_FALLBACK_URLS,
  SOLC_VENDOR_PAGE_URL,
  SOLC_VENDOR_WORKER_URL,
} from '../js/solc.js';

test('URL list: vendored compiler FIRST, page vs worker flavours', () => {
  const page = compilerUrlList(false);
  const worker = compilerUrlList(true);
  assert.equal(page[0], SOLC_VENDOR_PAGE_URL);
  assert.equal(page[0].startsWith('js/vendor/'), true, 'page list is page-relative');
  assert.equal(worker[0], SOLC_VENDOR_WORKER_URL);
  assert.equal(worker[0].startsWith('vendor/'), true, 'worker list is worker-relative (importScripts)');
  // CDN stays as the emergency fallback, never the primary:
  assert.equal(page.includes(SOLC_URL), true);
  for (const u of SOLC_FALLBACK_URLS) assert.equal(page.includes(u), true);
});

test('sanitizeCompileMessage: solc excerpt dump → one line, no source/carets/pointers', () => {
  const DQM = '"';
  const dump = [
    'Error (5321): ParserError: Expected ' + DQM + '; but got ' + DQM + '}',
    ' --> input.sol:5:9:',
    '  |',
    '5 |                 }',
    '  |                 ^',
    '',
  ].join('\n');
  const line = sanitizeCompileMessage(dump);
  assert.equal(line, 'Error (5321): ParserError: Expected ' + DQM + '; but got ' + DQM + '}');
  assert.doesNotMatch(line, /[\^|\|]/);
});

test('sanitizeCompileMessage: long strings cap at 180 chars, empty → fallback', () => {
  const capped = sanitizeCompileMessage('x'.repeat(500));
  assert.ok(capped.length <= 180, 'cap ≤ 180, got ' + capped.length);
  assert.ok(capped.endsWith('…'), 'cap marks the cut with …');
  assert.equal(sanitizeCompileMessage(''), 'unknown failure');
  assert.equal(sanitizeCompileMessage(null), 'unknown failure');
});

test('compileContract: solc errors → one short line for the user, dump parked on err.detail', async () => {
  resetCompiler();
  const dump = [
    'Error (9402): TypeError: Member not found',
    ' --> input.sol:1:1:',
    ' --|',
    '1 | contract A {}',
  ].join('\n');
  injectCompiler({
    compile: () => JSON.stringify({
      contracts: {},
      errors: [
        { severity: 'error', formattedMessage: dump },
        { severity: 'warning', formattedMessage: 'Warning about nothing' },
      ],
    }),
  });
  await assert.rejects(
    () => compileContract('contract A {}', 'A'),
    (err) => {
      assert.match(err.message, /^Compile failed — Error \(9402\): TypeError: Member not found$/, 'ringkas: ' + err.message);
      assert.ok(!/-->/.test(err.message), 'penunjuk baris tidak boleh bocor ke pesan user');
      assert.match(String(err.detail || ''), /--> input\.sol:1:1:/, 'dump lengkap ikut di err.detail utk activity log');
      return true;
    },
  );
  resetCompiler();
});
