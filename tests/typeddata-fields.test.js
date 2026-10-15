// The EIP-712 sheet used to show the type name and nothing else. The type name
// is chosen by the site: a payload that moves tokens can call itself "Mail", and
// a person signing it had nothing to compare. The fields themselves are the
// content, so the sheet shows them — and a value it cannot render is marked
// rather than dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedDataFields } from '../js/native-dapp.js';
import { readFileSync } from 'node:fs';

const flat = (o) => Object.fromEntries(typedDataFields(o).map((f) => [f.k, f.v]));

test('every top-level field reaches the sheet', () => {
  const f = flat({ contents: 'hello', from: '0xabc', deadline: 1700000000 });
  assert.equal(f.contents, 'hello');
  assert.equal(f.from, '0xabc');
  assert.equal(f.deadline, '1700000000');
});

test('a struct is read, not printed as [object Object]', () => {
  const f = flat({ values: { amount: '1000', spender: '0xdead' } });
  assert.match(f.values, /amount: 1000/);
  assert.match(f.values, /spender: 0xdead/);
  assert.doesNotMatch(f.values, /\[object Object\]/,
    'payload tak terbaca adalah tanda sheet menampilkan sesuatu yang tak dipahami');
});

test('an array shows its size, and only the first few items', () => {
  const f = flat({ tokens: ['0x1', '0x2', '0x3', '0x4', '0x5'] });
  assert.match(f.tokens, /\[5\]/);
  assert.match(f.tokens, /0x1/);
  assert.match(f.tokens, /…/, 'sisanya ditandai, bukan dipangkas diam-diam');
});

test('null and undefined fields are skipped rather than shown as "null"', () => {
  const keys = typedDataFields({ a: 1, b: null, c: undefined }).map((f) => f.k);
  assert.deepEqual(keys, ['a']);
});

test('an empty or missing payload produces no rows and does not throw', () => {
  assert.deepEqual(typedDataFields({}), []);
  assert.deepEqual(typedDataFields(null), []);
  assert.deepEqual(typedDataFields(undefined), []);
  assert.deepEqual(typedDataFields('nonsense'), []);
});

test('the sign sheet puts the fields between the type and the site', () => {
  const src = readFileSync(new URL('../js/native-dapp.js', import.meta.url), 'utf8');
  // Anchor on the call itself — the ARGUMENT changed name (it is now `message`,
  // the validated, normalized copy typedParts returns, i.e. exactly the value
  // passed to signTypedData below), but the intent is untouched: the sheet must
  // render the payload's FIELDS, not just the type name the site chose.
  const at = src.indexOf('typedDataFields(message)');
  assert.ok(at > 0, 'sheet harus memuat isi payload');
  const row = src.slice(at - 400, at + 120);
  assert.match(row, /site\.primaryType/,
    'baris isi payload harus muncul setelah nama tipe');
});
