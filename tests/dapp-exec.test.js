// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapp-exec.test.js
//
// The wallet-side dispatch the injected provider used to lose to a node
// (live, 2026-10-08: personal_sign → -32601, eth_sendTransaction → -32602,
// wallet_switchEthereumChain → -32601, all AFTER the user approved).
// These tests pin the local execution: signer for sign/send, the network
// registry for switch/add, session state for watchAsset — and the
// passthrough that leaves reads on the node path.
// ═══════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

// dapp-exec reads globalThis.ethers at module load (same rule as app.js).
globalThis.ethers = ethers;

// The state store touches localStorage; give it one.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.window = globalThis;

const { executeLocal, currentChainId, splitSignParams, isLocalMethod } = await import('../js/dapp-exec.js');
const { set } = await import('../js/state.js');

const ADDR = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);

function installSigner(over = {}) {
  const calls = [];
  const signer = {
    address: ADDR,
    signMessage: async (m) => { calls.push(['signMessage', m]); return '0xsig-message'; },
    signTypedData: async (d, t, m) => { calls.push(['signTypedData', d, t, m]); return '0xsig-typed'; },
    connect: () => ({
      sendTransaction: async (tx) => { calls.push(['sendTransaction', tx]); return { hash: '0xdeadbeefhash' }; },
    }),
    ...over,
  };
  set('signer', signer);
  set('address', ADDR);
  return calls;
}

// activateNetwork stand-in: app.js's chokepoint, minus the DOM.
function fakeActivate(switches) {
  return (id, opts) => {
    switches.push([id, opts]);
    set('networkId', id);
    return true;
  };
}

beforeEach(() => {
  mem.clear();
  set('signer', null);
  set('address', ADDR);
  set('networkId', 'ethereum');
  set('provider', null);
});

// ── dispatch shape ────────────────────────────────────────────────
test('reads are not ours: {done:false}, straight through', async () => {
  const r = await executeLocal({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
  assert.deepEqual(r, { done: false });
  assert.equal(isLocalMethod('eth_getBalance'), false);
  assert.equal(isLocalMethod('personal_sign'), true);
});

// ── chain id ──────────────────────────────────────────────────────
test('currentChainId resolves the registry, never NaN', () => {
  set('networkId', 'ethereum');
  assert.equal(currentChainId(), 1);
  set('networkId', 'polygon');
  assert.equal(currentChainId(), 137);
  set('networkId', 'no-such-network');
  assert.equal(currentChainId(), 1);
  set('networkId', undefined);
  assert.equal(currentChainId(), 1);
});

// ── personal_sign ─────────────────────────────────────────────────
test('splitSignParams accepts spec and legacy order', () => {
  assert.deepEqual(splitSignParams(['hello', ADDR]), { message: 'hello', address: ADDR });
  assert.deepEqual(splitSignParams([ADDR, 'hello']), { message: 'hello', address: ADDR });
});

test('personal_sign: hex message becomes BYTES, signs locally, no node', async () => {
  const calls = installSigner();
  const r = await executeLocal({ method: 'personal_sign', params: ['0x68656c6c6f', ADDR] });
  assert.equal(r.done, true);
  assert.equal(r.value, '0xsig-message');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'signMessage');
  // 'hello' as utf8 bytes — NOT the literal characters "0x6865…".
  assert.deepEqual(calls[0][1], ethers.getBytes('0x68656c6c6f'));
});

test('personal_sign: utf8 message passes through as a string', async () => {
  const calls = installSigner();
  await executeLocal({ method: 'personal_sign', params: ['login to site', ADDR] });
  assert.equal(calls[0][1], 'login to site');
});

test('personal_sign: legacy [address, message] order is accepted', async () => {
  const calls = installSigner();
  await executeLocal({ method: 'personal_sign', params: [ADDR, '0x68656c6c6f'] });
  assert.equal(calls[0][0], 'signMessage');
});

test('personal_sign: another account → 4100, signer never touched', async () => {
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'personal_sign', params: ['0x68656c6c6f', OTHER] }),
    (e) => e.code === 4100,
  );
  assert.equal(calls.length, 0);
});

test('personal_sign: locked wallet → 4100', async () => {
  set('signer', null);
  await assert.rejects(
    () => executeLocal({ method: 'personal_sign', params: ['0x68656c6c6f', ADDR] }),
    (e) => e.code === 4100,
  );
});

test('personal_sign: missing params → 32602', async () => {
  installSigner();
  await assert.rejects(() => executeLocal({ method: 'personal_sign', params: [] }), (e) => e.code === 32602);
});

