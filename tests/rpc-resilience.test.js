// Bear Tool — rpc-resilience.test.js
// The "muter-muter" regression guard, using a REAL black-holed TCP socket:
// a server that accepts the connection and then never answers. This is what a
// dead/stalled RPC endpoint actually looks like, and it used to hang the UI
// forever. If someone removes the timeout, this test starts hanging too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// minimal DOM so js/network.js can be imported outside the browser
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
}
if (!globalThis.document) {
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { style: {} } };
}
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });
// ethers is loaded from a <script> tag in the browser (vendored, see index.html);
// inject the same library here for Node. A missing dependency must fail loudly.
// This previously swallowed the error with an empty catch, which made getProvider
// report "ethers is not defined" and the assertions fail with a misleading
// "did the probe even run?" — reading like an RPC bug instead of a missing install.
if (!globalThis.ethers) {
  try {
    globalThis.ethers = (await import('ethers')).ethers;
  } catch (err) {
    throw new Error(
      'ethers is not installed — run `npm install` first. This is the real ' +
      'cause, not an RPC problem. (underlying: ' + err.message + ')'
    );
  }
}

const { getProvider } = await import('../js/network.js');
const { RPC_TIMEOUT_MS } = await import('../js/safetx.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// close() alone waits for established sockets and the black-holed connection
// never ends — the test would hang the runner instead of failing.
function kill(server) {
  try { server.closeAllConnections?.(); } catch {}
  for (const s of server._bearSockets || []) { try { s.destroy(); } catch {} }
  return new Promise(res => server.close(() => res()));
}

// accepts the connection, then stays silent forever
function blackHole() {
  const srv = net.createServer(() => { /* deliberately never respond */ });
  srv._bearSockets = new Set();
  srv.on('connection', s => { srv._bearSockets.add(s); s.on('close', () => srv._bearSockets.delete(s)); });
  return srv;
}

// A live endpoint answers each method on its own terms — in particular
// eth_chainId must report the chain it is actually on. Answering every method
// with one canned value models a node that confidently lies about its identity,
// which is a different scenario and is covered separately below.
//
// The old stub ignored the request body entirely and replied with one canned
// value for everything, so it never had to look at what was asked. Reading the
// method means actually parsing the HTTP request, because a single `data` event
// carries the headers and the body together — JSON.parse() on that whole chunk
// throws every time, and the stub silently degrades to the canned answer. The
// buffer below is what makes per-method answers possible at all.
function tinyRpc(result = '0x10', { chainId = null, chainIdError = false } = {}) {
  const srv = net.createServer(sock => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;                       // headers still arriving
      const length = Number((/content-length:\s*(\d+)/i.exec(buf.slice(0, headEnd)) || [])[1] || 0);
      const body = buf.slice(headEnd + 4, headEnd + 4 + length);
      if (body.length < length) return;              // body still arriving
      buf = buf.slice(headEnd + 4 + length);         // keep any pipelined request

      let method = '', id = 1;
      try { method = JSON.parse(body)?.method || ''; id = JSON.parse(body)?.id ?? 1; }
      catch { /* not JSON-RPC */ }

      const payload = (method === 'eth_chainId' && chainIdError)
        // An endpoint that genuinely does not implement the method.
        ? { error: { code: -32601, message: 'Method not supported' } }
        : { result: (method === 'eth_chainId' && chainId != null) ? chainId : result };

      // The id must be echoed, not hardcoded. A node that always answers "id: 1"
      // only works until the client asks a second question: ethers increments
      // the id per request, and a mismatched reply is not a slow node, it is a
      // dropped one ("missing response for request").
      const out = JSON.stringify({ jsonrpc: '2.0', id, ...payload });
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n` +
                 `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n${out}`);
    });
    sock.on('error', () => {});
  });
  srv._bearSockets = new Set();
  srv.on('connection', s => { srv._bearSockets.add(s); s.on('close', () => srv._bearSockets.delete(s)); });
  return srv;
}

const CHAIN = 949494;
const useNetwork = (rpc) => localStorage.setItem('bear.customNetworks', JSON.stringify([
  { id: 'custom-test', chainId: CHAIN, name: 'Test Chain', symbol: 'TST', decimals: 18, rpc, explorer: '' }
]));

test('a black-holed RPC is abandoned within the budget, not waited on forever', { timeout: 30000 }, async () => {
  const dead = blackHole();
  const port = await listen(dead);
  useNetwork([`http://127.0.0.1:${port}`]);
  const t0 = Date.now();
  let err = null;
  try { await getProvider(CHAIN); } catch (e) { err = e; }
  const dt = Date.now() - t0;
  await kill(dead);
  assert.ok(err, 'must reject instead of hanging');
  assert.match(err.message, /All RPCs failed/i);
  assert.ok(dt >= RPC_TIMEOUT_MS - 500, `gave up too early (${dt}ms) — did the probe even run?`);
  assert.ok(dt < RPC_TIMEOUT_MS + 6000, `took ${dt}ms — the timeout is not clamping the wait`);
});

test('a dead RPC first does not block a live RPC second', { timeout: 30000 }, async () => {
  const dead = blackHole();
  const good = tinyRpc('0x10', { chainId: '0x' + CHAIN.toString(16) });
  const deadPort = await listen(dead);
  const goodPort = await listen(good);
  useNetwork([`http://127.0.0.1:${deadPort}`, `http://127.0.0.1:${goodPort}`]);
  let provider = null;
  try { provider = await getProvider(CHAIN); } finally { await kill(dead); await kill(good); }
  assert.ok(provider, 'must fall through to the working endpoint');
  localStorage.removeItem('bear.customNetworks');
});

test('unknown networkId falls back to a usable network (no undefined.chainId crash)', async () => {
  const { getNetworkById } = await import('../js/network.js');
  const stale = getNetworkById('ethereum-sepolia');
  assert.ok(stale, 'stale id must not return undefined');
  assert.ok(stale.chainId && Array.isArray(stale.rpc) && stale.rpc.length, 'fallback must be usable');
});

// `staticNetwork: true` tells ethers to trust the chainId we declared and skip
// eth_chainId entirely, which left every downstream chain check comparing a
// constant with itself — bridge's post-await re-verification, and the chainId a
// deployed contract is filed under. getProvider now asks the node.
test('an RPC that reports a different chain is refused, not silently accepted', { timeout: 30000 }, async () => {
  const liar = tinyRpc('0x1', { chainId: '0x1' });   // alive, and confidently mainnet
  const port = await listen(liar);
  useNetwork([`http://127.0.0.1:${port}`]);
  let err = null;
  try { await getProvider(CHAIN); } catch (e) { err = e; }
  await kill(liar);
  localStorage.removeItem('bear.customNetworks');
  assert.ok(err, 'a node on the wrong chain must not produce a provider');
  assert.match(err.message, /All RPCs failed/i);
  assert.match(err.message, /reports chain/i,
    'the failure must name the mismatch — "reports chain 0x1, expected 949494"');
});

test('an RPC that cannot answer eth_chainId is used unverified, not rejected', { timeout: 30000 }, async () => {
  // An endpoint that simply does not implement the method is a configuration
  // problem, not an attack. Refusing it would break working setups, and the
  // blockNumber probe has already proved the socket is alive.
  const noChainId = tinyRpc('0x10', { chainIdError: true });
  const port = await listen(noChainId);
  useNetwork([`http://127.0.0.1:${port}`]);
  let provider = null, err = null;
  try { provider = await getProvider(CHAIN); } catch (e) { err = e; }
  await kill(noChainId);
  localStorage.removeItem('bear.customNetworks');
  assert.equal(err, null, 'an unverifiable endpoint must not be treated as a hostile one');
  assert.ok(provider, 'it must still be usable');
});

// The test above covers a wrong-chain endpoint when it is the ONLY one, because
// then the loop runs out and throws "All RPCs failed". It says nothing about the
// case that actually bites a user: an override they stored, plus the public
// endpoints that follow it.
//
// There the mismatch hit `continue`, which steps over the guard that turns an
// override failure into a loud error — that guard lives in the catch block, and
// a continue never reaches it. The loop then walked on to a public node, and the
// app carried on against a chain the user never chose. Measured in a real
// browser: with `bear.rpcOverrides = {"ethereum":["http://127.0.0.1:8545"]}` and a
// live anvil on that port, getProvider returned the public endpoint and block
// 26075508 — a real Ethereum block — while anvil answered HTTP 200 on block 2.
// The override was stored, read back, and first in the list, and still unused.
//
// The cost is not a wrong number on screen. Public endpoints that work for the
// author are frequently rate-limited, region-blocked or simply down for the
// person using the app, and an override is chosen precisely because the defaults
// do not work. Silently going back to the defaults fails every on-chain call with
// no visible reason.
test('a wrong-chain override is reported, not replaced by a public endpoint', { timeout: 30000 }, async () => {
  const liar = tinyRpc('0x10', { chainId: '0x1' });   // alive, and confidently mainnet
  const fallback = tinyRpc('0x10', { chainId: '0x' + CHAIN.toString(16) });
  const liarPort = await listen(liar);
  const fallbackPort = await listen(fallback);
  const liarUrl = `http://127.0.0.1:${liarPort}`;
  useNetwork([`http://127.0.0.1:${fallbackPort}`]);
  localStorage.setItem('bear.rpcOverrides', JSON.stringify({ 'custom-test': [liarUrl] }));

  let provider = null, err = null;
  try { provider = await getProvider(CHAIN); } catch (e) { err = e; }
  const used = provider ? endpointOf(provider) : null;

  await kill(liar); await kill(fallback);
  localStorage.removeItem('bear.customNetworks');
  localStorage.removeItem('bear.rpcOverrides');

  assert.equal(provider, null,
    `the override the user stored was ignored and ${used} was used instead — that is a ` +
    'silent substitution of the endpoint they chose, and every on-chain call then runs ' +
    'against a chain they did not pick');
  assert.ok(err, 'a wrong-chain override must be reported, not swallowed');
  assert.match(err.message, /did not answer|reports chain/i,
    'the message must name the problem — the same wording Settings already uses');
  // A wrapped message reads like a stutter and hides which half is the cause.
  // It shipped once: the refusal was thrown from inside the try and the catch
  // re-wrapped it, so the user saw the sentence twice plus the hint twice.
  const times = (re) => (err.message.match(re) || []).length;
  assert.equal(times(/did not answer/gi), 1, `the refusal is stated twice:\n${err.message}`);
  assert.equal(times(/Fix Settings/gi), 1, `the fix hint is stated twice:\n${err.message}`);
  assert.match(err.message, /reports chain 0x1, expected 949494/i,
    'the message must say what the node reported and what was expected');
});

// getProvider does not expose which URL it settled on, so read the one place the
// code records it (network.js attaches bearEndpoint before returning).
function endpointOf(provider) {
  try { return provider.bearEndpoint; } catch { return '(tidak diketahui)'; }
}
