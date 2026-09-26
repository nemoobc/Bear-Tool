// ═══════════════════════════════════════════════════════════════
// dapp-bridge.js — window.ethereum for pages served by the wallet itself.
//
// THE LIMIT, STATED PLAINLY, because getting this wrong is the difference
// between a real feature and a decoration:
//
//   A cross-origin dApp inside an iframe can never see this object. The browser
//   sandbox does not let a parent page reach into a child document, and no
//   amount of JavaScript changes that. Every wallet whose dApp browser really
//   injects a provider — MetaMask, OKX, Trust, Rabby — is a native app holding
//   a WebView it controls, or a browser extension. A static web page is neither.
//
//   So this bridge covers exactly the cases that are real from here:
//     - a dApp served from the wallet's own origin (a local build, a test page)
//     - pages the user runs alongside the wallet
//   and the UI in Settings says so rather than letting anyone believe otherwise.
//
// What it does do is do it properly: per-origin consent, a method allow-list,
// no claim to be MetaMask, and nothing answered while the wallet is locked.
// ═══════════════════════════════════════════════════════════════

import { isAllowedMethod, needsConfirmation } from './security.js';
import { siteAllowed, addSite, removeSite, hasPermission, grantPermission } from './dapp-sessions.js';

export const PROVIDER_FLAG = '__bearToolProvider';

export function makeProviderError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Build the EIP-1193 provider.
 * @param {object} cfg
 * @param {() => string|null} cfg.getAddress
 * @param {() => boolean}      cfg.isUnlocked
 * @param {() => number}       cfg.getChainId
 * @param {(req:object) => Promise<any>} cfg.onRequest  handles the confirmed
 *        calls: consent prompts, signing, sending. The bridge never signs
 *        anything itself, it only decides what may be asked for.
 * @param {string} cfg.origin
 */
export function createProvider(cfg) {
  const listeners = { accountsChanged: new Set(), chainChanged: new Set(), connect: new Set(), disconnect: new Set() };
  const on = (ev, fn) => { listeners[ev]?.add(fn); return () => listeners[ev]?.delete(fn); };
  const emit = (ev, arg) => { for (const fn of listeners[ev] || []) { try { fn(arg); } catch { /* a bad listener is not a reason to fail */ } } };

  const origin = (cfg.origin || '').toLowerCase();
  const approved = () => siteAllowed(origin);

  async function request({ method, params = [] } = {}) {
    // 1. Allow-list first. An unknown method is refused without a prompt, so a
    //    page cannot use an unlisted call as an oracle.
    if (!isAllowedMethod(method)) {
      throw makeProviderError(4200, `Bear Tool does not expose "${method}".`);
    }

    // 2. Nothing is answered while the wallet is locked. Not balances, not the
    //    chain id from this provider — a locked wallet is not a public RPC.
    if (!cfg.isUnlocked?.()) {
      throw makeProviderError(4100, 'The wallet is locked. Unlock it to continue.');
    }

    // 3. A page with no grant gets nothing that matters.
    const allowed = approved();

    if (method === 'eth_accounts') {
      // EIP-1193: an unconnected wallet answers with an empty array, not an
      // error. Pages poll this to decide whether to show a Connect button.
      return approved() && cfg.getAddress?.() ? [cfg.getAddress()] : [];
    }

    if (method === 'eth_requestAccounts') {
      if (!allowed) {
        // Consent is the wallet's decision, not the page's. The callback asks
        // the user and returns their answer; the grant itself is recorded HERE,
        // after that answer — checking for a session before writing one can
        // only ever fail.
        const granted = await cfg.onRequest?.({ method, params, kind: 'consent', origin });
        if (!granted) throw makeProviderError(4001, 'The user rejected the connection request.');
        addSite(origin, { name: origin });
        if (!siteAllowed(origin)) {
          throw makeProviderError(4001, 'The connection could not be recorded, so it stays refused.');
        }
        emit('connect', { provider: this });
      }
      return [cfg.getAddress?.()].filter(Boolean);
    }

    // The chain id is a fact about this wallet, not something to ask a signer
    // about, and answering it locally keeps the locked-wallet refusal above as
    // the only thing standing between a page and the network details.
    if (method === 'eth_chainId' || method === 'net_version') {
      const id = Number(cfg.getChainId?.() ?? 1);
      return method === 'eth_chainId' ? '0x' + id.toString(16) : String(id);
    }

    if (!allowed) {
      throw makeProviderError(4100, `${origin} is not connected. Call eth_requestAccounts first.`);
    }

    // 4. State-changing calls need an explicit per-method grant on top of the
    //    site grant, so "connected" is not the same as "may spend".
    if (needsConfirmation(method) && !hasPermission(origin, method)) {
      const granted = await cfg.onRequest?.({ method, params, kind: 'permission', origin });
      if (!granted) throw makeProviderError(4001, `The user refused ${method} for ${origin}.`);
      grantPermission(origin, method);
    }

    return cfg.onRequest?.({ method, params, kind: 'call', origin });
  }

  return {
    isBearTool: true,
    // Deliberately NOT claiming to be MetaMask. A page that feature-detects
    // window.ethereum and then branches on isMetaMask must be told the truth,
    // and there are far more wallets than one honest name.
    isMetaMask: false,
    isCoinbaseWallet: false,
    isRabby: false,
    request,
    // Legacy aliases some pages still call. Same gate, same allow-list.
    sendAsync(payload, cb) {
      request(payload).then((r) => cb(null, { id: payload.id, jsonrpc: '2.0', result: r }),
        (e) => cb(e, null));
    },
    enable() { return request({ method: 'eth_requestAccounts' }); },
    on,
    removeListener(ev, fn) { listeners[ev]?.delete(fn); },
    _origin: origin,
    _emit: emit,
  };
}

/** Tell connected pages that the wallet locked. */
export function announceLock(provider) {
  try { provider?._emit?.('accountsChanged', []); } catch { /* ignore */ }
}

export function announceAccounts(provider, address) {
  try { provider?._emit?.('accountsChanged', address ? [address] : []); } catch { /* ignore */ }
}

/** Revoke one origin and tell it. */
export function disconnectOrigin(provider, origin) {
  removeSite(origin);
  announceAccounts(provider, null);
}
