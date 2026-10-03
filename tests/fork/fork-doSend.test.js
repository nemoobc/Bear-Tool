// Bear Tool — fork-doSend.test.js
//
// The REAL doSend — the app's Send button handler — driven end to end against
// an anvil fork: form values in, broadcast out, balances moved on chain.
//
// Why this file exists. tests/e2e/04-send.spec.js proves the send VIEW (form,
// preview, warning modals) and stops there: no e2e spec ever clicks
// "Sign & Send" through to a broadcast, and the fork suite builds its own
// transactions instead of calling the app's handler. That gap is exactly the
// territory of the user-reported "can't send a transaction" bug: every test
// green, the one code path that actually transacts never exercised. This test
// closes it — if doSend's fee construction, state wiring or receipt handling
// breaks on any chain, this goes red with the toast text and the stack.
//
// DOM strategy: a tiny element stub (the tests/modal.test.js pattern) before
// the app modules import. confirmTx is a promise wired to #confirmYes.onclick,
// so a driver interval clicks each fresh confirmation the moment it appears —
// the same thing a human does, in the same order (mainnet warning, then the
// sign confirmation).
//
// Safety: throwaway recipient addresses generated here; keys are anvil's
// public dev keys from fork-helper; nothing real, nothing printed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, stopFork, forkSkipReason, deployErc20, ANVIL_ACCOUNT, ANVIL_KEY } from './fork-helper.mjs';

const skip = forkSkipReason();

// ── storage shims (journey.test.js pattern): state.js writes activity here ──
const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
};
globalThis.localStorage = store();
globalThis.sessionStorage = store();

// ── DOM stub: one persistent element per selector, listener-recording ──
function makeClassList() {
  const set = new Set();
  return {
    add: (...n) => { for (const x of n) set.add(x); },
    remove: (...n) => { for (const x of n) set.delete(x); },
    toggle: (n, force) => {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      return want;
    },
    contains: (n) => set.has(n),
  };
}
const created = []; // every document.createElement target, for toast capture
function makeEl(name = '') {
  return {
    name, innerHTML: '', textContent: '', value: '', disabled: false,
    className: '', dataset: {}, style: {}, tabIndex: 0, offsetParent: {},
    focus() {}, remove() {},
    classList: makeClassList(),
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { created.push(c); return c; },
  };
}
const els = new Map();
const el = (sel) => {
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};
const gasBtn = makeEl('.gas-btn.active');
gasBtn.dataset.speed = 'normal';

globalThis.document = {
  // Auto-create on demand: openModal writes innerHTML and the browser then
  // finds #confirmYes inside it — the stub answers the same way, with one
  // persistent element per selector so onclick assignments survive re-reads.
  querySelector: (sel) => {
    if (sel === '.gas-btn.active') return gasBtn;
    return el(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => els.has('#' + id) ? els.get('#' + id) : null,
  createElement: (tag) => { const e = makeEl(tag); created.push(e); return e; },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
  activeElement: null,
};
el('#toast-wrap'); // toast() appends here — absent would throw in toast itself

// App modules, imported AFTER the stubs exist (ui.js wires document at import).
const { ethers } = await import('ethers');
globalThis.ethers = ethers;
const state = await import('../../js/state.js');
const netMod = await import('../../js/network.js');
const sendMod = await import('../../js/send.js');

/** Toast texts captured so far (className starts with "toast"). */
const toasts = () => created
  .filter((e) => typeof e.className === 'string' && e.className.startsWith('toast'))
  .map((e) => e.textContent);

/**
 * Click every fresh confirmTx "Yes" the moment it is wired — mainnet warning
 * and sign confirmation both come through here, in order. A settled modal's
 * onclick is the same function reference, so it never fires twice.
 */
function driveModals(promise) {
  let last = null;
  const iv = setInterval(() => {
    const yes = els.get('#confirmYes');
    if (yes && typeof yes.onclick === 'function' && yes.onclick !== last) {
      last = yes.onclick;
      yes.onclick();
    }
  }, 20);
  return promise.finally(() => clearInterval(iv));
}

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});

/** Poll until `get()` equals `want` (anvil receipts fall to the remote RPC on
 *  some networks; the balance change is the assertion — fork-send.test.js). */
async function poll(label, get, want, ms = 75000) {
  const deadline = Date.now() + ms;
  let v = await get();
  while (v !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    v = await get();
  }
  return { ok: v === want, value: v };
}

