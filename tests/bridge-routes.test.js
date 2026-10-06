// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/bridge-routes.test.js
// M2: two bridge routers that answer with a REAL transaction (Gas.zip,
// Relay) plus the two-column token picker they sit behind.
//
// Every fixture below is a trimmed copy of a LIVE response captured
// 2026-10-06 (keyless), not a shape invented for the test — the point of
// these assertions is that a changed response breaks here first.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

// bridge-routes.js reads globalThis.ethers at module load (same rule as
// bridge.js); the import has to happen after the global exists.
globalThis.ethers = ethers;

const routes = await import('../js/bridge-routes.js');
const { gaszipQuote, relayQuote, opstackQuote, BRIDGE_ROUTE_FETCHERS } = routes;

const USER = '0x1111111111111111111111111111111111111111';
const DEPOSIT_CONTRACT = '0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762';
const RELAY_DEPOSIT = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const nativeCtx = (over = {}) => ({
  seq: 1, networkId: 'ethereum', chainId: 1, address: ethers.getAddress(USER),
  token: 'native', tokenAddress: null, toTokenAddress: null,
  fromChainId: 1, toChainId: 8453, decimals: 18,
  amount: '0.01', amountSmallest: '10000000000000000',
  ...over,
});

const erc20Ctx = (over = {}) => nativeCtx({
  token: USDC, tokenAddress: USDC, toTokenAddress: USDC_BASE,
  decimals: 6, amount: '10', amountSmallest: '10000000',
  ...over,
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status, text) => ({ ok: false, status, json: async () => { throw new Error('no json'); }, text: async () => text });

// ── Gas.zip ────────────────────────────────────────────────────
// Live: GET /v2/quotes/1/10000000000000000/8453?from=&to= → 200
function gaszipBody(over = {}) {
  return {
    calldata: '0x010036',
    contractDepositTxn: {
      data: '0xc9630cb000000000000000000000000000000000000000000000000000000000000000367ed2a81b7054dc5d393234b7a3a33b9ba125cac9000000000000000000000000',
      to: DEPOSIT_CONTRACT,
      value: '0x2386f26fc10000',
      ...over.txn,
    },
    expires: Math.floor(Date.now() / 1000) + 60,
    quotes: [{
      chain: 8453, decimals: 18,
      expected: 9999836887225412, expectedNative: 9999836887225412,
      gas: 126000000000, speed: 3.0, usd: 26.9448,
      ...over.quote,
    }],
    ...over.root,
  };
}

test('gas.zip: measured response binds a ready-to-send native tx, no approval', async () => {
  const calls = [];
  const bound = await gaszipQuote(nativeCtx(), async (url) => { calls.push(url); return ok(gaszipBody()); });

  assert.equal(calls.length, 1, 'one quote request');
  assert.match(calls[0], /^https:\/\/backend\.gas\.zip\/v2\/quotes\/1\/10000000000000000\/8453\?/);
  assert.match(calls[0], new RegExp(`from=${USER}`, 'i'), 'the address is in the query — calldata needs it');
  assert.equal(bound.tx.to, DEPOSIT_CONTRACT);
  assert.equal(bound.tx.value, 10000000000000000n, 'deposit value = the quoted amount');
  assert.equal(bound.tx.chainId, 1, 'the tx runs on the SOURCE chain');
  assert.equal(bound.approvalAddress, null, 'native needs no allowance');
  assert.equal(bound.skipApproval, true);
  assert.equal(bound.toAmount, 9999836887225412n, 'Auto best-route compares this number');
  assert.equal(bound.route, 'Gas.zip');
  assert.ok(Object.isFrozen(bound), 'execution only ever reads the snapshot');
});

test('gas.zip: ERC-20 refuses BEFORE any request (the route takes deposit_wei)', async () => {
  let called = 0;
  await assert.rejects(
    () => gaszipQuote(erc20Ctx(), async () => { called++; return ok(gaszipBody()); }),
    /native only/i);
  assert.equal(called, 0, 'no network call for a token Gas.zip cannot quote');
});

test('gas.zip: a deposit value that is not the quoted amount is rejected', async () => {
  await assert.rejects(
    () => gaszipQuote(nativeCtx(), async () => ok(gaszipBody({ txn: { value: '0x2386f26fc10001' } }))),
    /does not match the requested amount/);
});

test('gas.zip: HTTP 400 screening message is surfaced verbatim (their wording, our error)', async () => {
  await assert.rejects(
    () => gaszipQuote(nativeCtx(), async () => fail(400, '{"error":"Restricted: Address has been flagged as high risk by a third-party screening tool."}')),
    /Gas\.zip HTTP 400.*flagged as high risk/s);
});

test('gas.zip: an expired quote never binds', async () => {
  await assert.rejects(
    () => gaszipQuote(nativeCtx(), async () => ok(gaszipBody({ root: { expires: Math.floor(Date.now() / 1000) - 5 } }))),
    /expired/);
});

test('gas.zip: a response naming another destination chain is refused', async () => {
  await assert.rejects(
    () => gaszipQuote(nativeCtx(), async () => ok(gaszipBody({ quote: { chain: 10 } }))),
    /no route 1→8453/);
});

// ── Relay ──────────────────────────────────────────────────────
// Live: POST api.relay.link/quote/v2 → 200 (steps: deposit | approve+deposit)
function relayDepositStep(data, over = {}) {
  return { id: 'deposit', kind: 'transaction', items: [{ data: {
    from: USER, to: RELAY_DEPOSIT, data, value: '0', chainId: 1,
    gas: '32415', maxFeePerGas: '225176819', ...over,
  } }] };
}
// 4-byte selector + one 32-byte word, built rather than pasted: a hand-typed
// hex literal with an odd nibble would trip the calldata guard instead of
// testing the thing this case is about.
const word = (hex) => BigInt(hex).toString(16).padStart(64, '0');
const depositData = (selector, arg) => `0x${selector}${word(arg)}`;
function relayBody(over = {}) {
  return {
    requestId: '0x1791268553',
    steps: over.steps || [relayDepositStep('0x49290c1c0000000000000000000000000000000000000000000000000000000000000001', { value: '10000000000000000' })],
    fees: { relayer: { amountUsd: '0.022087' } },
    details: {
      operation: 'swap',
      currencyIn: { currency: { chainId: 1, address: ethers.ZeroAddress, symbol: 'ETH', decimals: 18 }, amount: 10000000000000000 },
      currencyOut: { currency: { chainId: 8453, address: ethers.ZeroAddress, symbol: 'ETH', decimals: 18 }, amount: 9999000000000000 },
      timeEstimate: 3,
      // Real shape (probe 2026-10-06): an origin/destination object, not a
      // provider string — the adapter must fall back to "Relay" on it.
      route: { origin: { inputCurrency: {} }, destination: { inputCurrency: {} } },
      ...over.details,
    },
    ...over.root,
  };
}
const approveStep = (token, spender, amountHex) => ({
  id: 'approve', kind: 'transaction',
  items: [{ data: { from: USER, to: token, value: '0', chainId: 1,
    data: `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amountHex}` } }],
});

test('relay: native deposit binds tx + fee + output (measured response)', async () => {
  const urls = [];
  const bound = await relayQuote(nativeCtx(), async (url, opts) => {
    urls.push([url, opts]);
    return ok(relayBody({ steps: [relayDepositStep('0x49290c1c0000000000000000000000000000000000000000000000000000000000000001', { value: '10000000000000000' })] }));
  });

  assert.equal(urls[0][0], 'https://api.relay.link/quote/v2');
  assert.equal(urls[0][1].method, 'POST');
  const sent = JSON.parse(urls[0][1].body);
  assert.equal(sent.user, ethers.getAddress(USER));
  assert.equal(sent.amount, '10000000000000000');
  assert.equal(sent.originCurrency, ethers.ZeroAddress, 'native on both sides = address(0)');
  assert.equal(sent.tradeType, 'EXACT_INPUT');
  assert.equal(bound.tx.to, ethers.getAddress(RELAY_DEPOSIT), 'checksummed, straight from the response');
  assert.equal(bound.tx.value, 10000000000000000n);
  assert.equal(bound.approvalAddress, null);
  assert.equal(bound.skipApproval, true);
  assert.equal(bound.toAmount, 9999000000000000n);
  assert.equal(bound.fee, '0.022087');
  assert.equal(bound.route, 'Relay', 'no provider name in a route object → say Relay');
});

test('relay: ERC-20 quotes the pair and takes the spender OUT of the approve step', async () => {
  const spender = RELAY_DEPOSIT;
  const bound = await relayQuote(erc20Ctx(), async (url, opts) => {
    const sent = JSON.parse(opts.body);
    assert.equal(sent.originCurrency, USDC, 'the exact source token goes over the wire');
    assert.equal(sent.destinationCurrency, USDC_BASE, 'and the exact destination twin');
    return ok(relayBody({
      steps: [
        approveStep(USDC, spender, (10000000n).toString(16).padStart(64, '0')),
        relayDepositStep(depositData('e8017952', USER)),
      ],
      details: {
        currencyIn: { currency: { chainId: 1, address: USDC, symbol: 'USDC', decimals: 6 }, amount: 10000000 },
        currencyOut: { currency: { chainId: 8453, address: USDC_BASE, symbol: 'USDC', decimals: 6 }, amount: 9977910 },
      },
    }));
  });

  assert.equal(bound.approvalAddress, ethers.getAddress(spender), 'spender comes from the response, never from us');
  assert.equal(bound.skipApproval, false, 'an ERC-20 with no allowance must approve first');
  assert.equal(bound.tx.value, 0n, 'an ERC-20 deposit carries no native value');
});

test('relay: approval smaller than the amount is refused', async () => {
  await assert.rejects(
    () => relayQuote(erc20Ctx(), async () => ok(relayBody({
      steps: [
        approveStep(USDC, RELAY_DEPOSIT, (999999n).toString(16).padStart(64, '0')),
        relayDepositStep('0xe8017952'),
      ],
    }))),
    /approval is smaller than the amount/);
});

test('relay: output currency swapped for another token is rejected', async () => {
  await assert.rejects(
    () => relayQuote(erc20Ctx(), async () => ok(relayBody({
      steps: [relayDepositStep(depositData('e8017952', USER))],
      details: {
        currencyIn: { currency: { chainId: 1, address: USDC }, amount: 10000000 },
        currencyOut: { currency: { chainId: 8453, address: ethers.ZeroAddress }, amount: 9977910 },
      },
    }))),
    /output currency mismatch/);
});

test('relay: deposit on the wrong chain is rejected', async () => {
  await assert.rejects(
    () => relayQuote(nativeCtx(), async () => ok(relayBody({
      steps: [relayDepositStep('0x1234', { chainId: 10 })],
    }))),
    /deposit chainId mismatch/);
});

test('relay: a step this app cannot perform (signature) aborts the quote', async () => {
  await assert.rejects(
    () => relayQuote(erc20Ctx(), async () => ok(relayBody({
      steps: [{ id: 'permit', kind: 'signature', items: [{ data: { sign: '0xab' } }] },
        relayDepositStep('0x1234')],
    }))),
    /unsupported step kind/);
});

test('relay: a response with no deposit transaction never binds', async () => {
  await assert.rejects(
    () => relayQuote(nativeCtx(), async () => ok(relayBody({ steps: [approveStep(USDC, RELAY_DEPOSIT, (1n).toString(16).padStart(64, '0'))] }))),
    /no deposit transaction/);
});

test('relay: HTTP error carries the status, no silent empty quote', async () => {
  await assert.rejects(() => relayQuote(nativeCtx(), async () => fail(503, 'unavailable')), /Relay HTTP 503.*unavailable/s);
});

// ── OP Stack canonical ────────────────────────────────────────
const PORTALS = {
  10: '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed',
  130: '0x0bd48f6B86a26D3a217d0Fa6FfE2B491B956A7a2',
  480: '0xd5ec14a83B7d95BE1E2Ac12523e2dEE12Cbeea6C',
  8453: '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e',
  81457: '0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb',
  11155420: '0x16Fc5058F25648194471939df75CF27A2fdC48BC',
  84532: '0x49f53e41452C74589E85cA1677426Ba426459e85',
};

test('opstack: portal table matches the on-chain verified addresses (2026-10-06)', () => {
  // Every address below was verified on L1: EIP-1967 implementation holds
  // selector 0xe9e05c42 (viem portalAbi depositTransaction) in runtime code.
  // A typo here would send a deposit to a contract that cannot mint.
  assert.deepEqual({ ...routes.OP_STACK_PORTALS }, PORTALS);
});

test('opstack: builds the canonical portal deposit — no fetch, frozen tx', () => {
  const bound = opstackQuote(nativeCtx());          // 1 → 8453 (Base)
  assert.ok(Object.isFrozen(bound), 'quotes are immutable snapshots');
  assert.equal(bound.tx.to, PORTALS[8453], 'tx targets the Base portal on L1');
  assert.equal(bound.tx.chainId, 1, 'the tx is sent on the source (L1) chain');
  assert.equal(bound.tx.value, 10000000000000000n, 'value = the quoted amount');
  assert.equal(bound.approvalAddress, null);
  assert.equal(bound.skipApproval, true, 'native deposit, no allowance');
  assert.equal(bound.fee, '0', 'canonical bridge charges no fee');
  assert.equal(bound.toAmount, 10000000000000000n, '1:1 mint on the L2');
  assert.equal(bound.route, 'OP Stack canonical (OptimismPortal)');

  // Calldata decodes back to EXACTLY the viem/superbridge call.
  const iface = new ethers.Interface(
    ['function depositTransaction(address,uint256,uint64,bool,bytes)']);
  const parsed = iface.parseTransaction({ data: bound.tx.data });
  assert.equal(parsed.selector, '0xe9e05c42',
    'selector must match viem portalAbi (uint64 gasLimit — NOT uint256)');
  const [to, value, gas, isCreation, l2data] = parsed.args;
  assert.equal(ethers.getAddress(to), ethers.getAddress(USER),
    'deposit lands at the same wallet address on the L2');
  assert.equal(value, 10000000000000000n, 'inner _value must equal tx value');
  assert.equal(Number(gas), 400000, 'L2 execution budget');
  assert.equal(isCreation, false, 'a plain transfer creates no contract');
  assert.equal(l2data, '0x', 'no L2 calldata for a native transfer');
});

test('opstack: covers every shipped OP-stack pair on both L1s', () => {
  const mainnetL2s = [10, 130, 480, 8453, 81457];
  for (const l2 of mainnetL2s) {
    const bound = opstackQuote(nativeCtx({ toChainId: l2 }));
    assert.equal(bound.tx.to, PORTALS[l2]);
    assert.equal(bound.tx.chainId, 1);
  }
  assert.equal(opstackQuote(nativeCtx({ fromChainId: 11155111, toChainId: 11155420 })).tx.to,
    PORTALS[11155420]);
  assert.equal(opstackQuote(nativeCtx({ fromChainId: 11155111, toChainId: 84532 })).tx.to,
    PORTALS[84532]);
});

test('opstack: refuses everything outside a native L1 → L2 deposit', () => {
  assert.throws(() => opstackQuote(erc20Ctx()), /native ETH only/,
    'an ERC-20 has no canonical path here');
  assert.throws(() => opstackQuote(nativeCtx({ fromChainId: 10, toChainId: 1 })),
    /L1 → L2 only/, 'a withdrawal needs the proof round-trip — not this adapter');
  assert.throws(() => opstackQuote(nativeCtx({ fromChainId: 11155111, toChainId: 10 })),
    /L1 → L2 only/, "Sepolia cannot deposit to a mainnet portal");
  assert.throws(() => opstackQuote(nativeCtx({ toChainId: 56 })), /no canonical portal/);
  assert.throws(() => opstackQuote(nativeCtx({ amountSmallest: '0' })), /positive/);
});

// ── dispatch + registry ────────────────────────────────────────
test('all three adapters are registered under their registry ids', () => {
  assert.equal(BRIDGE_ROUTE_FETCHERS.gaszip, gaszipQuote);
  assert.equal(BRIDGE_ROUTE_FETCHERS.relay, relayQuote);
  assert.equal(BRIDGE_ROUTE_FETCHERS.opstack, opstackQuote);
  assert.equal(BRIDGE_ROUTE_FETCHERS.lifi, undefined, 'LI.FI keeps its own path in bridge.js (quoteUrl/validateQuote)');
});

test('registry: all bridge chains ⊆ NETWORKS, gas.zip + opstack stay native-only', async () => {
  const { BRIDGE_ROUTERS } = await import('../js/routers.js');
  const { NETWORKS } = await import('../js/network.js');
  const shipped = new Set(NETWORKS.map(n => n.chainId));
  for (const r of BRIDGE_ROUTERS) {
    for (const c of r.chains) assert.ok(shipped.has(c), `${r.id} claims chain ${c} which is not in NETWORKS`);
  }
  const gz = BRIDGE_ROUTERS.find(r => r.id === 'gaszip');
  assert.equal(gz.nativeOnly, true, 'the deposit_wei route cannot quote an ERC-20');
  const os = BRIDGE_ROUTERS.find(r => r.id === 'opstack');
  assert.equal(os.nativeOnly, true, 'the portal mints ETH only');
  assert.equal(os.api, null, 'the canonical deposit calls no API at all');
  const relay = BRIDGE_ROUTERS.find(r => r.id === 'relay');
  assert.ok(relay.chains.every(c => NETWORKS.find(n => n.chainId === c)?.type === 'mainnet'),
    'relay has no testnet API on this host — no testnet claim');
  assert.ok(relay.chains.length >= 17, `relay covers the shipped mainnets, got ${relay.chains.length}`);
});

// ── two-column token picker (M2a) ──────────────────────────────
test('bridge view carries a destination token column beside the source one', () => {
  const jsx = readFileSync(new URL('../src/views/bridge.jsx', import.meta.url), 'utf8');
  assert.ok(jsx.includes('id="bridgeToken"'), 'source column kept');
  assert.ok(jsx.includes('id="bridgeToToken"'), 'destination column added');
  assert.ok(jsx.includes('data-picker="bridgeToToken"'), 'destination uses the shared token picker');
  const fromAt = jsx.indexOf('id="bridgeToken"');
  const toAt = jsx.indexOf('id="bridgeToToken"');
  const rowAt = jsx.indexOf('bridge-chains bridge-token-row');
  assert.ok(rowAt > -1 && rowAt < Math.min(fromAt, toAt), 'both columns live in one grid row (mirror of the chain row)');
});

test('bridge.js paints both columns from ONE option list and keeps them in sync', () => {
  const src = readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
  assert.ok(/initTokenPicker\('bridgeToToken'/.test(src), 'destination column is a real picker');
  assert.ok(/function syncBridgeTokenSide\(/.test(src), 'either column drives the other');
  assert.ok(/function toValueOf\(/.test(src), 'one mapping source → twin value');
  // doBridge derives the destination from the curated twin (fail closed) and
  // then repaints the column, so a stale value can never disagree with the tx.
  assert.ok(/toTokEl\.value = toTokenAddress \|\| 'native'/.test(src), 'destination column repainted from the twin');
  const doBridge = src.slice(src.indexOf('export async function doBridge()'));
  assert.ok(doBridge.indexOf('twin.address') > -1, 'the twin from POPULAR_TOKENS stays authoritative');
});
