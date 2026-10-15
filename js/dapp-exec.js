// ═══════════════════════════════════════════════════════════════
// dapp-exec.js — wallet-side RPC answered by the WALLET, never by a node.
//
// WHY THIS FILE EXISTS (live, 2026-10-08, publicnode.com):
//   personal_sign              → node -32601 "Method not found"
//   eth_sendTransaction        → node -32602 "missing field request"
//   wallet_switchEthereumChain → node -32601 "does not exist/is not available"
//   wallet_getPermissions      → node -32601
// A public node holds no keys, no chain list, no permission bookkeeping —
// forwarding these calls to it can only fail, and it failed AFTER the user
// had approved the dialog. Every method in LOCAL is executed here, against
// the wallet's own signer / network state / session store. Read-only JSON-RPC
// (eth_getBalance, eth_call, …) still goes to the node: that is what nodes
// are for.
//
// The WalletConnect path (walletconnect.js) always did this right —
// `signer.signMessage` / `signer.signTypedData` — which is the proof that
// the pattern works; the injected bridge just never followed it.
// ═══════════════════════════════════════════════════════════════

import { get, persistCustomToken } from './state.js';
import { getNetwork, getNetworkById, sanitizeChainRequest, installRequestedChain } from './network.js';
import { scanTransaction } from './security.js';

const { ethers } = globalThis;

// The methods this module owns. Anything else → { done: false } and the
// caller forwards it to the node (the reads).
const LOCAL = new Set([
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
]);

