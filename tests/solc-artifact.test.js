// Bear Tool — solc-artifact.test.js
// The vendored soljson ships with the app (2026-10-20): deploy/rescue must not
// walk a 9.2 MB public CDN on first compile. This pin FAILS THE APP if the
// vendored bytes drift from the version the runtime reports — a silently
// wrong compiler would produce bytecode that off-chain verifiers call wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLC_INTEGRITY, SOLC_LONG, SOLC_VENDOR_PAGE_URL } from '../js/solc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('vendored soljson exists next to the app assets', () => {
  const file = path.join(__dirname, '..', SOLC_VENDOR_PAGE_URL);
  assert.ok(fs.existsSync(file), SOLC_VENDOR_PAGE_URL + ' must ship with the repo');
  const buf = fs.readFileSync(file);
  assert.ok(buf.length > 5_000_000, 'soljson is a ~9 MB wasm bundle, got ' + buf.length);
});

test('vendored bytes are EXACTLY the pinned compiler (sha384)', () => {
  const file = path.join(__dirname, '..', SOLC_VENDOR_PAGE_URL);
  const sha = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64');
  assert.equal(sha, SOLC_INTEGRITY,
    'vendored soljson drifted — reproduce it from solc@' + SOLC_LONG.split('+')[0] + ' and update SOLC_INTEGRITY in one place only');
});
