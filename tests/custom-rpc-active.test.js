// Bear Tool — custom-rpc-active.test.js
//
// LIVE BUG (user report, 2026-10-03): "Add Network" → paste
// http://127.0.0.1:8546 (sepolia fork, funded 100 ETH) → saved → picked as
// active → balance stayed 0. Cause: getProvider(chainId) resolved the BUILTIN
// network for that chainId — getNetwork() searches [...NETWORKS, ...custom]
// (js/network.js) — so the user's endpoint was never queried and the app
// silently talked to the default public node, which reports 0. The picker said
// "custom network active" while every call went elsewhere: the same silent-
// substitution class the override refusal in getProvider was written against.
//
// Reproduction = the exact live shape, hermetic: TWO local endpoints for the
// SAME chainId — the ACTIVE custom one must answer (100 ETH), the builtin
// default must not (0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}
if (!globalThis.document) {
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: { style: {} },
  };
}
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });
if (!globalThis.ethers) {
  try {
    globalThis.ethers = (await import('ethers')).ethers;
  } catch (err) {
    throw new Error('ethers is not installed — run `npm install` first. (underlying: ' + err.message + ')');
  }
}

const state = await import('../js/state.js');
const { getProvider, NETWORKS } = await import('../js/network.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function kill(server) {
  try { server.closeAllConnections?.(); } catch { /* noop */ }
  for (const s of server._bearSockets || []) { try { s.destroy(); } catch { /* noop */ } }
  return new Promise(res => server.close(() => res()));
}

// Minimal JSON-RPC HTTP server (same contract as rpc-resilience's tinyRpc):
// per-method answers, id echoed — ethers increments ids per request.
// Per-method matters: getProvider probes eth_blockNumber and ethers rejects an
// out-of-safe-range block number ("invalid numeric string: overflow"), so a
// 100-ETH balance string echoed back as the block number fails the probe even
// though eth_getBalance would accept it.
function tinyRpc(balanceHex, blockHex, chainIdHex) {
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const length = Number((/content-length:\s*(\d+)/i.exec(buf.slice(0, headEnd)) || [])[1] || 0);
      const body = buf.slice(headEnd + 4, headEnd + 4 + length);
      if (body.length < length) return;
      buf = buf.slice(headEnd + 4 + length);
      let method = '';
      let id = 1;
      try { method = JSON.parse(body)?.method || ''; id = JSON.parse(body)?.id ?? 1; } catch { /* not JSON-RPC */ }
      const result = method === 'eth_chainId' ? chainIdHex
        : method === 'eth_blockNumber' ? blockHex
        : method === 'eth_getBalance' ? balanceHex
          : '0x0';
      const out = JSON.stringify({ jsonrpc: '2.0', id, result });
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
        + `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n${out}`);
    });
    sock.on('error', () => { /* noop */ });
  });
  srv._bearSockets = new Set();
  srv.on('connection', (s) => { srv._bearSockets.add(s); s.on('close', () => srv._bearSockets.delete(s)); });
  return srv;
}

const SEPOLIA = 11155111;
const CHAIN_HEX = '0xaa36a7';                      // sepolia
const FUNDED = '0x56bc75e2d63100000';              // 100 ETH
const ADDR = '0x197bCec95428789cB037F83d67e6306A7D29bC2D';
const CUSTOM_ID = 'custom-live-funded';

async function seedPair() {
  // serverA = user's custom endpoint (funded fork); serverB = builtin default
  // (stands in for publicnode — hermetic, no internet in this test).
  const a = tinyRpc(FUNDED, '0x5000000', CHAIN_HEX);
  const b = tinyRpc('0x0', '0x5000000', CHAIN_HEX);
  const portA = await listen(a);
  const portB = await listen(b);
  const builtin = NETWORKS.find(n => n.chainId === SEPOLIA);
  const origRpc = builtin.rpc;
  builtin.rpc = [`http://127.0.0.1:${portB}`];
  localStorage.setItem('bear.customNetworks', JSON.stringify([
    {
      id: CUSTOM_ID, chainId: SEPOLIA, name: 'Sepolia (local fork)',
      symbol: 'ETH', decimals: 18, type: 'testnet', custom: true,
      rpc: [`http://127.0.0.1:${portA}`],
    },
  ]));
  const restore = async () => {
    builtin.rpc = origRpc;
    localStorage.removeItem('bear.customNetworks');
    state.set('networkId', 'ethereum');
    await kill(a);
    await kill(b);
  };
  return { restore };
}

test('jaringan custom yang AKTIF harus yang menjawab (saldo 100 ETH, bukan 0)',
  { timeout: 30000 }, async () => {
    const { restore } = await seedPair();
    state.set('networkId', CUSTOM_ID);
    try {
      const provider = await getProvider(SEPOLIA);
      const bal = await provider.getBalance(ADDR);
      assert.equal(
        bal.toString(), '100000000000000000000',
        'endpoint jaringan AKTIF (custom) harus dipakai — saldo 100 ETH dari fork, bukan 0 dari node bawaan',
      );
    } finally {
      await restore();
    }
  });

test('jaringan BAWAAN yang aktif tetap memakai endpoint bawaannya (guard)',
  { timeout: 30000 }, async () => {
    const { restore } = await seedPair();
    state.set('networkId', 'sepolia');            // builtin id — bukan custom
    try {
      const provider = await getProvider(SEPOLIA);
      const bal = await provider.getBalance(ADDR);
      assert.equal(bal.toString(), '0',
        'memilih sepolia bawaan harus tetap berarti node bawaan — fix tidak boleh membajak');
    } finally {
      await restore();
    }
  });
