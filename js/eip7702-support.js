// Bear Tool — js/eip7702-support.js
//
// "Does this node understand EIP-7702?" — asked of every network we ship, with
// the answer showing which RPC endpoint actually said yes.
//
// ── Why the probe looks like this ──────────────────────────────────────────
//
// EIP-7702 adds a transaction TYPE (status Final, eips.ethereum.org/EIPS/eip-7702:
// "Add a new tx type that permanently sets the code for an EOA"), and that type
// carries an `authorizationList` the node must decode. So the probe sends an
// eth_estimateGas that can never be executed — `from` and `to` are the zero
// address, there is no signature, and estimateGas costs nothing anywhere —
// purely to see how the node reacts to a field only a 7702-aware node knows.
//
// Measured against live public endpoints before this file was written:
//
//   ethereum-rpc.publicnode.com   → -32000 "failed with 16777216 gas: EIP-7702 transaction with empty auth list"
//   bsc-rpc.publicnode.com        → -32003 "EIP-7702 authorization list has inval…
//   arbitrum-one-rpc.publicnode.com → -32000 "failed with 50000341 gas: EIP-7702 …"
//   base-rpc.publicnode.com       → -32003 "EIP-7702 authorization list has inval…
//   avalanche-c-chain…publicnode  → result "0x"   (field silently ignored)
//   blast-rpc.publicnode.com      → result "0x"   (field silently ignored)
//
// A node that decodes `authorizationList` answers with an error that names
// 7702. A node that has never heard of it drops the field on the floor and
// reports success — which is a NO, not a maybe: it will not carry a type-0x04
// transaction either.
//
// ── Two methods that were tried and DISCARDED, so nobody re-invents them ───
//
// 1. `eth_call` with only `type: "0x4"` — publicnode returned `0x` for BOTH the
//    probe and the control. The field is ignored without `authorizationList`,
//    so that probe cannot tell anything apart. It was the first attempt.
//
// 2. Reading `requestsHash` off the latest block (a Prague/Pectra marker) —
//    Arbitrum's latest block has NO `requestsHash` while Arbitrum DOES answer
//    with an EIP-7702 error. Using it would report the second-largest chain as
//    unsupported. FALSE NEGATIVE, thrown out.
//
// Rate limits are their own class: `-32001`, "usage limit", "Unauthorized" are
// the endpoint refusing US, not the chain refusing 7702. Reporting those as
// "unsupported" would publish a lie about a chain we never actually asked.

export const PROBE_TIMEOUT_MS = 12_000;

// The four states a row can end in. Anything else is a bug in classify().
export const STATUS = {
  SUPPORT: 'support',         // the node decoded authorizationList → yes
  UNSUPPORTED: 'unsupported', // the node ignored the field → no
  UNKNOWN: 'unknown',         // rate-limited / answered something else → not measured
  OFFLINE: 'offline',         // no answer at all → endpoint dead
};

// eth_estimateGas, no signature, no broadcast, no cost to anyone.
// from/to are the zero address so nothing can be executed even by accident.
export const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_estimateGas',
  params: [{
    from: '0x0000000000000000000000000000000000000000',
    to: '0x0000000000000000000000000000000000000000',
    data: '0x',
    type: '0x4',
    authorizationList: [],
  }],
});

const LIMIT_MARKERS = ['rate limit', 'usage limit', '-32001', 'unauthorized', 'api key', 'too many', 'quota'];

/**
 * Turn one JSON-RPC answer into one of the four states.
 *
 * Pure on purpose: every classification below is decided from the payload
 * alone, so tests feed it the exact responses that were captured from the live
 * endpoints and cannot drift away from what the network really said.
 *
 * @param {{result?: unknown, error?: {message?: string}}} payload
 * @returns {{status: string, detail: string}}
 */
export function classify(payload) {
  if (payload && typeof payload.result !== 'undefined' && payload.result !== null) {
    // Success with an empty authorizationList means the field was never
    // decoded: an empty 7702 list is invalid on every node that reads it
    // (ethereum and arbitrum both reject it). So this is a "no".
    return { status: STATUS.UNSUPPORTED, detail: 'node ignored authorizationList' };
  }
  const msg = String(payload?.error?.message || payload?.error || '').trim();
  if (!msg) return { status: STATUS.UNKNOWN, detail: 'no message' };

  // Order matters: the limit markers are checked before the 7702 match so a
  // gateway that echoes our body inside a quota error cannot be read as support.
  const lower = msg.toLowerCase();
  if (LIMIT_MARKERS.some((m) => lower.includes(m))) {
    return { status: STATUS.UNKNOWN, detail: msg };
  }
  if (lower.includes('7702') || lower.includes('authorization')) {
    return { status: STATUS.SUPPORT, detail: msg };
  }
  return { status: STATUS.UNKNOWN, detail: msg };
}

/**
 * Ask one endpoint. Never throws — an unreachable RPC is a result, not an
 * exception, because the whole feature is a list and one dead endpoint must
 * not take the list down with it.
 */
export async function probeRpc(url, { fetchFn = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: PROBE_BODY,
      signal: ctrl.signal,
    });
    if (!res.ok) return { url, status: STATUS.UNKNOWN, detail: `http ${res.status}` };
    const payload = await res.json();
    return { url, ...classify(payload) };
  } catch (e) {
    return { url, status: STATUS.OFFLINE, detail: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 4 at a time. Public endpoints answer with -32001 once a burst arrives, and a
// rate-limited answer is indistinguishable from "we never got to ask", which
// would paint whole chains as unknown for no reason.
const CONCURRENCY = 4;

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Probe every RPC of one network and roll the answers up to a network verdict.
 *
 * All endpoints are asked, not just the first: the point of the feature is to
 * show WHICH link supports 7702, and a network's providers disagree (the
 * measured set above spans two different error shapes and two silent ignores).
 */
export async function checkNetwork(network, opts = {}) {
  const urls = (network.rpc || []).filter(Boolean);
  if (!urls.length) return { network, rpcs: [], status: STATUS.UNKNOWN, detail: 'no RPC configured' };

  const rpcs = await pool(urls, CONCURRENCY, (url) => probeRpc(url, opts));

  const supported = rpcs.filter((r) => r.status === STATUS.SUPPORT);
  const answered = rpcs.filter((r) => r.status !== STATUS.OFFLINE);

  let status;
  if (supported.length) status = STATUS.SUPPORT;
  else if (answered.some((r) => r.status === STATUS.UNSUPPORTED)) status = STATUS.UNSUPPORTED;
  else status = STATUS.UNKNOWN;

  return { network, rpcs, status, detail: `${supported.length}/${urls.length} endpoints support 7702` };
}

/**
 * Walk every network, one at a time, reporting as it goes so the UI can fill
 * in row by row instead of sitting blank for 27 networks' worth of round trips.
 */
export async function checkAllNetworks(networks, { onResult, ...opts } = {}) {
  const results = [];
  for (const n of networks) {
    const r = await checkNetwork(n, opts);
    results.push(r);
    onResult?.(r, results);
  }
  return results;
}

/** Summarise a result list for the headline count. */
export function summarize(results) {
  const support = results.filter((r) => r.status === STATUS.SUPPORT).length;
  const unsupported = results.filter((r) => r.status === STATUS.UNSUPPORTED).length;
  const unknown = results.filter((r) => r.status === STATUS.UNKNOWN).length;
  const offline = results.filter((r) => r.status === STATUS.OFFLINE).length;
  return { support, unsupported, unknown, offline, total: results.length };
}
