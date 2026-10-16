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
import { renderSignMessage, typedDataFields } from './sign-render.js';
import { t } from './i18n.js';
import { get, requireUnlock, on, waitForSigner } from './state.js';
import { getNetworkById, getNetwork, getAllNetworks, sanitizeChainRequest, installRequestedChain, rpcLabel } from './network.js';
import { NATIVE_PROVIDER_SCRIPT } from './native-provider.js';
// One source of truth for what a signature request MEANS: the injected path
// (dapp-exec.js) already splits both param orders, validates typed data, runs
// the security detectors, builds/validates a send transaction, and guards the
// chain a broadcast goes out on. This path re-implemented each by hand and
// got them wrong — see the personal_sign / typed-data / tx branches below.
import { splitSignParams, splitTypedParams, parseTyped, typedParts, providerOnCurrentChain, buildSendTx, scanSignCall, signPayload, currentChainId, decodeTokenCall, formatUnitsLean } from './dapp-exec.js';

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };
const LOCKED = { code: 5100, message: 'Wallet is locked.' };
// How long a request the user can actually approve by unlocking waits for
// them (see the locked gate in handleNativeRpc). Long enough to type the
// password, short enough that a dead dApp does not pin a promise all day.
const UNLOCK_WAIT_MS = 120000;
// Requests that are HELD through the unlock sheet instead of being refused
// with 5100 (MetaMask parity: prompt, never "no"). Reads and chain queries
// refuse instantly as before — a page polling while locked must not pin
// 120-second promises, nor re-open the sheet the user is typing into.
const HELD_WHILE_LOCKED = new Set([
  'eth_requestAccounts', 'wallet_requestPermissions',
  'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction',
]);
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

// 4-byte selectors → plain action names. A raw "0x095ea7b3" forces the user to
// look the call up; OKX names the action ("Approve") right on the sheet. The
// map is deliberately small and conservative — an unknown selector falls back
// to a neutral name, never to a guess.
const ACTION_SELECTORS = new Map([
  ['0x095ea7b3', 'Approve'],
  ['0xa9059cbb', 'Transfer'],
  ['0x23b872dd', 'Transfer From'],
  ['0x38ed1739', 'Swap'],
  ['0x7ff36ab5', 'Swap'],
  ['0x18cbafe5', 'Swap'],
  ['0xfb3bdb41', 'Swap'],
  ['0x8803dbee', 'Swap'],
  ['0x791ac947', 'Swap'],
  ['0xac9650d8', 'Multicall'],
  ['0xd0e30db0', 'Deposit'],
  ['0x2e1a7d4d', 'Withdraw'],
  ['0x42842e0e', 'NFT Transfer'],
  ['0x6a761202', 'Execute'],
  ['0xa22cb465', 'Set Approval'],
]);

function actionLabel(data) {
  const d = String(data || '');
  if (!d || d === '0x') return t('cf.none.a.plain.transfer');
  return ACTION_SELECTORS.get(d.slice(0, 10).toLowerCase()) || t('tx.sheet.contractCall');
}

function permissionRecord(site, address) {
  // EIP-2255 shape, field-for-field the one the injected web path returns
  // (dapp-bridge.js permissionsFor) — a site must meet ONE wallet, whichever
  // path answers.
  return {
    id: `bear:eth_accounts:${site}`,
    invoker: site,
    parentCapability: 'eth_accounts',
    caveats: [{ type: 'restrictReturnedAccounts', value: [address] }],
    date: Date.now(),
  };
}

// One consent flight per origin. eth_requestAccounts and
// wallet_requestPermissions can arrive CONCURRENTLY (wagmi/AppKit fire the
// pair; a double-tap doubles them) and each would open its own native sheet —
// the second replaces the first, and Java auto-REFUSES the replaced request,
// so a connect died while the user simply stared at a sheet (report
// 2026-10-16). Concurrent asks share one sheet; both receive the same answer.
const connectConsentInFlight = new Map();

