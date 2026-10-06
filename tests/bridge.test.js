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
    // Sign confirmation renders before runTx touches the provider.
    await new Promise(r => setImmediate(r));
    const yes = document.querySelector('#confirmYes');
    assert.ok(yes && typeof yes.onclick === 'function', 'sign confirm rendered');
    yes.onclick();
    await Promise.resolve();
    release();
    await pending;
    assert.equal(calls, 2); // preNet guard (1) + runTx netPre (2) — drift caught before netPost
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
    // New pre-confirm guard awaits getNetwork (call 1) FIRST: resolve it,
    // then the sign confirmation renders, then the account drift is seen by
    // the post-await re-check inside runTx and the signer is never touched.
    await new Promise(r => setImmediate(r));
    resolveNetwork({ chainId: 11155111n });
    await new Promise(r => setImmediate(r));
    const yes = document.querySelector('#confirmYes');
    assert.ok(yes && typeof yes.onclick === 'function', 'sign confirm rendered');
    state.set('address', '0x3333333333333333333333333333333333333333');
    yes.onclick();
    await new Promise(r => setImmediate(r));
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
  elements.clear(); // no DOM leakage between tests (confirmYes etc. are per-test)
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
  const pending = bridge.doBridgeExec();
  await new Promise(r => setImmediate(r));
  const yes = document.querySelector('#confirmYes');
  assert.ok(yes && typeof yes.onclick === 'function', 'sign confirm rendered');
  yes.onclick();
  await pending;
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
  // Anti-dialog proof: wrong chain must reject BEFORE the sign confirmation renders.
  const yes = document.querySelector('#confirmYes');
  assert.ok(!yes || typeof yes.onclick !== 'function', 'no sign dialog may render on wrong chain');
});

test('bridge: quote chain drift (form edited after quote) rejects', async (t) => {
  const { toasts, spy } = setupExec(t, { form: { toChain: 'arbitrum-sepolia' } });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('no longer matches')));
});

test('bridge: account change rejects (state + signer identity)', async (t) => {
  const { toasts, spy } = setupExec(t, { signerAddress: '0x7777777777777777777777777777777777777777' });
  const pending = bridge.doBridgeExec();
  await new Promise(r => setImmediate(r));
  const yes = document.querySelector('#confirmYes');
  assert.ok(yes && typeof yes.onclick === 'function', 'sign confirm rendered');
  yes.onclick();
  await pending;
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('account changed')));
});

test('bridge: stale amount (form edited after quote) rejects', async (t) => {
  const { toasts, spy } = setupExec(t, { form: { amount: '42' } });
  await bridge.doBridgeExec();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.includes('no longer matches')));
});

test('bridge: unknown ERC-20 (not curated for this chain) rejected loudly, no fetch', async (t) => {
  // Spec change 2026-10-05: ERC-20 IS now supported, but only curated tokens
  // — an address the wallet cannot map to a destination-chain twin must never
  // reach LI.FI (a wrong toToken would be a wrong-contract bridge).
  const { toasts, spy } = setupExec(t, { quote: null, form: { token: '0xdAC17F958D2ee523a2206206994597C13D831ec7' } });
  await bridge.doBridge();
  assert.equal(spy.calls, 0);
  assert.ok(toasts.some(m => m.toLowerCase().includes('no curated')), 'honest rejection naming the real reason');
  assert.equal(state.get('bridgeQuote'), null, 'no quote may exist for an unmappable token');
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'no network call for an unmappable token');
});

test('bridge: absent / old unbound quote rejects before signer access', async (t) => {
  for (const bad of [null, { simulated: true }, { transactionRequest: { to: '0x1' } }]) {
    const { toasts, spy } = setupExec(t, { quote: bad });
    await bridge.doBridgeExec();
    assert.equal(spy.calls, 0, 'no signing for unbound quote: ' + JSON.stringify(bad));
    assert.ok(toasts.some(m => m.includes('valid route')));
  }
});

