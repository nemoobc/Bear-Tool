// js/non-evm-rpc.js — the network edge for Bitcoin, XRP and Solana.
//
// Everything else in this build is pure: chain-btc/xrp/sol turn keys into
// signed bytes and never touch the outside world. This module is the one place
// that talks to it, which keeps two questions answerable in a single file:
// WHICH hosts we will talk to, and HOW we interpret what they say.
//
// The endpoints are fixed constants, not user input — a wallet that lets a
// screen hand it an arbitrary URL is a wallet that leaks a signed transaction to
// whoever typed it. So there is an allowlist, and it is enforced before any
// request leaves. Loopback (http://localhost / 127.0.0.1) is opened only when a
// caller passes `debug: true`, mirroring the app's own rule that cleartext is a
// local-development exception, never a transport for a real broadcast.
//
// Every function takes an optional `fetchFn` so the whole module is testable
// with no network at all (tests/non-evm-rpc.test.js drives it with a fake).

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * The only hosts this module will ever contact. Same spirit as the app's
 * isSafeRpcUrl: https is required in production, loopback is a debug-only
 * escape hatch, everything else is refused by name.
 */
export const NON_EVM_ALLOWED_HOSTS = [
  'mempool.space',
  'blockstream.info',
  's1.ripple.com',
  's.altnet.rippletest.net',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
];

const ALLOWED = new Set(NON_EVM_ALLOWED_HOSTS);

/**
 * Refuse anything that is not an allowlisted https endpoint. `debug` opens
 * http loopback only — the fork/local-node path, which never carries real
 * funds — and nothing else.
 */
