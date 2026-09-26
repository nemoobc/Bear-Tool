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

test('every module that broadcasts uses a provider-connected signer (no "missing provider")', () => {
  // Keystore signers are plain ethers.Wallet instances with NO provider.
  // Broadcasting with one dies with UNSUPPORTED_OPERATION "missing provider"
  // (send.js had this bug; deploy.js and opensea.js had the same pattern).
  const offenders = [];
  for (const f of jsFiles) {
    const src = read('js/' + f);
    const usesSigner = src.includes("get('signer')");
    const broadcasts = /sendTransaction\(|factory\.deploy\(/.test(src);
    if (usesSigner && broadcasts && !/\.connect\(/.test(src)) {
      offenders.push(`js/${f}: uses get('signer') + broadcast but never .connect(provider)`);
    }
  }
  assert.deepEqual(offenders, [],
    'unconnected signer broadcast found: ' + offenders.join(', '));
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
  // Assert the intent, not the exact tail of the function. The old check was
  // /updateSendTokenBalance\(\);\s*\}\s*$/m — it demanded that the call be the
  // LAST statement before the closing brace, so adding a background refresh
  // after it failed a test whose name says nothing about ordering. A check that
  // breaks on a correct refactor trains you to route around the check.
  const body = send.slice(send.indexOf('export function loadSendTokens()'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert.match(fn, /updateSendTokenBalance\(\)/, 'loadSendTokens must call updateSendTokenBalance');
});

test('the send form re-reads balances from the chain, not a cached snapshot', () => {
  const send = read('js/send.js');
  // The token list is written by the dashboard render. Funds that arrive after
  // it left the dropdown offering a balance the user did not have, and MAX
  // filling in the stale figure: measured 19.999795 ETH on chain against
  // 9.999795 in the list, so "100%" sent half of what the user actually held.
  assert.match(send, /refreshSendBalances/, 'loadSendTokens must trigger a balance refresh');
  const fn = send.slice(send.indexOf('export async function refreshSendBalances'));
  assert.match(fn, /getBalance|balanceOf/, 'the refresh must read the chain, not re-render the cache');
  assert.match(fn, /get\('provider'\)/, 'and it needs a provider to ask');
});

test('MAX reads a live balance, so a stale list cannot shorten it', () => {
  const maxui = read('js/max-ui.js');
  // resolveMax used token.balance verbatim - a cache. The amount that gets SENT
  // must come from the chain; the cache is only the fallback when the node
  // cannot answer.
  const fn = maxui.slice(maxui.indexOf('export async function resolveMax'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /provider\.getBalance\(from\)/,
    'resolveMax must read the native balance from the node');
  assert.match(body, /balanceSource/,
    'and it must say where the number came from, so a stale one is visible');
});
