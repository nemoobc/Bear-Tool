import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
globalThis.localStorage = { getItem: () => null, setItem() {} };
const elements = new Map();
function element() {
  return {
    value: '', innerHTML: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {},
    options: []
  };
}
globalThis.document = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  },
  createElement: element,
  body: element()
};
const state = await import('../js/state.js');
const bridge = await import('../js/bridge.js');
const account = '0x1111111111111111111111111111111111111111';

test('bridge: provider chain changes across awaited promise', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline only'); });
  const toasts = [];
  t.mock.method(document.querySelector('#toast-wrap'), 'appendChild', el => toasts.push(el.textContent));
  for (const [selector, value] of Object.entries({
    '#bridgeFromChain': 'sepolia', '#bridgeToChain': 'bsc-testnet',
    '#bridgeToken': 'native', '#bridgeAmount': '0.5'
  })) document.querySelector(selector).value = value;
  state.set('unlocked', true);
  state.set('networkId', 'sepolia');
  state.set('address', account);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  state.set('provider', { async getNetwork() {
    calls++;
    if (calls === 1) return { chainId: 11155111n };
    await gate;
    return { chainId: 97n };
  } });
  state.set('bridgeQuote', {
    simulated: false,
    context: { networkId: 'sepolia', chainId: 11155111, fromChainId: 11155111, toChainId: 97,
      address: account, token: 'native', amount: '0.5', amountSmallest: '500000000000000000' },
    tx: { to: '0x2222222222222222222222222222222222222222', data: '0x12345678', value: 500000000000000000n, chainId: 11155111 }
  });
  let signerReads = 0;
  Object.defineProperty(state.get(), 'signer', { configurable: true, get() { signerReads++; throw new Error('Unexpected signer access'); } });
  try {
    const pending = bridge.doBridgeExec();
    await Promise.resolve();
    assert.equal(calls, 2);
    release();
    await pending;
    assert.equal(signerReads, 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(toasts.length, 1);
  } finally {
    Object.defineProperty(state.get(), 'signer', { configurable: true, writable: true, value: null });
  }
});

test('bridge: account change during provider await cannot access signer', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected fetch: offline test'); });
  const toasts = [];
  t.mock.method(document.querySelector('#toast-wrap'), 'appendChild', el => toasts.push(el.textContent));
  for (const [selector, value] of Object.entries({
    '#bridgeFromChain': 'sepolia', '#bridgeToChain': 'bsc-testnet',
    '#bridgeToken': 'native', '#bridgeAmount': '0.5'
  })) document.querySelector(selector).value = value;
  state.set('unlocked', true);
  state.set('networkId', 'sepolia');
  state.set('address', account);
  let resolveNetwork;
  let calls = 0;
  state.set('provider', { getNetwork() {
    calls++;
    return calls === 1 ? new Promise(resolve => { resolveNetwork = resolve; }) : Promise.resolve({ chainId: 11155111n });
  } });
  state.set('bridgeQuote', {
    simulated: false,
    context: { networkId: 'sepolia', chainId: 11155111, fromChainId: 11155111, toChainId: 97,
      address: account, token: 'native', amount: '0.5', amountSmallest: '500000000000000000' },
    tx: { to: '0x2222222222222222222222222222222222222222', data: '0x12345678', value: 500000000000000000n, chainId: 11155111 }
  });
  let signerReads = 0;
  Object.defineProperty(state.get(), 'signer', { configurable: true, get() { signerReads++; throw new Error('Signer must not be accessed'); } });
  try {
    const pending = bridge.doBridgeExec();
    state.set('address', '0x3333333333333333333333333333333333333333');
    resolveNetwork({ chainId: 11155111n });
    await pending;
    assert.equal(signerReads, 0);
    assert.deepEqual(toasts, ['Bridge context changed. Get a new route.']);
  } finally {
    Object.defineProperty(state.get(), 'signer', { configurable: true, writable: true, value: null });
  }
});

// ── shared fixture: valid quote-shaped context + spy signer (never real) ──
function validQuote() {
  return {
    simulated: false,
    context: { networkId: 'sepolia', chainId: 11155111, fromChainId: 11155111, toChainId: 97,
      address: account, token: 'native', amount: '0.5', amountSmallest: '500000000000000000' },
    tx: { to: '0x2222222222222222222222222222222222222222', data: '0x12345678', value: 500000000000000000n, chainId: 11155111 }
  };
}

