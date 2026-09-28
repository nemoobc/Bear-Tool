// Bear Tool — max-ui-gate.test.js
// MAX must never fill a field it cannot pay for.
//
// The module states the rule itself, at the top of js/max-ui.js:
//
//   "a MAX button must never leave the wallet in a state where the transaction
//    cannot be paid for. Where a real estimate is unavailable it says so in the
//    field rather than filling in a hopeful number."
//
// currentGasPriceWei broke exactly that. It answered 0n when the fee could not
// be read — on a provider that throws, and, more importantly, with no error at
// all: `fee.maxFeePerGas ?? fee.gasPrice ?? 0n` yields 0n whenever a node
// answers getFeeData() with nulls, which several L2s and any node without
// eth_feeHistory do. The file's own comment says gasPrice "is null on some L2s".
//
// Zero is a real number, so nothing downstream questioned it. maxSpendable
// subtracted nothing, and MAX filled the entire balance:
//
//     fee 0         → spendable 1000000000000000000   (all of it)
//     fee 3000000…  → spendable  996940000000000000   (balance less fee + buffer)
//
// The user then pressed send and got "insufficient funds for gas" — the one
// outcome this file exists to prevent, produced by the button meant to prevent it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });
if (!globalThis.ethers) {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
}

const { currentGasPriceWei, resolveMax, verifySpendable } = await import('../js/max-ui.js');

const WHO = '0x3333333333333333333333333333333333333333';
// 10 ETH is 10^19 wei. 10^18 wei is ONE ETH — a slip I made while writing this
// test, and the module caught it by refusing an unrealistic fee.
const TEN_ETH = 10n ** 19n;
const NATIVE = { balance: TEN_ETH, decimals: 18, address: null, symbol: 'ETH' };
// 3 gwei. The first figure used here was 3e15 wei per gas — 3,000 gwei, a
// hundred thousand times too high, which MAX quite correctly refused.
const REAL_FEE = 3_000_000_000n;

// A node that answers, and has no fee to give. Not an error — a null answer.
const nullFeeProvider = {
  async getFeeData() { return { maxFeePerGas: null, gasPrice: null, maxPriorityFeePerGas: null }; },
  async getBlockNumber() { return 1n; },
  async getBalance() { return 10n ** 19n; },
  async estimateGas() { return 21000n; },
};
const throwingProvider = {
  async getFeeData() { throw new Error('connection reset'); },
  async getBlockNumber() { return 1n; },
  async getBalance() { return 10n ** 19n; },
  async estimateGas() { return 21000n; },
};
const realProvider = {
  async getFeeData() { return { maxFeePerGas: REAL_FEE, maxPriorityFeePerGas: 1n, gasPrice: REAL_FEE }; },
  async getBlockNumber() { return 1n; },
  async getBalance() { return 10n ** 19n; },
  async estimateGas() { return 21000n; },
};

test('an unknown fee is reported as unknown, not as zero', async () => {
  // Zero is a number the rest of the pipeline trusts. "We do not know" has to be
  // distinguishable from it, or everything downstream treats it as a real fee.
  assert.equal(await currentGasPriceWei(nullFeeProvider), null,
    'a node that answers with nulls is not charging zero — the fee is unknown');
  assert.equal(await currentGasPriceWei(throwingProvider), null,
    'a provider that cannot answer is not charging zero');
  assert.equal(await currentGasPriceWei(realProvider), REAL_FEE, 'a real fee still comes through');
});

test('MAX refuses to fill the field when the fee cannot be read', async () => {
  for (const [label, provider] of [['nulls', nullFeeProvider], ['throwing', throwingProvider]]) {
    const r = await resolveMax({ token: NATIVE, provider, from: WHO, to: WHO });
    assert.equal(r.ok, false,
      `${label}: MAX reported success with a fee it never read`);
    assert.equal(r.amount, '',
      `${label}: the field was filled with ${JSON.stringify(r.amount)} on an unknown fee — ` +
      'that amount cannot pay for its own gas');
    assert.match(r.message, /fee|gas/i,
      `${label}: the message must say the fee is the problem: ${r.message}`);
  }
});

test('MAX with a real fee still fills the field and leaves room for gas', async () => {
  const r = await resolveMax({ token: NATIVE, provider: realProvider, from: WHO, to: WHO });
  assert.equal(r.ok, true, `a real fee must still work: ${r.message}`);
  // `amount` is a DECIMAL string for the input field, not wei — BigInt() on
  // "9.999935" throws, which is how this assertion was wrong the first time.
  assert.ok(r.amount && Number(r.amount) > 0, 'the field must be filled');
  assert.ok(Number(r.amount) < 10,
    `MAX filled the whole 10 ETH balance (${r.amount}) even though the fee was known`);
  assert.match(r.message, /leaves|for fees/i,
    `the note must say what was left for the fee: ${r.message}`);
});

test('the pre-send check does not treat an unknown fee as a free transaction', async () => {
  const r = await verifySpendable({
    amount: '10', token: NATIVE, provider: nullFeeProvider, from: WHO, to: WHO,
  });
  assert.notEqual(r.gasWei, 0n,
    'an unknown fee was recorded as 0 wei, so the check passed a transaction that cannot pay for gas');
  assert.ok(r.gasWei === null || r.gasWei === undefined,
    `the fee must be reported as unknown, got ${r.gasWei}`);
});
