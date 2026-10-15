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
import { getNetwork, getNetworkById } from './network.js';

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
// user.
function signPayload(raw) {
  if (typeof raw === 'string' && raw.length % 2 === 0 && HEX_RE.test(raw)) return ethers.getBytes(raw);
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
 */
export async function executeLocal({ method, params = [], origin = '', activateNetwork, confirmAsset } = {}) {
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
      const inTx = Array.isArray(params) ? params[0] : null;
      if (!inTx || typeof inTx !== 'object') throw err(32602, 'eth_sendTransaction expects a transaction object.');
      // Not get('provider') straight from state: the id may already be switched
      // while the provider object is not, and a broadcast through the old one
      // lands on the wrong chain (see providerOnCurrentChain).
      const provider = await providerOnCurrentChain();
      if (inTx.from && String(inTx.from).toLowerCase() !== String(signer.address || get('address') || '').toLowerCase()) {
        throw err(4100, `The account ${inTx.from} is not the active account.`);
      }
      if (inTx.chainId != null) {
        const want = typeof inTx.chainId === 'string' ? parseInt(inTx.chainId, 16) : Number(inTx.chainId);
        if (Number.isFinite(want) && want !== currentChainId()) {
          throw err(4902, `The transaction targets chain ${want} but the wallet is on chain ${currentChainId()}.`);
        }
      }
      // Normalize the JSON-RPC shape to what ethers accepts. `from` is dropped:
      // the signer IS the account, and ethers refuses a mismatched from.
      const tx = {};
      for (const k of ['to', 'data', 'nonce', 'type', 'accessList']) if (inTx[k] != null) tx[k] = inTx[k];
      if (inTx.value != null) tx.value = BigInt(inTx.value);
      const gas = inTx.gasLimit ?? inTx.gas;
      if (gas != null) tx.gasLimit = BigInt(gas);
      for (const k of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
        if (inTx[k] != null) tx[k] = BigInt(inTx[k]);
      }
      const sent = await signer.connect(provider).sendTransaction(tx);
      return { done: true, value: sent.hash };
    }

    case 'wallet_switchEthereumChain':
      return { done: true, value: await switchTo(parseChainIdParam(params), activateNetwork) };

    case 'wallet_addEthereumChain':
      // EIP-3085 lets a wallet REFUSE a chain it does not know, and Bear Tool
      // does: the registry (Settings → Networks) is the only source of chain
      // truth here — a dApp-invented endpoint is how a wallet reads a fake
      // balance. Known chain → switch to it (what dApps actually want); 4902
      // otherwise, with the place to add it.
      return { done: true, value: await switchTo(parseChainIdParam(params), activateNetwork) };

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
