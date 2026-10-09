// js/native-dapp.js — wallet-side glue for the NATIVE dApp browser (Capacitor
// plugin BearDappBrowser). MetaMask Mobile does this in BrowserTab.tsx
// (onMessage → BackgroundBridge → engine; cloned 2026-10-09); we do it as:
// the dApp WebView posts JSON over @JavascriptInterface → the plugin emits
// 'rpcRequest' {id, origin, payload} here → the SAME consent dialogs
// (confirmTx) and the SAME signer (state 'signer') the WalletConnect path
// uses → plugin.resolve() carries the answer back into the dApp page via
// window.__bearNativeResolve.
//
// Security posture (mirrors walletconnect.js handleRequest):
// - origin is supplied by NATIVE code (WebView.getUrl()), never by the page;
// - eth_accounts stays empty until the user approved that origin here;
// - typed-data chain mismatch and sendTransaction chain mismatch are REFUSED,
//   not silently executed on the local chain;
// - locked wallet raises the unlock prompt and answers honestly.
import { confirmTx, toast } from './ui.js';
import { get, requireUnlock } from './state.js';
import { getNetworkById } from './network.js';
import { NATIVE_PROVIDER_SCRIPT } from './native-provider.js';

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };
const LOCKED = { code: 5100, message: 'Wallet is locked.' };
// Session-level consent, same semantics as an eth_accounts grant in a browser
// wallet: revisiting the site inside the app does not re-prompt, closing the
// app does.
const connectedOrigins = new Set();
let plugin = null;

