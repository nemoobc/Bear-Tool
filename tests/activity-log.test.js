// The activity log used to disagree with itself.
//
// Every module records a transaction twice by design: once as pending when it is
// sent, once with its final status when the receipt lands. addActivity appended
// both, so a completed transfer showed as "pending" AND "success" for the same
// hash, and a transfer that had completed stayed listed as pending forever.
// Measured on a real wallet: 5 rows, 3 unique hashes.
//
// These are the data-layer rules, run against the real module with a fake
// localStorage, because every one of the eight callers depends on them and
// patching eight call sites instead would be eight chances to get it wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
};
const st = await import('../js/state.js');

test('a completed transaction is one row, not two', () => {
  st.get('activity').length = 0;
  st.addActivity({ hash: '0xabc', type: 'send', status: 'pending', ts: 1000, detail: '1 ETH' });
  st.addActivity({ hash: '0xabc', type: 'send', status: 'success', ts: 2000 });
  const a = st.get('activity');
  assert.equal(a.length, 1, `expected 1 row, got ${a.length}`);
  assert.equal(a[0].status, 'success');
  assert.equal(a[0].detail, '1 ETH', 'the pending row is the one that knows what was sent');
});

test('the timestamp stays when the user pressed send, not when it confirmed', () => {
  st.get('activity').length = 0;
  st.addActivity({ hash: '0xabc', status: 'pending', ts: 1000, detail: 'x' });
  st.addActivity({ hash: '0xabc', status: 'success', ts: 2000 });
  assert.equal(st.get('activity')[0].ts, 1000,
    'a history is a record of when you acted, not of when a node replied');
});

test('distinct hashes stay distinct', () => {
  st.get('activity').length = 0;
  st.addActivity({ hash: '0x1', status: 'pending', ts: 1 });
  st.addActivity({ hash: '0x2', status: 'pending', ts: 2 });
  assert.equal(st.get('activity').length, 2);
});

test('a failed receipt is terminal too, and is not a second row', () => {
  st.get('activity').length = 0;
  st.addActivity({ hash: '0xf', status: 'pending', ts: 5 });
  st.addActivity({ hash: '0xf', status: 'failed', ts: 6 });
  assert.equal(st.get('activity').length, 1);
  assert.equal(st.get('activity')[0].status, 'failed');
});

test('a reverted receipt does not get stuck pending', () => {
  st.get('activity').length = 0;
  st.addActivity({ hash: '0xr', status: 'pending', ts: 7 });
  st.addActivity({ hash: '0xr', status: 'reverted', ts: 8 });
  assert.equal(st.get('activity').length, 1);
  assert.equal(st.get('activity')[0].status, 'reverted');
});

test('history written by the old code heals on load', () => {
  store['bear.activity'] = JSON.stringify([
    { hash: '0xdup', status: 'success', ts: 300, detail: 'x' },
    { hash: '0xdup', status: 'pending', ts: 298, detail: 'x' },
    { hash: '0xsolo', status: 'pending', ts: 100, detail: 'y' },
  ]);
  st.loadActivity();
  const a = st.get('activity');
  assert.equal(a.length, 2, `3 rows for 2 hashes is the old bug; healed to ${a.length}`);
  const dup = a.find((x) => x.hash === '0xdup');
  assert.ok(dup, 'the duplicated hash must survive as one row');
  assert.equal(dup.status, 'success', 'the receipt status wins over the earlier pending row');
  assert.equal(dup.ts, 298, 'oldest timestamp kept, so a row cannot change date on every boot');
});

test('healing rewrites storage, so the next boot is already clean', () => {
  st.loadActivity();
  assert.equal(JSON.parse(store['bear.activity']).length, 2);
});

test('corrupt storage does not throw', () => {
  store['bear.activity'] = '{oops';
  st.loadActivity();
  assert.deepEqual(st.get('activity'), []);
});

test('non-array storage does not throw', () => {
  store['bear.activity'] = '{"not":"an array"}';
  st.loadActivity();
  assert.deepEqual(st.get('activity'), []);
});

test('rows without a hash are all kept — they are not the same transaction', () => {
  store['bear.activity'] = JSON.stringify([
    { type: 'deploy-helper', status: 'success', ts: 10, detail: 'batch' },
    { type: 'deploy-helper', status: 'success', ts: 11, detail: 'rescue' },
  ]);
  st.loadActivity();
  assert.equal(st.get('activity').length, 2,
    'a helper deploy has no tx hash; collapsing those would erase real history');
});