// ── typed data ────────────────────────────────────────────────────
const TYPED = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Mail: [
      { name: 'from', type: 'string' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: { name: 'BearTest' },
  message: { from: 'bear', contents: 'hi' },
};

test('eth_signTypedData_v4: JSON string and object both parse, EIP712Domain stripped', async () => {
  const calls = installSigner();
  const r = await executeLocal({ method: 'eth_signTypedData_v4', params: [JSON.stringify(TYPED), ADDR] });
  assert.equal(r.value, '0xsig-typed');
  const [, domain, types, message] = calls[0];
  assert.deepEqual(domain, { name: 'BearTest' });
  assert.equal('EIP712Domain' in types, false, 'EIP712Domain must not be handed to ethers');
  assert.deepEqual(message, { from: 'bear', contents: 'hi' });
});

test('eth_signTypedData_v3 works the same way', async () => {
  installSigner();
  const r = await executeLocal({ method: 'eth_signTypedData_v3', params: [TYPED, ADDR] });
  assert.equal(r.value, '0xsig-typed');
});

test('eth_signTypedData_v4: single type + missing primaryType is inferred', async () => {
  installSigner();
  const { primaryType, ...noPrimary } = TYPED;
  const r = await executeLocal({ method: 'eth_signTypedData_v4', params: [noPrimary, ADDR] });
  assert.equal(r.value, '0xsig-typed');
});

test('eth_signTypedData_v4: malformed JSON → 32602', async () => {
  installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData_v4', params: ['{nope', ADDR] }),
    (e) => e.code === 32602,
  );
});

test('eth_signTypedData_v4: undeclared primaryType → 32602', async () => {
  installSigner();
  const bad = { ...TYPED, primaryType: 'Ghost' };
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData_v4', params: [bad, ADDR] }),
    (e) => e.code === 32602,
  );
});

test('legacy eth_signTypedData (v1) refuses honestly with 4200, not a node error', async () => {
  installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData', params: [{ name: 'amount', type: 'uint256', value: '1' }, ADDR] }),
    (e) => e.code === 4200 && /v4/.test(e.message),
  );
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData_v1', params: [[], ADDR] }),
    (e) => e.code === 4200,
  );
});

test('eth_signTypedData_v4: wrong signing account → 4100', async () => {
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData_v4', params: [TYPED, OTHER] }),
    (e) => e.code === 4100,
  );
  assert.equal(calls.length, 0);
});

// ── eth_sendTransaction ───────────────────────────────────────────
test('eth_sendTransaction: signs LOCALLY through the signer, returns the hash', async () => {
  set('provider', { tag: 'fake-provider' });
  const calls = installSigner();
  const r = await executeLocal({
    method: 'eth_sendTransaction',
    params: [{
      from: ADDR,
      to: ADDR,
      value: '0x1',
      gas: '0x5208',
      maxFeePerGas: '0x59682f00',
      data: '0x',
    }],
  });
  assert.equal(r.done, true);
  assert.equal(r.value, '0xdeadbeefhash');
  const [kind, tx] = calls.find((c) => c[0] === 'sendTransaction');
  assert.equal(kind, 'sendTransaction');
  assert.equal(tx.value, 1n, 'hex value becomes BigInt');
  assert.equal(tx.gasLimit, 21000n, 'gas → gasLimit');
  assert.equal(tx.maxFeePerGas, 1500000000n);
  assert.equal('from' in tx, false, 'from is dropped — the signer is the account');
  assert.equal(tx.to, ADDR);
});

test('eth_sendTransaction: another from-account → 4100, nothing sent', async () => {
  set('provider', { tag: 'fake-provider' });
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_sendTransaction', params: [{ from: OTHER, to: ADDR, value: '0x1' }] }),
    (e) => e.code === 4100,
  );
  assert.equal(calls.length, 0);
});

