// ═══════════════════════════════════════════════════════════════
// max-amount.js — make "MAX" mean what people expect it to mean.
//
// The bug this exists to kill: MAX filled the input with the whole balance,
// so on a chain where the input token is also the gas token the transaction
// could not pay for itself. The RPC answered "insufficient funds for gas * gas
// price + value" and the user was left guessing. OKX, MetaMask and Trust all
// subtract the fee first, so pressing MAX just works.
//
// Four rules, all of them arithmetic you can check by hand:
//
//   1. Only subtract gas when the token being sent is the token paying gas.
//     Swapping a USDC balance for ETH has nothing to do with ETH gas.
//   2. Round DOWN, never to nearest. Rounding up by one wei reintroduces the
//     exact failure MAX is meant to remove.
//   3. Cap the displayed decimals. 18 dp of dust makes the field unusable and
//     still rounds up at the end.
//   4. When the balance cannot even cover the fee, say so with both numbers.
//     An error string from a node is not an explanation.
//
// Pure bigint arithmetic, no ethers, so it is unit-testable without a browser
// or a chain.
// ═══════════════════════════════════════════════════════════════

/** BigInt() that never throws, because a malformed fee must not kill a form. */
export function toBig(v, fb = 0n) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') { try { return BigInt(Math.trunc(v)); } catch { return fb; } }
  if (typeof v === 'string' && v.trim()) {
    const t = v.trim();
    // Hex — raw JSON-RPC hands back "0x..." and BigInt parses it. Rejecting it
    // here would send a perfectly good value to the 0n fallback, which is the
    // exact silent-zero bug this function is being fixed for.
    if (/^0x[0-9a-fA-F]+$/.test(t)) { try { return BigInt(t); } catch { return fb; } }
    // Plain integer — the common case.
    if (/^[+-]?\d+$/.test(t)) { try { return BigInt(t); } catch { return fb; } }
    // Scientific notation ("1e18", "2.5E-3"). BigInt rejects these outright, so
    // they used to fall through to the 0n fallback — which meant a balance
    // arriving as "1e18" read as an EMPTY wallet, and MAX wrote 0. Silently,
    // and wrong. That is the one case the fallback must never produce.
    const sci = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(t);
    if (sci) {
      const [, sign, ip, fp = '', exp] = sci;
      const shift = BigInt(exp);
      const fracLen = BigInt(fp.length);
      const mant = BigInt(ip + fp);
      // mantissa × 10^(exp − fraction length), truncating if that is negative.
      const scaled = shift >= fracLen ? mant * 10n ** (shift - fracLen) : mant / 10n ** (fracLen - shift);
      return sign === '-' ? -scaled : scaled;
    }
    // Decimal without an exponent ("1.5"). Truncate toward zero, as the number
    // branch above does — never round up, which is rule 2 of this file.
    const dec = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(t);
    if (dec) {
      const [, sign, ip, fp = ''] = dec;
      const mant = BigInt(ip + fp);
      const scaled = fp.length ? mant / 10n ** BigInt(fp.length) : mant;
      return sign === '-' ? -scaled : scaled;
    }
    return fb;
  }
  return fb;
}

export const NATIVE_TRANSFER_GAS = 21000n;
export const ERC20_TRANSFER_GAS = 65000n;

/** Default gas limit when nothing better is available. */
export function defaultGasLimit(isNative) {
  return isNative ? NATIVE_TRANSFER_GAS : ERC20_TRANSFER_GAS;
}

/** gasLimit × gasPrice, in wei. */
export function gasCost({ gasLimit, gasPriceWei }) {
  return toBig(gasLimit) * toBig(gasPriceWei);
}

/**
 * A cushion so a fee that ticks up between the estimate and inclusion does not
 * turn a valid MAX into a failed one. 2% of the fee, and never less than
 * 1000 wei — a floor matters on L2s where the whole fee can be tiny.
 */
export function gasBuffer(gasWei) {
  const g = toBig(gasWei);
  if (g <= 0n) return 0n;
  const pct = g / 50n;                 // 2%
  return pct > 1000n ? pct : 1000n;
}

/**
 * The largest amount that can actually be sent.
 * @param {object} o
 * @param {bigint|string} o.balance     spendable balance, in the token's own units
 * @param {bigint|string} o.gasWei      cost of the transaction, in wei
 * @param {boolean} [o.paysGas]         true when this token is also the gas token
 * @param {boolean} [o.keepBuffer]      leave the fee cushion in the wallet
 * @returns {bigint} never negative
 */
