// Bear Tool — fork-batch-hostile.test.js
//
// REPRODUCTION of the user-reported class: "fundex sends tx fine on the same
// machine, Bear Tool never runs at all". The structural difference that fits
// a 100%-failure with everything else green:
//
//   - every doSend fires provider.getFeeData(), which in ethers resolves
//     THREE calls in parallel (block + gasPrice + priorityFee) → they queue
//     into the provider's batch window → ONE POST with a JSON ARRAY;
//   - a batch-hostile endpoint (rejecting arrays, or silently swallowing
//     them) kills the send at the fee step,100% of the time;
//   - sequential reads stay single-object POSTs → the rest of the app works;
//   - ethers' default fetch timeout is 300 SECONDS (fetch.js:402) and the
//     pre-flight had no withTimeout → a hanging endpoint means a Send button
//     that does nothing for five minutes;
//   - fundex/viem never batches (http transport, retry 3x / 10s), which is
//     exactly why the reference app survives the same environment;
//   - the fork/e2e suite runs against anvil, which happily accepts arrays —
//     so every green run proved nothing about this class.
//
// This file closes the detector gap with a local hostile proxy in two modes:
//   1. 'forward' + array rejection (-32600) — doSend must still broadcast;
//   2. 'hang'     — no answer at all; doSend must fail FAST with a toast.
// It also asserts the traffic shape: zero array POSTs, N single POSTs — so a
// fix cannot claim green by routing around the proxy.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFork, stopFork, forkSkipReason, ANVIL_ACCOUNT, ANVIL_KEY } from './fork-helper.mjs';

const skip = forkSkipReason();

// ── storage shims (journey/fork-doSend pattern): state.js writes activity ──
const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
};
globalThis.localStorage = store();
globalThis.sessionStorage = store();

// ── DOM stub (fork-doSend pattern): confirmTx promise + toast capture ──────
function makeClassList() {
  const set = new Set();
  return {
    add: (...n) => { for (const x of n) set.add(x); },
    remove: (...n) => { for (const x of n) set.delete(x); },
    toggle: (n, force) => {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      return want;
    },
    contains: (n) => set.has(n),
  };
}
const created = [];
function makeEl(name = '') {
  return {
    name, innerHTML: '', textContent: '', value: '', disabled: false,
    className: '', dataset: {}, style: {}, tabIndex: 0, offsetParent: {},
    focus() {}, remove() {},
    classList: makeClassList(),
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { created.push(c); return c; },
  };
}
const els = new Map();
const el = (sel) => {
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};
const gasBtn = makeEl('.gas-btn.active');
gasBtn.dataset.speed = 'normal';

globalThis.document = {
  querySelector: (sel) => (sel === '.gas-btn.active' ? gasBtn : el(sel)),
  querySelectorAll: () => [],
  getElementById: (id) => (els.has('#' + id) ? els.get('#' + id) : null),
  createElement: (tag) => { const e = makeEl(tag); created.push(e); return e; },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
  activeElement: null,
};
el('#toast-wrap');

const { ethers } = await import('ethers');
globalThis.ethers = ethers;
const state = await import('../../js/state.js');
const netMod = await import('../../js/network.js');
const sendMod = await import('../../js/send.js');

const toasts = () => created
  .filter((e) => typeof e.className === 'string' && e.className.startsWith('toast'))
  .map((e) => e.textContent);

/** Click every fresh confirmTx "Yes" the moment it is wired (fork-doSend). */
function driveModals(promise) {
  let last = null;
  const iv = setInterval(() => {
    const yes = els.get('#confirmYes');
    if (yes && typeof yes.onclick === 'function' && yes.onclick !== last) {
      last = yes.onclick;
      yes.onclick();
    }
  }, 20);
  return promise.finally(() => clearInterval(iv));
}

/**
 * A local endpoint the app is forced through, with a mode switch:
 *   'forward' — single-object POSTs are proxied to anvil; JSON ARRAY bodies
 *               are rejected with -32600 (what a batch-hostile node answers);
 *   'hang'    — the request is accepted and never answered (silent drop).
 * Counters record what the app actually sent, so the assertions can prove the
 * traffic shape instead of only the outcome.
 */
