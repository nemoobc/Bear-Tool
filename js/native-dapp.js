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
import { confirmTx, toast, setModalVisibilityHook } from './ui.js';
import { get, requireUnlock, on } from './state.js';
import { getNetworkById, getNetwork } from './network.js';
import { NATIVE_PROVIDER_SCRIPT } from './native-provider.js';

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };
const LOCKED = { code: 5100, message: 'Wallet is locked.' };
// Read-only methods answered WITHOUT a prompt, straight to the wallet's own
// network provider — the same policy the WalletConnect path has for
// WC_READ_METHODS (MetaMask forwards these to the active node too; a dApp
// that reads balances/calls with window.ethereum must work, not get 4200).
// Only READ methods land here; everything that can sign or spend keeps the
// explicit branch above, and an unknown method still falls through to 4200.
const NATIVE_READ_METHODS = new Set([
  'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas',
  'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
  'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getLogs', 'eth_syncing', 'eth_getProof',
]);
// Bound the time a page can hold a native thread waiting on its RPC: the
// wallet's own provider has timeouts, but a hostile page must not be able to
// pin the bridge open indefinitely (deadline rejects — no silent hang).
const READ_DEADLINE_MS = 20000;
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

// The wallet OWNS the network list; the native toolbar only shows what the
// wallet tells it. label = a compact symbol ("ETH", "BNB") for the ◆ chip,
// chainId = the hex the dApp's chainChanged event carries.
function chainHex(chainId) {
  const n = Number(chainId);
  return Number.isFinite(n) && n > 0 ? '0x' + n.toString(16) : '';
}

/** Push the wallet's active chain to the native toolbar. The plugin updates
 *  its ◆ chip and fires EIP-1193 chainChanged into every open dApp tab. */
export async function syncNativeChain() {
  if (!plugin) return;
  const n = getNetworkById(get('networkId'));
  if (!n) return;
  try {
    await plugin.setChain({ chainId: chainHex(n.chainId), label: String(n.symbol || n.name || '') });
  } catch { /* the dapp view may be gone — nothing to update */ }
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

// The plugin object MUST be wrapped before it can cross any await/then
// boundary. Capacitor v8's plugin proxy answers GET 'then' with a native
// method wrapper; calling it fires an internal native call that rejects as
// ITS OWN promise and never invokes the resolve/reject it was handed — so
// `await proxy` / `return proxy` from an async function hangs FOREVER and
// leaks one "BearDappBrowser.then() is not implemented" unhandled rejection.
// Proven on a real Android runtime (CI emulator run 38012047691, 2026-10-10):
// both boot-time adoption sites (diag ping, rpc init) hung, the rpc listener
// never attached and open() never fired — the blank "not implemented" bug the
// user reported. The proxy below makes 'then' read as undefined, so the value
// is simply not thenable: awaits resolve with it, methods pass through.
let pluginPromise = null;
async function ensurePlugin() {
  if (plugin) return plugin;
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/core').then((core) => {
      const raw = core.registerPlugin('BearDappBrowser');
      plugin = new Proxy(raw, {
        get(t, k) {
          return k === 'then' ? undefined : Reflect.get(t, k);
        },
      });
      return plugin;
    });
  }
  return pluginPromise; // real promise — single flight, no double registration
}

/** Native mode: open the dApp as a full-page WebView (top-level navigation).
 *  Failures surface verbatim (console + toast): a silent catch once hid the
 *  "not implemented" root cause (the proxy-'then' hang) behind a blank tap.
 *
 *  Scheme guard, wallet-side mirror of the Java gate in open(): the dApp
 *  browser is for http/https — anything else (javascript:, data:, file:,
 *  wc:) is refused here with an immediate toast instead of an error page or
 *  worse, script execution inside the view. The Java open() rejects the same
 *  shapes too; this layer just fails fast, before the plugin round-trip. */
export async function openNativeDapp(url) {
  try {
    const trimmed = String(url || '').trim();
    // NOTE: NO regex literal here. A `https?:\/\/` pattern contains two
    // adjacent slashes at the escape boundary, and scope.test.js's comment
    // stripper cuts the line there — the parser then misreads braces and
    // reports "trimmed used outside its block" (a false positive from ~2026
    // on). startsWith mirrors the Java gate exactly and stays stripper-safe.
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      const scheme = (trimmed.match(/^([a-z]+):/i) || [])[1] || 'none';
      const msg = 'unsupported scheme "' + scheme + '" — the dApp browser opens http/https URLs only';
      toast(msg, 'error');
      throw new Error(msg);
    }
    const p = await ensurePlugin();
    await p.open({ url: trimmed, providerScript: NATIVE_PROVIDER_SCRIPT });
    // Show the wallet's current chain on the fresh toolbar right away.
    syncNativeChain();
  } catch (e) {
    const msg = '[dApp] open failed: ' + (e && e.message ? e.message : String(e));
    console.error(msg, e);
    toast(msg, 'error');
    throw e;
  }
}


