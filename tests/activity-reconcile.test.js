// A pending row must be settled against the chain, and "pending" must mean
// "still in flight" rather than "we lost track and are guessing".
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
};
const st = await import('../js/state.js');

const fakeProvider = ({ receipt, tx, throwOn }) => ({
  async getTransactionReceipt(h) {
    if (throwOn === 'receipt') throw new Error('node unreachable');
    return receipt ?? null;
  },
  async getTransaction(h) {
    if (throwOn === 'tx') throw new Error('node unreachable');
    return tx ?? null;
  },
});

function seed(hash) {
  st.get('activity').length = 0;
  st.addActivity({ hash, status: 'pending', ts: 1000, detail: '1 ETH' });
}

test('a mined receipt settles the row', async () => {
  seed('0xmined');
  const r = await st.reconcileActivity(fakeProvider({ receipt: { status: 1 } }));
  assert.equal(st.get('activity').length, 1);
  assert.equal(st.get('activity')[0].status, 'success');
  assert.equal(r.settled, 1);
  assert.equal(st.get('activity')[0].ts, 1000, 'the send time is kept');
});

test('a mined but reverted receipt is failed, not success', async () => {
  seed('0xrev');
  await st.reconcileActivity(fakeProvider({ receipt: { status: 0 } }));
  assert.equal(st.get('activity')[0].status, 'failed');
});

test('a known transaction with no receipt is still in flight', async () => {
  seed('0xfly');
  const r = await st.reconcileActivity(fakeProvider({ receipt: null, tx: { hash: '0xfly' } }));
  assert.equal(st.get('activity')[0].status, 'pending',
    'a transaction the chain knows and has not mined yet is genuinely pending');
  assert.equal(r.settled + r.failed, 0);
});

test('a transaction the chain has never heard of is dropped, not pending', async () => {
  seed('0xghost');
  const r = await st.reconcileActivity(fakeProvider({ receipt: null, tx: null }));
  assert.equal(st.get('activity')[0].status, 'failed',
    'nothing is moving; saying pending would tell the user money is in flight');
  assert.match(st.get('activity')[0].detail, /not found on this network/);
  assert.equal(r.failed, 1);
});

test('an unreachable node never invents a verdict', async () => {
  seed('0xunk');
  const r = await st.reconcileActivity(fakeProvider({ throwOn: 'receipt' }));
  assert.equal(st.get('activity')[0].status, 'pending',
    'not knowing is not the same as failed');
  assert.equal(r.unreachable, 1);
});

test('no provider is a no-op, not a wipe', async () => {
  seed('0xkeep');
  const r = await st.reconcileActivity(null);
  assert.equal(st.get('activity').length, 1);
  assert.equal(r.checked, 0);
});

test('rows with no hash are left alone', async () => {
  st.get('activity').length = 0;
  st.addActivity({ type: 'deploy-helper', status: 'pending', ts: 5, detail: 'batch' });
  const r = await st.reconcileActivity(fakeProvider({ receipt: { status: 1 } }));
  assert.equal(st.get('activity').length, 1);
  assert.equal(st.get('activity')[0].status, 'pending');
  assert.equal(r.checked, 0, 'a helper deploy has no hash to look up');
});