export function isLocalMethod(method) {
  return LOCAL.has(String(method || ''));
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** The chain this wallet is ON, as a number. Never NaN.
 *
 * BTC/SOL/XRP are selectable networks now (same-seed chains this wallet can
 * only RECEIVE on) and they have NO EVM chain id. Answering 1 there would sign
 * a dApp request on Ethereum while the wallet's own pill says Bitcoin — the
 * silent-chain-substitution this file exists to kill — so a non-EVM network
 * refuses instead. An unknown/empty id still falls back to the registry default
 * (the "stale saved id" case pinned in dapp-exec.test.js). */
export function currentChainId() {
  const net = getNetworkById(get('networkId'));
  const n = Number(net?.chainId);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

// [message, address] is the spec order; [address, message] is the legacy
// order real dApps still send (MetaMask accepts both, so must we).
export function splitSignParams(params) {
  let [a, b] = Array.isArray(params) ? params : [];
  if (typeof a === 'string' && ADDR_RE.test(a) && !(typeof b === 'string' && ADDR_RE.test(b))) {
    [a, b] = [b, a];
  }
  return { message: a, address: b };
}

// EIP-712 arrives in BOTH orders — [address, typedData] (the convention real
// dApps send; the emulator's own fixture does, with the stand-in address
// "0x0") and [typedData, address] (legacy). splitSignParams CANNOT pick the
// side here: its 40-hex address rule rejects short addresses, so "0x0" was
// read AS the payload, JSON.parse('0x0') threw, and the wallet answered 32602
// without ever showing the sheet — the emulator gate failed on exactly this
// ("typed-data sheet never appeared", run 38726524114) after a fix that had
// only swapped which function did the picking.
//
// The discriminator is STRUCTURAL, not a length: the payload is an object, or
// a string holding a JSON object; an address is a bare hex token. Nothing else
// in this request can look like either. (MetaMask picks the side the same way.)
export function splitTypedParams(params) {
  const list = Array.isArray(params) ? params : [];
  const isPayload = (v) => (v && typeof v === 'object')
    || (typeof v === 'string' && /^\s*\{/.test(v));
  const at = list.findIndex(isPayload);
  if (at >= 0) {
    const rest = list.filter((_, i) => i !== at);
    return { typed: list[at], address: rest.length ? rest[0] : undefined };
  }
  // Nothing recognizable: assume the spec order and let the parse decide —
  // its 32602 names the real problem, where a guess here would only hide it.
  return { typed: list[1] !== undefined ? list[1] : list[0], address: list[0] };
}

function requireSigner() {
  const signer = get('signer');
  if (!signer || typeof signer.signMessage !== 'function') {
    throw err(4100, 'The wallet is locked. Unlock it to continue.');
  }
  return signer;
}

function requireAddressMatch(addr) {
  const active = get('address');
  if (addr && (!active || String(addr).toLowerCase() !== String(active).toLowerCase())) {
    throw err(4100, `The account ${addr} is not the active account (${active || 'none'}).`);
  }
}

/**
 * One builder for `eth_sendTransaction`, shared by all three send paths
 * (this file, native-dapp.js, walletconnect.js).
 *
 * Each path grew its own idea of what a dApp's transaction object means: the
 * injected branch dropped `from` but skipped the transaction's own chainId,
 * WalletConnect passed arbitrary fields through with only `gas` renamed, and
 * the native branch hand-picked three fields and silently dropped everything
 * else — so the SAME request got three different verdicts depending on which
 * surface asked. This is the function they all call now. It is PURE (the
 * caller hands in the active address and chain id) so every refusal is
 * unit-testable without a wallet.
 *
 * Refusals, in order:
 *   - not an object                       → 32602
 *   - `from` other than the active account→ 4100
 *   - `chainId` other than the wallet's   → 4902
 *   - `to` that is not a 0x address       → 32602
 *   - `data` that is not 0x hex           → 32602
 *   - `input` where Ethereum wants `data` → 32602. The old whitelists dropped
 *     `input` silently, so a contract call went out as a naked value transfer
 *     behind a sheet that had shown no calldata — refusing beats signing that.
 *   - neither `to` nor non-empty data     → 32602 (nothing to send; ethers
 *     would deploy an empty contract and burn gas doing it)
 * Everything else is whitelisted to the fields ethers accepts and numeric
 * values become BigInt. `from` is never copied — the signer IS the account.
 */
export function buildSendTx(raw, { activeAddress = '', chainId = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err(32602, 'eth_sendTransaction expects a transaction object.');
  }
  if (raw.from != null && String(raw.from)
      && String(raw.from).toLowerCase() !== String(activeAddress).toLowerCase()) {
    throw err(4100, `The account ${raw.from} is not the active account.`);
  }
  if (raw.chainId != null && raw.chainId !== '') {
    // Number() reads both spellings a dApp may use — the JSON-RPC hex string
    // ("0x89") and a plain number; NaN (unparseable, or '') is treated as
    // "no chain claimed", exactly how this check always degraded.
    const want = Number(raw.chainId);
    if (Number.isFinite(want) && chainId != null && want !== Number(chainId)) {
      throw err(4902, `The transaction targets chain ${want} but the wallet is on chain ${chainId}.`);
    }
  }
  if (raw.to != null) {
    if (typeof raw.to !== 'string' || !ADDR_RE.test(raw.to)) {
      throw err(32602, `The transaction's "to" (${String(raw.to).slice(0, 24)}) is not a 0x address.`);
    }
  }
  if (raw.data != null) {
    if (typeof raw.data !== 'string' || !HEX_RE.test(raw.data)) {
      throw err(32602, "The transaction's data is not 0x hex.");
    }
  } else if (raw.input != null) {
    throw err(32602,
      'The transaction sends "input" where an Ethereum transaction carries "data" — refusing rather than broadcasting a call with no calldata.');
  }
  const hasData = typeof raw.data === 'string' && raw.data !== '0x';
  if (raw.to == null && !hasData) {
    throw err(32602, 'The transaction has no recipient and no calldata — nothing to send.');
  }
  const toBig = (v, name) => {
    try { return BigInt(v); } catch { throw err(32602, `The transaction's ${name} is not a number.`); }
  };
  const tx = {};
  for (const k of ['to', 'data', 'nonce', 'type', 'accessList']) if (raw[k] != null) tx[k] = raw[k];
  if (raw.value != null) tx.value = toBig(raw.value, 'value');
  const gas = raw.gasLimit ?? raw.gas; // WC dApps spell it `gas` (JSON-RPC); ethers v6 only reads gasLimit.
  if (gas != null) tx.gasLimit = toBig(gas, 'gas');
  for (const k of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    if (raw[k] != null) tx[k] = toBig(raw[k], k);
  }
  return tx;
}

/**
 * Run the transaction detectors (security.js scanTransaction — unlimited
 * approval, operator grant, off-chain permit, unreadable selector, first-time
 * contract, large value) over a dApp's request. One scan for the injected
 * (app.js), native (native-dapp.js) and WalletConnect paths: it used to run
 * in app.js alone, so the Security Center's "every signing or spending call
 * from a dApp is scanned" was true for one surface out of three — a user
 * pairing over WalletConnect or browsing in the native WebView saw no
 * findings at all.
 * Returns [] on anything unexpected: a detector that throws must never
 * become a way to block signing, and a non-transaction request (a message, a
 * typed payload) simply has nothing a tx-scanner can read.
 */
export function scanSignCall(method, params) {
  try {
    const tx = Array.isArray(params) ? (params[0] || {}) : {};
    const known = (get('tokens') || []).map((tok) => tok.address).filter(Boolean);
    // scanTransaction returns { risk, findings, approval } — an object, not a
    // list. Returning it whole and then calling .find() on it is the kind of
    // mistake the browser test exists to catch: it threw "findings.find is not
    // a function" the first time a dApp actually sent a transaction.
    const r = scanTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0,
      knownContracts: known,
    });
    return Array.isArray(r?.findings) ? r.findings : [];
  } catch {
    return [];
  }
}

// The chain check for anything that BROADCASTS, shared by all three send paths
// (this file, native-dapp.js, walletconnect.js).
//
// Every one of them compared the chain against get('networkId') while taking
// the transport from get('provider') — and those two are updated at different
// times: activateNetwork() writes networkId SYNCHRONOUSLY, but the provider is
// rebuilt LATER, asynchronously, inside loadDashboard behind an RPC probe that
// costs a round trip or two. So the standard dApp flow
// `switchChain(x); sendTransaction(...)` passed the guard against the NEW id
// and was broadcast through the OLD provider: the transaction landed on the
// previous chain while the dialog named the new one — the exact silent chain
// substitution every guard here claims to kill.
//
// Asking the provider what chain it is actually on is the only check a
// half-finished switch cannot fool: a mismatch means the swap has not landed,
// and refusing with a retryable -32603 is correct — the alternative is a real
// transaction on the wrong chain. ethers caches this per provider, so a settled
// wallet pays one read, not one per send.
export async function providerOnCurrentChain() {
  const provider = get('provider');
  if (!provider) throw err(-32603, 'No RPC provider — pick a network and try again.');
  const want = currentChainId();
  const probe = await provider.getNetwork().catch(() => null);
  if (!probe) throw err(-32603, 'Could not confirm the active chain (the RPC did not answer) — try again in a moment.');
  const on = Number(probe.chainId);
  if (on !== want) {
    throw err(-32603,
      `The RPC provider is still on chain ${on} while the wallet is on chain ${want}. ` +
      'The network switch is still settling — nothing was sent; try again in a moment.');
  }
  return provider;
}

// personal_sign messages are hex-encoded bytes per spec; anything else is the
// literal string the dApp wants signed. A plain string signed by ethers is
// utf8-encoded, so hex MUST be converted to bytes first — signing the literal
// characters "0x6865…" would be a different message than the dApp showed the
// user. Shared with the WalletConnect and native paths, which each had a local
// copy that FLOORED the last nibble off an odd-length hex string and signed
// different bytes than the sheet had previewed.
export function signPayload(raw) {
  if (typeof raw === 'string' && raw.length >= 4 && raw.length % 2 === 0 && HEX_RE.test(raw)) return ethers.getBytes(raw);
  return raw;
}

export function parseTyped(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { throw err(32602, 'Invalid typed data JSON: ' + e.message); }
  }
  if (!data || typeof data !== 'object') throw err(32602, 'Invalid typed data payload.');
  return data;
}

