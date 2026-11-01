// Bear Tool — swap-approve-revert.test.js
//
// A reverted approval is an ON-CHAIN OUTCOME (status 0) and doSwap used to
// ignore it: only `timedOut` was read off waitForReceipt, so a token that
// REFUSED the approval (blacklist, zero-first rule, pausable) walked the
// user straight into broadcasting a swap whose allowance never moved —
// doomed at the router, after the approval's gas was already burned, with
// the router's revert noise instead of the real reason.
//
// This drives the REAL doSwap with a recording fake ethers.Contract: the
// approve comes back as CALL_EXCEPTION + receipt status 0, and the swap
// broadcast must never be attempted. No chain needed — the fake sits where
// globalThis.ethers.Contract is read (swap.js destructures it at import).
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

// ── DOM stub: one persistent element per selector ──
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
const created = [];
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

globalThis.document = {
  querySelector: (sel) => el(sel),
  querySelectorAll: () => [],
  getElementById: (id) => els.has('#' + id) ? els.get('#' + id) : null,
  createElement: (tag) => { const e = makeEl(tag); created.push(e); return e; },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
  activeElement: null,
};
el('#toast-wrap');

// ── ethers: real arithmetic, recording Contract ──
const realEthers = (await import('ethers')).ethers;
globalThis.ethers = realEthers;

const state = await import('../js/state.js');
const netMod = await import('../js/network.js');

const calls = [];                       // every Contract member access
const FROM = '0x' + '11'.repeat(20);
const TOKEN = '0x' + '33'.repeat(20);
const ROUTER = '0x' + '44'.repeat(20);

function fakeTx({ fail = false } = {}) {
  return {
    hash: '0x' + '22'.repeat(32),
    wait: async () => {
      if (fail) {
        const e = new Error('execution reverted');
        e.code = 'CALL_EXCEPTION';
        e.receipt = { status: 0 };
        throw e;
      }
      return { status: 1 };
    },
  };
}

function FakeContract(addr) {
  const fn = async (...args) => { calls.push({ addr, prop: fn.__prop, args }); return {}; };
  return new Proxy(fn, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;           // never treat as thenable
      calls.push({ addr, prop });
      if (prop === 'balanceOf') return async () => 10n ** 24n;
      if (prop === 'allowance') return async () => 0n; // no allowance → approve path
      if (prop === 'approve') return async () => fakeTx({ fail: true });
      if (prop === 'WETH') return async () => '0x' + 'aa'.repeat(20);
      const m = async (...args) => { calls.push({ addr, prop: prop + '.call', args }); return {}; };
      m.populateTransaction = async (...args) => {
        calls.push({ addr, prop: prop + '.populate', args });
        return { to: addr, data: '0x' };
      };
      return m;
    },
  });
}

// Shadow Contract on a plain copy of real ethers BEFORE swap.js imports: it
// destructures globalThis.ethers at module scope. A spread, not Object.create:
// the ethers export is a module namespace whose properties are frozen, so
// shadowing via the prototype chain throws in strict mode.
const fakeEthers = { ...realEthers, Contract: FakeContract };
globalThis.ethers = fakeEthers;

const swapMod = await import('../js/swap.js');
// ── signer stub ──
const signerCalls = [];
const signerStub = {
  address: FROM,
  connect: () => signerStub,
  estimateGas: async () => 280000n,
  sendTransaction: async (req) => { signerCalls.push(req); return fakeTx(); },
};

const toasts = () => created
  .filter((e) => typeof e.className === 'string' && e.className.startsWith('toast'))
  .map((e) => e.textContent);

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

test('doSwap aborts on a REVERTED approval instead of broadcasting a doomed swap', async () => {
  const net = netMod.getNetworkById('sepolia');
  state.set('unlocked', true);
  state.set('address', FROM);
  state.set('provider', null);
  state.set('signer', signerStub);
  state.set('networkId', 'sepolia');
  state.set('tokens', [{ address: TOKEN, symbol: 'TOK', decimals: 18, balance: (10n ** 24n).toString() }]);
  state.set('activity', []);
  state.set('swapQuote', {
    amountInWei: realEthers.parseUnits('10', 18).toString(),
    fromToken: TOKEN,
    toToken: 'native',
    chainId: net.chainId,
    source: 'Uniswap V2',
    uniswap: { kind: 'v2', router: ROUTER },
  });

  el('#swapFromAmount').value = '10';
  el('#swapFrom').value = TOKEN;
  el('#swapTo').value = 'native';
  el('#btnSwap').disabled = false;

  await driveModals(swapMod.doSwap());

  const approveCalls = calls.filter((c) => c.prop === 'approve');
  assert.equal(approveCalls.length, 1, `the approval must be attempted once, got ${approveCalls.length}`);
  assert.equal(approveCalls[0].addr, TOKEN, 'the approval goes to the token');

  const swapTried = calls.some((c) => String(c.prop).startsWith('swapExactTokensForTokens'));
  assert.equal(swapTried, false,
    'the swap must NOT be built after a reverted approval — the allowance never moved');
  assert.equal(signerCalls.length, 0, 'no swap broadcast after a reverted approval');
  assert.equal(state.get('activity').length, 0, 'no phantom activity row for a swap that never went out');
  assert.ok(
    toasts().some((s) => /approval failed on chain/i.test(s)),
    `the user must be told the approval refused it; toasts=${JSON.stringify(toasts())}`);
});