/**
 * Wallet DApps page → native: the browser's live tab list, or null when there
 * is no session (or we are on plain web). The wallet surfaces this as its own
 * "Tabs" entry, so a browser that was hidden — but still holds open tabs — is
 * reachable without going back through a dApp card (user report 2026-10-11:
 * "diluar daaps ga ada tabs").
 */
export async function nativeTabs() {
  if (!isNativeDappBrowser()) return null;
  try {
    const p = await ensurePlugin();
    const r = await p.getTabs();
    return r && r.open && Array.isArray(r.tabs) ? r : null;
  } catch { return null; }   // older build without getTabs — no entry, no crash
}

/** Wallet DApps page → native: reopen the in-app browser on tab <index>. */
export async function openNativeTab(index) {
  try {
    const p = await ensurePlugin();
    await p.selectTab({ index: Number(index) || 0 });
    return true;
  } catch { return false; }
}

/**
 * Boot the RPC listener. Returns true when running natively (Capacitor), false
 * on plain web — where the iframe browser stays in charge and this module is
 * dead weight the bundler can tree-shake around.
 */
export function initNativeDappRpc() {
  if (!isNativeDappBrowser()) return Promise.resolve(false);
  return ensurePlugin()
    .then((p) => {
      // Every wallet modal this webview draws must be SEEN. ui.js reports each
      // openModal/closeModal through this hook; with the native browser up, the
      // sheet would otherwise render underneath it (invisible, unclickable) —
      // exactly what a `wc:` deep link used to do. Registered before any sheet
      // can open, and idempotent (see applyBrowserVisibility).
      setModalVisibilityHook((open) => {
        modalOpen = !!open;
        applyBrowserVisibility();
      });
      p.addListener('rpcRequest', (ev) => {
        handleNativeRpc(ev).catch((e) => console.warn('[native-dapp]', e));
      });
      // The native ◆ chip asks the wallet to run its own Networks picker. One
      // listener, one boot — a second initNativeDappRpc() must not double-bind.
      p.addListener('walletCommand', (ev) => {
        handleWalletCommand(ev).catch((e) => console.warn('[native-dapp]', e));
      });
      // The wallet's chain is the single source of truth: whenever it moves
      // (picker row, bridge source, a dApp's switch request) push it to the
      // native toolbar, which fans chainChanged out to every open tab.
      on('networkId', () => { syncNativeChain(); });
      return true;
    })
    .catch(() => false);
}

/** Native toolbar/menu → wallet commands. */
async function handleWalletCommand(ev) {
  const cmd = ev && ev.command;
  if (cmd === 'toggleBookmark') {
    // The ⋯ menu's star. The bookmark LIST is the wallet's, so a command with
    // no handler here would leave a button that silently does nothing.
    try {
      const bm = await import('./dapp-browser.js');
      if (typeof bm.toggleBookmarkFor === 'function') bm.toggleBookmarkFor(ev.url);
      else toast('Bookmarks are not ready yet.', 'error');
    } catch { toast('Bookmarks are not ready yet.', 'error'); }
    return;
  }
  if (cmd === 'openActivity') {
    // The ⋯ menu's "Transaction history": the wallet owns the history.
    try {
      const { switchView } = await import('./app.js');
      switchView('activity');
    } catch { /* activity view unavailable */ }
    return;
  }
  if (cmd !== 'openNetworkPicker') return;
  // The wallet's modal renders in the WALLET's webview, which the full-screen
  // dApp overlay covers — so hide the dapp around it (askUser here, plus the
  // ui.js modal hook) and restore it once the modal is dismissed.
  await askUser(async () => {
    const { showNetworkModal } = await import('./app.js');
    await new Promise((resolve) => {
      // The wallet modal mounts into the single #modalOverlay node: ui.js
      // openModal adds class "open", closeModal removes it. Body's "modal-open"
      // class is only ever REMOVED in this codebase (never added), so a body
      // mutation NEVER fired and the dapp overlay stayed hidden for the full
      // 120s ceiling after the picker closed. Watch the overlay's own class.
      const overlay = document.getElementById('modalOverlay');
      const isOpen = () => !!(overlay && overlay.classList.contains('open'));
      let obs = null;
      const finish = () => { try { if (obs) obs.disconnect(); } catch { /* already off */ } clearTimeout(timer); resolve(); };
      obs = new MutationObserver(() => { if (!isOpen()) finish(); });
      if (overlay) obs.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      const timer = setTimeout(finish, 120000); // a modal left open forever must not hang the overlay
      try { showNetworkModal(); } catch { finish(); }
      // showNetworkModal() opens the overlay synchronously; if it did not (or
      // the overlay node is missing), resolve now instead of waiting on a
      // mutation that will never come.
      if (!isOpen()) finish();
    });
  });
}

