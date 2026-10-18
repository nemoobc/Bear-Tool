// Bear Tool — tests/dex-core.test.js
// Milestone 1 of the Dex v2 rebuild (2026-10-17; user order: delete the dex
// and rebuild it from zero until mature). The old dex suite is deleted with
// the old modules; this file pins the fresh foundation. Assertions call the
// real modules the app calls — a regex over the source would prove nothing.
//
// The engine's chain identity is law (finance surface: a sloppy chain check
// lets swaps run on the wrong network), and the first paint of the view is
// honest state that works with zero address — the app doctrine every view
// must obey.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The dex graph now reaches the trade engine, which reads ethers off
// globalThis exactly like every other wallet module (js/max-ui.js): the
// browser has it before js/app.js evals, so the test arms the same shim.
import { ethers } from 'ethers';
globalThis.ethers = ethers;

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
};
const core = await import('../js/dex/core.js');
const dex = await import('../js/dex/index.js');
const st = await import('../js/state.js');

test('the engine locks to the Sepolia chain identity', () => {
  assert.equal(core.DEX_CHAIN_ID, 11155111);
  assert.equal(core.DEX_NETWORK, 'sepolia');
});

test('dexChainOk is honest: string ids pass, garbage never passes', () => {
  assert.equal(core.dexChainOk(11155111), true);
  assert.equal(core.dexChainOk('11155111'), true, 'some RPCs hand back hex-strings');
  assert.equal(core.dexChainOk(1), false);
  assert.equal(core.dexChainOk(0), false);
  assert.equal(core.dexChainOk(undefined), false);
  assert.equal(core.dexChainOk(null), false);
  assert.equal(core.dexChainOk('0x0'), false, 'hex-garbage is not a chain id');
});

test('renderDex paints the fresh shell into #dexRoot', () => {
  const root = { innerHTML: '' };
  const res = dex.renderDex(root);
  assert.equal(res.ok, true);
  assert.match(root.innerHTML, /dex-state/);
  assert.match(root.innerHTML, /dexEngineState/);
  assert.equal((root.innerHTML.match(/data-dex-row/g) || []).length, 3, 'three state rows: network, wallet, engine');
});

test('a wallet-less phone renders the shell — "no wallet", not a crash', () => {
  st.set('address', null);
  const root = { innerHTML: '' };
  const res = dex.renderDex(root);
  assert.equal(res.ok, true);
  assert.equal(res.wallet, false);
  assert.match(root.innerHTML, /(No wallet yet|Belum ada dompet)/);
});

test('renderDex refuses a missing root without throwing', () => {
  assert.deepEqual(dex.renderDex(null), { ok: false, reason: 'no-root' });
});
