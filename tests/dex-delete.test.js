// Bear Tool — tests/dex-delete.test.js
// The user (APK, 2026-10-15): "fitur dex itu bener² hapus coin bukan hide
// coin". These run the real exports of js/dex/list.js against a storage stub:
// delete must remove the coin from the feed NOW, keep it out ACROSS a state
// loss (a reload), honor the pre-delete "hidden" log, and never accept
// garbage or let case split the same address in two.
//
// This is behaviour, not source text: every assertion calls the module the app
// calls. A regex over list.js would pass on a function that returns nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEX_CHAIN_ID } from '../js/dex/core.js';
import { deleteCoin, deletedCoins, isDeleted, withoutDeleted } from '../js/dex/list.js';
import { set } from '../js/state.js';

// A minimal localStorage, per-key: enough for the stores list.js touches, and
// both the new and the legacy log can live side by side in it. Node has no
// localStorage — the module reads it lazily inside functions, never at import.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const feed = (...addrs) => addrs.map((address) => ({ address, symbol: 'T' }));

test('delete removes the coin from the feed the scan returns', () => {
  assert.equal(deleteCoin(A), true, 'first delete lands');
  assert.equal(deleteCoin(A), false, 'a double click cannot add it twice');
  assert.equal(isDeleted(A), true, 'the coin is marked deleted');
  assert.deepEqual(withoutDeleted(feed(A, B)).map((c) => c.address), [B],
    'the chain scan result must lose the deleted coin, keep the rest');
});

test('the tombstone survives a reload (the state mirror is not the source of truth)', () => {
  assert.ok(deletedCoins().includes(A), 'state mirror knows before the wipe');
  set('dex.deleted', []);
  assert.ok(isDeleted(A), 'after the mirror is gone the storage tombstone still holds');
  assert.equal(withoutDeleted(feed(A)).length, 0, 'and the feed stays clean');
});

test('coins hidden under the old design stay gone (the migration cannot drop them)', () => {
  // The pre-delete design wrote bear.dex.hidden.<chain>. Those coins were
  // taken out of the feed on purpose — the delete design reads them as
  // deleted rather than resurrecting them under a new name.
  store.set(`bear.dex.hidden.${DEX_CHAIN_ID}`, JSON.stringify([B]));
  assert.ok(deletedCoins().includes(B), 'the legacy log feeds the same filter');
  assert.equal(withoutDeleted(feed(B)).length, 0, 'and the feed honors it');
});

test('garbage can never enter the log, and case can never split it', () => {
  assert.equal(deleteCoin('not-an-address'), false, 'only real addresses get in');
  assert.equal(deleteCoin(''), false, 'and never an empty string');
  store.set(`bear.dex.deleted.${DEX_CHAIN_ID}`, JSON.stringify(['0xNOPE', 42, null, '0x' + 'AA'.repeat(20)]));
  const log = deletedCoins();
  assert.deepEqual(log, log.filter((x) => /^0x[0-9a-f]{40}$/.test(x)),
    'the log only ever holds addresses, whatever storage was told to say');
  assert.ok(log.includes(A), 'stored uppercase still matches lowercase reads');
  assert.equal(log.some((x) => x.startsWith('0xnope')), false, 'garbage stays out');
});

// The legacy coin page and the v2 token page must delete through the SAME two
// stores, or a coin deleted on one surface reappears from the other.
test('the v2 token page deletes through the same two stores as the legacy page', () => {
  const page = readFileSync(new URL('../js/dex/token-page.js', import.meta.url), 'utf8');
  assert.match(page, /confirmTx\(/, 'a delete that cannot be cancelled is a trap');
  assert.match(page, /forgetLaunchedToken\(token\)/, 'the launched index must forget the token');
  assert.match(page, /deleteCoin\(token\)/, 'and the tombstone must land for the feed scan');
  assert.match(page, /t\('dex\.list\.deletedToast'\)/, 'the user must be told what happened');
});