test('bridge: token picker shows 2 options — native + the common curated stable', () => {
  // Spec 2026-10-05: the picker had ONE option (native) — "pemilihan tokennya 1
  // harusnya ada 2". Second slot = first stable family (USDC > USDT > USDB >
  // DAI > WETH > WBTC — order pinned by FAMILY_PRIORITY in js/bridge.js)
  // curated on BOTH the source and destination chain, so the twin address for
  // the quote always exists. sepolia ∩ ethereum = USDC.
  state.set('networkId', 'sepolia');
  state.set('tokens', [{ address: null, symbol: 'ETH', decimals: 18 }]);
  // The mock element keeps .value independently of innerHTML (and its
  // .options array is empty, so loadBridgeChains' own defaulting is a no-op)
  // — pin the pair explicitly, otherwise #bridgeToChain carries the previous
  // test's destination (bsc-testnet, no curated list) and option #2 never
  // qualifies. sepolia ∩ ethereum = USDC.
  document.querySelector('#bridgeFromChain').value = 'sepolia';
  document.querySelector('#bridgeToChain').value = 'ethereum';
  bridge.loadBridgeChains();
  const el = document.querySelector('#bridgeToken');
  const html = el.innerHTML;
  const opts = [...html.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  assert.ok(opts.includes('native'), 'native always offered');
  assert.equal(opts.length, 2, `exactly 2 options, got: ${opts.join(', ')}`);
  assert.ok(opts.includes('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),
    'second slot is sepolia USDC (source-chain address of the common stable)');
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
  // These tests pin the LI.FI contract (li.quest URL, validated response), so
  // they pick that router explicitly. Auto = all candidates in parallel is
  // covered by tests/bridge-routes.test.js; a mock meant for one provider
  // must not be read by the other adapters.
  el('#bridgeRouterSelect').value = 'lifi';
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

test('doBridge: NUMERIC_FAULT amount kills the in-flight quote response (seq bump)', async (t) => {
  // bridge.js:440 bumps quoteSeq when parseUnits throws — without the bump
  // a response already on the wire could bind a quote for an amount that
  // never parsed. Race it for real: quote 1 in flight, then a 7-decimal
  // amount against 6-decimal USDC, then let response 1 land.
  const { fetchMock, toasts, el } = setupERC20Quote(t);
  let resolveGate;
  const gate = new Promise(r => { resolveGate = r; });
  fetchMock.mock.mockImplementation(async () => {
    await gate;
    return { ok: true, json: async () => erc20Response() };
  });
  const p1 = bridge.doBridge();                 // quote 1 now in flight
  await new Promise(r => setImmediate(r));
  assert.equal(fetchMock.mock.callCount(), 1, 'first quote request is on the wire');
  el('#bridgeAmount').value = '5.1234567';      // 7 decimals > USDC's 6
  await bridge.doBridge();                      // NUMERIC_FAULT → quoteSeq++
  assert.ok(toasts.some(m => m.toLowerCase().includes('decimal')), 'honest precision error');
  assert.equal(fetchMock.mock.callCount(), 1, 'the fault path never fetches');
  assert.equal(state.get('bridgeQuote'), null, 'fault path clears the quote');
  resolveGate();
  await p1;
  assert.equal(state.get('bridgeQuote'), null,
    'late response must NOT bind after the seq bump');
});

test('doBridge: auto-quote fetches immediately without confirmTx (safety at exec time)', async (t) => {
  const { fetchMock } = setupQuote(t);
  // mainnet chain → auto-quote path (no confirmTx in doBridge, only in doBridgeExec)
  document.querySelector('#bridgeFromChain').value = 'ethereum';
  state.set('networkId', 'ethereum');
  let fetchCalled = false;
  fetchMock.mock.mockImplementation(async () => {
    fetchCalled = true;
    return { ok: true, json: async () => validResponse({ fromChainId: 1 }) };
  });
  await bridge.doBridge();
  assert.equal(fetchCalled, true, 'fetch proceeds immediately (no confirm needed for quote)');
  assert.ok(state.get('bridgeQuote')?.context, 'quote context is set');
});

// ═════════ ERC-20 BRIDGE (spec 2026-10-05: 2 token di picker + approve flow) ═════════

const USDC_SEP = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // Sepolia USDC (curated)
const USDC_ARBSEP = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'; // Arb Sepolia USDC (curated)
const APPROVER = '0x5555555555555555555555555555555555555555';
const AMOUNT_5USDC = '5000000';

function erc20Response({ fromChainId = 11155111, toChainId = 421614, amount = AMOUNT_5USDC } = {}) {
  return {
    estimate: {
      fromAmount: amount, toAmount: '4990000', approvalAddress: APPROVER,
      executionDuration: 2, feeCosts: [], gasCosts: []
    },
    action: {
      fromChainId, toChainId,
      fromToken: { address: USDC_SEP, chainId: fromChainId, symbol: 'USDC', decimals: 6 },
      toToken: { address: USDC_ARBSEP, chainId: toChainId, symbol: 'USDC', decimals: 6 },
      fromAddress: account, toAddress: account, fromAmount: amount
    },
    transactionRequest: { to: ROUTER, data: '0xdeadbeef', value: '0x0', chainId: fromChainId, gasLimit: '300000' },
    includedSteps: [{ tool: 'across' }]
  };
}

function setupERC20Quote(t) {
  // amount '5' → parseUnits(5, 6) = 5000000 base units = AMOUNT_5USDC,
  // so the response's fromAmount matches the context exactly.
  const h = setupQuote(t, { toChain: 'arbitrum-sepolia', amount: '5' });
  h.el('#bridgeToken').value = USDC_SEP;
  return h;
}

test('doBridge: ERC-20 quote binds token addresses, 6-decimal amount, value 0x0, approvalAddress', async (t) => {
  const { fetchMock } = setupERC20Quote(t);
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => erc20Response() }));
  await bridge.doBridge();
  const q = state.get('bridgeQuote');
  assert.ok(q && !q.simulated, 'ERC-20 quote must bind');
  const reqUrl = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(reqUrl.searchParams.get('fromToken'), USDC_SEP, 'quote asks for the SELECTED source token');
  assert.equal(reqUrl.searchParams.get('toToken'), USDC_ARBSEP, 'quote asks for the destination twin');
  assert.equal(reqUrl.searchParams.get('fromAmount'), AMOUNT_5USDC, '5 USDC → base units of 6 decimals');
  assert.equal(q.context.tokenDecimals, 6, 'decimals travel with the context');
  assert.equal(q.context.tokenSymbol, 'USDC');
  assert.equal(q.approvalAddress.toLowerCase(), APPROVER.toLowerCase(), 'spender for approve must be bound');
  assert.equal(q.tx.value, 0n, 'ERC-20 bridge tx must carry value 0');
  assert.equal(q.context.amountSmallest, AMOUNT_5USDC);
});

test('doBridge: response token substituted (attacker fromToken) rejected', async (t) => {
  const { fetchMock } = setupERC20Quote(t);
  const bad = erc20Response();
  bad.action.fromToken.address = '0x0000000000000000000000000000000000000001';
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null, 'fromToken mismatch must never bind');
});

