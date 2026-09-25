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

// answers any request with a fixed JSON-RPC result
function tinyRpc(result = '0x10') {
  const srv = net.createServer(sock => {
    sock.on('data', () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
    });
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
  const good = tinyRpc();
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
