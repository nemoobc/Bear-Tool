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

const { executeLocal, currentChainId, splitSignParams, splitTypedParams, isLocalMethod, buildSendTx, signPayload } = await import('../js/dapp-exec.js');
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

// A provider must be able to say WHAT CHAIN IT IS ON: the send path now
// refuses to broadcast through one that cannot answer, and refuses even harder
// one that answers with a chain other than the wallet's (providerOnCurrentChain
// in dapp-exec.js). Default = the chain the wallet is on, so a test about some
// OTHER concern (from-account, tx chainId) still reaches that concern.
function installProvider(chainId = currentChainId()) {
  set('provider', { tag: 'fake-provider', getNetwork: async () => ({ chainId: BigInt(chainId) }) });
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

// ── the side is found by SHAPE, not by address length ───────────────────
// public/dapp-sign-fixture.html — the emulator's OWN dApp — sends
// params: ['0x0', JSON.stringify(typed)]: EIP-712's [address, typedData]
// convention with a STAND-IN address, because the wallet signs with its own
// account. splitSignParams' 40-hex rule does not recognize '0x0' as an
// address, so nothing was swapped: the address was taken AS the payload,
// JSON.parse('0x0') threw, and the native path answered 32602 without ever
// showing a sheet. The emulator gate died exactly there — "typed-data sheet
// never appeared" (run 38726524114) — while these unit tests stayed green,
// because none of them used the shape the fixture sends.
test('splitTypedParams: the fixture order — short stand-in address, JSON payload', () => {
  const json = JSON.stringify(TYPED);

  const spec = splitTypedParams(['0x0', json]);
  assert.equal(spec.typed, json, 'the payload is found by shape, never by a 40-hex rule');
  assert.equal(spec.address, '0x0', 'the address is the OTHER param, however short');

  const legacy = splitTypedParams([json, '0x0']);
  assert.equal(legacy.typed, json, 'the legacy order resolves to the same payload');
  assert.equal(legacy.address, '0x0');

  assert.deepEqual(splitTypedParams([TYPED, '0x0']).typed, TYPED, 'an object payload is recognized directly');
  assert.deepEqual(splitTypedParams(['0x0', TYPED]).typed, TYPED, 'object payload in spec order too');
  assert.equal(splitTypedParams([]).typed, undefined, 'nothing to find → the caller answers 32602');
});

test('eth_signTypedData_v4: both param orders hand the signer the SAME payload', async () => {
  const calls = installSigner();
  const r1 = await executeLocal({ method: 'eth_signTypedData_v4', params: [ADDR, JSON.stringify(TYPED)] });
  const r2 = await executeLocal({ method: 'eth_signTypedData_v4', params: [JSON.stringify(TYPED), ADDR] });
  assert.equal(r1.value, '0xsig-typed');
  assert.equal(r2.value, '0xsig-typed');

  const [, d1, t1, m1] = calls[0];
  const [, d2, t2, m2] = calls[1];
  assert.deepEqual(d1, d2, 'the ORDER of params must not change what is signed');
  assert.deepEqual(t1, t2, 'nor the types');
  assert.deepEqual(m1, m2, 'nor the message — a swapped order is still the same signature');
});

test('eth_signTypedData_v4: the stand-in address is identified as the ADDRESS', async () => {
  installSigner();
  // Spec order with the fixture's dummy account: requireAddressMatch must
  // refuse '0x0' (it is not the active account) — and the refusal must NAME
  // 0x0, proving the address side was found. When the address slot was read as
  // the payload, this same refusal instead named the whole JSON document.
  await assert.rejects(
    () => executeLocal({ method: 'eth_signTypedData_v4', params: ['0x0', JSON.stringify(TYPED)] }),
    (e) => e.code === 4100 && /\b0x0\b/.test(e.message) && !/domain/i.test(e.message),
    'the mismatch must name the ADDRESS it refused, not the payload',
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
  installProvider();
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
  installProvider();
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_sendTransaction', params: [{ from: OTHER, to: ADDR, value: '0x1' }] }),
    (e) => e.code === 4100,
  );
  assert.equal(calls.length, 0);
});

test('eth_sendTransaction: chainId mismatch → 4902, nothing sent', async () => {
  installProvider();
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

// The TRANSPORT has to match too, not only the tx's declared chainId.
// activateNetwork() writes networkId SYNCHRONOUSLY while the provider object
// is rebuilt later, behind a multi-endpoint probe — so a dApp doing
// switchChain(x) then sendTransaction(...) back-to-back passed the 4902 check
// against the NEW id and still broadcast through the OLD provider: the
// transaction landed on the previous chain while the dialog named the new one.
// This is the silent chain substitution every other guard here kills, so the
// provider itself is asked what chain it is on before anything is sent.
test('eth_sendTransaction: provider still on ANOTHER chain → -32603, nothing sent', async () => {
  installProvider(137);            // the wallet is on ethereum (1); this provider says polygon
  const calls = installSigner();
  await assert.rejects(
    () => executeLocal({ method: 'eth_sendTransaction', params: [{ from: ADDR, to: ADDR, value: '0x1' }] }),
    (e) => e.code === -32603 && /still on chain/i.test(e.message),
    'a broadcast through a provider on the wrong chain must be refused',
  );
  assert.equal(calls.length, 0, 'nothing may reach the signer');
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

test('wallet_addEthereumChain: known chain switches; unknown without a sheet → 4902', async () => {
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

// ── EIP-3085: an unknown chain, sanitized + user-confirmed ────────
// 2026-10-15 (user: "add network gabisa" for a dApp on a new testnet): the
// wallet may ASK. Scroll-Sepolia (534351) is deliberately a chain the
// registry does not carry — the add path is the only way it can land.
test('wallet_addEthereumChain: approved sheet → installed (sanitized) + switched', async () => {
  const chainId = 534351;
  const rpc = 'https://sepolia-rpc.scroll.io';
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, rpc, 'the probe must go to the requested RPC');
    assert.equal(JSON.parse(opts.body).method, 'eth_chainId');
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + chainId.toString(16) }) };
  };
  const offered = [];
  const switches = [];
  const r = await executeLocal({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: '0x' + chainId.toString(16),
      chainName: 'Scroll Sepolia',
      rpcUrls: [rpc],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia.scrollscan.com'],
    }],
    origin: 'https://dapp.example',
    offerAddChain: async (info) => { offered.push(info); return true; },
    activateNetwork: fakeActivate(switches),
  });
  assert.equal(r.done, true);
  assert.equal(r.value, null, 'success answers null');
  assert.equal(offered.length, 1, 'exactly one sheet, carrying the SANITIZED chain');
  assert.equal(offered[0].net.chainId, chainId);
  assert.equal(offered[0].net.name, 'Scroll Sepolia');
  assert.equal(offered[0].origin, 'https://dapp.example');
  const stored = JSON.parse(mem.get('bear.customNetworks') || '[]');
  assert.equal(stored.length, 1, 'approved → registered');
  assert.equal(stored[0].chainId, chainId);
  assert.deepEqual(stored[0].rpc, [rpc]);
  assert.equal(stored[0].custom, true);
  assert.equal(stored[0].type, 'testnet', 'a listed testnet id classifies as testnet');
  assert.equal(switches.length, 1, 'the wallet switches to what was added');
  assert.equal(switches[0][0], stored[0].id);
});