test('doBridge: ERC-20 quote carrying native-style value > 0 rejected', async (t) => {
  const { fetchMock } = setupERC20Quote(t);
  const bad = erc20Response();
  bad.transactionRequest.value = AMOUNT_5USDC;
  fetchMock.mock.mockImplementation(async () => ({ ok: true, json: async () => bad }));
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null, 'value > 0 on an ERC-20 route is a mismatch, never bound');
});

test('doBridge: destination chain has no curated twin → reject before any fetch', async (t) => {
  // bsc-testnet carries no curated list (research: no official source exists)
  const { fetchMock, toasts } = setupQuote(t, { toChain: 'bsc-testnet' });
  fetchMock.mock.mockImplementation(async () => { throw new Error('must not fetch'); });
  document.querySelector('#bridgeToken').value = USDC_SEP;
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null);
  assert.ok(toasts.some(m => m.toLowerCase().includes('no curated')), 'honest reason, zero network calls');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('decideApproval: skip/covered → none; empty → approve; stale partial → reset+approve', () => {
  assert.equal(bridge.decideApproval({ skipApproval: true, allowance: 0n, amount: 5n }), 'none');
  assert.equal(bridge.decideApproval({ skipApproval: false, allowance: 9n, amount: 5n }), 'none');
  assert.equal(bridge.decideApproval({ skipApproval: false, allowance: 5n, amount: 5n }), 'none');
  assert.equal(bridge.decideApproval({ skipApproval: false, allowance: 0n, amount: 5n }), 'approve');
  // USDT-style tokens refuse 0→N in one call: a stale non-zero allowance must
  // be reset to 0 first, or the approve silently fails on-chain (LI.FI S3).
  assert.equal(bridge.decideApproval({ skipApproval: false, allowance: 1n, amount: 5n }), 'reset+approve');
});

// ── execution order: approve BEFORE bridge, always quote-bound ──
function setupERC20Exec(t, { allowance } = {}) {
  elements.clear();
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const fetchMock = t.mock.method(globalThis, 'fetch',
    async () => ({ ok: true, json: async () => erc20Response() }));
  const toasts = [];
  t.mock.method(document.querySelector('#toast-wrap'), 'appendChild', el => toasts.push(el.textContent));
  const el = (sel) => document.querySelector(sel);
  el('#bridgeFromChain').value = 'sepolia';
  el('#bridgeToChain').value = 'arbitrum-sepolia';
  el('#bridgeToken').value = USDC_SEP;
  el('#bridgeAmount').value = '5';
  state.set('unlocked', true);
  state.set('networkId', 'sepolia');
  state.set('address', account);
  const enc = ethers.AbiCoder.defaultAbiCoder();
  state.set('provider', {
    async getNetwork() { return { chainId: 11155111n }; },
    async call({ to }) {
      assert.equal(String(to).toLowerCase(), USDC_SEP.toLowerCase(), 'allowance read must target the selected token');
      return enc.encode(['uint256'], [allowance]);
    }
  });
  const spy = { txs: [] };
  state.set('signer', {
    address: account,
    connect() { return this; },
    async sendTransaction(tx) { spy.txs.push(tx); return { hash: '0x' + 'a'.repeat(64), wait: async () => ({ status: 1 }) }; }
  });
  state.set('bridgeQuote', {
    simulated: false,
    approvalAddress: APPROVER,
    skipApproval: false,
    context: {
      networkId: 'sepolia', chainId: 11155111, fromChainId: 11155111, toChainId: 421614,
      address: account, token: USDC_SEP, tokenAddress: USDC_SEP, toTokenAddress: USDC_ARBSEP,
      tokenDecimals: 6, tokenSymbol: 'USDC',
      amount: '5', amountSmallest: AMOUNT_5USDC
    },
    tx: { to: ROUTER, data: '0xdeadbeef', value: 0n, chainId: 11155111 }
  });
  return { toasts, spy, fetchMock };
}

const APPROVE_SELECTOR = '0x095ea7b3';
const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);

