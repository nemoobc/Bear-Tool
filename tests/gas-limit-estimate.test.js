// Bear Tool — gas-limit-estimate.test.js
//
// gasLimitFor must only trust an estimate of the transaction the caller
// ACTUALLY described. It used to call
//
//   provider.estimateGas({ from, to: RECIPIENT, tokenAddress, data: '0x' })
//
// and ethers silently drops the unknown `tokenAddress` field (copyRequest
// copies only known keys — ethers providers/provider.js), so what got
// estimated was a value-less native transfer to the RECIPIENT — a different
// transaction than the token transfer being priced. To an EOA that answered
// 21000 and the `> 21000n` guard filtered it (correct by luck); to a
// contract with a payable fallback it answered whatever the fallback burns,
// and that number was trusted as the token transfer's gas limit — under-
// reserving the fee check that exists to catch "MAX then error", for
// exactly the destination class this wallet targets (smart wallets,
// EIP-7702 accounts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gasLimitFor, resolveMax } from '../js/max-ui.js';

const FROM = '0x' + '11'.repeat(20);
const RECIPIENT = '0x' + '22'.repeat(20);
const TOKEN = '0x' + '33'.repeat(20);

/** Provider whose estimateGas records every request and answers `gas`. */
function providerAnswering(gas, calls) {
  return {
    getFeeData: async () => ({ gasPrice: 10n ** 9n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }),
    estimateGas: async (req) => { calls.push(req); return gas; },
    getBalance: async () => 10n ** 18n,
  };
}

test('a token send never takes a native-transfer estimate as its gas limit', async () => {
  const calls = [];
  // The node answers 30000 for {to: RECIPIENT, data: '0x'} — a payable
  // fallback's burn. That is not the token transfer's cost (~48-65k).
  const r = await gasLimitFor({
    provider: providerAnswering(30000n, calls),
    isNative: false, from: FROM, to: RECIPIENT, tokenAddress: TOKEN,
  });
  assert.equal(r.limit, 65000n, 'must fall back to the ERC-20 default, not the fallback burn');
  assert.equal(r.source, 'default');
  assert.equal(calls.length, 0, 'no estimate of a transaction we are not sending');
});

test('EOA destination keeps the same honest default (regression)', async () => {
  const calls = [];
  const r = await gasLimitFor({
    provider: providerAnswering(21000n, calls),
    isNative: false, from: FROM, to: RECIPIENT, tokenAddress: TOKEN,
  });
  assert.equal(r.limit, 65000n, 'the guard-filtered path must stay 65000');
  assert.equal(calls.length, 0);
});

test('real calldata is still estimated — against the contract it goes to', async () => {
  const calls = [];
  const r = await gasLimitFor({
    provider: providerAnswering(40000n, calls),
    isNative: false, from: FROM, to: RECIPIENT, tokenAddress: TOKEN, data: '0xdeadbeef',
  });
  assert.equal(r.limit, 40000n, 'a described transaction is still worth estimating');
  assert.equal(r.source, 'estimated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, TOKEN, 'the estimate must target the token contract, not the recipient');
  assert.equal(calls[0].data, '0xdeadbeef', 'the described calldata must ride along');
});

test("a caller's fallback beats any estimate of a different tx (swap/bridge MAX)", async () => {
  const calls = [];
  const r = await gasLimitFor({
    provider: providerAnswering(30000n, calls),
    isNative: false, from: FROM, to: RECIPIENT, tokenAddress: TOKEN, fallback: 280000n,
  });
  assert.equal(r.limit, 280000n, 'the swap reservation must not collapse to a recipient-transfer estimate');
  assert.equal(r.source, 'default');
  assert.equal(calls.length, 0);
});

test('a plain native send keeps 21000 without touching the node', async () => {
  const calls = [];
  const r = await gasLimitFor({
    provider: providerAnswering(30000n, calls),
    isNative: true, from: FROM, to: RECIPIENT,
  });
  assert.equal(r.limit, 21000n);
  assert.equal(calls.length, 0);
});

test('MAX on a token to a contract destination reserves the ERC-20 default fee', async () => {
  const calls = [];
  const provider = providerAnswering(30000n, calls);
  const r = await resolveMax({
    token: { balance: (10n ** 18n).toString(), decimals: 18, address: TOKEN, symbol: 'TOK' },
    provider, from: FROM, to: RECIPIENT, pct: 100,
  });
  assert.equal(r.ok, true, r.message);
  // The reservation the check will use must be the token transfer's own
  // default (65000 × the read price), never the fallback's burn.
  assert.equal(r.gasWei, 65000n * 2n * 10n ** 9n, 'gasWei must price the token transfer, not the recipient fallback');
  assert.equal(calls.length, 0, 'MAX must not price a transaction it is not sending');
});