function armSendForm({ to, amount, token, speed = 'normal' }) {
  state.set('unlocked', true);
  state.set('address', ANVIL_ACCOUNT);
  state.set('activity', []);
  state.set('signer', new ethers.Wallet(ANVIL_KEY)); // provider attached by doSend
  el('#sendTo').value = to;
  el('#sendAmount').value = amount;
  el('#sendToken').value = token;
  el('#btnSend').disabled = false;
  // The speed the form shows — doSend reads .gas-btn.active. The native leg
  // runs "fast" so the multiplier path (buildFeeParams x120) is the thing
  // that actually broadcasts, not just a unit-test artifact.
  gasBtn.dataset.speed = speed;
}

test('fork: doSend() native — the Send button really broadcasts', { skip }, async () => {
  const { provider, network } = await startFork();
  state.set('provider', provider);
  const appNet = netMod.getAllNetworks().find((n) => n.chainId === network.chainId);
  assert.ok(appNet, `fork chainId ${network.chainId} tidak dikenal tabel jaringan aplikasi`);
  state.set('networkId', appNet.id);
  state.set('tokens', [{ address: null, symbol: 'ETH', decimals: 18, balance: 0n }]);

  // Fresh address: zero base-state balance, so any movement is the fork's own
  // (0xdEaD holds a remote balance anvil reads past local txs — foundry#4700).
  const to = ethers.Wallet.createRandom().address;
  const value = ethers.parseEther('0.001');
  armSendForm({ to, amount: '0.001', token: 'native', speed: 'fast' });
  // Capture the fee the node quotes now: the fast leg must land ON CHAIN with
  // a cap strictly above it (x120 applied, ± one block of base-fee drift is
  // never enough to hide a 20% lift). Before fee-params.js the cap went out
  // raw and this equality is exactly what a "no-op button" looked like.
  const feeBefore = await provider.getFeeData();

  await driveModals(sendMod.doSend());

  // Broadcast proof first: an activity entry with a real hash means doSend got
  // a hash back from the node — the click produced an on-chain transaction.
  const activity = state.get('activity');
  assert.equal(activity.length, 1, `aktivitas harus 1, dapat ${activity.length}; toasts=${JSON.stringify(toasts())}`);
  assert.match(activity[0].hash, /^0x[0-9a-f]{64}$/, `hash aneh: ${activity[0].hash}`);
  assert.equal(activity[0].type, 'send');
  assert.equal(activity[0].to, to);

  // The speed reached the wire: the mined tx carries a bigger cap than the
  // pre-send quote (fast = x120; a raw fee would be equal, not greater).
  const sent = await provider.getTransaction(activity[0].hash);
  assert.ok(sent.maxFeePerGas > feeBefore.maxFeePerGas,
    `fast fee tak terkirim: tx ${sent.maxFeePerGas} vs kutipan ${feeBefore.maxFeePerGas}`);

  // On-chain truth: the recipient actually holds the ETH.
  const r = await poll('native', async () => await provider.getBalance(to), value);
  assert.ok(r.ok, `saldo penerima ${r.value} != ${value}; toasts=${JSON.stringify(toasts())}`);
});

test('fork: doSend() ERC-20 — c.transfer path broadcasts', { skip }, async () => {
  const { provider, signer, network } = await startFork();
  state.set('provider', provider);
  const appNet = netMod.getAllNetworks().find((n) => n.chainId === network.chainId);
  assert.ok(appNet, `fork chainId ${network.chainId} tidak dikenal tabel jaringan aplikasi`);
  state.set('networkId', appNet.id);

  const token = await deployErc20(signer);
  state.set('tokens', [{ address: token.target, symbol: 'FBR', decimals: 18, balance: 0n }]);

  const to = ethers.Wallet.createRandom().address;
  const want = ethers.parseUnits('10', 18);
  armSendForm({ to, amount: '10', token: token.target });

  await driveModals(sendMod.doSend());

  const activity = state.get('activity');
  assert.equal(activity.length, 1, `aktivitas harus 1, dapat ${activity.length}; toasts=${JSON.stringify(toasts())}`);
  assert.match(activity[0].hash, /^0x[0-9a-f]{64}$/, `hash aneh: ${activity[0].hash}`);

  const r = await poll('erc20', async () => await token.balanceOf(to), want);
  assert.ok(r.ok, `saldo token penerima ${r.value} != ${want}; toasts=${JSON.stringify(toasts())}`);
});