function connectConsent(site, address) {
  let inflight = connectConsentInFlight.get(site);
  if (!inflight) {
    inflight = runConnectConsent(site, address);
    connectConsentInFlight.set(site, inflight);
    const drop = () => connectConsentInFlight.delete(site);
    inflight.then(drop, drop);
  }
  return inflight;
}

async function runConnectConsent(site, address) {
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
      { k: t('site.account'), v: shortAddr(address) },
      { k: t('site.canSee'), v: t('site.canSeeValue') },
      { k: t('site.canSign'), v: t('site.canSignValue') },
      { k: t('site.canSend'), v: t('site.canSendValue') },
    ],
    confirmText: t('site.connect'),
  });
  if (!ok) return null;
  connectedOrigins.add(site);
  return [address];
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
        // An RPC right now = the user is inside the browser right now. The
        // wallet's idle timer only sees its OWN webview's clicks, so without
        // this an actively browsing user got auto-locked mid-dApp ("keluar
        // sendiri", report 2026-10-16) and the next request met a locked wallet.
        pingWalletActivity();
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

// "The user is in the browser right now", told to the wallet's auto-lock
// timer (app.js noteActivity). Throttled, best-effort: the wallet bundle may
// still be booting during the first requests, and a lost ping only means the
// timer falls back to counting the wallet webview's own clicks (the old
// behaviour — an actively browsing user, auto-locked mid-dApp).
let lastActivityPing = 0;
function pingWalletActivity() {
  const now = Date.now();
  if (now - lastActivityPing < 5000) return;
  lastActivityPing = now;
  import('./app.js').then((m) => m.noteActivity?.()).catch(() => { /* boot in flight */ });
}