export function isNativeDappBrowser() {
  try {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch { return false; }
}

function shortAddr(a) {
  const s = String(a || '');
  return s ? s.slice(0, 6) + '…' + s.slice(-4) : '?';
}

function hexToBytes(hex) {
  const s = String(hex || '');
  if (!/^0x[0-9a-fA-F]*$/.test(s)) return s;
  const body = s.slice(2);
  const bytes = new Uint8Array(body.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function ensurePlugin() {
  if (plugin) return plugin;
  const core = await import('@capacitor/core');
  plugin = core.registerPlugin('BearDappBrowser');
  return plugin;
}

/** Native mode: open the dApp as a full-page WebView (top-level navigation).
 *  TEMPORARY (diagnostic build): a silent catch hid the "not implemented"
 *  root cause behind a blank tap — every failure now surfaces verbatim. */
export async function openNativeDapp(url) {
  try {
    const p = await ensurePlugin();
    await p.open({ url, providerScript: NATIVE_PROVIDER_SCRIPT });
  } catch (e) {
    const msg = '[dApp] open failed: ' + (e && e.message ? e.message : String(e));
    console.error(msg, e);
    toast(msg, 'error');
    throw e;
  }
}

/** TEMPORARY diagnostic — remove once the "not implemented" root cause is
 *  pinned. One screenshot must carry the whole chain: which build is on the
 *  device, whether the bridge knows the plugin, and whether a native method
 *  actually answers. back() resolves unconditionally in the Java plugin, so a
 *  clean ping = the plugin is registered and callable. */
async function diagNativeDapp() {
  try {
    const c = window.Capacitor;
    const sha = (import.meta.env && import.meta.env.VITE_BUILD_SHA) || 'local';
    const known = !!(c && c.Plugins && c.Plugins.BearDappBrowser);
    const avail = typeof (c && c.isPluginAvailable) === 'function'
      ? String(c.isPluginAvailable('BearDappBrowser')) : 'n/a';
    let ping;
    try {
      const p = await ensurePlugin();
      const r = await Promise.race([
        p.back({}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout 2500ms')), 2500)),
      ]);
      ping = 'OK ' + JSON.stringify(r);
    } catch (e) {
      ping = 'ERR ' + (e && e.message ? e.message : String(e));
    }
    const line = `[dApp diag] build ${String(sha).slice(0, 8)} | cap=${!!c} `
      + `| Plugins.BearDappBrowser=${known} | isPluginAvailable=${avail} | ping.back=${ping}`;
    console.log(line);
    toast(line, ping.startsWith('OK') ? 'info' : 'error');
  } catch (e) {
    console.warn('[dApp diag] crashed:', e);
  }
}

/**
 * Boot the RPC listener. Returns true when running natively (Capacitor), false
 * on plain web — where the iframe browser stays in charge and this module is
 * dead weight the bundler can tree-shake around.
 */
export function initNativeDappRpc() {
  if (!isNativeDappBrowser()) return Promise.resolve(false);
  diagNativeDapp(); // TEMPORARY diagnostic build — see diagNativeDapp()
  return ensurePlugin()
    .then((p) => {
      p.addListener('rpcRequest', (ev) => {
        handleNativeRpc(ev).catch((e) => console.warn('[native-dapp]', e));
      });
      return true;
    })
    .catch(() => false);
}

async function handleNativeRpc({ id, origin, payload }) {
  if (!plugin) return;
  let msg = {};
  try { msg = JSON.parse(payload || '{}'); } catch { msg = {}; }
  const respond = (result) => plugin.resolve({ id, response: JSON.stringify({ result }) }).catch(() => { /* dApp view gone */ });
  const respondError = (error) => plugin.resolve({
    id,
    response: JSON.stringify({ error: { code: error && error.code != null ? error.code : -32603, message: (error && error.message) || String(error) } }),
  }).catch(() => { /* dApp view gone */ });

  const method = msg.method;
  const site = String(origin || 'this site');
  const chainId = 'eip155:' + (getNetworkById(get('networkId'))?.chainId || 1);

  // Read-only answers work even while locked.
  if (method === 'eth_chainId') {
    const n = getNetworkById(get('networkId'));
    return respond(n ? '0x' + Number(n.chainId).toString(16) : '0x1');
  }
  if (method === 'net_version') {
    const n = getNetworkById(get('networkId'));
    return respond(n ? String(n.chainId) : '1');
  }

  const signer = get('signer');
  if (method === 'eth_accounts') {
    return respond(connectedOrigins.has(site) && signer ? [signer.address] : []);
  }
  if (!signer) {
    requireUnlock();
    return respondError(LOCKED);
  }

  if (method === 'eth_requestAccounts') {
    const ok = await confirmTx({
      title: 'Connect "' + site + '" to Bear Tool?',
      rows: [
        { k: 'Site', v: site },
        { k: 'Account', v: shortAddr(signer.address) },
        { k: 'Can request', v: 'accounts, sign, send transactions' },
      ],
      confirmText: 'Connect',
    });
    if (!ok) return respondError(USER_REJECTED);
    connectedOrigins.add(site);
    return respond([signer.address]);
  }

  if (method === 'personal_sign') {
    const [hex] = msg.params || [];
    const ok = await confirmTx({
      title: 'Sign message?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Site', v: site },
        { k: 'Account', v: shortAddr(signer.address) },
        { k: 'Message', v: String(hexToBytes(hex)).slice(0, 80) },
      ],
      confirmText: 'Sign',
    });
    if (!ok) return respondError(USER_REJECTED);
    return respond(await signer.signMessage(hexToBytes(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    const raw = (msg.params || [])[1];
    let parsed = {};
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { parsed = {}; }
    const domain = parsed.domain || {};
    // Same refusal as the WalletConnect path: a signature is only valid for
    // its domain's chain — never sign one that does not match the wallet.
    const domChain = Number(domain.chainId);
    const localNet = getNetworkById(get('networkId'));
    if (Number.isFinite(domChain) && localNet && Number(localNet.chainId) !== domChain) {
      const m = `This signature targets chain ${domChain}, but Bear Tool is on ${localNet.name} (chain ${localNet.chainId}). Switch network first — nothing was signed.`;
      toast(m, 'error');
      return respondError({ code: -32000, message: m });
    }
    const ok = await confirmTx({
      title: 'Sign typed data?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Domain', v: String(domain.name || '?') + (domain.version ? ' v' + domain.version : '') },
        { k: 'Primary type', v: String(parsed.primaryType || '?') },
        { k: 'Site', v: site },
        { k: 'Account', v: shortAddr(signer.address) },
      ],
      confirmText: 'Confirm',
    });
    if (!ok) return respondError(USER_REJECTED);
    const types = { ...(parsed.types || {}) };
    delete types.EIP712Domain;
    return respond(await signer.signTypedData(domain, types, parsed.message || {}));
  }

  if (method === 'eth_sendTransaction') {
    const localNet = getNetworkById(get('networkId'));
    const txReq = (msg.params || [])[0] || {};
    const reqChain = Number(txReq.chainId);
    if (Number.isFinite(reqChain) && localNet && Number(localNet.chainId) !== reqChain) {
      const m = `This dApp asked for chain ${reqChain}, but Bear Tool is on ${localNet.name} (chain ${localNet.chainId}). Switch network in Bear Tool and ask again — nothing was sent.`;
      toast(m, 'error');
      return respondError({ code: -32000, message: m });
    }
    const provider = get('provider');
    if (!provider) return respondError({ code: -32000, message: 'No provider for the current network.' });
    const ok = await confirmTx({
      title: 'Send transaction?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Site', v: site },
        { k: 'To', v: shortAddr(txReq.to || '') },
        { k: 'Value', v: String(txReq.value || '0x0') },
        { k: 'Data', v: txReq.data && txReq.data !== '0x' ? (String(txReq.data).length / 2 - 1) + ' bytes' : 'none' },
      ],
      confirmText: 'Confirm',
    });
    if (!ok) return respondError(USER_REJECTED);
    // Keystore signers are plain ethers.Wallet instances with NO provider —
    // broadcasting without .connect(provider) dies with "missing provider"
    // (the exact bug tests/send-resilience.test.js exists to catch).
    const tx = await signer.connect(provider).sendTransaction({
      to: txReq.to || undefined,
      value: txReq.value ? BigInt(txReq.value) : undefined,
      data: txReq.data || undefined,
    });
    return respond(tx.hash);
  }

  if (method === 'wallet_switchEthereumChain') {
    const want = Number((msg.params || [])[0]?.chainId);
    const localNet = getNetworkById(get('networkId'));
    if (Number.isFinite(want) && localNet && Number(localNet.chainId) === want) return respond(null);
    const m = 'Switch the network inside Bear Tool, then ask the dApp again.';
    return respondError({ code: 4902, message: m });
  }

  return respondError({ code: 4200, message: method + ' is not supported by the native dApp browser yet.' });
}