test('eth_sendTransaction: chainId mismatch → 4902, nothing sent', async () => {
  set('provider', { tag: 'fake-provider' });
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({
      method: 'eth_sendTransaction',
      params: [{ from: ADDR, to: ADDR, value: '0x1', chainId: '0x89' }],
    }),
    (e) => e.code === 4902 && /polygon|137|chain/i.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test('eth_sendTransaction: no signer → 4100; no provider → -32603', async () => {
  set('signer', null);
  await assert.rejects(
    () => executeLocal({ method: 'eth_sendTransaction', params: [{ to: ADDR, value: '0x1' }] }),
    (e) => e.code === 4100,
  );
  installSigner();
  set('provider', null);
  await assert.rejects(
    () => executeLocal({ method: 'eth_sendTransaction', params: [{ to: ADDR, value: '0x1' }] }),
    (e) => e.code === -32603,
  );
});

// ── switch / add chain (EIP-3326 / EIP-3085) ─────────────────────
test('wallet_switchEthereumChain: known chain → activateNetwork, returns null', async () => {
  const switches = [];
  const r = await executeLocal({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x89' }],
    activateNetwork: fakeActivate(switches),
  });
  assert.equal(r.done, true);
  assert.equal(r.value, null, 'EIP-3326: null on success');
  assert.deepEqual(switches[0][0], 'polygon');
  assert.equal(switches[0][1].close, false, 'the requesting flow keeps its modal open');
});

test('wallet_switchEthereumChain: already on it → no churn, still null', async () => {
  const switches = [];
  const r = await executeLocal({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x1' }],
    activateNetwork: fakeActivate(switches),
  });
  assert.equal(r.value, null);
  assert.equal(switches.length, 0, 'same chain must not re-run the switch');
});

test('wallet_switchEthereumChain: unknown chain → 4902 with the where-to-add text', async () => {
  const switches = [];
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x539' }],
      activateNetwork: fakeActivate(switches),
    }),
    (e) => e.code === 4902 && /Settings → Networks/.test(e.message),
  );
  assert.equal(switches.length, 0);
});

test('wallet_switchEthereumChain: garbage chainId → 32602', async () => {
  await assert.rejects(
    () => executeLocal({ method: 'wallet_switchEthereumChain', params: [{ chainId: 'banana' }] }),
    (e) => e.code === 32602,
  );
  await assert.rejects(
    () => executeLocal({ method: 'wallet_switchEthereumChain', params: [] }),
    (e) => e.code === 32602,
  );
});

test('wallet_addEthereumChain: known chain switches; unknown → 4902 (registry is truth)', async () => {
  const switches = [];
  const ok = await executeLocal({
    method: 'wallet_addEthereumChain',
    params: [{ chainId: '0x89', rpcUrls: ['https://evil.example'] }],
    activateNetwork: fakeActivate(switches),
  });
  assert.equal(ok.value, null);
  assert.equal(switches[0][0], 'polygon', 'a known chain is switched to, not re-added');
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x99999', rpcUrls: ['https://evil.example'] }],
      activateNetwork: fakeActivate(switches),
    }),
    (e) => e.code === 4902,
  );
  assert.equal(switches.length, 1, 'an unknown chain must never reach activateNetwork');
});

// ── wallet_watchAsset ─────────────────────────────────────────────
test('wallet_watchAsset: confirmed with details, persisted on the active chain', async () => {
  const asks = [];
  const r = await executeLocal({
    method: 'wallet_watchAsset',
    params: [{ type: 'ERC20', options: { address: '0x' + '11'.repeat(20), symbol: 'DAI', decimals: 18 } }],
    origin: 'https://dapp.example',
    confirmAsset: async (info) => { asks.push(info); return true; },
  });
  assert.equal(r.value, true);
  assert.equal(asks.length, 1, 'EVERY call is confirmed — not grant-once');
  assert.equal(asks[0].site, 'https://dapp.example');
  assert.equal(asks[0].symbol, 'DAI');
  const stored = JSON.parse(mem.get('bear.customTokens') || '[]');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].symbol, 'DAI');
  assert.equal(stored[0].chainId, 1, 'persisted on the ACTIVE chain');
});

test('wallet_watchAsset: refusal → 4001, nothing stored', async () => {
  const r = await assert.rejects(
    () => executeLocal({
      method: 'wallet_watchAsset',
      params: [{ type: 'ERC20', options: { address: '0x' + '11'.repeat(20), symbol: 'SPAM', decimals: 18 } }],
      confirmAsset: async () => false,
    }),
    (e) => e.code === 4001,
  );
  void r;
  assert.equal(mem.has('bear.customTokens'), false);
});

test('wallet_watchAsset: non-ERC20 → 4200; bad address → 32602; no UI → -32603', async () => {
  const confirmAsset = async () => true;
  await assert.rejects(
    () => executeLocal({ method: 'wallet_watchAsset', params: [{ type: 'ERC721', options: { address: '0x' + '11'.repeat(20) } }], confirmAsset }),
    (e) => e.code === 4200,
  );
  await assert.rejects(
    () => executeLocal({ method: 'wallet_watchAsset', params: [{ type: 'ERC20', options: { address: '0x1234', symbol: 'X' } }], confirmAsset }),
    (e) => e.code === 32602,
  );
  await assert.rejects(
    () => executeLocal({ method: 'wallet_watchAsset', params: [{ type: 'ERC20', options: { address: '0x' + '11'.repeat(20) } }] }),
    (e) => e.code === -32603,
  );
});
