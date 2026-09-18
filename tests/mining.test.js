// Bear Tool — mining.test.js
// SHA-256 Proof-of-Work core: challenge math, verification, nonce search,
// abort, progress, multi-thread split. Pure Node — no DOM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, makeChallenge, isValidPoW, findNonce, mineChallenge } from '../js/mining.js';

test('mining: sha256Hex produces the known SHA-256 of "abc"', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('mining: makeChallenge builds a bitcoin-style target', () => {
  const c = makeChallenge({ difficulty: 4 });
  assert.match(c.prefix, /^[0-9a-f]+$/, 'prefix must be hex');
  assert.equal(c.difficulty, 4);
  // target = 2^(256-16) - 1 → starts with 4 zero hex digits
  const hex = c.target.toString(16).padStart(64, '0');
  assert.equal(hex.slice(0, 4), '0000', 'difficulty 4 → 4 leading zero hex digits');
  assert.ok(hex.slice(4).includes('f'), 'rest of target must be all f');
});

test('mining: makeChallenge rejects bad difficulty', () => {
  assert.throws(() => makeChallenge({ difficulty: 0 }), /difficulty/);
  assert.throws(() => makeChallenge({ difficulty: 33 }), /difficulty/);
  assert.throws(() => makeChallenge({ difficulty: 2.5 }), /difficulty/);
  assert.throws(() => makeChallenge({ prefix: 'zz' }), /hex/);
});

test('mining: isValidPoW accepts a real proof and rejects a wrong nonce', async () => {
  const c = makeChallenge({ difficulty: 2, prefix: 'deadbeef' });
  // find a valid nonce first
  const found = await findNonce({ prefix: c.prefix, target: c.target, maxNonce: 100000 });
  assert.ok(found, 'a nonce must exist for difficulty 2');
  assert.equal(await isValidPoW({ prefix: c.prefix, nonce: found.nonce, target: c.target }), true);
  assert.equal(await isValidPoW({ prefix: c.prefix, nonce: found.nonce + 1, target: c.target }), false);
});

test('mining: findNonce returns a nonce whose hash is below target', async () => {
  const c = makeChallenge({ difficulty: 2, prefix: 'c0ffee' });
  const found = await findNonce({ prefix: c.prefix, target: c.target, maxNonce: 100000 });
  assert.ok(found, 'must find a nonce');
  const hash = await sha256Hex(c.prefix + BigInt(found.nonce).toString(16));
  assert.ok(BigInt('0x' + hash) < c.target, 'hash must be below target');
  assert.equal(found.hash, hash, 'returned hash must match');
});

test('mining: findNonce reports progress', async () => {
  const c = makeChallenge({ difficulty: 3, prefix: 'feedface' });
  let calls = 0;
  const found = await findNonce({
    prefix: c.prefix, target: c.target, maxNonce: 100000,
    onProgress: () => { calls++; }
  });
  assert.ok(found, 'must find a nonce');
  assert.ok(calls >= 1, 'progress callback must fire at least once');
});

test('mining: findNonce aborts cleanly (returns null)', async () => {
  const c = makeChallenge({ difficulty: 24, prefix: 'aabbccdd' }); // impossible target
  const controller = new AbortController();
  const promise = findNonce({ prefix: c.prefix, target: c.target, maxNonce: 2 ** 32, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result, null, 'aborted search must resolve null');
});

test('mining: mineChallenge splits the nonce space across threads', async () => {
  const c = makeChallenge({ difficulty: 2, prefix: 'c0ffee11' });
  const found = await mineChallenge({ prefix: c.prefix, target: c.target, threads: 3 });
  assert.ok(found, 'multi-thread search must find a nonce');
  assert.ok(found.hashes > 0, 'must count hashes');
  assert.ok(found.speed === undefined || found.speed >= 0, 'speed must be sane');
  assert.equal(await isValidPoW({ prefix: c.prefix, nonce: found.nonce, target: c.target }), true);
});