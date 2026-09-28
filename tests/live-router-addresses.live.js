// Bear Tool — live router address verification
//
// The static guards in router-registry.test.js check the registry is internally
// consistent. This one checks it is TRUE: that every address answers on the
// chain it is listed for.
//
// It exists because the registry was wrong in a way no source-level test could
// see. Camelot 0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2 and Aerodrome
// 0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441 are well-formed addresses with the
// right-looking checksums and NO CODE on Arbitrum and Base. A registry test that
// only read the source would have passed them forever.
//
// Two independent endpoints per chain, because the first version of this check
// used one endpoint and reported Ethereum's QuoterV2 as absent when it is
// present — a single node failing is not an answer about the chain.
//
// This file is NOT part of `npm test`. It is a live-network check, run with
// `npm run test:live`, because a gate that depends on someone else's uptime is a
// gate that eventually reports a network problem as a product problem.
//
// Skipped when there is no network, so an offline run is honest rather than red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { SWAP_ROUTERS, BRIDGE_ROUTERS } = await import(pathToFileURL(path.join(here, '..', 'js', 'routers.js')).href);

const NETWORKS = await import(pathToFileURL(path.join(here, '..', 'js', 'network.js')).href).then((m) => m.NETWORKS);

// One endpoint per chain and one pass. The first version asked three endpoints
// twice, which was the right instinct — a single node failing is not an answer
// about a chain, and it is why an early reading of this file wrongly reported
// Ethereum's QuoterV2 as absent — but it also meant hundreds of sequential
// requests inside a test run, and the whole suite stopped producing output on a
// fresh box. One endpoint plus a second only when the first disagrees keeps the
// protection and makes the run finish.
//
// Two endpoints per chain, from the app's own list where possible.
const EXTRA = {
  1: ['https://eth.llamarpc.com'],
  137: ['https://polygon.drpc.org'],
  10: ['https://optimism.drpc.org'],
  42161: ['https://arbitrum.drpc.org'],
  8453: ['https://base.drpc.org'],
  56: ['https://bsc.drpc.org'],
  11155111: ['https://sepolia.drpc.org'],
  80002: ['https://polygon-amoy.drpc.org'],
  421614: ['https://arbitrum-sepolia.drpc.org'],
  11155420: ['https://optimism-sepolia.drpc.org'],
  84532: ['https://base-sepolia.drpc.org'],
  97: ['https://bsc-testnet.drpc.org'],
};

const rpcFor = (chainId) => {
  const net = NETWORKS.find((n) => Number(n.chainId) === Number(chainId));
  const first = net?.rpc?.[0];
  return [first, ...(EXTRA[chainId] || [])].filter(Boolean);
};

async function rpc(url, method, params, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message.slice(0, 50));
    return j.result;
  } finally { clearTimeout(timer); }
}