async function clickSign() {
  await new Promise(r => setImmediate(r));
  const yes = document.querySelector('#confirmYes');
  assert.ok(yes && typeof yes.onclick === 'function', 'sign confirm rendered');
  yes.onclick();
}

test('exec: allowance 0 → approve first, THEN bridge (order + payload pinned)', async (t) => {
  const { spy } = setupERC20Exec(t, { allowance: 0n });
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 2, 'approve then bridge');
  const [approveTx, bridgeTx] = spy.txs;
  assert.equal(approveTx.to.toLowerCase(), USDC_SEP.toLowerCase(), 'approve targets the token contract');
  assert.ok(approveTx.data.startsWith(APPROVE_SELECTOR), 'approve selector');
  const [spender, amt] = approveIface.decodeFunctionData('approve', approveTx.data);
  assert.equal(spender.toLowerCase(), APPROVER.toLowerCase(), 'approve the quote-bound spender only');
  assert.equal(amt, BigInt(AMOUNT_5USDC), 'approve the exact amount, not unlimited');
  assert.equal(approveTx.value, 0n);
  assert.equal(bridgeTx.to.toLowerCase(), ROUTER.toLowerCase(), 'bridge tx after approval');
  assert.equal(bridgeTx.value, 0n, 'ERC-20 bridge tx carries no native value');
});

test('exec: allowance already covered → NO approve, straight to bridge, no extra fetch', async (t) => {
  const { spy, fetchMock } = setupERC20Exec(t, { allowance: BigInt(AMOUNT_5USDC) });
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 1, 'only the bridge tx');
  assert.equal(spy.txs[0].to.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(fetchMock.mock.callCount(), 0, 'no re-quote needed when nothing waited');
});

test('exec: stale partial allowance → reset to 0 first, then approve amount, then bridge', async (t) => {
  const { spy } = setupERC20Exec(t, { allowance: 2500000n });
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 3, 'reset + approve + bridge');
  const [reset, approve, bridgeTx] = spy.txs;
  assert.ok(reset.data.startsWith(APPROVE_SELECTOR));
  assert.equal(approveIface.decodeFunctionData('approve', reset.data)[1], 0n, 'first tx resets to zero');
  assert.equal(approveIface.decodeFunctionData('approve', approve.data)[1], BigInt(AMOUNT_5USDC));
  assert.equal(bridgeTx.to.toLowerCase(), ROUTER.toLowerCase());
});