export function typedParts(data) {
  const types = { ...(data.types || {}) };
  delete types.EIP712Domain; // ethers builds the domain type itself; a copy of it is an error.
  let primary = data.primaryType;
  if (!primary) {
    const keys = Object.keys(types);
    if (keys.length === 1) primary = keys[0];
    else throw err(32602, 'primaryType is missing from the typed data.');
  }
  if (!types[primary]) throw err(32602, `primaryType "${primary}" is not declared in types.`);
  const domain = data.domain && typeof data.domain === 'object' ? data.domain : {};
  const message = data.message && typeof data.message === 'object' ? data.message : {};
  return { domain, types, message };
}

function parseChainIdParam(params) {
  const raw = params?.[0]?.chainId;
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  throw err(32602, 'Expected [{ chainId: "0x…" }].');
}

// EIP-3326: the wallet serves the switch itself and returns null on success;
// a chain Bear Tool does not know is a 4902 with the instruction where to add
// it — the exact shape walletconnect.js already gives WC dApps (CHAIN_UNKNOWN).
async function switchTo(chainId, activateNetwork) {
  const net = getNetwork(chainId);
  if (!net) {
    throw err(4902, `Bear Tool has no network with chain id ${chainId}. Add it in Settings → Networks, then ask again.`);
  }
  if (net.id !== get('networkId')) {
    if (typeof activateNetwork !== 'function') throw err(-32603, 'Network switching is unavailable.');
    // activateNetwork is THE chokepoint: it also fires chainChanged, so the
    // page hears about the move exactly once, from one place.
    const changed = activateNetwork(net.id, { close: false });
    if (changed === false && net.id !== get('networkId')) {
      throw err(-32603, 'The network switch did not land.');
    }
  }
  return null;
}

