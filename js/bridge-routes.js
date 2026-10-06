// ═══════════════════════════════════════════════════════════════
// Bear Tool — bridge-routes.js
// Quote adapters for the bridge routers that are NOT LI.FI. LI.FI's
// fetch+validate stays in bridge.js (quoteUrl / validateQuote, the two
// functions e2e-probe pins); these two follow the same contract:
//
//   gaszipQuote(context, fetchFn) / relayQuote(context, fetchFn)
//     → frozen { tx, approvalAddress, skipApproval, fee, dur, route, toAmount }
//
// `tx` is the ONLY thing execution may sign, and every field is checked
// against the captured context first — the same field-by-field rule
// validateQuote applies to a LI.FI response. A mismatching response must
// never reach a signature: it throws instead.
//
// All three services were measured unauthenticated on 2026-10-06:
//   Gas.zip GET backend.gas.zip/v2/quotes/… → 200 (contractDepositTxn)
//   Relay   POST api.relay.link/quote/v2    → 200 (steps[])
// Superbridge is NOT here: api.superbridge.app/v1/chains → 401 without
// an API key, and access is granted case by case — a route the app cannot
// call has no business being in the picker.
//
// The address/checksum helpers are deliberately re-declared here rather
// than imported from bridge.js: bridge.js imports THIS module, and a cycle
// would put module-init order between the two.
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isAddress(a) {
  try { ethers.getAddress(String(a)); return true; }
  catch { return false; }
}
function sameAddr(a, b) {
  try { return ethers.getAddress(String(a)) === ethers.getAddress(String(b)); }
  catch { return false; }
}
function sameChainId(a, b) {
  try { return BigInt(a) === BigInt(b); }
  catch { return false; }
}
// Surface sanity only (hex shape + bounded length) — the same bar bridge.js
// applies to a LI.FI calldata.
function saneTxData(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return false;
  if (data.length % 2 !== 0) return false;
  if (data.length > 2 + 2 * 100000) return false;
  return true;
}
function saneExecAddress(addr) {
  return isAddress(addr) && String(addr).toLowerCase() !== ZERO_ADDRESS;
}
async function errText(res) {
  try {
    const t = (await res.text()).replace(/\s+/g, ' ').slice(0, 220);
    return t ? ` — ${t}` : '';
  } catch { return ''; }
}
function bigOrThrow(v, what) {
  try { return BigInt(v); }
  catch { throw new Error(`Relay/Gas.zip: ${what} is not an integer`); }
}

// The spender out of an `approve(address,uint256)` calldata: selector
// (0x095ea7b3) + 32-byte address slot. This is what the allowance read and
// the approve tx target — taking it from the RESPONSE instead of inventing
// one is the whole point of the check.
function spenderFromApprove(data) {
  if (typeof data !== 'string' || !/^0x095ea7b3/i.test(data)) return null;
  if (data.length < 10 + 64) return null;
  const addr = '0x' + data.slice(10 + 24, 10 + 64);
  return isAddress(addr) ? ethers.getAddress(addr) : null;
}
function approveAmountFromCalldata(data) {
  if (typeof data !== 'string' || !/^0x095ea7b3/i.test(data)) return null;
  if (data.length < 10 + 64 + 64) return null;
  try { return BigInt('0x' + data.slice(10 + 64, 10 + 128)); }
  catch { return null; }
}

/**
 * Gas.zip — native gas bridge. Returns ready-to-send calldata for one
 * origin-chain transaction that funds the destination chain with the same
 * native asset. ERC-20 has no route here (the API takes deposit_wei), so it
 * is refused BEFORE the fetch.
 */
export async function gaszipQuote(context, fetchFn) {
  if (context.tokenAddress) {
    throw new Error('Gas.zip quotes native only (this bridge is an ERC-20)');
  }
  const url = `https://backend.gas.zip/v2/quotes/${context.fromChainId}/${context.amountSmallest}/${context.toChainId}` +
    `?from=${encodeURIComponent(context.address)}&to=${encodeURIComponent(context.address)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Gas.zip HTTP ${res.status}${await errText(res)}`);
  const q = await res.json();
  const list = Array.isArray(q?.quotes) ? q.quotes : [];
  if (!list.length) throw new Error('Gas.zip: quote response has no quotes[]');
  const hit = list.find(x => Number(x.chain) === Number(context.toChainId) && x.error == null);
  if (!hit) {
    const why = list.map(x => x.error).filter(Boolean)[0];
    throw new Error(`Gas.zip: no route ${context.fromChainId}→${context.toChainId}${why ? ` (${why})` : ''}`);
  }
  const txn = q.contractDepositTxn;
  if (!txn?.to || !txn?.data) throw new Error('Gas.zip: response carries no contractDepositTxn');
  if (!saneExecAddress(txn.to)) throw new Error('Gas.zip: deposit contract address invalid');
  if (!saneTxData(txn.data)) throw new Error('Gas.zip: deposit calldata invalid');
  const value = bigOrThrow(txn.value, 'deposit value');
  const want = bigOrThrow(context.amountSmallest, 'requested amount');
  // The deposit transaction must carry EXACTLY the amount that was quoted —
  // measured 2026-10-06 (0.01 ETH request → 0x2386f26fc10000). Anything else
  // is a different deal than the one on screen.
  if (value !== want) throw new Error('Gas.zip: deposit value does not match the requested amount');
  if (typeof q.expires === 'number' && q.expires < Math.floor(Date.now() / 1000)) {
    throw new Error('Gas.zip: quote already expired');
  }
  const toAmount = bigOrThrow(hit.expected, 'expected output');
  if (toAmount <= 0n || toAmount > want) throw new Error('Gas.zip: expected output out of range');
  // Their `usd` is the destination value of the whole transfer; the fee is
  // the part that did not arrive.
  const feeUsd = hit.usd != null
    ? (Number(want - toAmount) / Number(want)) * Number(hit.usd) : null;
  return Object.freeze({
    tx: { to: ethers.getAddress(txn.to), data: txn.data, value, chainId: Number(context.fromChainId) },
    approvalAddress: null,        // native: no allowance, ever
    skipApproval: true,
    fee: feeUsd == null ? '?' : feeUsd.toFixed(4),
    dur: hit.speed ?? '?',
    route: 'Gas.zip',
    toAmount,
  });
}

