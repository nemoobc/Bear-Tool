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

/** The chain this wallet is ON, as a number. Never NaN. */
export function currentChainId() {
  const n = Number(getNetworkById(get('networkId'))?.chainId);
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

// personal_sign messages are hex-encoded bytes per spec; anything else is the
// literal string the dApp wants signed. A plain string signed by ethers is
// utf8-encoded, so hex MUST be converted to bytes first — signing the literal
// characters "0x6865…" would be a different message than the dApp showed the
// user.
function signPayload(raw) {
  if (typeof raw === 'string' && raw.length % 2 === 0 && HEX_RE.test(raw)) return ethers.getBytes(raw);
  return raw;
}

function parseTyped(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { throw err(32602, 'Invalid typed data JSON: ' + e.message); }
  }
  if (!data || typeof data !== 'object') throw err(32602, 'Invalid typed data payload.');
  return data;
}

function typedParts(data) {
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
      const { message: raw, address } = splitSignParams(params);
      requireAddressMatch(address);
      if (raw == null) throw err(32602, 'Expected [typedData, address].');
      const { domain, types, message } = typedParts(parseTyped(raw));
      return { done: true, value: await signer.signTypedData(domain, types, message) };
    }

    case 'eth_sendTransaction': {
      const signer = requireSigner();
      const inTx = Array.isArray(params) ? params[0] : null;
      if (!inTx || typeof inTx !== 'object') throw err(32602, 'eth_sendTransaction expects a transaction object.');
      const provider = get('provider');
      if (!provider) throw err(-32603, 'No RPC provider — pick a network and try again.');
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