/**
 * Execute a wallet-side RPC locally.
 * @returns {Promise<{done:false} | {done:true, value:any}>}
 *   {done:false} → not ours, forward to the node.
 *   {done:true, value} → answered here; return value to the dApp.
 *   THROWS provider-style errors ({code, message}) for methods it owns.
 * @param {object} opts
 * @param {string}   opts.method
 * @param {any[]}    [opts.params]
 * @param {string}   [opts.origin]        requesting site (for prompts)
 * @param {(id:string, o?:object) => boolean} [opts.activateNetwork]  app.js chokepoint
 * @param {(info:object) => Promise<boolean>} [opts.confirmAsset]  watchAsset dialog
 * @param {(info:{net:object, origin:string}) => Promise<boolean>} [opts.offerAddChain]
 *   EIP-3085 add-network dialog (caller shows the sanitized chain + Cancel/Confirm)
 */
export async function executeLocal({ method, params = [], origin = '', activateNetwork, confirmAsset, offerAddChain } = {}) {
  if (!isLocalMethod(method)) return { done: false };

  switch (method) {
    case 'personal_sign': {
      const signer = requireSigner();
      const { message, address } = splitSignParams(params);
      requireAddressMatch(address);
      if (message == null) throw err(32602, 'personal_sign expects [message, address].');
      return { done: true, value: await signer.signMessage(signPayload(message)) };
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v1':
      // Legacy v1 has its own hashing algorithm no modern signer exposes, and
      // inventing it from memory would produce signatures other wallets cannot
      // verify. Refuse honestly instead of forwarding to a node that cannot
      // answer it either — v4 is what every current library sends.
      throw err(4200, 'Bear Tool does not serve legacy eth_signTypedData (v1). Use eth_signTypedData_v4.');

    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const signer = requireSigner();
      // splitTypedParams, NOT splitSignParams: the payload must be found by
      // shape (object / JSON string), or a short stand-in address like "0x0"
      // is read as the payload and the request dies unparseable.
      const { typed, address } = splitTypedParams(params);
      requireAddressMatch(address);
      if (typed == null) throw err(32602, 'Expected [typedData, address].');
      const { domain, types, message } = typedParts(parseTyped(typed));
      return { done: true, value: await signer.signTypedData(domain, types, message) };
    }

    case 'eth_sendTransaction': {
      const signer = requireSigner();
      // One validator for all three send paths (buildSendTx above): malformed
      // shape, a foreign `from`, the transaction's own chainId, `to`/`data`
      // format, field whitelist, BigInt conversions. The from/chain checks
      // used to be hand-written here; they are not any more, so a fix in one
      // path is a fix in all of them.
      const tx = buildSendTx(Array.isArray(params) ? params[0] : null, {
        activeAddress: signer.address || get('address') || '',
        chainId: currentChainId(),
      });
      // Not get('provider') straight from state: the id may already be switched
      // while the provider object is not, and a broadcast through the old one
      // lands on the wrong chain (see providerOnCurrentChain).
      const provider = await providerOnCurrentChain();
      const sent = await signer.connect(provider).sendTransaction(tx);
      return { done: true, value: sent.hash };
    }

    case 'wallet_switchEthereumChain':
      return { done: true, value: await switchTo(parseChainIdParam(params), activateNetwork) };

    case 'wallet_addEthereumChain': {
      const want = parseChainIdParam(params);
      // Known chain → switch to it (what dApps actually want — same as before).
      if (getNetwork(want)) {
        return { done: true, value: await switchTo(want, activateNetwork) };
      }
      // Unknown chain. The registry is still the only source of chain truth —
      // but EIP-3085 says the wallet may ASK, and as of 2026-10-15 it does
      // (user report: "add network gabisa" for a dApp on a new testnet). The
      // dApp's raw parameters never install themselves: sanitizeChainRequest
      // validates (https/loopback URL only, capped name, clamped currency),
      // the offerAddChain sheet shows the SANITIZED request with Cancel /
      // Confirm, and only an approved sheet reaches installRequestedChain
      // (probe: an RPC answering with a different chain id is refused).
      // No sheet available (headless caller) → 4902, exactly the old answer.
      // No sheet available (headless caller) → 4902, exactly the old answer.
      if (typeof offerAddChain !== 'function') {
        throw err(4902, `Bear Tool has no network with chain id ${want}. Add it in Settings → Networks, then ask again.`);
      }
      const san = sanitizeChainRequest(Array.isArray(params) ? params[0] : null);
      if (!san.ok) throw err(san.code || 32602, san.message);
      const approved = await offerAddChain({ net: san.net, origin });
      if (!approved) throw err(4001, 'The user refused wallet_addEthereumChain.');
      const ins = await installRequestedChain(san.net);
      if (!ins.ok) throw err(ins.code || 4902, ins.message);
      return { done: true, value: await switchTo(Number(ins.net.chainId), activateNetwork) };
    }

    case 'wallet_watchAsset': {
      const spec = Array.isArray(params) ? params[0] : null;
      if (!spec || spec.type !== 'ERC20') throw err(4200, 'Bear Tool watches ERC20 assets only.');
      const o = spec.options || {};
      if (typeof o.address !== 'string' || !ADDR_RE.test(o.address)) {
        throw err(32602, 'wallet_watchAsset needs options.address (0x…40 hex).');
      }
      if (typeof confirmAsset !== 'function') throw err(-32603, 'Confirmation UI unavailable.');
      // Confirmed EVERY call, with the token's own details — unlike the
      // grant-once permission prompts, because a dApp that may add one token
      // must not silently add a hundred.
      const ok = await confirmAsset({
        site: origin,
        symbol: o.symbol,
        decimals: o.decimals,
        address: o.address,
      });
      if (!ok) throw err(4001, 'The user refused wallet_watchAsset.');
      persistCustomToken({
        address: o.address,
        symbol: o.symbol || 'TOKEN',
        decimals: o.decimals,
        chainId: currentChainId(),
      });
      return { done: true, value: true };
    }

    default:
      return { done: false };
  }
}