// ═══════════ RED-TEAM — attack the approve flow itself (2026-10-05) ═══════════
// The approve path moves user funds permission, so it gets attacker-shaped
// tests, not just happy paths. Findings were: re-entrancy had NO lock (P1,
// fixed with the single-flight guard in js/bridge.js), plus three
// fail-closed checks that must stay proved by executable spec.

test('RED-TEAM: double-click during the approve flow cannot run a second exec', async (t) => {
  const { spy, toasts } = setupERC20Exec(t, { allowance: 0n });
  const p1 = bridge.doBridgeExec();          // first tap — flag now held
  const p2 = bridge.doBridgeExec();          // impatient second tap
  assert.ok(toasts.some(m => m.includes('in progress')), 'second entry rejected loudly');
  await clickSign();
  await p1;
  await p2;
  assert.equal(spy.txs.length, 2, 'exactly ONE flow (approve+bridge), never four');
});

test('RED-TEAM: unreadable allowance (garbage RPC answer) aborts before ANY tx', async (t) => {
  const { spy, toasts } = setupERC20Exec(t, { allowance: 0n });
  state.get().provider.call = async () => '0xzz-nothex';   // not even hex
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 0, 'no approve, no bridge — never assume approval');
  assert.ok(toasts.some(m => m.toLowerCase().includes('allowance')), 'honest error naming the real reason');
});

test('RED-TEAM: re-quote swaps the spender AFTER approval → bridge refuses to fire', async (t) => {
  const { spy, toasts, fetchMock } = setupERC20Exec(t, { allowance: 0n });
  fetchMock.mock.mockImplementation(async () => ({
    ok: true,
    json: async () => {
      const r = erc20Response();
      r.estimate.approvalAddress = '0x6666666666666666666666666666666666666666'; // attacker
      return r;
    }
  }));
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 1, 'approve mined, bridge did NOT follow');
  assert.ok(spy.txs[0].data.startsWith(APPROVE_SELECTOR));
  assert.ok(toasts.some(m => m.includes('Route changed')), 'aborts with the real reason');
  assert.equal(fetchMock.mock.callCount(), 1, 'exactly the one re-quote, no retry loop');
});

test('RED-TEAM: ERC-20 quote with zeroed approvalAddress is rejected, never bound', async (t) => {
  const h = setupERC20Quote(t);
  h.fetchMock.mock.mockImplementation(async () => ({
    ok: true,
    json: async () => {
      const r = erc20Response();
      r.estimate.approvalAddress = '0x0000000000000000000000000000000000000000';
      return r;
    }
  }));
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null, 'no quote bound with a zero spender');
  assert.equal(h.fetchMock.mock.callCount(), 1, 'response consumed, nothing signed');
});

// ── follow-up specs for the critic VETO fixes (2026-10-05) ──

test('RED-TEAM: full-precision amount dies BEFORE the fetch — stale quote killed, button off', async (t) => {
  const h = setupERC20Quote(t);                  // USDC, 6 decimals
  h.el('#bridgeAmount').value = '5.1234567';     // 7 decimals → NUMERIC_FAULT
  await bridge.doBridge();
  assert.equal(state.get('bridgeQuote'), null, 'the PREVIOUS quote must not survive');
  assert.ok(h.toasts.some(m => m.toLowerCase().includes('decimal')), 'honest error naming precision');
  assert.equal(h.fetchMock.mock.callCount(), 0, 'no request with an unrepresentable amount');
  assert.equal(document.querySelector('#btnBridgeExec').disabled, true, 'Bridge disabled — nothing stale to fire');
});