/**
 * Relay — intent solver. POST /quote/v2, no credential. The response is an
 * ordered step list: `approve` first when an allowance is missing, then the
 * `deposit` transaction that actually starts the bridge.
 */
export async function relayQuote(context, fetchFn) {
  const payload = {
    user: context.address,
    originChainId: Number(context.fromChainId),
    destinationChainId: Number(context.toChainId),
    originCurrency: context.tokenAddress || ZERO_ADDRESS,
    destinationCurrency: context.toTokenAddress || ZERO_ADDRESS,
    amount: context.amountSmallest,
    tradeType: 'EXACT_INPUT',
  };
  const res = await fetchFn('https://api.relay.link/quote/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}${await errText(res)}`);
  const q = await res.json();
  const steps = Array.isArray(q?.steps) ? q.steps : [];
  if (!steps.length) throw new Error('Relay: quote response has no steps[]');

  let approvalAddress = null;
  let approveAmount = null;
  let deposit = null;
  for (const s of steps) {
    // A signature step (EIP-3009 permit) or anything else this app does not
    // perform would leave the deposit unsigned — refuse before signing, do
    // not half-run the flow.
    if (s && s.kind && s.kind !== 'transaction') {
      throw new Error(`Relay: unsupported step kind "${s.kind}"`);
    }
    const data = Array.isArray(s?.items) ? s.items[0]?.data : null;
    if (!data || typeof data !== 'object') continue;
    if (s.id === 'approve') {
      const spender = spenderFromApprove(data.data);
      if (!spender) throw new Error('Relay: approve step without a readable spender');
      if (context.tokenAddress && !sameAddr(data.to, context.tokenAddress)) {
        throw new Error('Relay: approve targets a different token than the quote');
      }
      approvalAddress = spender;
      approveAmount = approveAmountFromCalldata(data.data);
    } else if (s.id === 'deposit') {
      deposit = data;
    }
  }
  if (!deposit) throw new Error('Relay: quote has no deposit transaction');

  if (!sameChainId(deposit.chainId, context.fromChainId)) {
    throw new Error('Relay: deposit chainId mismatch');
  }
  if (!sameAddr(deposit.from, context.address)) throw new Error('Relay: deposit from-address mismatch');
  if (!saneExecAddress(deposit.to)) throw new Error('Relay: deposit contract address invalid');
  if (!saneTxData(deposit.data)) throw new Error('Relay: deposit calldata invalid');
  const value = bigOrThrow(deposit.value ?? '0', 'deposit value');
  const want = bigOrThrow(context.amountSmallest, 'requested amount');
  if (context.tokenAddress) {
    if (value !== 0n) throw new Error('Relay: ERC-20 deposit must carry no native value');
    if (approvalAddress) {
      if (approveAmount == null) throw new Error('Relay: approve amount unreadable');
      if (approveAmount < want) throw new Error('Relay: approval is smaller than the amount');
    }
  } else {
    if (value <= 0n || value > want) throw new Error('Relay: native deposit value out of range');
  }

  // The currencies named in the response must be the pair being quoted —
  // an swapped-in token on either side is a different contract entirely.
  const cin = q.details?.currencyIn?.currency;
  const cout = q.details?.currencyOut?.currency;
  const expectFrom = context.tokenAddress || ZERO_ADDRESS;
  const expectTo = context.toTokenAddress || ZERO_ADDRESS;
  if (cin) {
    if (!sameAddr(cin.address || ZERO_ADDRESS, expectFrom)) throw new Error('Relay: input currency mismatch');
    if (cin.chainId != null && !sameChainId(cin.chainId, context.fromChainId)) throw new Error('Relay: input chain mismatch');
  }
  if (cout) {
    if (!sameAddr(cout.address || ZERO_ADDRESS, expectTo)) throw new Error('Relay: output currency mismatch');
    if (cout.chainId != null && !sameChainId(cout.chainId, context.toChainId)) throw new Error('Relay: output chain mismatch');
  }

  const toAmountRaw = q.details?.currencyOut?.amount;
  const toAmount = toAmountRaw == null ? 0n : bigOrThrow(toAmountRaw, 'output amount');
  if (toAmount <= 0n) throw new Error('Relay: output amount missing');
  const route = typeof q.details?.route === 'string' && q.details.route
    ? `Relay → ${q.details.route.slice(0, 40)}` : 'Relay';
  return Object.freeze({
    tx: { to: ethers.getAddress(deposit.to), data: deposit.data, value, chainId: Number(context.fromChainId) },
    approvalAddress,
    skipApproval: !approvalAddress,
    fee: q.fees?.relayer?.amountUsd ?? '?',
    dur: q.details?.timeEstimate ?? '?',
    route,
    toAmount,
  });
}

export const BRIDGE_ROUTE_FETCHERS = { gaszip: gaszipQuote, relay: relayQuote };
