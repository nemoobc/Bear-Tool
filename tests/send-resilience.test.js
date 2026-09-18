// Bear Tool — send-resilience.test.js
// Guards the "send cuma muter-muter" class of bug: nothing may wait forever.
// Every RPC probe and every tx.wait() must be bounded, and the Send screen's
// controls must actually be wired (they used to be dead markup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withTimeout, waitForReceipt, RPC_TIMEOUT_MS, CONFIRM_TIMEOUT_MS } from '../js/safetx.js';
import { getNetworkById } from '../js/network.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const jsFiles = fs.readdirSync(new URL('../js', import.meta.url)).filter(f => f.endsWith('.js'));

// ── runtime: withTimeout ──
test('withTimeout rejects with BEAR_TIMEOUT instead of hanging forever', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(never, 40, 'probe'),
    e => e.code === 'BEAR_TIMEOUT' && /probe/.test(e.message)
  );
});

test('withTimeout passes through a value that resolves in time', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 500, 'probe'), 'ok');
});

test('withTimeout clears its timer (no dangling handle on the fast path)', async () => {
  assert.equal(await withTimeout('sync', 5000, 'probe'), 'sync');
});

// ── runtime: waitForReceipt ──
test('waitForReceipt reports timedOut instead of spinning when a tx never confirms', async () => {
  const tx = { hash: '0xdeadbeef', wait: () => new Promise(() => {}) };
  const res = await waitForReceipt(tx, { timeoutMs: 40 });
  assert.equal(res.timedOut, true);
  assert.equal(res.receipt, null);
  assert.equal(res.hash, '0xdeadbeef', 'hash must survive so the user can track it');
});

test('waitForReceipt returns the receipt on success', async () => {
  const tx = { hash: '0xabc', wait: async () => ({ status: 1 }) };
  const res = await waitForReceipt(tx);
  assert.equal(res.timedOut, false);
  assert.equal(res.receipt.status, 1);
});

test('waitForReceipt still rethrows real revert errors', async () => {
  const tx = { hash: '0xabc', wait: async () => { throw new Error('execution reverted'); } };
  await assert.rejects(() => waitForReceipt(tx), /execution reverted/);
});

test('timeout budgets are finite and sane', () => {
  assert.ok(RPC_TIMEOUT_MS > 0 && RPC_TIMEOUT_MS <= 15000, 'RPC probe must be bounded');
  assert.ok(CONFIRM_TIMEOUT_MS > 0 && CONFIRM_TIMEOUT_MS <= 600000, 'confirm wait must be bounded');
});

// ── runtime: unknown network must not blow up every feature ──
test('getNetworkById falls back for a stale/unknown id instead of returning undefined', () => {
  const stale = getNetworkById('ethereum-sepolia'); // never existed in NETWORKS
  assert.ok(stale, 'unknown id must not yield undefined');
  assert.ok(stale.chainId && stale.rpc?.length, 'fallback must be a usable network');
});

test('getNetworkById still resolves the real ids (no regression)', () => {
  assert.equal(getNetworkById('sepolia').chainId, 11155111);
  assert.equal(getNetworkById('ethereum').chainId, 1);
  assert.equal(getNetworkById('base').chainId, 8453);
});

// ── static: no unbounded waits left anywhere ──
test('getProvider bounds every RPC probe with withTimeout', () => {
  const net = read('js/network.js');
  assert.match(net, /await withTimeout\(p\.getBlockNumber\(\), RPC_TIMEOUT_MS/,
    'an RPC that accepts the socket but never answers would hang the UI forever');
});

test('getGasPrice is bounded too', () => {
  const net = read('js/network.js');
  assert.match(net, /withTimeout\(provider\.send\('eth_gasPrice', \[\]\), RPC_TIMEOUT_MS/,
    'gas preview must not hang on a silent RPC');
});

test('no bare tx.wait() remains — every send goes through waitForReceipt', () => {
  const offenders = [];
  for (const f of jsFiles) {
    const src = read('js/' + f);
    src.split('\n').forEach((line, i) => {
      if (/await\s+\w+\.wait\(\)/.test(line)) offenders.push(`js/${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'unbounded tx.wait() found — a dropped tx would leave the button spinning: ' + offenders.join(', '));
});

test('every module that waits for a receipt imports waitForReceipt', () => {
  for (const f of jsFiles) {
    if (f === 'safetx.js') continue; // it is the module that defines it
    const src = read('js/' + f);
    if (!src.includes('waitForReceipt(')) continue;
    assert.match(src, /import \{[^}]*waitForReceipt[^}]*\} from '\.\/safetx\.js'/,
      `js/${f} uses waitForReceipt but does not import it`);
  }
});

// ── static: Send screen controls are wired, not dead markup ──
test('send.js wires the paste button and the token balance / gas estimate fields', () => {
  const send = read('js/send.js');
  assert.match(send, /\$\('#btnSendPaste'\)\?\.addEventListener\('click'/,
    'the paste button existed in the markup but did nothing');
  assert.match(send, /function updateSendTokenBalance\(\)/, 'selected-token balance must be rendered');
  assert.match(send, /\$\('#sendTokenBalance'\)/, 'sendTokenBalance must be written to');
  assert.match(send, /\$\('#gasEstValue'\)/, 'gasEstValue must be written to');
  assert.match(send, /\$\('#gasEstUsd'\)/, 'gasEstUsd must be written to');
});

test('the ids wired by send.js really exist in index.html', () => {
  const html = read('index.html');
  for (const id of ['btnSendPaste', 'sendTokenBalance', 'gasEstValue', 'gasEstUsd', 'sendToken', 'sendTo', 'sendAmount']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});

test('loadSendTokens refreshes the balance label, not just the options', () => {
  const send = read('js/send.js');
  assert.match(send, /updateSendTokenBalance\(\);\s*\}\s*$/m, 'loadSendTokens must call updateSendTokenBalance');
});