test('bridge: LI.FI deny-listed native (Celo) → native row drops, ERC-20 row stays', async () => {
  const n = await import('../js/network.js');
  const celo = n.getNetworkById('celo'), base = n.getNetworkById('base');
  const opts = bridge.bridgeTokenOptions(celo, base);
  assert.ok(!opts.some(o => o.value === 'native'), 'deny-listed native is never offered');
  assert.equal(opts.length, 1, 'the curated ERC-20 row is the only option');
  assert.equal(opts[0].symbol, 'USDC');
  assert.equal(opts[0].value, '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 'source = curated Celo USDC');
  assert.equal(opts[0].toAddress, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'twin = curated Base USDC');
  // destination side of the deny list behaves the same
  const back = bridge.bridgeTokenOptions(base, celo);
  assert.ok(!back.some(o => o.value === 'native'), 'native dropped as DESTINATION too');
  // denied chain WITHOUT a curated twin: native stays as the last resort
  // (an empty picker helps nobody — it fails honestly at quote time instead)
  const noTwin = bridge.bridgeTokenOptions(celo, n.getNetworkById('bsc-testnet'));
  assert.equal(noTwin.length, 1, 'no ERC-20 alternative → keep native');
  assert.equal(noTwin[0].value, 'native');
});

test('RED-TEAM: wallet locked during the approve+re-quote window → bridge tx aborts', async (t) => {
  const { spy, toasts } = setupERC20Exec(t, { allowance: 0n });
  // Flip the lock while the flow sits PAST runTx's entry guards: the
  // allowance read happens inside, after sign confirmation.
  const enc = ethers.AbiCoder.defaultAbiCoder();
  state.get().provider.call = async () => {
    state.set('unlocked', false);
    return enc.encode(['uint256'], [0n]);
  };
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 1, 'approve went out, bridge did NOT');
  assert.ok(toasts.some(m => m.includes('context changed')), 'aborts with the drift message');
});

test('RED-TEAM: destination/source select swapped mid-approve → bridge tx aborts', async (t) => {
  // Round-2 critic probes (GAP-A / GAP-B): the entry guard compares both
  // selects, the post-approve guard must too — flipping EITHER select during
  // the approve+re-quote window ends with txs=1, never a signature.
  for (const flip of [() => { document.querySelector('#bridgeToChain').value = 'sepolia'; },
                      () => { document.querySelector('#bridgeFromChain').value = 'no-such-network'; }]) {
    const { spy, toasts } = setupERC20Exec(t, { allowance: 0n });
    const enc = ethers.AbiCoder.defaultAbiCoder();
    state.get().provider.call = async () => { flip(); return enc.encode(['uint256'], [0n]); };
    const pending = bridge.doBridgeExec();
    await clickSign();
    await pending;
    assert.equal(spy.txs.length, 1, 'approve only — select drift must never sign the bridge');
    assert.ok(toasts.some(m => m.includes('context changed')), 'honest drift abort');
  }
});

test('RED-TEAM: live chain flips during the approve+re-quote window → bridge tx aborts (TOCTOU)', async (t) => {
  // The hoisted approvalWindowDrift re-reads getNetwork AFTER the awaits —
  // an RPC whose reported chain changes while the flow sits in the approve
  // window must abort before the bridge signature, exactly like form drift.
  const { spy, toasts } = setupERC20Exec(t, { allowance: 0n });
  const enc = ethers.AbiCoder.defaultAbiCoder();
  const provider = state.get('provider');
  provider.call = async () => {
    provider.getNetwork = async () => ({ chainId: 999n });   // flip mid-window
    return enc.encode(['uint256'], [0n]);
  };
  const pending = bridge.doBridgeExec();
  await clickSign();
  await pending;
  assert.equal(spy.txs.length, 1, 'approve went out, bridge did NOT');
  assert.ok(toasts.some(m => m.includes('context changed')), 'honest drift abort, not a signature');
});

test('README pair numbers are pinned to the code (HUKUM 10)', async () => {
  const n = await import('../js/network.js');
  const b = await import('../js/bridge.js');
  const nets = n.getAllNetworks();
  let withE = 0, without = 0;
  for (const a of nets) for (const c of nets) {
    if (a.chainId === c.chainId) continue;
    b.bridgeTokenOptions(a, c).some(o => o.value !== 'native') ? withE++ : without++;
  }
  const readme = (await import('node:fs')).readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(withE + without, 506, '23 networks → 506 ordered pairs');
  assert.ok(readme.includes(`${withE} of ${withE + without} ordered chain pairs carry a curated ERC-20 row`),
    `README must state the measured pair count (${withE}/${withE + without})`);
  assert.ok(readme.includes(`the other ${without} share no stable family`),
    `README must state the native-only count (${without})`);
});