export function maxSpendable({ balance, gasWei, paysGas, keepBuffer = true }) {
  const bal = toBig(balance);
  if (bal < 0n) return 0n;
  if (!paysGas) return bal;              // the fee comes out of another token
  const gas = toBig(gasWei);
  const reserve = keepBuffer ? gas + gasBuffer(gas) : gas;
  const out = bal - reserve;
  return out > 0n ? out : 0n;
}

/**
 * Render a bigint amount into an input field.
 * Truncates toward zero at `dp` decimals and strips trailing zeros, so the
 * value typed is always ≤ the true maximum.
 */
export function formatDown(wei, decimals = 18, dp = 6) {
  const v = toBig(wei);
  if (v <= 0n) return '0';
  // Validate BEFORE any `**`. `10n ** -1n` and `BigInt(6.5)` both throw, and
  // an unhandled throw here killed the whole MAX button — the form became
  // unusable. A custom network's `decimals` is attacker-shaped: addCustomNetwork
  // in network.js stores it with no validation at all, so it can arrive as
  // 2.5, -1 or NaN straight off the localStorage record.
  const d = Number(decimals);
  if (!Number.isSafeInteger(d) || d < 0 || d > 255) {
    throw new RangeError(`decimals must be an integer in 0..255, got ${decimals}`);
  }
  const keepDigits = Math.max(0, Math.min(Math.trunc(Number(dp) || 0), d));
  const abs = v;                       // v <= 0 already returned, so abs === v
  const base = 10n ** BigInt(d);
  const whole = abs / base;
  const frac = abs % base;
  const keep = BigInt(keepDigits);
  let fracStr = '';
  if (keep > 0n) {
    // Truncate the fraction to `keep` digits. Never round — see rule 2.
    const div = 10n ** (BigInt(d) - keep);
    const trimmed = frac / div;
    fracStr = trimmed.toString().padStart(Number(keep), '0').replace(/0+$/, '');
  }
  return whole.toString() + (fracStr ? '.' + fracStr : '');
}

/** The input a MAX button should write, plus an explanation when it is empty. */
export function computeMax({ balance, decimals = 18, gasWei = 0n, paysGas = true, dp = 6, symbol = '' }) {
  const bal = toBig(balance);
  const gas = toBig(gasWei);
  const spendable = maxSpendable({ balance: bal, gasWei: gas, paysGas });

  if (spendable <= 0n) {
    // The case that used to produce a raw node error. Now it explains itself,
    // with both sides of the subtraction.
    return {
      amount: '',
      ok: false,
      shortfallWei: gas > bal ? gas - bal : 0n,
      balance, gasWei: gas, symbol,
      message: paysGas
        ? `Not enough ${symbol || 'gas token'} to cover the fee. Balance ${formatDown(bal, decimals, dp)} `
          + `${symbol}, fee needs ${formatDown(gas, 18, 6)} native. `
          + 'Send a smaller amount after adding funds, or pick a token that does not pay gas.'
        : 'Zero balance.',
    };
  }

  return {
    amount: formatDown(spendable, decimals, dp),
    ok: true,
    shortfallWei: 0n,
    balance: bal, gasWei: gas, symbol,
    // Short on purpose. This sits directly under the amount field as a blue note
    // and the previous wording ran to four lines of small grey text on a phone,
    // which is the weightiest thing on the screen for a fact that is one clause:
    // what is left is the fee. The arithmetic is unchanged; only the sentence is.
    message: paysGas
      ? `Leaves ${formatDown(bal - spendable, decimals, dp)} ${symbol} for fees — sending the exact `
        + 'balance would leave nothing to pay with.'
      : `Full balance ${formatDown(spendable, decimals, dp)} ${symbol} — fees are paid in another token.`,
  };
}

/**
 * Would this amount actually go through?
 * The check the Send flow was missing, and the reason "MAX then error" happened
 * even after the arithmetic was right: a stale balance, or a fee that moved.
 */
export function checkSpendable({ amountWei, balance, gasWei, paysGas }) {
  const amt = toBig(amountWei);
  const bal = toBig(balance);
  const need = amt + (paysGas ? toBig(gasWei) : 0n);
  if (bal < need) {
    return {
      ok: false,
      shortfall: need - bal,
      message: `Not enough balance: this needs ${formatDown(need, 18, 6)} but the wallet holds `
        + `${formatDown(bal, 18, 6)}. Short by ${formatDown(need - bal, 18, 6)}.`,
    };
  }
  return { ok: true, shortfall: 0n, message: '' };
}
