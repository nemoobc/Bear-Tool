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
import { renderSignMessage } from './sign-render.js';
import { t } from './i18n.js';
import { get, requireUnlock, on } from './state.js';
import { getNetworkById, getNetwork } from './network.js';
import { NATIVE_PROVIDER_SCRIPT } from './native-provider.js';
// One source of truth for what a signature request MEANS: the injected path
// (dapp-exec.js) already splits both param orders, validates typed data, and
// guards the chain a broadcast goes out on. This path re-implemented each by
// hand and got them wrong — see the personal_sign / typed-data branches below.
import { splitSignParams, parseTyped, typedParts, providerOnCurrentChain } from './dapp-exec.js';

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
// A connection is a per-ORIGIN grant (MetaMask semantics), never per-page:
// approving "https://example.com/swap" must silently cover
// "https://example.com/account" without re-prompting. Keying the consent on
// the full URL of the page that asked made every in-page navigation return
// 4100 ("not connected — call eth_requestAccounts first"), which made every
// real dApp think the wallet had vanished. The grant is recorded against
// the origin; everything else (UI text, sheet title) stays useful by
// falling back to the raw value when URL parsing fails.
function originOf(raw) {
  try { return new URL(raw).origin; } catch { return String(raw || 'this site'); }
}

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
 *  its ◆ chip and fires EIP-1193 chainChanged into every open dApp tab.
 *
 *  On a non-EVM network (BTC/SOL/XRP) chainHex() is '' and the plugin's
 *  `0x[0-9a-fA-F]+` guard then fires NO chainChanged at all — deliberate. There
 *  is no EVM chain to announce, and announcing the previous one (or a made-up
 *  '0x1') is the silent-chain-substitution this wallet refuses everywhere else.
 *  The chip still follows the wallet ("BTC"); a dApp that asks eth_chainId gets
 *  the named 4901 refusal from handleRequest. */
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

// wei (hex 0x… or decimal string) → "0.123 native". Pure BigInt, no ethers
// import (native-dapp.js stays lean); an unparseable value falls back to the
// raw string so the user still sees the number the dApp sent, never a blank.
function formatWeiNative(wei) {
  if (wei == null || wei === '' || wei === '0x' ) return '0';
  try {
    const w = BigInt(wei);
    if (w === 0n) return '0';
    const whole = w / 10n ** 18n;
    const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return (frac ? `${whole}.${frac}` : `${whole}`) + ' native';
  } catch { return String(wei).slice(0, 40); }
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
        get(tgt, k) {
          return k === 'then' ? undefined : Reflect.get(tgt, k);
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
        handleNativeRpc(ev).catch((e) => {
          console.warn('[native-dapp]', e);
          // Every request MUST end in an answer. respond()/respondError() are
          // only reached on the success paths of handleNativeRpc, and both
          // swallow their own transport errors — so a throw after the prompt
          // (insufficient funds, a gas estimate that reverts, a stale nonce, a
          // malformed payload) used to die right here: the page's promise never
          // settled and the dApp spun on "signing…" forever, with no error for
          // its retry logic to see. The WalletConnect path already guarantees
          // exactly this answer (walletconnect.js session_request catch); this
          // is the same guarantee for the native path. Because a responder can
          // only have been SKIPPED — never completed — when we get here, this
          // is the missing answer, not a second one.
          try {
            plugin?.resolve(nativeErrorPayload(ev.id, e)).catch(() => { /* dApp view gone */ });
          } catch { /* the view is already gone — nothing left to answer */ }
        });
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
// Flatten an EIP-712 payload into "Field: value" lines the confirmation sheet can
// show. The sheet used to display only the type name — "Mail", "Permit",
// "Order" — which says nothing about WHAT is being authorised: the site picks
// that name, and a payload that moves tokens can call itself "Mail". The person
// signing had nothing to compare it against. Nested structs and arrays are read
// one level deep and mark what they truncate, because a value that cannot be
// shown must not vanish silently.
export function typedDataFields(message, depth = 0) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const out = [];
  for (const [k, v] of Object.entries(message)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const head = v.slice(0, 3).map((x) => (typeof x === 'object' && x !== null ? '{…}' : String(x))).join(', ');
      out.push({ k, v: `[${v.length}] ${head}${v.length > 3 ? '…' : ''}` });
    } else if (typeof v === 'object') {
      const keys = Object.keys(v);
      out.push({
        k,
        v: depth
          ? `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`
          : typedDataFields(v, depth + 1).map((f) => `${f.k}: ${f.v}`).join(' · ') || '{…}',
      });
    } else {
      out.push({ k, v: String(v) });
    }
  }
  return out;
}

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

// The wire shape of a REFUSAL, in exactly one place. The per-request responder
// inside handleNativeRpc builds it, and the listener's last-resort catch below
// builds it too — a response shape written twice is a shape that drifts, and
// the two would then disagree about the very code the dApp keys its retry logic
// on. code defaults to -32603 (internal) the same way respondError always did.
function nativeErrorPayload(id, error) {
  return {
    id,
    response: JSON.stringify({
      error: {
        code: error && error.code != null ? error.code : -32603,
        message: (error && error.message) || String(error),
      },
    }),
  };
}