test('wallet_addEthereumChain: declined sheet → 4001, nothing installed', async () => {
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x99999', chainName: 'Nope', rpcUrls: ['https://rpc.example'] }],
      offerAddChain: async () => false,
    }),
    (e) => e.code === 4001,
  );
  assert.equal(JSON.parse(mem.get('bear.customNetworks') || '[]').length, 0);
});

test('wallet_addEthereumChain: an RPC answering with another chain id installs nothing', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ result: '0x1' }) }); // says mainnet
  const switches = [];
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x99999', chainName: 'Fake', rpcUrls: ['https://rpc.fake.example'] }],
      offerAddChain: async () => true,
      activateNetwork: fakeActivate(switches),
    }),
    (e) => e.code === 32602 && /reports chain/i.test(e.message),
  );
  assert.equal(JSON.parse(mem.get('bear.customNetworks') || '[]').length, 0, 'a lying RPC installs nothing');
  assert.equal(switches.length, 0);
});

test('wallet_addEthereumChain: unsafe RPC / missing name → 32602 before any sheet', async () => {
  let sheets = 0;
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x99999', chainName: 'Evil', rpcUrls: ['http://evil.example'] }],
      offerAddChain: async () => { sheets += 1; return true; },
    }),
    (e) => e.code === 32602,
  );
  await assert.rejects(
    () => executeLocal({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x99999', rpcUrls: ['https://rpc.example'] }],
      offerAddChain: async () => { sheets += 1; return true; },
    }),
    (e) => e.code === 32602 && /name/i.test(e.message),
  );
  assert.equal(sheets, 0, 'a malformed request never reaches the user');
  assert.equal(JSON.parse(mem.get('bear.customNetworks') || '[]').length, 0);
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

