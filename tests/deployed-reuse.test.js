// Bear Tool — deployed-reuse.test.js
// "Did that helper already get deployed?" must not destroy the answer on a hiccup.
//
// The registry exists to save gas: a helper already deployed is reused instead of
// deploying a second copy. So the check that decides "still deployed?" runs before
// a user spends anything, and a wrong answer there costs real money.
//
// It was two-valued. contractExists() answered false when provider.getCode()
// threw, and findUsableDeployed() read that as "dead" and called removeDeployed().
// A node that was briefly unreachable — rate-limited, restarting, on a flaky link —
// therefore deleted a valid record. The user was then told to deploy a helper they
// had already paid to deploy, and the registry quietly stopped doing the one job
// it exists for.
//
// Three states: alive, dead (the chain said there is no code), and unknown (the
// node did not answer). Only the second may delete anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });

// registry.js reads `ethers` off the global, the way every module in this app
// does. Without it `ethers.getAddress` throws inside isValidAddress, every
// address reads as invalid, and saveDeployed reports "Invalid contract address" —
// which looks like a bad fixture and is actually a missing import.
if (!globalThis.ethers) {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
}

const tools = await import('../js/eip7702-tools.js');
const registry = await import('../js/registry.js');

const ADDR = '0x3333333333333333333333333333333333333333';
const TYPE = 'rescue';
const CHAIN = 1;

const providerWith = (getCode) => ({ async getCode(a) { return getCode(a); } });

function seed() {
  store.clear();
  // saveDeployed(type, address, extra) — three positional arguments. Passing a
  // single object saved nothing at all, so every assertion below failed for a
  // reason that had nothing to do with the policy under test.
  registry.saveDeployed(TYPE, ADDR, { chainId: CHAIN, safe: ADDR });
}
const stillThere = () => registry.listDeployed(TYPE).some(d => d.address.toLowerCase() === ADDR);

test('a live contract is reused', async () => {
  seed();
  const found = await tools.findUsableDeployed(TYPE, CHAIN, () => true, providerWith(async () => '0x6080'));
  assert.ok(found, 'a deployed helper must be found again');
  assert.equal(found.unverified, undefined, 'a verified reuse is not flagged as unverified');
  assert.equal(stillThere(), true, 'reuse must not disturb the record');
});

test('a contract the chain says is gone is dropped', async () => {
  seed();
  const found = await tools.findUsableDeployed(TYPE, CHAIN, () => true, providerWith(async () => '0x'));
  assert.equal(found, null, 'a contract with no code must not be reused');
  assert.equal(stillThere(), false, 'a confirmed-dead record may be removed');
});

test('a node that does not answer deletes nothing', async () => {
  seed();
  const boom = providerWith(async () => { throw new Error('connection reset'); });
  const found = await tools.findUsableDeployed(TYPE, CHAIN, () => true, boom);
  assert.equal(stillThere(), true,
    'an unreadable node deleted a valid deployment record — the user would be told to pay to deploy a helper they already have');
  assert.ok(found, 'the record is still offered rather than silently re-deployed');
  assert.equal(found.unverified, true,
    'an unverified reuse must say so, so the UI can tell reuse from a confirmed check');
});

test('the two states are actually distinguishable', async () => {
  const alive = await tools.contractExists(providerWith(async () => '0x6080'), ADDR);
  const dead = await tools.contractExists(providerWith(async () => '0x'), ADDR);
  const unknown = await tools.contractExists(providerWith(async () => { throw new Error('x'); }), ADDR);
  assert.deepEqual(alive, { known: true, alive: true });
  assert.deepEqual(dead, { known: true, alive: false });
  assert.deepEqual(unknown, { known: false, alive: false });
  assert.notEqual(dead.known, unknown.known,
    '"the chain says there is nothing there" and "the node did not answer" must not collapse into one answer');
});

test('no record means no work, whatever the node says', async () => {
  store.clear();
  const found = await tools.findUsableDeployed(TYPE, CHAIN, () => true, providerWith(async () => { throw new Error('x'); }));
  assert.equal(found, null);
});