function setupExec(t, { quote = validQuote(), providerChain = 11155111n, signerAddress = account, form = {} } = {}) {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access in offline test'); });
  const toasts = [];
  t.mock.method(document.querySelector('#toast-wrap'), 'appendChild', el => toasts.push(el.textContent));
  const el = (sel) => document.querySelector(sel);
  el('#bridgeFromChain').value = form.fromChain ?? 'sepolia';
  el('#bridgeToChain').value = form.toChain ?? 'bsc-testnet';
  el('#bridgeToken').value = form.token ?? 'native';
  el('#bridgeAmount').value = form.amount ?? '0.5';
  state.set('unlocked', true);
  state.set('networkId', form.networkId ?? 'sepolia');
  state.set('address', form.address ?? account);
  state.set('provider', { async getNetwork() { return { chainId: BigInt(providerChain) }; } });
  const spy = { calls: 0, tx: null };
  state.set('signer', {
    address: signerAddress,
    connect() { return this; },
    async sendTransaction(tx) { spy.calls++; spy.tx = tx; return { hash: '0x' + 'a'.repeat(64), wait: async () => ({ status: 1 }) }; }
  });
  state.set('bridgeQuote', quote);
  return { toasts, spy };
}

test('bridge: matching native happy path signs quote-bound tx via spy only', async (t) => {
  const { toasts, spy } = setupExec(t);
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 1, 'exactly one sendTransaction via spy');
  assert.equal(spy.tx.to, '0x2222222222222222222222222222222222222222');
  assert.equal(spy.tx.value, 500000000000000000n);
  assert.equal(spy.tx.chainId, 11155111);
  assert.ok(toasts.some(m => m.includes('sent')));
});

test('bridge: wrong active chain (state) rejects before signer', async (t) => {
  const { toasts, spy } = setupExec(t, { form: { networkId: 'bsc-testnet' } });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('active network')));
});

test('bridge: wrong live provider chain rejects before signing', async (t) => {
  const { toasts, spy } = setupExec(t, { providerChain: 999 });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('active network')));
});

test('bridge: quote chain drift (form edited after quote) rejects', async (t) => {
  const { toasts, spy } = setupExec(t, { form: { toChain: 'arbitrum-sepolia' } });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('no longer matches')));
});

test('bridge: account change rejects (state + signer identity)', async (t) => {
  const { toasts, spy } = setupExec(t, { signerAddress: '0x7777777777777777777777777777777777777777' });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('account changed')));
});

test('bridge: stale amount (form edited after quote) rejects', async (t) => {
  const { toasts, spy } = setupExec(t, { form: { amount: '42' } });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('no longer matches')));
});

test('bridge: ERC-20 selection is rejected loudly at quote, never signed', async (t) => {
  const { toasts, spy } = setupExec(t, { quote: null, form: { token: '0xdAC17F958D2ee523a2206206994597C13D831ec7' } });
  await bridge.doBridge();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.toLowerCase().includes('native token bridging is supported')));
  assert.equal(state.get('bridgeQuote'), null, 'no quote may exist for ERC-20 attempt');
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'no network call for ERC-20 selection');
});

test('bridge: absent / old unbound quote rejects before signer access', async (t) => {
  for (const bad of [null, { simulated: true }, { transactionRequest: { to: '0x1' } }]) {
    const { toasts, spy } = setupExec(t, { quote: bad });
    await bridge.doBridgeExec();
    assert.equal(spy.calls, 0, 'no signing for unbound quote: ' + JSON.stringify(bad));
    assert.ok(toasts.some(m => m.includes('valid route')));
  }
});

test('bridge: token select renders native-only with clear label', () => {
  state.set('networkId', 'sepolia');
  state.set('tokens', [{ address: null, symbol: 'ETH', decimals: 18 }]);
  bridge.loadBridgeChains();
  const html = document.querySelector('#bridgeToken').innerHTML;
  assert.ok(html.includes('value="native"'), 'only native option offered');
  assert.ok(html.includes('native only'), 'clear native-only label');
  assert.ok(!html.includes('USDT') && !html.includes('value="0x'), 'no ERC-20 options pretended');
});

// ═════════ doBridge behavior — REAL call with mocked fetch ═════════

const NATIVE_HEX = '0x0000000000000000000000000000000000000000';
const ROUTER = '0x4444444444444444444444444444444444444444';

// Valid LI.FI-shaped native quote. Params let tests shape the response
// for a specific chain pair (e.g. ethereum → bsc-testnet).
function validResponse({ fromChainId = 11155111, toChainId = 97, amount = '500000000000000000' } = {}) {
  return {
    estimate: { fromAmount: amount, toAmount: '490000000000000000' },
    action: {
      fromChainId, toChainId,
      fromToken: { address: NATIVE_HEX }, toToken: { address: NATIVE_HEX },
      fromAddress: account, toAddress: account,
      fromAmount: amount
    },
    transactionRequest: { to: ROUTER, data: '0xdeadbeef', value: amount, chainId: fromChainId, gasLimit: '300000' }
  };
}

function setupQuote(t, { amount = '0.5', fromChain = 'sepolia', toChain = 'bsc-testnet' } = {}) {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('set fetchResponse'); });
  const toasts = [];
  t.mock.method(document.querySelector('#toast-wrap'), 'appendChild', el => toasts.push(el.textContent));
  const el = (sel) => document.querySelector(sel);
  el('#bridgeFromChain').value = fromChain;
  el('#bridgeToChain').value = toChain;
  el('#bridgeToken').value = 'native';
  el('#bridgeAmount').value = amount;
  state.set('unlocked', true);
  state.set('networkId', fromChain);
  state.set('address', account);
  state.set('bridgeQuote', { simulated: false, old: 'stale quote must die' });
  return { fetchMock, toasts, el };
}