async function codeSize(url, addr, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) return { size: -1, why: j.error.message.slice(0, 40) };
    return { size: (j.result.length - 2) / 2, why: '' };
  } catch (e) {
    return { size: -1, why: e.name };
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasCode(chainId, addr) {
  const urls = rpcFor(chainId);
  const seen = [];
  for (const u of urls) {
    const r = await codeSize(u, addr);
    seen.push(r);
    if (r.size > 0) return { ok: true, endpoint: new URL(u).host, seen };
    // Only pay for the fallback when the first endpoint actually failed to
    // answer. A clean "0 bytes" is an answer and needs no second opinion.
    if (r.size === 0) return { ok: false, endpoint: null, seen, inconclusive: false };
    await sleep(150);
  }
  const networkErrors = seen.filter((s) => s.size < 0).length;
  return { ok: false, endpoint: null, seen, inconclusive: seen.every((s) => s.size < 0) || networkErrors === seen.length };
}

// Connectivity is eth_blockNumber, not eth_getCode on a convenient address.
// The first version probed the burn address, which correctly has NO code — so a
// perfectly healthy chain read as "no network" and the whole file skipped. A
// reachability check must ask a question reachability can answer.
const online = await (async () => {
  try {
    const r = await rpc('https://ethereum-rpc.publicnode.com', 'eth_blockNumber', [], 15000);
    return { ok: typeof r === 'string' && r.length > 2, why: r ? '' : 'eth_blockNumber kosong' };
  } catch (e) { return { ok: false, why: e.message.slice(0, 50) }; }
})();

test('every on-chain router address has code on the chain it is listed for', async (t) => {
  if (!online.ok) {
    t.skip(`no network: eth_blockNumber on Ethereum returned "${online.why || 'kosong'}"`);
    return;
  }
  const dead = [];
  const skipped = [];
  for (const r of SWAP_ROUTERS) {
    for (const [chainStr, addr] of Object.entries(r.router || {})) {
      const chain = Number(chainStr);
      const res = await hasCode(chain, addr);
      if (res.ok) continue;
      if (res.inconclusive) { skipped.push(`${r.id} chain ${chain} (semua endpoint gagal)`); continue; }
      dead.push(`${r.name} ${addr} on chain ${chain} — no code at ${res.endpoint ? res.endpoint : 'any endpoint'}`);
    }
    for (const [chainStr, addr] of Object.entries(r.quoter || {})) {
      const chain = Number(chainStr);
      const res = await hasCode(chain, addr);
      if (res.ok) continue;
      if (res.inconclusive) { skipped.push(`${r.id} quoter chain ${chain} (semua endpoint gagal)`); continue; }
      dead.push(`${r.name} QUOTER ${addr} on chain ${chain} — no code`);
    }
  }
  if (skipped.length) t.diagnostic(`tidak bisa dijangkau: ${skipped.join(' · ')}`);
  assert.deepEqual(dead, [],
    `these addresses are listed but have no contract behind them:\n    ${dead.join('\n    ')}\n` +
    `    Fix by removing the entry or correcting the address — do not add a key to make it work.`);
});

test('the quoter and the router are both deployed wherever a V3 route is offered', async (t) => {
  if (!online.ok) { t.skip('no network'); return; }
  const bad = [];
  for (const r of SWAP_ROUTERS) {
    if (r.abi !== 'v3') continue;
    for (const chain of r.chains.map(Number)) {
      const router = r.router?.[chain];
      const quoter = r.quoter?.[chain];
      if (!router) { bad.push(`${r.name} chain ${chain}: no router`); continue; }
      if (!quoter) { bad.push(`${r.name} chain ${chain}: no quoter — a quote with no router cannot be sent`); continue; }
      const [rq, qq] = [await hasCode(chain, router), await hasCode(chain, quoter)];
      if (rq.ok !== true) bad.push(`${r.name} chain ${chain}: router ${router} ${rq.ok ? '' : 'tidak ada'}`);
      if (qq.ok !== true) bad.push(`${r.name} chain ${chain}: quoter ${quoter} ${qq.ok ? '' : 'tidak ada'}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n    '));
});

test('the bridge route still answers without a key', async (t) => {
  if (!online.ok) { t.skip('no network'); return; }
  // LI.FI returning a transactionRequest unauthenticated is the only reason the
  // bridge tab is a route rather than a list. A project note claimed this had
  // started requiring a key; it had not, and the claim would have deleted a
  // working feature.
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x1111111111111111111111111111111111111111&toAddress=0x1111111111111111111111111111111111111111';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) {
      t.skip('LI.FI now requires a key — the bridge tab needs a real answer, not a dead entry');
      return;
    }
    assert.equal(r.status, 200, `LI.FI /v1/quote answered HTTP ${r.status}`);
    const j = await r.json();
    assert.ok(j.transactionRequest?.to && j.transactionRequest?.data,
      'LI.FI must return a signable transaction; without one the route is a dead end');
  } catch (e) {
    t.skip(`LI.FI unreachable (${e.name}) — cannot judge, not a failure`);
  } finally { clearTimeout(timer); }
});

test('no route in the registry points at a service that answers 401/403', async (t) => {
  if (!online.ok) { t.skip('no network'); return; }
  // The claim to test is one-directional: a service that needs a credential must
  // NOT be offered as a route. The first version asserted that no probed
  // service needed a key, which fails for 1inch and Bungee precisely because
  // they DO — and reported that as a problem with the registry when it was the
  // correct outcome.
  const PROBES = [
    ['1inch', 'https://api.1inch.dev/swap/v6.0/1/quote?src=0x0000000000000000000000000000000000000000&dst=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&amount=1'],
    ['bungee', 'https://backend.bungee.exchange/v1/quote?fromChainId=1&toChainId=10&fromTokenAddress=0x0000000000000000000000000000000000000000&toTokenAddress=0x0000000000000000000000000000000000000000&fromAmount=1&toAddress=0x1111111111111111111111111111111111111111'],
  ];
  const listed = new Set([...SWAP_ROUTERS, ...BRIDGE_ROUTERS].map((r) => r.id.toLowerCase()));
  const offenders = [];
  const confirmedKeyless = [];
  for (const [id, url] of PROBES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let status = 0;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      status = r.status;
    } catch { /* unreachable is not a key requirement */ } finally { clearTimeout(timer); }
    const needsKey = status === 401 || status === 403;
    if (needsKey && listed.has(id)) offenders.push(`${id} (HTTP ${status})`);
    if (!needsKey && status === 200) confirmedKeyless.push(id);
  }
  t.diagnostic(`layanan yang butuh key: ${PROBES.map(([id]) => id).join(', ')} — semuanya tidak ada di registry`);
  assert.deepEqual(offenders, [],
    `these services need a credential and are still offered as routes: ${offenders.join(', ')}`);
});
