// Bear Tool — send-preview-honest.test.js
//
// Two bugs the unit gate could not see before, both in updateSendPreview:
//
// 1. HONESTY: a node that answers getFeeData() with nulls (several L2s
//    without feeHistory) multiplied out to 0n, and the preview printed a
//    confident "Gas: ~0.0 ETH" — a lie about a free transaction. The confirm
//    dialog already treats 0n gas as unreadable (ui.js totalPriceRow:
//    knownGas = gas > 0n), and the preview must not disagree with it.
//
// 2. RACE: the function is async (a fee fetch sits in the middle) and
//    nothing ordered its writers. A slow answer for an EARLIER amount could
//    land after a fast one for the current amount and repaint the preview
//    with numbers the fields no longer hold. Every invocation now claims a
//    monotonic sequence; a claimant that lost while awaiting writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── storage shims (fork-doSend pattern) ──
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

// ── DOM stub ──
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
    appendChild(c) { return c; },
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
  querySelector: (sel) => (sel === '.gas-btn.active' ? gasBtn : el(sel)),
  querySelectorAll: () => [],
  getElementById: (id) => els.has('#' + id) ? els.get('#' + id) : null,
  createElement: (tag) => makeEl(tag),
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
  activeElement: null,
};

const { ethers } = await import('ethers');
globalThis.ethers = ethers;

const state = await import('../js/state.js');
const sendMod = await import('../js/send.js');

const FROM = '0x' + '11'.repeat(20);
const ADDR_A = '0x' + 'aa'.repeat(20);
const ADDR_B = '0x' + 'bb'.repeat(20);
const HEALTHY = { gasPrice: 10n ** 9n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n };
const DEAD = { gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null };

function armForm({ to, amount }) {
  state.set('address', FROM);
  state.set('networkId', 'sepolia');
  state.set('tokens', [{ address: null, symbol: 'ETH', decimals: 18, balance: (10n ** 18n).toString(), usd: 0 }]);
  el('#sendTo').value = to;
  el('#sendAmount').value = amount;
  el('#sendToken').value = 'native';
  el('#sendPreview').classList.remove('hidden');
}

test('an unreadable fee leaves the gas row at "—", never a confident ~0.0', async () => {
  state.set('provider', { getFeeData: async () => DEAD });
  armForm({ to: ADDR_A, amount: '1' });
  // A stale figure from the previous preview must not survive this one.
  el('#gasEstValue').textContent = '0.42 ETH';
  el('#gasEstUsd').textContent = '$999.00';

  await sendMod.updateSendPreview();

  const preview = el('#sendPreview');
  assert.doesNotMatch(preview.innerHTML, /Gas:/, `no gas line when the fee is unknown: ${preview.innerHTML}`);
  assert.equal(el('#gasEstValue').textContent, '—', 'the Est. gas row must reset to an honest dash');
  assert.equal(el('#gasEstUsd').textContent, '', 'no dollar price we do not have');
  assert.match(preview.innerHTML, /Sending/, 'the amount/recipient preview still renders');
});

test('a healthy fee still prices the preview (regression)', async () => {
  state.set('provider', { getFeeData: async () => HEALTHY });
  armForm({ to: ADDR_A, amount: '1' });
  el('#gasEstValue').textContent = '—';

  await sendMod.updateSendPreview();

  assert.match(el('#sendPreview').innerHTML, /Gas: ~/, 'a known fee must show its line');
  assert.match(el('#gasEstValue').textContent, /ETH/, 'the Est. gas row must carry the number');
});

test('a slow answer for an OLD amount never repaints over the current one', async () => {
  const resolvers = [];
  state.set('provider', { getFeeData: () => new Promise((res) => resolvers.push(res)) });
  const tick = () => new Promise((r) => setTimeout(r, 10));

  armForm({ to: ADDR_A, amount: '1' });
  const first = sendMod.updateSendPreview();   // slow: its fee lands last
  armForm({ to: ADDR_B, amount: '2' });
  const second = sendMod.updateSendPreview();  // fast: the CURRENT keystroke

  assert.equal(resolvers.length, 2, 'both previews are waiting on a fee read');
  resolvers[1](HEALTHY);                       // current answer lands first
  await second;
  await tick();
  resolvers[0](HEALTHY);                       // stale answer lands late
  await first;
  await tick();

  const html = el('#sendPreview').innerHTML;
  assert.match(html, />2</, `preview must show the current amount: ${html}`);
  assert.doesNotMatch(html, />1</, 'the stale amount must not repaint over the current one');
  const wallet = await import('../js/wallet.js');
  assert.ok(html.includes(wallet.shortAddress(ADDR_B)), 'the preview must address the current recipient');
  assert.ok(!html.includes(wallet.shortAddress(ADDR_A)), 'the stale recipient must be gone');
});
