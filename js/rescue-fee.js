// ═══════════════════════════════════════════════════════════════
// Bear Tool — rescue-fee.js
// What the rescue transaction will cost, measured BEFORE the user approves
// it — and the honest fallback when the chain cannot price it.
//
// The rescue sweep is an EIP-7702 type-4 transaction: ONE tx that carries
// the delegation tuple AND the rescue call. Four facts, all measured on
// anvil (prague), not assumed:
//
//   1. A node CAN price that shape. eth_estimateGas with the authorization
//      list in the request answered 79,859 gas (ERC-20) against the 67,056
//      the same transaction actually burned.
//
//   2. The tuple has to be the REAL one — signed by the target, carrying
//      the target's current nonce. A tuple whose nonce does not match is
//      silently SKIPPED by the node (the same rule the broadcast path
//      obeys), and the estimate then prices a call into an account with no
//      code: 46,584 gas, about a third of the truth. That number LOOKS
//      precise and is a lie.
//
//   3. The lie is detectable, and cheaply: the same call estimated WITHOUT
//      the delegation costs 22,460 gas (ERC-20). A real delegation adds the
//      code write plus the sweep's own work — 57,399 gas of difference. A
//      skipped tuple adds only 24,124. The gap between those two is the
//      proof that the delegation was priced.
//
//   4. When the helper contract does not exist yet (first run — the helper
//      is deployed after this sheet), the delegation target has no code, so
//      no node can price the sweep honestly. There the sheet falls back to
//      a documented worst case instead of inventing a number.
//
// Measured matrix (anvil prague, ERC-20 / ERC-721 with one id):
//
//   plain → target with no code ................ 22,460 / 23,130   (a lie)
//   type-4, tuple skipped (wrong nonce) ........ 46,584 / 46,852   (a lie)
//   type-4, tuple applied (right nonce) ........ 79,859 / 57,758   (the truth)
//   plain → target ALREADY delegated ........... 37,487 / 32,758   (the truth)
//   real gasUsed of the broadcast ............... 67,056 / 46,207
//
// No DOM, no ethers, no chain state: everything is injected, so a unit test
// can drive it with a fake provider.
// ═══════════════════════════════════════════════════════════════

// Worst case for ONE sweep when the node cannot price the real transaction.
// The honest type-4 estimate for an ERC-20 sweep measured 79,859; 150,000
// leaves room for a heavier token and colder accounts without pretending to
// a precision the node cannot give. For ERC-721 the same base applies — the
// delegation and the first transfer are the same work.
export const SWEEP_GAS_BOUND = 150000n;

// Each ERC-721 id is one more transfer inside the helper's loop. The mock
// measured +7,794 per id, but a real ERC-721 (owner slot + balance slot +
// approval clear) costs 30,000-50,000, so the bound uses the real number,
// not the cheap one.
export const SWEEP_GAS_PER_ERC721_ID = 50000n;

// A type-4 estimate under this did not price the sweep at all: the base
// transaction plus calldata is ~22,460, and a node that drops the
// authorization list answers exactly that. It is also below the honest
// ERC-721 figure (57,758), so the floor must sit under the smallest
// honest number and above every lie.
export const SWEEP_GAS_FLOOR = 40000n;

// A plain estimate into an ALREADY-DELEGATED target is the real price of
// the sweep — the node executes the helper's code (measured 32,758 for one
// NFT, 37,487 for an ERC-20). A node that ignored the delegation would
// answer the no-code price instead (~22,460), so the floor sits between
// the two.
export const SWEEP_PLAIN_FLOOR = 28000n;

// The delegation must cost real gas: the difference between the type-4
// estimate and the plain baseline. Measured 57,399 (ERC-20) and 34,628
// (one NFT) when the tuple applied, 24,124 and 23,722 when it was skipped.
// 30,000 separates them with margin on both sides.
export const SWEEP_DELEGATION_MIN_EXTRA = 30000n;

// A dead node must not hold the confirm sheet hostage.
export const SWEEP_ESTIMATE_TIMEOUT_MS = 8000;

/**
 * Worst-case gas for one sweep, when the node cannot price the real tx.
 * @param {'erc20'|'erc721'} type
 * @param {number} idCount  ERC-721 ids in the batch (ignored for ERC-20)
 */
export function boundSweepGas({ type, idCount = 0 }) {
  if (type === 'erc721') {
    const n = BigInt(Math.max(0, Number(idCount) || 0));
    return SWEEP_GAS_BOUND + SWEEP_GAS_PER_ERC721_ID * n;
  }
  return SWEEP_GAS_BOUND;
}

/**
 * The fee in wei for a gas figure at a price per gas.
 * @returns {bigint|null} null when either side is unknown/zero — a fee of
 *   zero is not a free transaction, it is a missing number.
 */
export function feeWeiFromGas(gas, pricePerGas) {
  if (gas == null || pricePerGas == null) return null;
  const g = BigInt(gas);
  const p = BigInt(pricePerGas);
  if (g <= 0n || p <= 0n) return null;
  return g * p;
}

