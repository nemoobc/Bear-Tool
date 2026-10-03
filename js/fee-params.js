// Bear Tool — fee-params.js
// Pure construction of the fee fields for a chosen gas speed.
//
// Why this exists (measured, not assumed): doSend computed a speed multiplier
// and then threw it away — `maxFeePerGas: feeData.maxFeePerGas || gasSpeed…`
// always picked the raw fee on every 1559 chain, and the token path passed no
// fee fields at all. The slow/fast buttons were labels; the confirmation row
// said "Fast" while a normal-fee transaction went out. This module makes the
// label and the wire agree, in one place that a unit test can import without
// a DOM, a provider or a chain.
//
// Invariants:
//   - speed "normal" (or unknown) reproduces the old values exactly: the
//     default path is byte-identical to the code this replaced, so nothing
//     changes for anyone who never touched the buttons.
//   - slow = 90% and fast = 120% of the SAME base, applied to maxFee and
//     priority together — a scaled priority with an unscaled cap (or the
//     reverse) is how "max priority fee per gas higher than max fee per gas"
//     gets minted.
//   - nothing knowable is sent as zero: a node answering 0n or null gets
//     `undefined` back, and ethers estimates instead of broadcasting an
//     invalid 0-fee transaction.

/** Multiplier for a speed, in percent: slow 90, fast 120, everything else 100. */
export function speedPercent(gasSpeed) {
  return gasSpeed === 'slow' ? 90n : gasSpeed === 'fast' ? 120n : 100n;
}

/**
 * Build the fee fields for one send.
 *
 * @param {object|null} feeData  provider.getFeeData() result
 * @param {string} [gasSpeed]    'slow' | 'fast' | anything else = normal
 * @returns {{baseFee: bigint, maxFeePerGas: bigint|undefined,
 *            maxPriorityFeePerGas: bigint|undefined}}
 *   baseFee        the unscaled reference the balance check uses
 *   maxFeePerGas   undefined = unknown, let ethers estimate (never 0n)
 */
export function buildFeeParams(feeData, gasSpeed) {
  const f = feeData || {};
  const pct = speedPercent(gasSpeed);
  // gasPrice first — the same order doSend has always used, kept so the
  // normal path stays value-identical on every chain shape.
  const base = f.gasPrice || f.maxFeePerGas || 0n;
  const scale = (v) => v * pct / 100n;
  const maxFeePerGas = f.maxFeePerGas
    ? scale(f.maxFeePerGas)
    : (base ? scale(base) : undefined);
  // The priority fallback is the scaled base, not the raw one: on a chain with
  // a cap but no tip read, slow must not promise a tip above its own cap.
  const maxPriorityFeePerGas = f.maxPriorityFeePerGas
    ? scale(f.maxPriorityFeePerGas)
    : (base ? scale(base) : undefined);
  return { baseFee: base, maxFeePerGas, maxPriorityFeePerGas };
}