export function assertAllowedEndpoint(url, { debug = false } = {}) {
  const text = String(url == null ? '' : url).trim();
  if (!text) throw new Error('non-EVM: empty endpoint');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`non-EVM: not a valid URL — "${text}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
  if (parsed.protocol === 'https:') {
    if (ALLOWED.has(host)) return text;
    throw new Error(`non-EVM: refusing to contact "${host}" — not an allowlisted endpoint`);
  }
  if (parsed.protocol === 'http:' && debug && loopback) return text;
  if (parsed.protocol === 'http:') {
    throw new Error('non-EVM: refusing plain http — a broadcast must not travel in clear (use https)');
  }
  throw new Error(`non-EVM: refusing the "${parsed.protocol}" scheme`);
}

// ── endpoints ───────────────────────────────────────────────────────────

export const NON_EVM_ENDPOINTS = {
  bitcoin: {
    mainnet: {
      primary: 'https://mempool.space/api',
      fallback: 'https://blockstream.info/api',
      explorer: 'https://mempool.space',
    },
    testnet: {
      primary: 'https://mempool.space/testnet/api',
      fallback: 'https://blockstream.info/testnet/api',
      explorer: 'https://mempool.space/testnet',
    },
  },
  xrp: {
    mainnet: { rpc: 'https://s1.ripple.com:51234/', explorer: 'https://xrpscan.com' },
    testnet: { rpc: 'https://s.altnet.rippletest.net:51234/', explorer: 'https://testnet.xrpscan.com' },
  },
  solana: {
    mainnet: { rpc: 'https://api.mainnet-beta.solana.com', explorer: 'https://solscan.io' },
    testnet: { rpc: 'https://api.devnet.solana.com', explorer: 'https://solscan.io' },
  },
};

// Where a transaction link goes once the explorer host is known. Kept apart from
// NON_EVM_ENDPOINTS so that every value over there stays a plain https URL
// (tests/non-evm-rpc.test.js enforces exactly that).
//
// The path is NOT the same for every chain, and two of them are easy to get
// wrong. XRPScan documents the transaction link as /tx/{hash} on BOTH mainnet and
// testnet.xrpscan.com. Solscan carries the cluster as a QUERY STRING —
// solscan.io/tx/{sig}?cluster=devnet — so appending /tx/… to a base that already
// carried ?cluster=devnet built a URL that went nowhere.
const EXPLORER_TX = {
  bitcoin: { mainnet: '/tx/{hash}', testnet: '/tx/{hash}' },
  xrp: { mainnet: '/tx/{hash}', testnet: '/tx/{hash}' },
  solana: { mainnet: '/tx/{hash}', testnet: '/tx/{hash}?cluster=devnet' },
};

/** The full explorer link for a mined transaction, or '' if we have no explorer. */
export function explorerTxUrl(chain, network, hash) {
  const net = NON_EVM_ENDPOINTS[chain]?.[network];
  const path = EXPLORER_TX[chain]?.[network];
  if (!net?.explorer || !path) return '';
  return net.explorer + path.replace('{hash}', encodeURIComponent(String(hash)));
}

export function endpointFor(chainId, network = 'mainnet', kind = 'primary') {
  const chain = NON_EVM_ENDPOINTS[chainId];
  if (!chain) throw new Error(`non-EVM: unknown chain "${chainId}"`);
  const net = chain[network];
  if (!net) throw new Error(`non-EVM: unknown network "${network}" for ${chainId}`);
  return net[kind] || net.rpc || net.primary;
}

// ── transport ───────────────────────────────────────────────────────────

/** A JSON GET/POST with a hard timeout, an allowlist check and useful errors. */
export async function requestJson(url, { method = 'GET', body, headers, fetchFn, timeoutMs = DEFAULT_TIMEOUT_MS, debug = false, signal } = {}) {
  const href = assertAllowedEndpoint(url, { debug });
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('non-EVM: no fetch available in this environment');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  // Honour a caller's signal as well as the timeout.
  if (controller && signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetchImpl(href, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: controller ? controller.signal : undefined,
    });
    if (!res || typeof res.ok !== 'boolean') throw new Error('non-EVM: the endpoint did not return a response');
    if (!res.ok) throw new Error(`non-EVM: ${method} ${href} failed (HTTP ${res.status})`);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error && (error.name === 'AbortError' || /aborted/i.test(String(error.message)))) {
      throw new Error('non-EVM: the request timed out');
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Bitcoin (mempool.space / blockstream.info) ──────────────────────────

/**
 * Unspent outputs for an address. Returns the fields the signer needs and
 * nothing it does not: txid (display order, as mempool.space reports it),
 * vout, value in satoshis, and whether the output is confirmed.
 *
 * The node is NOT trusted to hand back a well-formed outpoint: a txid that is
 * not 32 bytes, a fractional vout or a negative value would be signed straight
 * into a transaction that can never confirm (or, worse, one that spends an
 * output the wallet did not mean to). Anything that does not fit the shape is
 * dropped here, where it can still be seen, instead of at signing time.
 */
export async function btcUtxos(address, { network = 'mainnet', fetchFn, base, debug = false, signal } = {}) {
  const root = base || endpointFor('bitcoin', network, 'primary');
  const url = `${root}/address/${encodeURIComponent(address)}/utxo`;
  const data = await requestJson(url, { fetchFn, debug, signal });
  if (!Array.isArray(data)) throw new Error('non-EVM: unexpected response for the UTXO list');
  return data.map((u) => ({
    txid: String(u.txid || '').toLowerCase(),
    vout: Number(u.vout),
    value: Number(u.value),
    confirmed: Boolean(u.status && u.status.confirmed),
    blockHeight: u.status && u.status.block_height ? Number(u.status.block_height) : null,
  })).filter((u) => (
    /^[0-9a-f]{64}$/.test(u.txid)
    && Number.isInteger(u.vout) && u.vout >= 0 && u.vout <= 0xffffffff
    && Number.isInteger(u.value) && u.value > 0
  ));
}

export async function btcBalance(address, options = {}) {
  const utxos = await btcUtxos(address, options);
  const confirmed = utxos.filter((u) => u.confirmed).reduce((sum, u) => sum + u.value, 0);
  const unconfirmed = utxos.filter((u) => !u.confirmed).reduce((sum, u) => sum + u.value, 0);
  return { confirmed, unconfirmed, total: confirmed + unconfirmed, utxos };
}

/**
 * Recommended fee rates in sat/vB. mempool.space answers with a fixed object;
 * blockstream.info answers with a height→rate map, so both are normalised to
 * the same shape.
 */
export async function btcFeeRate({ network = 'mainnet', fetchFn, base, debug = false, signal } = {}) {
  const root = base || endpointFor('bitcoin', network, 'primary');
  try {
    const data = await requestJson(`${root}/v1/fees/recommended`, { fetchFn, debug, signal });
    if (data && typeof data === 'object' && data.fastestFee) {
      return {
        fastest: Number(data.fastestFee),
        halfHour: Number(data.halfHourFee ?? data.fastestFee),
        hour: Number(data.hourFee ?? data.fastestFee),
        economy: Number(data.economyFee ?? data.minimumFee ?? 1),
        minimum: Number(data.minimumFee ?? 1),
      };
    }
    throw new Error('non-EVM: unexpected fee response');
  } catch (error) {
    // Fall back to blockstream's estimates when the primary has nothing.
    if (base) throw error;
    const estimates = await requestJson(`${endpointFor('bitcoin', network, 'fallback')}/fee-estimates`, { fetchFn, debug, signal });
    const rates = Object.values(estimates || {}).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!rates.length) throw new Error('non-EVM: no fee estimates available');
    const pick = (frac) => rates[Math.min(rates.length - 1, Math.floor(rates.length * frac))];
    return { fastest: pick(0.95), halfHour: pick(0.75), hour: pick(0.5), economy: pick(0.25), minimum: rates[0] };
  }
}

/** Broadcast a raw transaction hex. Returns the txid the node computed. */
export async function btcBroadcast(rawHex, { network = 'mainnet', fetchFn, base, debug = false, signal } = {}) {
  const root = base || endpointFor('bitcoin', network, 'primary');
  const hex = String(rawHex || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('non-EVM: the transaction to broadcast is not hex');
  const out = await requestJson(`${root}/tx`, {
    method: 'POST', body: hex, fetchFn, debug, signal,
    headers: { 'content-type': 'text/plain' },
  });
  const txid = typeof out === 'string' ? out.trim() : (out && out.txid ? String(out.txid) : '');
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`non-EVM: the node rejected the transaction — ${txid || 'no txid returned'}`);
  return txid;
}

// ── XRP (rippled JSON-RPC) ──────────────────────────────────────────────

async function xrpRpc(method, params, { network = 'mainnet', fetchFn, rpc, debug = false, signal } = {}) {
  const url = rpc || endpointFor('xrp', network, 'rpc');
  const payload = { method, params: params || [{}] };
  const data = await requestJson(url, { method: 'POST', body: payload, fetchFn, debug, signal });
  if (!data || typeof data !== 'object') throw new Error(`non-EVM: XRP ${method} returned nothing`);
  if (data.result && data.result.error) {
    throw new Error(`non-EVM: XRP ${method} failed — ${data.result.error_message || data.result.error}`);
  }
  if (data.error) throw new Error(`non-EVM: XRP ${method} failed — ${data.error_message || data.error}`);
  return data.result;
}

/** Sequence (for the next transaction) and balance, in drops. */
export async function xrpAccountInfo(address, options = {}) {
  const result = await xrpRpc('account_info', [{ account: address, ledger_index: 'current', strict: true }], options);
  const accountData = result && result.account_data;
  if (!accountData) throw new Error('non-EVM: XRP account_info returned no account data');
  return {
    sequence: Number(accountData.Sequence),
    balanceDrops: BigInt(accountData.Balance),
    ownerCount: Number(accountData.OwnerCount || 0),
    ledgerIndex: Number(result.ledger_current_index || result.ledger_index || 0),
    validated: Boolean(result.validated),
  };
}

/** An account that has never been funded has no sequence — this tells you so. */
export async function xrpAccountExists(address, options = {}) {
  try {
    await xrpAccountInfo(address, options);
    return true;
  } catch (error) {
    if (/actNotFound|account not found/i.test(String(error && error.message))) return false;
    throw error;
  }
}

export async function xrpLedgerIndex(options = {}) {
  const result = await xrpRpc('ledger', [{ ledger_index: 'current' }], options);
  return Number((result && (result.ledger_index || (result.ledger && result.ledger.seq))) || 0);
}

export async function xrpServerInfo(options = {}) {
  const result = await xrpRpc('server_info', [{}], options);
  const info = result && result.info;
  const vledger = (info && info.validated_ledger) || {};
  // server_info reports the reserves in DECIMAL XRP (reserve_base_xrp /
  // reserve_inc_xrp); server_state reports integer drops. We convert to drops.
  const toDrops = (xrp) => (Number.isFinite(Number(xrp)) ? BigInt(Math.round(Number(xrp) * 1e6)) : null);
  return {
    state: info && info.server_state,
    validatedLedger: Number(vledger.seq) || 0,
    loadFactor: Number(info && info.load_factor) || 1,
    reserveBaseDrops: toDrops(vledger.reserve_base_xrp),
    reserveIncDrops: toDrops(vledger.reserve_inc_xrp),
  };
}

// The ledger's documented fallbacks, used only when server_info could not be
// read. On mainnet the base reserve is 1 XRP and the owner reserve 0.2 XRP per
// owned object (xrpl.org/docs/concepts/accounts/reserves) — these are set by fee
// voting and DO change, which is why the live value is preferred.
const XRP_BASE_RESERVE_FALLBACK = 1000000n; // 1 XRP
const XRP_OWNER_RESERVE_FALLBACK = 200000n; // 0.2 XRP per item

/**
 * The XRP an account must keep: the base reserve plus one owner reserve for each
 * object it owns. Read from the ledger when possible — hardcoding it once meant
 * the MAX button withheld 10 XRP for a reserve that had become 1.
 */
export function xrpReserveDrops({ serverInfo, ownerCount = 0 } = {}) {
  const base = serverInfo?.reserveBaseDrops ?? XRP_BASE_RESERVE_FALLBACK;
  const inc = serverInfo?.reserveIncDrops ?? XRP_OWNER_RESERVE_FALLBACK;
  return base + BigInt(ownerCount) * inc;
}

/**
 * Submit a signed blob.
 *
 * rippled answers with an engine_result that is any of three families: tes
 * (success), ter (tentative — retry the same blob), tec/tem/tef (the ledger
 * refused it). Only the last is an error worth surfacing as one; a ter that
 * were thrown would hide a transaction that may still land.
 */
export async function xrpSubmit(blobHex, options = {}) {
  const blob = String(blobHex || '').trim().replace(/^0x/, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(blob)) throw new Error('non-EVM: the XRP transaction to submit is not hex');
  const result = await xrpRpc('submit', [{ tx_blob: blob }], options);
  const engineResult = String((result && result.engine_result) || '');
  const accepted = engineResult.startsWith('tes') || engineResult.startsWith('ter');
  if (!accepted) {
    throw new Error(`non-EVM: the ledger refused the transaction — ${engineResult}${result && result.engine_result_message ? ` (${result.engine_result_message})` : ''}`);
  }
  return {
    engineResult,
    engineResultMessage: String((result && result.engine_result_message) || ''),
    accepted,
    tentative: engineResult.startsWith('ter'),
    hash: String((result && result.tx_json && result.tx_json.hash) || ''),
    blob: String((result && result.tx_blob) || blob),
  };
}

export async function xrpTxStatus(hash, options = {}) {
  const result = await xrpRpc('tx', [{ transaction: hash, binary: false }], options);
  return {
    validated: Boolean(result && result.validated),
    ledgerIndex: Number((result && (result.ledger_index || result.inLedger)) || 0),
    result: String((result && result.meta && result.meta.TransactionResult) || ''),
  };
}

// ── Solana (JSON-RPC) ───────────────────────────────────────────────────

let solRpcId = 0;

export async function solRpc(method, params = [], { network = 'mainnet', fetchFn, rpc, debug = false, signal } = {}) {
  const url = rpc || endpointFor('solana', network, 'rpc');
  solRpcId += 1;
  const data = await requestJson(url, {
    method: 'POST', fetchFn, debug, signal,
    body: { jsonrpc: '2.0', id: solRpcId, method, params },
  });
  if (data && data.error) {
    throw new Error(`non-EVM: Solana ${method} failed — ${data.error.message || JSON.stringify(data.error)}`);
  }
  if (!data || data.result === undefined) throw new Error(`non-EVM: Solana ${method} returned no result`);
  return data.result;
}

export async function solLatestBlockhash(options = {}) {
  const result = await solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }], options);
  const value = result && result.value;
  if (!value || !value.blockhash) throw new Error('non-EVM: Solana returned no blockhash');
  return { blockhash: String(value.blockhash), lastValidBlockHeight: Number(value.lastValidBlockHeight) };
}

export async function solBalance(address, options = {}) {
  const result = await solRpc('getBalance', [address, { commitment: 'confirmed' }], options);
  const lamports = typeof result === 'object' && result !== null ? result.value : result;
  return BigInt(lamports || 0);
}

export async function solSendTransaction(rawBase64, options = {}) {
  const tx = String(rawBase64 || '').trim();
  if (!tx) throw new Error('non-EVM: no transaction to send');
  const signature = await solRpc('sendTransaction', [tx, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }], options);
  if (typeof signature !== 'string' || !signature) throw new Error('non-EVM: Solana did not return a signature');
  return signature;
}

export async function solSignatureStatus(signature, options = {}) {
  const result = await solRpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], options);
  const value = result && Array.isArray(result.value) ? result.value[0] : null;
  if (!value) return { found: false, confirmed: false, slot: null, error: null };
  return {
    found: true,
    confirmed: value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized',
    finalized: value.confirmationStatus === 'finalized',
    slot: value.slot == null ? null : Number(value.slot),
    error: value.err || null,
  };
}

export async function solMinimumBalanceForRentExemption(space, options = {}) {
  const lamports = await solRpc('getMinimumBalanceForRentExemption', [Number(space)], options);
  return BigInt(lamports || 0);
}
