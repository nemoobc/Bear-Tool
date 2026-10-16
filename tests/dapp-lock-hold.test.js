// The native dApp RPC path HOLDS a signing request while the wallet is locked
// (report 2026-10-16 "pertama bisa konek pas mau konek gabisa": refusing with
// 5100 trained users to tap-unlock-tap-again, and the auto-lock fired while
// they browsed because browser touches never reset its idle timer). The hold
// is waitForSigner — pure state logic in state.js, provable without a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, set, waitForSigner } from '../js/state.js';

test('waitForSigner resolves immediately when the wallet is already unlocked', async () => {
  const signer = { address: '0xabc' };
  set('signer', signer);
  const got = await waitForSigner(5000);
  assert.equal(got, signer, 'unlocked wallet = the request never waits');
  set('signer', null);
});

test('waitForSigner resolves the moment the wallet unlocks mid-wait', async () => {
  set('signer', null);
  const pr = waitForSigner(5000);
  setTimeout(() => set('signer', { address: '0xdef' }), 30);
  const got = await pr;
  assert.ok(got && got.address === '0xdef', 'held request must continue by itself on unlock');
  set('signer', null);
});

test('waitForSigner gives up at its deadline — a dead page cannot pin a promise all day', async () => {
  set('signer', null);
  const got = await waitForSigner(40);
  assert.equal(got, null);
});

test('a timed-out waiter unsubscribes and a later unlock does not resurrect it', async () => {
  set('signer', null);
  assert.equal(await waitForSigner(30), null);
  set('signer', { address: '0x111' });   // must not throw, must not wake the dead waiter
  assert.equal(get('signer').address, '0x111');
  set('signer', null);
});

test('a signer that lands between the initial read and the subscription is never missed', async () => {
  // The classic lost-wakeup: get() sees null, set() fires, on() starts
  // listening — and the waiter sleeps until its timeout even though the
  // wallet is open. The re-check after subscribing closes the window.
  set('signer', null);
  const pr = waitForSigner(5000);
  set('signer', { address: '0x222' });
  const got = await pr;
  assert.ok(got && got.address === '0x222');
  set('signer', null);
});
