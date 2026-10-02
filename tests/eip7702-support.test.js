// Bear Tool — tests/eip7702-support.test.js
//
// The support check asks every RPC the same impossible question and classifies
// the answer. Classification is the entire product here: mark a chain as
// supporting 7702 when it does not, and someone picks a delegating contract
// path on a chain that will refuse the transaction; mark it unsupported when
// it does work, and a working feature looks broken.
//
// The fixtures below are the payloads that were actually returned by the live
// public endpoints while this feature was being designed — not invented
// examples. Four shapes were observed and two detection methods were thrown
// out; both of the discarded methods have a test pinning them dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classify, probeRpc, checkNetwork, checkAllNetworks, summarize,
  STATUS, PROBE_BODY, PROBE_TIMEOUT_MS,
} from '../js/eip7702-support.js';

const src = readFileSync(new URL('../js/eip7702-support.js', import.meta.url), 'utf8');

// ── captured from real endpoints, 2026-10-02 ───────────────────────────────
const FROM_ETHEREUM = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'failed with 16777216 gas: EIP-7702 transaction with empty auth list (sender 0x0000000000000000000000000000000000000000)' } };
const FROM_BSC = { jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'EIP-7702 authorization list has invalid signature or nonce' } };
const FROM_AVALANCHE = { jsonrpc: '2.0', id: 1, result: '0x' };
const FROM_ONE_RPC_LIMIT = { jsonrpc: '2.0', id: 1, error: { code: -32001, message: "You've reached the usage limit for your current plan." } };

test('a node that decoded authorizationList is reported as supporting 7702', () => {
  // Both observed error shapes: the empty-list rejection and the list validator.
  assert.equal(classify(FROM_ETHEREUM).status, STATUS.SUPPORT);
  assert.equal(classify(FROM_BSC).status, STATUS.SUPPORT);
  assert.equal(classify({ error: { code: -32000, message: 'failed with 50000341 gas: EIP-7702 …' } }).status, STATUS.SUPPORT);
  assert.equal(classify({ error: { code: -32003, message: 'EIP-7702 authorization list has inval…' } }).status, STATUS.SUPPORT);
});

test('a node that silently ignored the field is reported as NOT supporting', () => {
  // "0x" means the probe ran to completion. An empty authorizationList is
  // invalid on every node that reads it, so nobody who decoded it says yes.
  assert.equal(classify(FROM_AVALANCHE).status, STATUS.UNSUPPORTED);
  assert.equal(classify({ result: '0x' }).status, STATUS.UNSUPPORTED);
  // `result: null` is a malformed answer, not a decoded field — calling it
  // "unsupported" would turn a broken response into a claim about the chain.
  assert.equal(classify({ result: null }).status, STATUS.UNKNOWN, 'null is not an answer');
});

test('a rate limit is UNKNOWN, never unsupported', () => {
  // The endpoint refused US. Turning that into "this chain has no 7702" would
  // publish a false answer about a chain we never managed to ask.
  const r = classify(FROM_ONE_RPC_LIMIT);
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.ok(!r.detail.startsWith('node'), 'the refusal reason survives into the detail');
});

test('a quota error that echoes our body is still not support', () => {
  // Some gateways quote the request back inside their error. The limit markers
  // are checked first so "…authorizationList… you have hit the rate limit" cannot
  // be mistaken for a real 7702 answer.
  const r = classify({ error: { code: -32001, message: 'authorizationList rejected: usage limit exceeded' } });
  assert.equal(r.status, STATUS.UNKNOWN);
});

test('an unrecognised error stays UNKNOWN rather than being guessed', () => {
  assert.equal(classify({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } }).status, STATUS.UNKNOWN);
  assert.equal(classify({}).status, STATUS.UNKNOWN);
  assert.equal(classify(null).status, STATUS.UNKNOWN);
});

test('the discarded detection methods stay dead', () => {
  // Comments are stripped: the module is REQUIRED to explain why these two
  // were thrown out, so the string appears in prose. What must not appear is
  // the string in CODE — a live probe on either method would ship a wrong answer.
  const code = src
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // (1) requestsHash off the latest block: Arbitrum's latest block has none
  //     yet Arbitrum answers with an EIP-7702 error → false negative.
  assert.ok(!code.includes('requestsHash'), 'requestsHash was measured false-negative on Arbitrum');
  // (2) eth_call with type only: publicnode returned 0x for probe AND control.
  assert.ok(!code.includes('eth_call'), 'eth_call with type alone cannot tell the two apart');
  assert.ok(code.includes('eth_estimateGas'), 'and the method that did work stays');
});

