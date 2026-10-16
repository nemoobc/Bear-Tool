// Shared guard against the anvil wedge that eats the runtime proofs on CI.
//
// What happens (runs 38898501268, 38926627716, 38930491444, 38935202597): a
// transaction is accepted — the send resolves with a hash — and then never
// mined, so `receipt.wait()` polls null forever with no error, no anvil exit
// and no output until the file-level cap fires. A single stalled transport
// looks the same from the outside. ethers itself retries forever against a
// node that stopped answering; the fork suite already learned both halves of
// this lesson (see tests/fork/fork-helper.mjs: a deadline turns a stall into
// a thrown timeout, and a bounded retry turns the transient wedge into a
// pass). Same treatment here: every request and every wait carries a
// deadline, a wedged attempt dies FAST carrying its label, and the caller
// restarts the whole story on a fresh chain instead of burning fifteen
// silent minutes. Every attempt runs every assertion for real — the retry
// is a full replay, never a skipped proof.

export const RPC_TIMEOUT_MS = 20_000;
export const WAIT_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;

/** Race a promise against a deadline. The loser never goes unhandled. */
export function withDeadline(label, promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: no settlement in ${timeoutMs}ms — wedged node or mine stall (see anvil-guard.mjs)`)),
      timeoutMs,
    );
  });
  const real = Promise.resolve().then(() => promise);
  // Once the deadline wins, the real call keeps running; if it later rejects,
  // that rejection must not surface as an unhandled error belonging to some
  // unrelated test. Attach a sink: only the race decides the outcome.
  real.catch(() => {});
  return Promise.race([real, deadline]).finally(() => clearTimeout(timer));
}

/** Bound every JSON-RPC call of a provider: a stalled request throws its
 *  method name in RPC_TIMEOUT_MS instead of hanging until the file cap. */
export function guardProvider(provider) {
  const raw = provider._perform.bind(provider);
  provider._perform = (req) => withDeadline(
    `rpc ${req && req.method ? req.method : 'request'}`,
    raw(req),
    RPC_TIMEOUT_MS,
  );
  return provider;
}

/** waitForDeployment with a deadline — ethers' own version takes no timeout. */
export function waitDeployed(label, contract) {
  return withDeadline(`deploy(${label})`, contract.waitForDeployment(), WAIT_TIMEOUT_MS);
}