// ── S1 (2026-10-16): buildSendTx — one validator for all three send paths ──
test('buildSendTx: normalizes to the ethers shape, `from` never copied', () => {
  assert.deepStrictEqual(
    buildSendTx({ from: ADDR, to: ADDR, value: '0x1', gas: '0x5208', maxFeePerGas: '0x59682f00', data: '0x' }, { activeAddress: ADDR }),
    { to: ADDR, data: '0x', value: 1n, gasLimit: 21000n, maxFeePerGas: 0x59682f00n });
  // WC spelling: an explicit gasLimit wins over `gas`, and the alias never survives.
  assert.deepStrictEqual(buildSendTx({ to: ADDR, gas: '0x1', gasLimit: '0x2' }),
    { to: ADDR, gasLimit: 2n });
  // Unknown fields are dropped by whitelist — including `from`.
  assert.deepStrictEqual(buildSendTx({ to: ADDR, from: ADDR, junk: 1 }, { activeAddress: ADDR }),
    { to: ADDR });
});

test('buildSendTx refusals: shape, from, chainId, to, data, input, empty', () => {
  const bad = (raw, code, opts) => assert.throws(() => buildSendTx(raw, opts), (e) => e.code === code);
  bad(undefined, 32602);    // the WC `|| {}` fallback used to turn this into an empty sheet
  bad('0xdeadbeef', 32602); // params[0] is a string, not a tx object
  bad([], 32602);           // an array is not a transaction
  bad({ to: ADDR, from: OTHER }, 4100, { activeAddress: ADDR });
  bad({ to: ADDR, chainId: 137 }, 4902, { activeAddress: ADDR, chainId: 1 });
  bad({ to: ADDR, chainId: '0x89' }, 4902, { activeAddress: ADDR, chainId: 1 });
  bad({ to: '0xnot-an-address' }, 32602);
  bad({ to: ADDR, data: '0xzz' }, 32602);
  bad({ to: ADDR, input: '0x1234' }, 32602, { activeAddress: ADDR });
  bad({ value: '0x1' }, 32602);            // no recipient, no calldata — nothing to send
  bad({ to: ADDR, value: 'wat' }, 32602);
  // A contract creation (no `to`) with real initcode is legal.
  assert.deepStrictEqual(buildSendTx({ data: '0x60016001' }), { data: '0x60016001' });
  // A chainId it cannot read is "no claim" — the old behaviour, unchanged.
  assert.deepStrictEqual(buildSendTx({ to: ADDR, chainId: 'eip155:1' }, { chainId: 137 }), { to: ADDR });
});

test('signPayload: even hex → bytes, everything else → the literal string (preview parity)', () => {
  assert.deepStrictEqual(signPayload('0x68656c6c6f'), ethers.getBytes('0x68656c6c6f'));
  assert.equal(signPayload('hello'), 'hello');
  assert.equal(signPayload('0xabc'), '0xabc',
    'odd nibble count is not hex — signed as the literal string, exactly as sign-render previews it');
  assert.equal(signPayload('0x'), '0x', 'fewer than one byte is not a byte string either');
});