test('the probe cannot spend, sign or broadcast anything', () => {
  const body = JSON.parse(PROBE_BODY);
  assert.equal(body.method, 'eth_estimateGas', 'estimate only');
  const [tx] = body.params;
  assert.equal(tx.type, '0x4', 'the 7702 transaction type');
  assert.deepEqual(tx.authorizationList, [], 'the field the node must decode');
  assert.equal(tx.from, '0x0000000000000000000000000000000000000000', 'zero address');
  assert.equal(tx.to, '0x0000000000000000000000000000000000000000');
  assert.ok(!('gas' in tx) && !('value' in tx), 'nothing to spend');
  const flat = JSON.stringify(body);
  assert.ok(!/privateKey|mnemonic|sign/i.test(flat), 'no secret ever enters the probe');
  assert.ok(PROBE_TIMEOUT_MS >= 1000 && PROBE_TIMEOUT_MS <= 30000, 'bounded wait');
});

// ── probeRpc: a dead endpoint is a result, not an exception ─────────────────
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

test('probeRpc classifies every transport outcome without throwing', async () => {
  assert.equal((await probeRpc('https://a', { fetchFn: async () => ok(FROM_ETHEREUM) })).status, STATUS.SUPPORT);
  assert.equal((await probeRpc('https://a', { fetchFn: async () => ok(FROM_AVALANCHE) })).status, STATUS.UNSUPPORTED);
  assert.equal((await probeRpc('https://a', { fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }) })).status, STATUS.UNKNOWN);
  assert.equal((await probeRpc('https://a', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } })).status, STATUS.OFFLINE);
  const timeout = await probeRpc('https://a', {
    fetchFn: (_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
    timeoutMs: 10,
  });
  assert.equal(timeout.status, STATUS.OFFLINE);
  assert.equal(timeout.detail, 'timeout');
});

test('probeRpc posts the probe body to the endpoint given', async () => {
  let seen;
  await probeRpc('https://rpc.example/x', { fetchFn: async (url, init) => { seen = { url, init }; return ok(FROM_ETHEREUM); } });
  assert.equal(seen.url, 'https://rpc.example/x');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, PROBE_BODY);
});

// ── roll-up: one network, then all of them ─────────────────────────────────
const net = (id, rpc) => ({ id, name: id, chainId: 1, rpc });

test('one supporting endpoint makes the whole network support', async () => {
  const r = await checkNetwork(net('eth', ['https://a', 'https://b']), {
    fetchFn: async () => ok(FROM_ETHEREUM),
  });
  assert.equal(r.status, STATUS.SUPPORT);
  assert.equal(r.rpcs.length, 2, 'every configured endpoint is reported, not just the first');
  assert.equal(r.detail, '2/2 endpoints support 7702');
});

test('a network answers unsupported only when an endpoint actually says no', async () => {
  const answers = { 'https://a': ok(FROM_AVALANCHE), 'https://b': ok(FROM_AVALANCHE) };
  const r = await checkNetwork(net('avax', ['https://a', 'https://b']), { fetchFn: async (u) => answers[u] });
  assert.equal(r.status, STATUS.UNSUPPORTED);
  assert.equal(r.detail, '0/2 endpoints support 7702');
});

test('mixed endpoints roll up to support, and keep the losers visible', async () => {
  const answers = { 'https://yes': ok(FROM_BSC), 'https://no': ok(FROM_AVALANCHE) };
  const r = await checkNetwork(net('mix', ['https://yes', 'https://no']), { fetchFn: async (u) => answers[u] });
  assert.equal(r.status, STATUS.SUPPORT);
  const byUrl = Object.fromEntries(r.rpcs.map((x) => [x.url, x.status]));
  assert.deepEqual(byUrl, { 'https://yes': STATUS.SUPPORT, 'https://no': STATUS.UNSUPPORTED },
    'the unsupported link is still listed so the user does not pick it');
});

test('every endpoint failing leaves the network UNKNOWN, not unsupported', async () => {
  const r = await checkNetwork(net('dead', ['https://a', 'https://b']), { fetchFn: async () => { throw new TypeError('down'); } });
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.equal(r.detail, '0/2 endpoints support 7702');
});

test('a network with no RPC configured is reported, not skipped silently', async () => {
  const r = await checkNetwork(net('none', []));
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.match(r.detail, /no RPC/);
  assert.equal(r.rpcs.length, 0);
});

test('checkAllNetworks returns one result per network, in order, with progress', async () => {
  const nets = [net('one', ['https://a']), net('two', ['https://b']), net('three', ['https://c'])];
  const answers = { 'https://a': ok(FROM_ETHEREUM), 'https://b': ok(FROM_AVALANCHE), 'https://c': ok(FROM_ETHEREUM) };
  const seen = [];
  const all = await checkAllNetworks(nets, { fetchFn: async (u) => answers[u], onResult: (r) => seen.push(r.network.id) });
  assert.deepEqual(all.map((r) => r.network.id), ['one', 'two', 'three'], 'order preserved');
  assert.deepEqual(seen, ['one', 'two', 'three'], 'progress fires per row so the UI fills as it goes');
  assert.deepEqual(summarize(all), { support: 2, unsupported: 1, unknown: 0, offline: 0, total: 3 });
});

test('summarize of an empty run reports zero, not NaN', () => {
  assert.deepEqual(summarize([]), { support: 0, unsupported: 0, unknown: 0, offline: 0, total: 0 });
});
