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

// ethers comes off globalThis here, as in every other module. The bare
// `import ethers from 'ethers'` form works in the browser but not under
// `node --test`: ethers v6 ships no default export, so the whole module fails to
// load and every test that imports it dies at import time rather than at the
// assertion. One broken import took 17 tests with it.
const { ethers } = globalThis;

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
export async function gasLimitFor({ provider, isNative, from, to, tokenAddress, data, fallback }) {
  // A native transfer is the only flow where 21k is the right answer. A swap or
  // a bridge on the native token needs 250k-400k, and reserving 21k there built
  // a transaction that provably could not pay for itself — the exact failure
  // MAX exists to remove. The caller says what it is about to do; if it stays
  // silent we keep the old per-kind default rather than guess high.
  if (isNative && !fallback) return { limit: defaultGasLimit(true), source: 'default' };
  if (provider && from && to) {
    try {
      const limit = await provider.estimateGas({ from, to: tokenAddress, data: data || '0x' });
      // A node that answers with something absurd is worse than a table value.
      if (limit && limit > 21000n && limit < 5_000_000n) return { limit, source: 'estimated' };
    } catch { /* fall through */ }
  }
  return { limit: fallback || defaultGasLimit(false), source: 'default' };
}

/**
 * Resolve what to put in an amount field.
 * @param {object} o
 * @param {object} o.token      { balance, decimals, address } — address absent = native
 * @param {object} [o.provider]
 * @param {string} [o.from]
 * @param {string} [o.to]
 * @param {number} [o.pct]      100 = MAX; 25/50/75 take a share of the spendable amount
 * @param {bigint} [o.gasLimit] what the caller is about to do. Swap and bridge
 *   must pass a realistic figure (a native swap is ~280k, a bridge more): MAX
 *   reserving the 21k of a plain transfer on those paths produced a transaction
 *   that could not pay for itself, which is the one thing MAX is for.
 * @returns {Promise<{amount:string, ok:boolean, message:string, gasWei:bigint, spendable:bigint, source:string}>}
 */
export async function resolveMax({ token, provider, from, to, pct = 100, gasLimit }) {
  const isNative = !token?.address;
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol || '';
  const price = await currentGasPriceWei(provider);
  const { limit, source } = await gasLimitFor({ provider, isNative, from, to, tokenAddress: token?.address, fallback: gasLimit });
  const gasWei = gasCost({ gasLimit: limit, gasPriceWei: price });

  // The balance the caller passed in is a CACHED one — it was last written when
  // the dashboard loaded. Measured on a real wallet: 19.999795 ETH on chain,
  // 9.999795 in the token list, and MAX dutifully filled in half the balance.
  // Funds arriving between the dashboard render and the MAX press is an ordinary
  // thing, not a race, so the amount that gets SENT must come from the chain.
  // The cached value stays as the fallback: if the node cannot answer we would
  // rather under-send on a stale figure than refuse to fill the field at all.
  let balance = token?.balance ?? 0n;
  let balanceSource = 'cached';
  if (isNative && provider && from) {
    try {
      const live = await provider.getBalance(from);
      if (live > 0n) { balance = live; balanceSource = 'live'; }
    } catch { /* keep the cached balance */ }
  } else if (!isNative && token?.address && provider && from) {
    try {
      const c = new ethers.Contract(token.address, ['function balanceOf(address) view returns (uint256)'], provider);
      const live = await c.balanceOf(from);
      if (live > 0n) { balance = live; balanceSource = 'live'; }
    } catch { /* keep the cached balance */ }
  }

  const spendable = maxSpendable({ balance, gasWei, paysGas: isNative });

  if (spendable <= 0n) {
    const r = computeMax({ balance, decimals, gasWei, paysGas: isNative, symbol });
    return { amount: '', ok: false, message: r.message, gasWei, spendable: 0n, source, balanceSource };
  }

  // `Number(pct) || 100` looks harmless and is not: 0 is falsy, so a 0% button —
  // or a missing data-pct attribute, which parses to NaN — silently became 100%
  // and the field was filled with the whole spendable balance. Only a genuine
  // "no percentage given" may mean 100; an explicit 0 must stay 0.
  const raw = Number(pct);
  const p = pct == null || pct === '' || !Number.isFinite(raw)
    ? 100
    : Math.max(0, Math.min(100, Math.round(raw)));
  // Integer maths on purpose: a float multiply can round the share up past the
  // spendable amount, which is the same failure as rounding the total up.
  const share = p === 100 ? spendable : (spendable * BigInt(p)) / 100n;

  // computeMax formats internally, so a bad `decimals` throws from inside it,
  // before the guard below. A token's decimals come from the contract and a
  // custom network's from localStorage with no validation at all, and an
  // uncaught throw in this handler left the MAX button dead with no message.
  let r;
  try {
    r = computeMax({ balance, decimals, gasWei, paysGas: isNative, symbol });
  } catch (e) {
    const why = e?.message || String(e);
    return {
      amount: '', ok: false, message: `Token decimals are invalid (${why}) — fix the network or token and retry.`,
      gasWei, spendable: 0n, source, balanceSource,
    };
  }
  // A token's `decimals` comes from the contract, and a custom network's from
  // localStorage with no validation at all (network.js addCustomNetwork). If
  // that value is not a sane integer, formatDown throws — report it as a normal
  // "not available" result rather than letting the form die.
  let amount;
  try {
    amount = formatDown(share, decimals, 6);
  } catch (e) {
    const why = e?.message || String(e);
    return {
      amount: '', ok: false, message: `Token decimals are invalid (${why}) — fix the network or token and retry.`,
      gasWei, spendable: 0n, source, balanceSource,
    };
  }
  const message = p === 100
    ? r.message
    : `${p}% of what is sendable — ${amount} ${symbol}. ${r.message}`;

  return { amount, ok: true, message, gasWei, spendable, source, balanceSource };
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

  // Live balance, for the same reason resolveMax reads one: token.balance is a
  // snapshot from the last dashboard render. A cached figure fails this check in
  // both directions — too low and a perfectly good send is refused, too high and
  // an impossible one is waved through to a node error the user cannot act on.
  // ERC-20 included: reading only the native balance left every token send on the
  // stale number while the native one had been fixed.
  let balance = token?.balance ?? 0n;
  if (provider && from) {
    try {
      balance = isNative
        ? await provider.getBalance(from)
        : await new ethers.Contract(token.address, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(from);
    } catch { /* keep the cached balance — a stale number beats a refusal */ }
  }
  return { ...checkSpendable({ amountWei, balance, gasWei, paysGas: isNative }), gasWei, amountWei, balance };
}