function startHostileProxy(upstreamUrl) {
  const stats = { arrays: 0, singles: 0, hangs: 0 };
  const sockets = new Set();
  let mode = 'forward';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (mode === 'hang') { stats.hangs++; return; } // hold the socket — no answer
      if (body.trimStart().startsWith('[')) {
        stats.arrays++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32600, message: 'Batch JSON-RPC is disabled by policy' },
        }));
        return;
      }
      stats.singles++;
      try {
        const up = await fetch(upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const text = await up.text();
        res.writeHead(up.status, { 'content-type': 'application/json' });
        res.end(text);
      } catch {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream down"}}');
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        stats,
        setMode: (m) => { mode = m; },
        reset: () => { stats.arrays = 0; stats.singles = 0; stats.hangs = 0; },
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
      });
    });
  });
}

let proxy = null;

before(async () => {
  if (skip) return;
  await startFork();
  const upstream = `http://127.0.0.1:${process.env.FORK_PORT || 8545}`;
  proxy = await startHostileProxy(upstream);
});

after(async () => {
  if (skip) return;
  await proxy?.close();
  await stopFork();
});

/** Seed the custom-RPC override so getProvider() binds to the proxy, exactly
 *  the path a user's Settings → Custom RPC takes, then hand doSend the result. */
async function providerThroughProxy() {
  const { network } = await startFork();
  globalThis.localStorage.setItem(
    'bear.rpcOverrides',
    JSON.stringify({ [network.name]: [proxy.url] }),
  );
  const provider = await netMod.getProvider(network.chainId);
  state.set('provider', provider);
  return provider;
}

function armSendForm({ to, amount }) {
  state.set('unlocked', true);
  state.set('address', ANVIL_ACCOUNT);
  state.set('activity', []);
  state.set('tokens', [{ address: null, symbol: 'ETH', decimals: 18, balance: 0n }]);
  state.set('signer', new ethers.Wallet(ANVIL_KEY));
  el('#sendTo').value = to;
  el('#sendAmount').value = amount;
  el('#sendToken').value = 'native';
  el('#btnSend').disabled = false;
  gasBtn.dataset.speed = 'normal';
}

test('batch-hostile endpoint: doSend still broadcasts — zero array POSTs', {
  skip, timeout: 180_000,
}, async () => {
  proxy.setMode('forward');
  proxy.reset();
  const provider = await providerThroughProxy();
  const to = ethers.Wallet.createRandom().address;
  armSendForm({ to, amount: '0.001' });

  await driveModals(sendMod.doSend());

  const activity = state.get('activity');
  assert.equal(activity.length, 1,
    `doSend died on a batch-hostile endpoint; toasts=${JSON.stringify(toasts())} `
    + `arrays=${proxy.stats.arrays} singles=${proxy.stats.singles}`);
  assert.equal(proxy.stats.arrays, 0,
    `the app sent ${proxy.stats.arrays} JSON-ARRAY POSTs — batching is back`);
  assert.ok(proxy.stats.singles >= 5,
    `traffic did not go through the proxy (singles=${proxy.stats.singles}) — false green`);

  const bal = await provider.getBalance(to); // also through the proxy
  assert.ok(bal > 0n, 'recipient balance must have moved on chain');
});

test('hanging endpoint: doSend fails FAST with a toast, not in 5 minutes', {
  skip, timeout: 600_000,
}, async () => {
  proxy.setMode('forward');
  const provider = await providerThroughProxy(); // construction probes answer
  proxy.setMode('hang');                          // …then the node goes silent

  const to = ethers.Wallet.createRandom().address;
  armSendForm({ to, amount: '0.001' });
  const t0 = Date.now();
  try {
    await driveModals(sendMod.doSend());
  } finally {
    proxy.setMode('forward'); // never leave the suite behind a black hole
  }
  const elapsed = Date.now() - t0;

  assert.equal(state.get('activity').length, 0, 'must not broadcast on a dead RPC');
  assert.ok(elapsed < 30_000,
    `pre-flight must fail within 30s, took ${elapsed}ms — a silent wait is the bug`);
  assert.ok(toasts().some((t) => /too long|timed out|failed|estimation|balance check/i.test(t)),
    `expected a visible failure toast, got ${JSON.stringify(toasts())}`);
});