async function handleNativeRpc({ id, origin, payload }) {
  if (!plugin) return;
  let msg = {};
  try { msg = JSON.parse(payload || '{}'); } catch { msg = {}; }
  const respond = (result) => plugin.resolve({ id, response: JSON.stringify({ result }) }).catch(() => { /* dApp view gone */ });
  const respondError = (error) => plugin.resolve(nativeErrorPayload(id, error)).catch(() => { /* dApp view gone */ });

  const method = msg.method;
  const site = originOf(origin);
  // BTC/SOL/XRP are pickable networks now (2026-10-11) and have NO EVM chain id.
  // `Number(n.chainId)` on one of those is 0, so the old answers were '0x0' and
  // 'null' — a corrupted chain id, not even the '1' fallback. The session label
  // must not claim eip155:1 either: a native dApp page told "chain 1" builds
  // mainnet transactions this wallet cannot sign. Named refusal instead, same
  // code (4901) as dapp-exec/walletconnect, so every path tells one story.
  const activeNet = getNetworkById(get('networkId'));
  const chainId = 'eip155:' + Number(activeNet?.chainId || 1);

  // Read-only answers work even while locked.
  if (method === 'eth_chainId' || method === 'net_version') {
        return respond(method === 'eth_chainId'
      ? '0x' + Number(activeNet.chainId).toString(16)
      : String(activeNet.chainId));
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
      title: t('site.connectTitle', { site }),
      // One row per capability, each saying what it MEANS, instead of a single
      // CSV line. The old line read "accounts, sign, send transactions" — three
      // different consequences sharing one visual weight, with the irreversible
      // one (moving money) last and unremarked. It was also static text: it
      // described what the wallet can do in general, not anything this site
      // asked for, so it could not inform a decision however it was worded.
      // This says what the site may ask, and names the one that cannot be undone.
      rows: [
        { k: t('site.site'), v: site },
        { k: t('site.account'), v: shortAddr(signer.address) },
        { k: t('site.canSee'), v: t('site.canSeeValue') },
        { k: t('site.canSign'), v: t('site.canSignValue') },
        { k: t('site.canSend'), v: t('site.canSendValue') },
      ],
      confirmText: t('site.connect'),
    });
    if (!ok) return respondError(USER_REJECTED);
    connectedOrigins.add(site);
    return respond([signer.address]);
  }

  // The consent this file's header advertises was enforced in exactly one place:
  // eth_accounts. personal_sign, eth_signTypedData_v4 and eth_sendTransaction
  // all prompted and signed unconditionally, so any page in the WebView could
  // obtain a signature — or spend — without ever having been connected. The
  // injected path has always gated on the same check (dapp-bridge.js).
  // Reads are not secrets. eth_chainId and net_version were already
  // answered for unconnected pages (line above, before the gate) because
  // exposure of chain state never threatens the wallet — and a page could
  // discover each of these itself by pointing an HTTP client at any node.
  // The same holds for every method in NATIVE_READ_METHODS, which only
  // returns what the wallet's own node returns: the connection gate must
  // protect SIGNING and SPENDING, never reads, or every disconnected dApp
  // gets 4100 while pretending to verify the wallet's network.
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

  if (!connectedOrigins.has(site)) {
    // 4100 is the standard "unauthorized" code, which is what a dApp checks to
    // decide it must call eth_requestAccounts first.
    return respondError({ code: 4100, message: `${site} is not connected. Call eth_requestAccounts first.` });
  }

  if (method === 'personal_sign') {
    // BOTH orders — [message, address] is the spec, [address, message] is the
    // legacy one real dApps still send, and splitSignParams is the function
    // that already knows both (dapp-exec.js, used by the injected signer).
    // Taking params[0] blindly meant the legacy order put the requester's
    // ADDRESS on screen as "the message" and then signed those 20 bytes: the
    // user approved content they could never read, and the dApp's login check
    // verified over the wrong payload. Display and signature now cover the
    // same, correct string.
    const { message: hex } = splitSignParams(msg.params || []);
    if (hex == null) return respondError({ code: 32602, message: 'personal_sign expects [message, address].' });
    const ok = await askConfirm({
      title: t('sign.title'),
      rows: [
        { k: t('site.chain'), v: chainId },
        { k: t('site.site'), v: site },
        { k: t('site.account'), v: shortAddr(signer.address) },
        { k: t('site.message'), v: renderSignMessage(hex) },
      ],
      confirmText: t('sign.action'),
    });
    if (!ok) return respondError(USER_REJECTED);
    return respond(await signer.signMessage(hexToBytes(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    // BOTH param orders, exactly as personal_sign above: the legacy
    // [typedData, address] puts the ADDRESS in params[1] — which is precisely
    // where this branch used to look.
    const { message: raw } = splitSignParams(msg.params || []);
    if (raw == null) return respondError({ code: 32602, message: 'Expected [typedData, address].' });
    // parseTyped/typedParts THROW 32602 on a payload that cannot be signed —
    // that is their entire job. The local try/catch they replace turned every
    // failure into {}: the chain guard then saw no chainId (so refused
    // nothing), the dialog showed all-"?" rows, and the wallet went on to SIGN
    // EMPTY DATA. A dApp sending something unparseable received a useless
    // signature instead of the 32602 it can correct and retry on. Same two
    // functions the injected signer uses, so every path accepts and refuses
    // identical payloads.
    let parsed, domain, types, message;
    try {
      parsed = parseTyped(raw);
      ({ domain, types, message } = typedParts(parsed));
    } catch (e) {
      return respondError({ code: (e && e.code) || 32602, message: (e && e.message) || String(e) });
    }
    // Same refusal as the WalletConnect path: a signature is only valid for
    // its domain's chain — never sign one that does not match the wallet.
    const domChain = Number(domain.chainId);
    const localNet = getNetworkById(get('networkId'));
    if (Number.isFinite(domChain) && localNet && Number(localNet.chainId) !== domChain) {
      const m = `This signature targets chain ${domChain}, but Bear Tool is on ${`${localNet.name} (chain ${localNet.chainId})`}. Switch network first — nothing was signed.`;
      toast(m, 'error');
      return respondError({ code: -32000, message: m });
    }
    const ok = await askConfirm({
      title: t('sign.typedTitle'),
      rows: [
        { k: t('site.chain'), v: chainId },
        { k: t('site.domain'), v: String(domain.name || '?') + (domain.version ? ' v' + domain.version : '') },
        { k: t('site.primaryType'), v: String(parsed.primaryType || '?') },
        // The fields themselves, not just the type name: that name is chosen by
        // the site, and can be called anything.
        ...typedDataFields(message).slice(0, 8).map((f) => ({ k: f.k, v: f.v })),
        { k: t('site.site'), v: site },
        { k: t('site.account'), v: shortAddr(signer.address) },
      ],
      confirmText: t('sign.action'),
    });
    if (!ok) return respondError(USER_REJECTED);
    // `types` already has EIP712Domain stripped and `message` is already the
    // object-or-{} the signer needs — typedParts owns both, so the local
    // copy/delete/default that used to sit here is gone.
    return respond(await signer.signTypedData(domain, types, message));
  }

  if (method === 'eth_sendTransaction') {
    const localNet = getNetworkById(get('networkId'));
    const txReq = (msg.params || [])[0] || {};
    const reqChain = Number(txReq.chainId);
    if (Number.isFinite(reqChain) && localNet && Number(localNet.chainId) !== reqChain) {
      const m = `This dApp asked for chain ${reqChain}, but Bear Tool is on ${`${localNet.name} (chain ${localNet.chainId})`}. Switch network in Bear Tool and ask again — nothing was sent.`;
      toast(m, 'error');
      return respondError({ code: -32000, message: m });
    }
    // Money line for the native sheet, matching the iframe path's
    // describeSignCall: value in native units (not raw hex) and the calldata
    // itself (truncated, not just a byte count) — a user signing a swap must
    // see what the dApp is spending, not "0x2386f26fc10000" and "244 bytes".
    const ok = await askConfirm({
      title: t('sign.txTitle'),
      rows: [
        { k: t('site.chain'), v: chainId },
        { k: t('site.site'), v: site },
        { k: t('site.to'), v: txReq.to ? shortAddr(txReq.to) : t('sign.contractCreation') },
        { k: t('site.value'), v: formatWeiNative(txReq.value) },
        { k: t('site.data'), v: txReq.data && txReq.data !== 'x' && txReq.data !== '0x'
            ? String(txReq.data).slice(0, 74) + (String(txReq.data).length > 74 ? '…' : '')
            : t('cf.none.a.plain.transfer') },
      ],
      confirmText: t('sign.action'),
    });
    if (!ok) return respondError(USER_REJECTED);
    // Guard the TRANSPORT, not just the id. activateNetwork() writes networkId
    // SYNCHRONOUSLY while the provider object is rebuilt later, behind a probe
    // that tries several endpoints — and when that probe fails it can leave the
    // OLD provider in state for good. The reqChain check at the top of this
    // branch compares against networkId, so it saw the NEW chain and waved the
    // request through while the broadcast still went out the OLD provider:
    // wrong chain, behind a dialog naming the right one. Checked here, at the
    // last possible moment, the dialog's own wait has already given a transient
    // swap time to land — so this refuses only a provider genuinely still
    // elsewhere, which is exactly the one that must not broadcast.
    let provider;
    try {
      provider = await providerOnCurrentChain();
    } catch (e) {
      return respondError({ code: (e && e.code) || -32603, message: (e && e.message) || String(e) });
    }
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
