// ═══════════════════════════════════════════════════════════════
// max-ui.js — the provider-aware half of MAX.
//
// max-amount.js does the arithmetic with no chain attached, which is why it can
// be unit-tested. This file is the part that needs a live node: read the fee,
// ask for a real gas limit where it can, and hand the result to a view.
//
// One rule runs through all of it: a MAX button must never leave the wallet in
// a state where the transaction cannot be paid for. Where a real estimate is
// unavailable it says so in the field rather than filling in a hopeful number.
// ═══════════════════════════════════════════════════════════════

import { maxSpendable, computeMax, formatDown, defaultGasLimit, gasCost, checkSpendable } from './max-amount.js';

/** Read the current fee in wei, preferring the EIP-1559 ceiling when present. */
export async function currentGasPriceWei(provider) {
  if (!provider) return 0n;
  try {
    const fee = await provider.getFeeData();
    // maxFeePerGas is the worst case the tx can be charged, which is the right
    // number to reserve against. gasPrice is the fallback for chains that do
    // not report it, and it is null on some L2s.
    return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  } catch {
    return 0n;
  }
}

/**
 * A gas limit for one transfer.
 * Uses the node's own estimate when the call is cheap to make and the chain
 * answers, and falls back to a per-kind default when it does not. Never
 * pretends an estimate succeeded when it did not.
 */
export async function gasLimitFor({ provider, isNative, from, to, tokenAddress, data }) {
  if (isNative) return { limit: defaultGasLimit(true), source: 'default' };
  if (provider && from && to) {
    try {
      const limit = await provider.estimateGas({ from, to: tokenAddress, data: data || '0x' });
      // A node that answers with something absurd is worse than a table value.
      if (limit && limit > 21000n && limit < 5_000_000n) return { limit, source: 'estimated' };
    } catch { /* fall through */ }
  }
  return { limit: defaultGasLimit(false), source: 'default' };
}

/**
 * Resolve what to put in an amount field.
 * @param {object} o
 * @param {object} o.token      { balance, decimals, address } — address absent = native
 * @param {object} [o.provider]
 * @param {string} [o.from]
 * @param {string} [o.to]
 * @param {number} [o.pct]      100 = MAX; 25/50/75 take a share of the spendable amount
 * @returns {Promise<{amount:string, ok:boolean, message:string, gasWei:bigint, spendable:bigint, source:string}>}
 */
export async function resolveMax({ token, provider, from, to, pct = 100 }) {
  const isNative = !token?.address;
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol || '';
  const price = await currentGasPriceWei(provider);
  const { limit, source } = await gasLimitFor({ provider, isNative, from, to, tokenAddress: token?.address });
  const gasWei = gasCost({ gasLimit: limit, gasPriceWei: price });

  const spendable = maxSpendable({ balance: token?.balance ?? 0n, gasWei, paysGas: isNative });

  if (spendable <= 0n) {
    const r = computeMax({ balance: token?.balance ?? 0n, decimals, gasWei, paysGas: isNative, symbol });
    return { amount: '', ok: false, message: r.message, gasWei, spendable: 0n, source };
  }

  const p = Math.max(0, Math.min(100, Number(pct) || 100));
  // Integer maths on purpose: a float multiply can round the share up past the
  // spendable amount, which is the same failure as rounding the total up.
  const share = p === 100 ? spendable : (spendable * BigInt(p)) / 100n;

  const r = computeMax({ balance: token?.balance ?? 0n, decimals, gasWei, paysGas: isNative, symbol });
  const amount = formatDown(share, decimals, 6);
  const message = p === 100
    ? r.message
    : `${p}% of what is sendable — ${amount} ${symbol}. ${r.message}`;

  return { amount, ok: true, message, gasWei, spendable, source };
}

/**
 * Last check before a send goes out, using the amount actually in the field.
 * Catches the case where the balance moved between filling MAX and pressing
 * send, which is the remaining way "MAX then error" can happen.
 */
export async function verifySpendable({ amount, token, provider, from, to }) {
  const isNative = !token?.address;
  const price = await currentGasPriceWei(provider);
  const { limit } = await gasLimitFor({ provider, isNative, from, to, tokenAddress: token?.address });
  const gasWei = gasCost({ gasLimit: limit, gasPriceWei: price });

  let amountWei = 0n;
  try {
    amountWei = isNative
      ? (globalThis.ethers ? globalThis.ethers.parseEther(amount) : 0n)
      : (globalThis.ethers ? globalThis.ethers.parseUnits(amount, token?.decimals ?? 18) : 0n);
  } catch { return { ok: false, message: `That amount cannot be read: "${amount}".`, gasWei }; }

  let balance = token?.balance ?? 0n;
  if (isNative && provider && from) {
    try { balance = await provider.getBalance(from); } catch { /* keep the cached balance */ }
  }
  return { ...checkSpendable({ amountWei, balance, gasWei, paysGas: isNative }), gasWei, amountWei, balance };
}