/** Native toolbar/menu → wallet commands. */
async function handleWalletCommand(ev) {
  const cmd = ev && ev.command;
  if (cmd === 'activity') {
    // Throttled touch pings from the native browser (Java dispatchTouchEvent):
    // the user is physically in the dApp view, so the wallet's idle timer must
    // count it — it only saw the wallet webview's clicks otherwise, and locked
    // an actively browsing user mid-dApp. The ping only resets the timer; it
    // cannot unlock, sign, or change state.
    pingWalletActivity();
    return;
  }
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
  // A NATIVE pick sheet draws ABOVE the dApp (OKX-style): the wallet's
  // Networks modal lives in the WALLET webview, which the dApp overlay covers
  // — opening it meant the browser vanished and flashed back after ("ganti
  // jaringan langsung keluar dari daaps setelah ganti langsung balik lagi di
  // dalam daaps", report 2026-10-16). Native sheet first, wherever the plugin
  // has pickNetwork(); the modal below stays for older builds and web.
  if (plugin && typeof plugin.pickNetwork === 'function') {
    try {
      const activeId = get('networkId');
      const rows = getAllNetworks().map((n) => ({
        id: String(n.id),
        label: String(n.name || n.symbol || n.id),
        sub: String(n.symbol || n.type || ''),
        active: String(n.id) === String(activeId) ? '1' : '',
      }));
      const picked = await plugin.pickNetwork({ title: t('net.sheet.title'), rows, cancelText: t('common.cancel') });
      if (picked && picked.id) {
        const { activateNetwork } = await import('./app.js');
        activateNetwork(String(picked.id));
      }
      return;
    } catch { /* no pick sheet on this build — fall through to the wallet modal */ }
  }
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

async function askConfirm({ title, rows, confirmText, danger, tx, headline, subhead }) {
  const p = plugin;
  if (p) {
    try {
      const safe = (rows || []).map((r) => ({ k: String(r.k), v: String(r.v) }));
      // `danger` rides along for builds whose native sheet understands it —
      // older builds simply ignore the extra key. Same for headline/subhead:
      // the big money line some sheets lead with (OKX parity), optional, and
      // the rows below always carry the full record either way.
      const r = await p.confirm({ title, rows: safe, confirmText: confirmText || 'Confirm', danger: !!danger, headline: headline || undefined, subhead: subhead || undefined });
      if (r && typeof r.ok === 'boolean') return r.ok;
    } catch { /* no native sheet on this build — fall through to the wallet modal */ }
  }
  return askUser(() => confirmTx({
    title,
    rows,
    confirmText,
    ...(danger ? { danger: true } : {}),
    ...(headline ? { headline } : {}),
    ...(subhead ? { subhead } : {}),
    ...(tx ? { tx } : {}),
  }));
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

  const signer0 = get('signer');
  if (method === 'eth_accounts') {
    return respond(connectedOrigins.has(site) && signer0 ? [signer0.address] : []);
  }
  // EIP-2255 permissions are the WALLET's own bookkeeping, answered from the
  // same records the injected web path returns (dapp-bridge.js). They sit
  // BEFORE the locked gate on purpose: asking what is granted must return []
  // while nothing is, not an error — and revoking nothing is still a success.
  if (method === 'wallet_getPermissions') {
    return respond(connectedOrigins.has(site) && signer0 ? [permissionRecord(site, signer0.address)] : []);
  }
  if (method === 'wallet_revokePermissions') {
    connectedOrigins.delete(site);
    return respond(null);
  }
  // A LOCKED wallet HOLDS every request its unlock sheet can actually
  // satisfy — the user is asked to unlock, and the request continues by
  // itself (MetaMask parity). Refusing with 5100 trained people to tap,
  // unlock, tap again ("pas mau konek gabisa", report 2026-10-16 — and the
  // auto-lock used to fire mid-dApp because browser touches never reset its
  // idle timer). Reads and chain queries still refuse instantly: a page
  // polling while locked must not pin long promises — nor re-open the sheet
  // the user is typing a password into.
  let signer = signer0;
  if (!signer) {
    if (!modalOpen) requireUnlock();
    if (!HELD_WHILE_LOCKED.has(method)) return respondError(LOCKED);
    signer = await waitForSigner(UNLOCK_WAIT_MS);
    if (!signer) return respondError(LOCKED);
  }

  if (method === 'eth_requestAccounts') {
    // Already granted: MetaMask/OKX answer without a sheet — the consent is
    // for the FIRST connect, not a toll booth on every reconnect. dApps
    // re-ask on every load (and the E2E fixture does too, on purpose): a
    // sheet nobody expects here read as "connect is broken" (report
    // 2026-10-16 "pertama bisa konek pas mau konek gabisa").
    if (connectedOrigins.has(site)) return respond([signer.address]);
    const accounts = await connectConsent(site, signer.address);
    if (!accounts) return respondError(USER_REJECTED);
    return respond(accounts);
  }

  if (method === 'wallet_requestPermissions') {
    // The MetaMask-flavored connector in wagmi/AppKit connects through THIS
    // method, not eth_requestAccounts. The native path answered 4200 while
    // the wallet sat right there — and the wallet's own web path has answered
    // it since day one, so one site met two different Bear Tools. Only
    // eth_accounts may be asked for; anything else is refused loudly.
    const asked = (msg.params || [])[0];
    const keys = asked && typeof asked === 'object' ? Object.keys(asked) : [];
    if (!keys.length || keys.some((k) => k !== 'eth_accounts')) {
      return respondError({ code: 4201, message: 'Bear Tool only supports the eth_accounts permission.' });
    }
    if (!connectedOrigins.has(site)) {
      const accounts = await connectConsent(site, signer.address);
      if (!accounts) return respondError(USER_REJECTED);
    }
    return respond([permissionRecord(site, signer.address)]);
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
    // signPayload (dapp-exec.js), not a local converter: display and signature
    // must cover the same bytes — the local hexToBytes floored odd-length hex.
    return respond(await signer.signMessage(signPayload(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    // BOTH orders — [address, typedData] (the convention real dApps send; the
    // E2E fixture sends it with the stand-in address "0x0") and the legacy
    // [typedData, address]. splitTypedParams finds the payload by SHAPE
    // (object / JSON string): a length rule rejects short addresses like
    // "0x0", reads them as the payload, JSON.parse throws — and this branch
    // then answered 32602 without ever showing a sheet, which is how the
    // emulator gate failed ("typed-data sheet never appeared") after the
    // previous fix.
    const { typed } = splitTypedParams(msg.params || []);
    if (typed == null) return respondError({ code: 32602, message: 'Expected [typedData, address].' });
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
      parsed = parseTyped(typed);
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
    // The SAME validator the injected and WalletConnect paths call
    // (buildSendTx, dapp-exec.js): a malformed request → 32602, a foreign
    // `from` → 4100, the transaction's own chainId → 4902, `to`/`data`
    // format, field whitelist and BigInt. This branch used to hand-pick three
    // fields — a dApp-supplied gas limit silently vanished — and never
    // checked `from` or the tx's chainId at all.
    let tx;
    try {
      tx = buildSendTx((msg.params || [])[0], {
        activeAddress: signer.address || get('address') || '',
        chainId: currentChainId(),
      });
    } catch (e) {
      return respondError({ code: (e && e.code) || 32602, message: (e && e.message) || String(e) });
    }
    // The transaction detectors — the same scanSignCall the injected and
    // WalletConnect paths run before their sheets. This path showed none of it.
    const findings = scanSignCall(method, msg.params || []);
    const worst = findings.find((f) => f.level === 'fail') || findings.find((f) => f.level === 'warn');
    // Money line for the native sheet, matching the iframe path's
    // describeSignCall: value in native units (not raw hex) and the calldata
    // itself (truncated, not just a byte count) — a user signing a swap must
    // see what the dApp is spending, not "0x2386f26fc10000" and "244 bytes".
    // The money can also hide INSIDE the calldata: transfer/approve carry the
    // amount as their second word while the value field stays empty, so the
    // sheet used to lead with "0" for every ERC-20 move ("interaksi tx juga
    // gitu ga lengkap", report 2026-10-16). The wallet's own token list turns
    // raw units into "1.5 USDC"; an unknown token keeps its raw amount next
    // to the contract it is calling. Display only — the signer signs bytes.
    const tokenCall = decodeTokenCall(tx.data);
    const tokenMeta = tokenCall && tx.to
      ? (get('tokens') || []).find((x) => x && x.address && String(x.address).toLowerCase() === String(tx.to).toLowerCase())
      : null;
    const nativeValue = tx.value ? BigInt(tx.value) : 0n;
    const tokenAmount = tokenCall
      ? (tokenMeta && Number.isInteger(tokenMeta.decimals)
          ? `${formatUnitsLean(tokenCall.amount, tokenMeta.decimals)}${tokenMeta.symbol ? ` ${tokenMeta.symbol}` : ''}`
          : `${tokenCall.amount} · ${tx.to ? shortAddr(tx.to) : ''}`)
      : null;
    const ok = await askConfirm({
      title: (worst ? (worst.level === 'fail' ? '🚨 ' : '⚠️ ') : '') + t('sign.txTitle'),
      danger: !!(worst && worst.level === 'fail'),
      // The money line ON TOP and BIG — OKX draws the amount as the sheet's
      // headline; ours used to be one 13sp row among seven ("ask tx dalam
      // daaps masih ambigu", report 2026-10-16). An ERC-20 call leads with
      // its decoded amount; everything else with the native value or the
      // action. headline/subhead ride the native sheet AND the wallet-modal
      // fallback; the rows below stay complete either way.
      headline: nativeValue > 0n ? formatWeiNative(tx.value) : (tokenCall && tokenMeta ? tokenAmount : actionLabel(tx.data)),
      subhead: `${actionLabel(tx.data)} → ${tokenCall?.to ? shortAddr(tokenCall.to) : (tx.to ? shortAddr(tx.to) : t('sign.contractCreation'))}`,
      rows: [
        { k: t('site.chain'), v: chainId },
        { k: t('site.site'), v: site },
        { k: t('site.to'), v: tx.to ? shortAddr(tx.to) : t('sign.contractCreation') },
        { k: t('site.value'), v: formatWeiNative(tx.value) },
        ...(tokenCall ? [{ k: t('cf.amount'), v: tokenAmount }] : []),
        { k: t('site.data'), v: tx.data && tx.data !== '0x'
            ? String(tx.data).slice(0, 74) + (String(tx.data).length > 74 ? '…' : '')
              + ` · ${Math.max(0, Math.round((String(tx.data).length - 2) / 2))} bytes`
            : t('cf.none.a.plain.transfer') },
        ...(findings.length ? [{ k: t('cf.flags'), v: findings.map((f) => `${f.level.toUpperCase()}: ${f.title}`).join(' · ') }] : []),
        ...(worst ? [{ k: t('cf.why'), v: worst.detail }] : []),
      ],
      confirmText: worst && worst.level === 'fail' ? t('cf.sendAnyway') : t('sign.send'),
      tx: { to: tx.to, data: tx.data, value: tx.value },
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
    // (the exact bug tests/send-resilience.test.js exists to catch). The tx
    // is the validated, whitelisted object from buildSendTx: a gas limit,
    // nonce or fee field the dApp sent now rides along instead of vanishing.
    const sent = await signer.connect(provider).sendTransaction(tx);
    return respond(sent.hash);
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

  if (method === 'wallet_addEthereumChain') {
    const payload = (msg.params || [])[0] || {};
    const want = Number(payload.chainId);
    const target = Number.isFinite(want) ? getNetwork(want) : null;
    // Known chain: switch to it (already on it → nothing to do). One
    // chokepoint, same as the switch branch above.
    if (target) {
      const localNet = getNetworkById(get('networkId'));
      if (localNet && Number(localNet.chainId) === Number(target.chainId)) return respond(null);
      try {
        const { activateNetwork } = await import('./app.js');
        activateNetwork(target.id);
        return respond(null);
      } catch (e) {
        return respondError({ code: 4902, message: (e && e.message) || 'Switch failed.' });
      }
    }
    // Unknown chain: EIP-3085 — the wallet may ASK (user report 2026-10-15:
    // "add network gabisa" for a dApp on a new testnet; this browser had no
    // add path at all). Sanitize → Cancel/Confirm sheet with the SANITIZED
    // values → only an approved sheet reaches the registry. The dApp's raw
    // parameters are never installed directly.
    const san = sanitizeChainRequest(payload);
    if (!san.ok) return respondError({ code: san.code || 32602, message: san.message });
    const ok = await askConfirm({
      title: t('dapp.addChain.title'),
      rows: [
        { k: t('cf.site'), v: site },
        { k: t('dapp.addChain.name'), v: san.net.name },
        { k: t('dapp.addChain.id'), v: String(san.net.chainId) },
        { k: t('dapp.addChain.rpc'), v: rpcLabel(san.net.rpc[0]) },
        { k: t('dapp.addChain.symbol'), v: san.net.symbol },
        { k: t('dapp.addChain.note'), v: t('dapp.addChain.noteText') },
      ],
      confirmText: t('dapp.addChain.confirm'),
    });
    if (!ok) return respondError(USER_REJECTED);
    const ins = await installRequestedChain(san.net);
    if (!ins.ok) return respondError({ code: ins.code || 4902, message: ins.message });
    try {
      const { activateNetwork } = await import('./app.js');
      activateNetwork(ins.net.id);
      return respond(null);
    } catch (e) {
      return respondError({ code: 4902, message: (e && e.message) || 'Switch failed.' });
    }
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