test('doBridge: valid native response binds context + tx (real call, mocked fetch)', async (t) => {
  const { fetchMock } = setupQuote(t);
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => validResponse() }));
  await bridge.doBridge();
  const q = state.get('bridgeQuote');
  assert.ok(q && !q.simulated, 'quote must be bound');
  assert.equal(q.context.fromChainId, 11155111);
  assert.equal(q.context.toChainId, 97);
  assert.equal(q.context.address.toLowerCase(), account.toLowerCase());
  assert.equal(q.context.amount, '0.5');
  assert.equal(q.context.amountSmallest, '500000000000000000');
  assert.equal(q.tx.to.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(q.tx.value, 500000000000000000n);
  const reqUrl = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(reqUrl.searchParams.get('toAddress'), account, 'toAddress must be requested explicitly');
  assert.equal(reqUrl.searchParams.get('fromToken'), NATIVE_HEX);
  assert.equal(reqUrl.searchParams.get('toToken'), NATIVE_HEX);
});

test('doBridge: malformed response field (fromAmount inflated) rejected, no quote bound', async (t) => {
  const { fetchMock } = setupQuote(t);
  const bad = validResponse();
  bad.action.fromAmount = '900000000000000000';
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  const q = state.get('bridgeQuote');
  assert.equal(q, null, 'malformed quote must never bind');
});

test('doBridge: wrong destination (attacker toAddress) rejected', async (t) => {
  const { fetchMock } = setupQuote(t);
  const bad = validResponse();
  bad.action.toAddress = '0x9999999999999999999999999999999999999999';
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  const q = state.get('bridgeQuote');
  assert.equal(q, null, 'toAddress mismatch must never bind');
});

test('doBridge: missing toAddress in response rejected (explicit match required)', async (t) => {
  const { fetchMock } = setupQuote(t);
  const bad = validResponse();
  delete bad.action.toAddress;
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null);
});

test('doBridge: non-hex calldata rejected (regex, not just prefix)', async (t) => {
  const { fetchMock } = setupQuote(t);
  const bad = validResponse();
  bad.transactionRequest.data = '0xZZnot-hex!!';
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null, 'non-hex calldata must never bind');
});

test('doBridge: old request race — late stale response cannot overwrite newer quote', async (t) => {
  const { fetchMock } = setupQuote(t, { amount: '0.5' });
  let resolveFirst, resolveSecond;
  const firstGate = new Promise(r => { resolveFirst = r; });
  const secondGate = new Promise(r => { resolveSecond = r; });
  let call = 0;
  fetchMock.mock.mockImplementation(async () => {
    call++;
    if (call === 1) { await firstGate; return { ok: true, json: async () => validResponse() }; }
    await secondGate;
    const second = validResponse({ amount: '600000000000000000' }); // matches p2's 0.6
    second.transactionRequest.data = '0xbeef'; // valid hex, distinct from 0xdeadbeef
    return { ok: true, json: async () => second };
  });
  const p1 = bridge.doBridge();
  await new Promise(r => setImmediate(r));
  document.querySelector('#bridgeAmount').value = '0.6';
  const p2 = bridge.doBridge();
  await new Promise(r => setImmediate(r));
  assert.equal(state.get('bridgeQuote'), null, 'second request must clear state before fetch');
  resolveSecond();
  await new Promise(r => setImmediate(r));
  assert.equal(state.get('bridgeQuote')?.tx?.data, '0xbeef', 'newest response binds first');
  resolveFirst();
  await p1; await p2;
  const q = state.get('bridgeQuote');
  assert.equal(q?.tx?.data, '0xbeef', 'stale seq response must be discarded');
  assert.equal(q?.context?.amount, '0.6');
});

test('doBridge: old unbound quote cleared before confirmTx await (state cleared pre-await)', async (t) => {
  const { fetchMock } = setupQuote(t);
  // mainnet chain → confirmTx path exercises the pre-await clear
  document.querySelector('#bridgeFromChain').value = 'ethereum';
  state.set('networkId', 'ethereum');
  let fetchCalled = false;
  fetchMock.mock.mockImplementation(async () => {
    fetchCalled = true;
    return { ok: true, json: async () => validResponse({ fromChainId: 1 }) };
  });
  const pending = bridge.doBridge();
  await new Promise(r => setImmediate(r));
  assert.equal(state.get('bridgeQuote'), null, 'old quote must already be gone while confirmTx is pending');
  assert.equal(fetchCalled, false, 'no fetch before user confirms');
  state.set('bridgeQuote', { simulated: true }); // something sneaks in during confirm — must be cleared
  const yes = document.querySelector('#confirmYes');
  yes.onclick();
  await pending;
  assert.equal(fetchCalled, true, 'after confirm, fetch proceeds');
  assert.equal(state.get('bridgeQuote')?.context?.fromChainId, 1);
});