/**
 * Is this estimate plausible as a sweep — i.e. did it price the delegation?
 * @param {bigint|number|null} gas
 * @param {bigint} [floor]
 */
export function isPlausibleSweepGas(gas, floor = SWEEP_GAS_FLOOR) {
  if (gas == null) return false;
  try {
    return BigInt(gas) >= BigInt(floor);
  } catch {
    return false;
  }
}

/**
 * Which nonce the delegation tuple must carry.
 *
 * EIP-7702 processes the authorization list AFTER the sender's nonce was
 * incremented, and a tuple whose nonce does not equal the authority's
 * current nonce is silently SKIPPED — the tx still mines status 1 while the
 * delegation never applies. When the sender IS the authority, its own nonce
 * was already consumed by the tx, so the tuple has to be one ahead.
 *
 * This is the same rule delegateAndExecute() applies, kept in one place so
 * the estimate and the broadcast cannot drift apart.
 *
 * @param {number|bigint} targetNonce  the authority's current nonce
 * @param {string} sponsorAddress       who broadcasts
 * @param {string} targetAddress         the authority
 * @returns {number}
 */
export function authNonceFor({ targetNonce, sponsorAddress, targetAddress }) {
  const self = String(sponsorAddress || '').toLowerCase() === String(targetAddress || '').toLowerCase();
  return self ? Number(targetNonce) + 1 : Number(targetNonce);
}

/**
 * One bounded estimate against the node.
 * @returns {Promise<bigint|null>} the gas, or null when the node refused or
 *   did not answer in time.
 */
async function boundedEstimate(provider, tx, timeoutMs) {
  let timer;
  try {
    const est = await Promise.race([
      provider.estimateGas(tx),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (est == null) return null;
    return BigInt(est);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The plain baseline: the same call estimated WITHOUT the delegation. It is
 * NOT the price of a sweep (a target with no code answers ~22,460) — it is
 * the reference the delegated estimate is measured against, so a skipped
 * tuple can be told apart from a priced one.
 *
 * @returns {Promise<bigint|null>}
 */
export async function measurePlainBaseline({ provider, from, to, data, timeoutMs = SWEEP_ESTIMATE_TIMEOUT_MS }) {
  if (!provider || !data) return null;
  return boundedEstimate(provider, { from, to, data }, timeoutMs);
}

/**
 * Measure the sweep the way it will actually be broadcast.
 *
 * @param {object} o
 * @param {object} o.provider        anything with estimateGas(tx)
 * @param {string} o.from             the broadcaster (the gas sponsor)
 * @param {string} o.to               the authority (the target wallet)
 * @param {string} o.data             the rescue calldata
 * @param {object|null} o.authorization  a signed delegation tuple, or null
 *   when the target is already delegated (then the sweep is a plain call)
 * @param {bigint|null} o.plainGas   the plain baseline, required for the
 *   delegated shape (it is what proves the tuple was priced, not skipped)
 * @param {bigint} [o.minExtra]     how much more than the baseline the
 *   delegated shape must cost. A sweep does real work, so the delegation
 *   adds 34,628-57,399 gas over the baseline. A REVOKE does no work at all:
 *   its correct estimate and its skipped-tuple estimate are the same number
 *   (46,001, measured), so it asks for no extra margin — the app verifies
 *   afterwards that the delegation really was cleared.
 * @returns {Promise<{gas: bigint, kind: 'plain'|'delegated'}|null>} null when
 *   the node could not price the transaction honestly.
 */
export async function measureSweepGas({
  provider, from, to, data, authorization = null, plainGas = null,
  minExtra = SWEEP_DELEGATION_MIN_EXTRA,
  timeoutMs = SWEEP_ESTIMATE_TIMEOUT_MS,
}) {
  if (!provider || !data) return null;

  if (!authorization) {
    // Already delegated: the broadcast is a plain call and the node prices
    // the helper's real code. A number at the no-code price would mean the
    // node ignored the delegation — not a price.
    const gas = await boundedEstimate(provider, { from, to, data }, timeoutMs);
    if (!isPlausibleSweepGas(gas, SWEEP_PLAIN_FLOOR)) return null;
    return { gas, kind: 'plain' };
  }

  // Fresh delegation: the estimate must carry the tuple, and the tuple must
  // have been applied. Two guards, both measured: the floor (a node that
  // drops the authorization list answers the no-code price) and the gap
  // against the plain baseline (a skipped tuple adds only the accounting
  // overhead, not the delegation's work).
  const tx = { type: 4, from, to, data, authorizationList: [authorization] };
  const gas = await boundedEstimate(provider, tx, timeoutMs);
  if (!isPlausibleSweepGas(gas, SWEEP_GAS_FLOOR)) return null;
  if (minExtra > 0n) {
    if (plainGas == null) return null;
    if (gas - BigInt(plainGas) < BigInt(minExtra)) return null;
  }
  return { gas, kind: 'delegated' };
}