// Flash to the wallet while a confirmation is up: confirmTx renders in the
// WALLET's webview, and the native dapp view covers the whole screen — a
// prompt drawn underneath that overlay is invisible and unclickable, so every
// confirmation-bound RPC (connect, sign, send) would hang forever on a tap
// nobody can make.
//
// Two independent reasons to move the browser aside, one output:
//   confirmCount — dapp RPC confirmations in flight (askUser, below);
//   modalOpen    — ANY wallet modal on screen, reported by ui.js's hook. The
//                  ◆ network picker predates the hook and wraps askUser; the
//                  WC pair sheet reached by a `wc:` deep link (or the ?wc= web
//                  link) never did — the user tapped "Bear Tool" in a browser
//                  and got the dApp in front of an invisible pairing sheet.
// Idempotent by STATE, not by count: openModal can fire again while a sheet is
// already up (pair sheet → unlock prompt) and a counter would drift, leaving
// the browser hidden for good. No dapp open → the plugin's setVisible is a
// no-op, so plain wallet modals pass straight through.
let confirmCount = 0;
let modalOpen = false;
let browserAside = false;
async function applyBrowserVisibility() {
  const p = plugin;
  if (!p) return;
  const aside = modalOpen || confirmCount > 0;
  if (aside === browserAside) return;
  browserAside = aside;
  try { await p.setVisible({ visible: !aside }); } catch { /* view never opened */ }
}

async function askUser(fn) {
  confirmCount += 1;
  await applyBrowserVisibility();
  try {
    return await fn();
  } finally {
    confirmCount -= 1;
    await applyBrowserVisibility();
  }
}

/**
 * Consent prompt for the native browser. Prefers the plugin's OWN confirm sheet
 * (draws above the dApp — the page never leaves the screen, OKX/MetaMask
 * parity); falls back to the wallet modal on web or on a build whose plugin
 * predates confirm(). Same rows contract as confirmTx.
 */
async function askConfirm({ title, rows, confirmText }) {
  const p = plugin;
  if (p) {
    try {
      const safe = (rows || []).map((r) => ({ k: String(r.k), v: String(r.v) }));
      const r = await p.confirm({ title, rows: safe, confirmText: confirmText || 'Confirm' });
      if (r && typeof r.ok === 'boolean') return r.ok;
    } catch { /* no native sheet on this build — fall through to the wallet modal */ }
  }
  return askUser(() => confirmTx({ title, rows, confirmText }));
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
    const ok = await askConfirm({
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
    const ok = await askConfirm({
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
    const ok = await askConfirm({
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
    const ok = await askConfirm({
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
    // A chain the wallet already knows: switch to it (MetaMask parity — no
    // prompt for a known chain) through the ONE chokepoint activateNetwork,
    // which fires the wallet's chainChanged AND, via on('networkId'), the
    // native fan-out to every open tab. Unknown chain → 4902, as before.
    const target = Number.isFinite(want) ? getNetwork(want) : null;
    if (target) {
      try {
        const { activateNetwork } = await import('./app.js');
        activateNetwork(target.id);
        return respond(null);
      } catch (e) {
        return respondError({ code: 4902, message: (e && e.message) || 'Switch failed.' });
      }
    }
    const m = 'Switch the network inside Bear Tool, then ask the dApp again.';
    return respondError({ code: 4902, message: m });
  }

  // Read-only methods: answered straight from the wallet's own provider —
  // no prompt, no account exposure, caller-safe (a dApp can already read
  // balances and state on any public RPC it chooses; this just makes the
  // injected provider as useful as MetaMask's). Errors pass through with
  // the node's own message so a dApp can distinguish e.g. insufficient
  // funds from a dead RPC.
  if (NATIVE_READ_METHODS.has(method)) {
    const provider = get('provider');
    if (!provider) return respondError({ code: 4900, message: 'No connected network provider.' });
    let result;
    try {
      result = await Promise.race([
        provider.send(method, msg.params || []),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC read timed out')), READ_DEADLINE_MS)),
      ]);
    } catch (e) {
      return respondError({ code: (e && e.code) || -32003, message: (e && e.message) || String(e) });
    }
    return respond(result);
  }

  return respondError({ code: 4200, message: method + ' is not supported by the native dApp browser yet.' });
}

// E2E hook (pinned by tests/emulator-e2e.test.js): the native build has no
// address bar yet — openDappBrowser()'s native branch opens catalogue cards
// only — so the emulator driver needs the same power a card tap has: open
// THIS url in the dapp browser. Same authority as tapping a card; no wallet
// state, native-only (plain web keeps the iframe browser in charge).
if (typeof window !== 'undefined') {
  window.__bearE2EOpenDapp = (url) => (isNativeDappBrowser()
    ? openNativeDapp(url)
    : Promise.reject(new Error('dapp browser hook is native-only')));
}
