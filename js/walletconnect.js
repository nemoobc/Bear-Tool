// js/walletconnect.js — WalletConnect v2 pairing & signing (Reown WalletKit).
//
// Why this exists: roughly half of the dApps in the catalogue send
// X-Frame-Options / frame-ancestors and can never be embedded in the in-app
// browser (audit 2026-10-02), and a blocked frame fires no event at all
// (WHATWG html #12311, Firefox 1552504) — the honest fallback offered there is
// "open in a new tab". This module completes that path: the dApp lives in the
// external tab, the CONNECTION comes back here over the Reown relay, and every
// signature still passes Bear Tool's own confirm dialog. Research (S20/S21,
// reown.com/blog + docs.reown.com/cloud/relay, 2026-10-02): WalletKit runs
// fully client-side with only a projectId — the projectId is public BY DESIGN
// and protected by an origin allowlist, so it is a config constant, not a
// secret.
//
// Override per build with VITE_WC_PROJECT_ID (your own id from
// dashboard.reown.com — free, no per-dApp approval needed, per Reown FAQ
// 2026-10-07); the bundled constant is the fallback so a stock build keeps
// working out of the box.
//
// The heavy dependency is imported dynamically inside ensureKit(): importing
// this module costs nothing at boot and opens no socket until the user
// actually pastes a wc: URI.
import { openModal, closeModal, confirmTx, escapeHtml, toast } from './ui.js';
import { get, set, requireUnlock } from './state.js';
import { getNetworkById, getNetwork } from './network.js';

export const WC_PROJECT_ID =
  (import.meta.env && import.meta.env.VITE_WC_PROJECT_ID) || '99909bde486039e2102663b92be74974';

// Exactly the methods this wallet will answer — what the session grants is
// what the confirm dialog can actually deliver. eth_sign is absent on
// purpose: it signs raw digests with no readable content, and MetaMask refuses
// it by default for the same reason.
export const WC_SIGN_METHODS = ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'];

// Read/chain methods a dApp needs to even finish connecting. WalletConnect
// validates the APPROVED namespace against what the dApp asked for: a session
// granting only the three signing methods is rejected outright by any dApp
// whose requiredNamespaces lists eth_accounts / wallet_switchEthereumChain
// (most do) — the connect fails before a single signature is requested, which
// is exactly the "cannot connect" symptom. eth_sign stays out for the same
// reason it is out of WC_SIGN_METHODS.
//
// wallet_switchEthereumChain is answered WITHOUT a per-call prompt on purpose:
// a chain switch is reversible and nagging on each one teaches people to click
// through — the same reasoning audit-regression.test.js pins for the injected
// shim (it only bars the method from PER_CALL_CONFIRM, not from being handled).
// The target must be a network Bear Tool already ships: wallet_addEthereumChain
// never installs the dApp's rpcUrls, so a page cannot point the wallet at its
// own RPC.
export const WC_READ_METHODS = [
  'eth_chainId', 'net_version', 'eth_accounts', 'eth_requestAccounts',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
];

/** What the session actually grants: sign/spend + the read/chain calls above. */
export const WC_SESSION_METHODS = [...WC_SIGN_METHODS, ...WC_READ_METHODS];

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };
// EIP-3085/3326: 4902 = the chain is not in the wallet. The message must say
// what the user can DO about it, not just repeat the number.
const CHAIN_UNKNOWN = (id) => ({
  code: 4902,
  message: `Bear Tool has no network with chain id ${id}. Add it in Settings → Networks, then ask again.`,
});
const METHOD_UNSUPPORTED = { code: -32601, message: 'Method not supported by Bear Tool.' };

let kit = null;
let initing = null;
// Topics this wallet disconnected itself (stale-session cleanup) — their
// session_delete events must not toast "closed by the dApp".
const silentDeleteTopics = new Set();

// -- pure helpers (unit-tested without a browser or a network) -------------

/** WC dApps spell the field `gas` (JSON-RPC spelling); ethers v6 only reads
 * gasLimit and silently DROPS `gas`, so a dapp-supplied limit never reached
 * the node. Map it — an explicit gasLimit keeps winning — and drop the alias. */
export function normalizeWcTx(raw) {
  const tx = { ...(raw || {}) };
  if (tx.gasLimit === undefined && tx.gas !== undefined) tx.gasLimit = tx.gas;
  delete tx.gas;
  return tx;
}

/** 'eip155:137' → 137; anything unparseable → null (caller treats that as
 * "no chain claimed", not as a mismatch). */
export function wcChainNumber(chainId) {
  const m = /^eip155:(\d+)$/.exec(String(chainId || ''));
  return m ? Number(m[1]) : null;
}

/** Native unit for value display on the ACTIVE network — every chain used to
 * be labelled "ETH", which is wrong on most of the networks this app ships. */
export function nativeUnit(net) {
  return (net && net.symbol) || 'ETH';
}

/** A pairing URI is `wc:<version>-<topic>@<relay>?symKey=...` — anything else
 *  must never reach core.pair(), where a malformed value throws deep inside
 *  the jsonrpc stack with an unhelpful message. */
export function isValidWcUri(u) {
  return typeof u === 'string'
    && u.trim().startsWith('wc:')
    && u.includes('@')
    && u.includes('?');
}

/** Union of the eip155 chains the dApp asked for (required + optional).
 *  With neither listed, the session is pinned to mainnet rather than granted
 *  "all chains": an unbounded namespace is a broader grant than the user was
 *  shown. */
export function collectEip155Chains(required, optional, fallback = ['eip155:1']) {
  const set = new Set();
  for (const ns of [required, optional]) {
    const e = ns && ns.eip155;
    if (e && Array.isArray(e.chains)) e.chains.forEach((c) => { if (typeof c === 'string') set.add(c); });
  }
  if (!set.size) fallback.forEach((c) => set.add(c));
  return [...set];
}

/** Shorten an address for a dialog row: 0x1234...abcd. */
export function shortAddr(a) {
  return typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : String(a || '');
}

/** Drop control characters, zero-width characters and bidi overrides from a
 *  decoded preview so a signed message cannot visually lie (U+202E would flip
 *  the displayed order of the text). Written as a code-point loop instead of
 *  a regex so this source file stays pure printable text. */
export function stripInvisible(text) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;   // control chars
    if (c >= 0x200b && c <= 0x200f) continue;               // zero-width + marks
    if (c >= 0x202a && c <= 0x202e) continue;               // bidi embedding
    if (c >= 0x2066 && c <= 0x2069) continue;               // bidi isolate
    out += ch;
  }
  return out;
}

/** Hex payload -> readable preview. personal_sign sends UTF-8 as hex; some
 *  dApps send bytes that are not text at all, so failures degrade to the raw
 *  hex instead of throwing inside a confirm dialog. */
export function hexToPreview(hex, max = 140) {
  const s = String(hex || '');
  if (!/^0x[0-9a-fA-F]*$/.test(s)) return s.slice(0, max);
  try {
    const body = s.slice(2);
    const bytes = new Uint8Array(body.length >> 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const printable = stripInvisible(text).trim();
    return (printable || s).slice(0, max);
  } catch {
    return s.slice(0, max);
  }
}

// -- runtime (needs a real wallet + network) -------------------------------

function address() {
  return get('signer')?.address || '';
}

function wcDebugEnabled() {
  try { return localStorage.getItem('bear.wcDebug') === '1'; } catch { return false; }
}

function consoleLogger() {
  const line = (level) => (...args) => console[level === 'trace' || level === 'debug' ? 'log' : level]('[wc:' + level + ']', ...args);
  const l = {
    level: 'debug',
    fatal: line('error'), error: line('error'), warn: line('warn'),
    info: line('info'), debug: line('debug'), trace: line('trace'),
    setLevel() {},
    isLevelEnabled: () => true,
  };
  // @walletconnect/logger's build() calls logger.child({context}) — a plain
  // object without child() crashes Core.init ("t.child is not a function").
  l.child = () => l;
  return l;
}

async function ensureKit() {
  if (kit) return kit;
  if (!initing) {
    initing = (async () => {
      const [{ WalletKit }, { Core }] = await Promise.all([
        import('@reown/walletkit'),
        import('@walletconnect/core'),
      ]);
      // Core.init() returns a Promise (core ≥2.25, typed `Promise<Core>`).
      // Without await, WalletKit receives a Promise as `core`: core.logger is
      // undefined and init dies at `this.logger.trace(...)` — pairing failed
      // with "Cannot read properties of undefined (reading 'trace')" and the
      // dApp browser had no working connection path at all (user report
      // 2026-10-08: "dapps browser ... gabisa connect wallet").
      // Opt-in wire diagnostics (localStorage bear.wcDebug=1): publish/receive
      // failures are swallowed at the SDK's debug level, so a silent
      // "resolve with no delivery" is otherwise indistinguishable from
      // success during live debugging of switch announcements.
      const core = await Core.init({
        projectId: WC_PROJECT_ID,
        ...(wcDebugEnabled() ? { logger: consoleLogger() } : {}),
      });
      const w = await WalletKit.init({
        core,
        metadata: {
          name: 'Bear Tool',
          description: 'Self-custody wallet with a hardened dApp browser',
          url: location.origin,
          icons: [new URL('assets/bear.svg', location.origin).href],
        },
      });
      w.on('session_proposal', (args) => { handleProposal(args).catch((e) => toast('WalletConnect: ' + e.message, 'error')); });
      w.on('session_request', (args) => { handleRequest(args).catch((e) => toast('WalletConnect: ' + e.message, 'error')); });
      w.on('session_delete', (args) => {
        // Topics WE disconnected during re-approve cleanup are not the dApp
        // closing anything — no toast for those.
        const t = args && args.topic;
        if (t && silentDeleteTopics.delete(t)) return;
        toast('WalletConnect session closed by the dApp.', 'info');
      });
      kit = w;
      if (wcDebugEnabled()) {
        // Live-diagnosis probes (flag bear.wcDebug=1): ping proves the dApp's
        // inbound session-topic subscription, announce re-fires a switch on
        // demand — both answer "published but never received?" questions.
        window.__wcDebug = {
          sessions: () => Object.values(w.getActiveSessions?.() || {}),
          // WalletKit has no ping wrapper; the sign-client engine does — it
          // awaits the pong (createDelayedPromise), so a resolve PROVES the
          // dApp's inbound session-topic subscription is alive.
          ping: (topic) => (w.signClient?.engine || w.engine).ping({ topic }),
          emit: (topic, name, data) =>
            w.emitSessionEvent({ topic, chainId: 'eip155:1', event: { name, data } }),
        };
      }
      return w;
    })().catch((e) => { initing = null; throw e; });
  }
  return initing;
}

function respond(topic, id, result) {
  return kit.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', result } });
}

function respondError(topic, id, err) {
  return kit.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', error: err } });
}

async function handleProposal({ id, params }) {
  const dappName = params?.proposer?.metadata?.name || 'A dApp';
  const chains = collectEip155Chains(params?.requiredNamespaces, params?.optionalNamespaces);
  const addr = address();
  if (!addr) {
    await kit.rejectSession({ id, reason: { code: 5100, message: 'Wallet is locked.' } }).catch(() => {});
    toast('Unlock Bear Tool before connecting a dApp.', 'error');
    return;
  }
  const ok = await confirmTx({
    title: 'Connect "' + dappName + '" to Bear Tool?',
    rows: [
      { k: 'dApp', v: dappName },
      { k: 'Account', v: shortAddr(addr) },
      { k: 'Chains', v: chains.join(', ') },
      { k: 'Can request', v: WC_SESSION_METHODS.join(', ') },
    ],
    confirmText: 'Connect',
  });
  if (!ok) {
    await kit.rejectSession({ id, reason: USER_REJECTED }).catch(() => {});
    return;
  }
  // One live session per dApp. Every re-pair (wallet page reload, dApp
  // reconnect) used to stack ANOTHER 7-day session for the same URL: ghost
  // entries in the session sheet, ghost publishes to topics nobody hears,
  // and duplicated approvals the user never made. Collected BEFORE approve
  // so only the pre-existing ones are killed.
  const dappUrl = String(params?.proposer?.metadata?.url || '').toLowerCase().replace(/\/+$/, '');
  const staleTopics = dappUrl
    ? Object.values(kit.getActiveSessions?.() || {})
        .filter((s) => String(s?.peer?.metadata?.url || '').toLowerCase().replace(/\/+$/, '') === dappUrl)
        .map((s) => s.topic)
    : [];
  await kit.approveSession({
    id,
    namespaces: {
      eip155: {
        accounts: chains.map((c) => c + ':' + addr),
        chains,
        methods: WC_SESSION_METHODS,
        events: ['chainChanged', 'accountsChanged'],
      },
    },
  });
  for (const topic of staleTopics) {
    silentDeleteTopics.add(topic);
    await kit.disconnectSession({
      topic,
      reason: { code: 6000, message: 'Replaced by a new session for this dApp.' },
    }).catch(() => { silentDeleteTopics.delete(topic); });
  }
  toast('Connected to ' + dappName + '.', 'info');
}

async function handleRequest({ id, topic, params }) {
  const method = params?.request?.method;
  const chainId = params?.chainId || 'eip155:1';
  const signer = get('signer');
  if (!signer) {
    // Item 12: locked wallet → raise the local password prompt so the user can
    // unlock, and tell the dApp why (the dApp retries on its own).
    requireUnlock();
    await respondError(topic, id, { code: 5100, message: 'Wallet is locked.' });
    return;
  }

  if (method === 'personal_sign') {
    const [hex] = params.request.params || [];
    const ok = await confirmTx({
      title: 'Sign message?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Account', v: shortAddr(signer.address) },
        { k: 'Message', v: hexToPreview(hex) },
      ],
      confirmText: 'Confirm',
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    return respond(topic, id, await signer.signMessage(hexToBytes(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    const raw = params.request.params && params.request.params[1];
    let parsed = {};
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { parsed = {}; }
    const domain = parsed.domain || {};
    // A typed-data signature is only valid for the domain's chain. Signing a
    // Polygon-domain payload while the wallet sits on Ethereum produces a
    // signature the dApp can never use, behind a dialog that looked fine.
    const domChain = Number(domain.chainId);
    const localNet = getNetworkById(get('networkId'));
    if (Number.isFinite(domChain) && localNet && Number(localNet.chainId) !== domChain) {
      const msg = `This signature targets chain ${domChain}, but Bear Tool is on ${localNet.name} (chain ${localNet.chainId}). Switch network first — nothing was signed.`;
      toast(msg, 'error');
      return respondError(topic, id, { code: -32000, message: msg });
    }
    const ok = await confirmTx({
      title: 'Sign typed data?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Domain', v: String(domain.name || '?') + (domain.version ? ' v' + domain.version : '') },
        { k: 'Primary type', v: String(parsed.primaryType || '?') },
        { k: 'Account', v: shortAddr(signer.address) },
      ],
      confirmText: 'Confirm',
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    const types = { ...(parsed.types || {}) };
    delete types.EIP712Domain;
    return respond(topic, id, await signer.signTypedData(domain, types, parsed.message || {}));
  }

  if (method === 'eth_sendTransaction') {
    const localNet = getNetworkById(get('networkId'));
    const reqChain = wcChainNumber(chainId);
    // The `chainId` row in the dialog used to be decoration: the transaction
    // was signed with the LOCAL provider whatever the dApp asked for, so a
    // dApp on Polygon could quietly push a transaction onto Ethereum behind a
    // dialog that said "eip155:137". Refuse the mismatch instead of executing
    // on the wrong chain.
    if (reqChain !== null && localNet && Number(localNet.chainId) !== reqChain) {
      const msg = `This dApp asked for chain ${reqChain}, but Bear Tool is on ${localNet.name} (chain ${localNet.chainId}). Switch network in Bear Tool and ask again — nothing was sent.`;
      toast(msg, 'error');
      return respondError(topic, id, { code: -32000, message: msg });
    }
    const tx = normalizeWcTx((params.request.params && params.request.params[0]) || {});
    const provider = get('provider');
    if (!provider) {
      return respondError(topic, id, { code: -32000, message: 'No provider for the current network.' });
    }
    const ok = await confirmTx({
      title: 'Send transaction?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'To', v: shortAddr(tx.to || '') },
        { k: 'Value', v: fmtValue(tx.value, nativeUnit(localNet)) },
        { k: 'Data', v: tx.data && tx.data !== '0x' ? (String(tx.data).length / 2 - 1) + ' bytes' : 'none' },
      ],
      confirmText: 'Sign & Send',
      danger: !!(tx.data && tx.data !== '0x'),
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    const sent = await signer.connect(provider).sendTransaction(tx);
    toast('Transaction sent: ' + sent.hash.slice(0, 18) + '...', 'info');
    return respond(topic, id, sent.hash);
  }

  // -- read / chain calls: what a dApp needs just to finish connecting ------
  // Answered without a prompt (see WC_READ_METHODS): no signature, no spend.
  if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
    return respond(topic, id, [signer.address]);
  }

  if (method === 'eth_chainId' || method === 'net_version') {
    const local = getNetworkById(get('networkId'));
    // Not named `id`: that is the JSON-RPC request id from the handler's own
    // parameter, and a local by that name puts every later `id` in the
    // function out of its declaring block (tests/scope.test.js).
    const localChain = Number(local?.chainId || 1);
    return respond(topic, id, method === 'eth_chainId' ? '0x' + localChain.toString(16) : String(localChain));
  }

  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
    const raw = String((params.request.params && params.request.params[0]?.chainId) || '');
    const want = /^0x[0-9a-fA-F]+$/.test(raw) ? parseInt(raw, 16) : NaN;
    if (!Number.isFinite(want)) {
      return respondError(topic, id, { code: -32602, message: 'Invalid chain id: ' + (raw || 'missing') });
    }
    // wallet_addEthereumChain is deliberately treated as "switch if we know
    // this chain, refuse otherwise". The dApp's rpcUrls / blockExplorerUrls
    // are NEVER installed: a page must not be able to point the wallet at an
    // RPC it controls, where it could answer whatever it likes to any later
    // read. Bear Tool's own registry is the only source of chain truth.
    const net = getNetwork(want);
    if (!net) return respondError(topic, id, CHAIN_UNKNOWN(want));
    if (net.id !== get('networkId')) {
      // The same two writes the network menu performs (app.js [data-net]),
      // followed by the same repaint, so the topbar pill and the dashboard
      // agree with what this dApp was just told.
      set('networkId', net.id);
      try { localStorage.setItem('bear.networkId', net.id); } catch { /* private mode */ }
      const app = await import('./app.js').catch(() => null);
      app?.updateTopbar?.();
      app?.refreshView?.('dashboard');
      // Same event to the INJECTED provider that the WalletConnect session
      // gets below — a page on this wallet's own origin hears every switch,
      // whoever asked for it.
      app?.announceChainChanged?.(want);
      toast('Network switched to ' + net.name + ' (requested by the dApp).', 'info');
      // EIP-1193 promises chainChanged — without it a dApp sits on a stale UI
      // until it polls eth_chainId. Best-effort: the JSON-RPC response below
      // is the authoritative answer.
      kit.emitSessionEvent({
        topic,
        chainId: 'eip155:' + want,
        event: { name: 'chainChanged', data: '0x' + want.toString(16) },
      }).catch(() => { /* session may not list that chain — response still stands */ });
    }
    return respond(topic, id, null);
  }

  await respondError(topic, id, METHOD_UNSUPPORTED);
}

// -- small runtime helpers -------------------------------------------------

function hexToBytes(hex) {
  const s = String(hex || '');
  if (!/^0x[0-9a-fA-F]*$/.test(s)) return s;
  const body = s.slice(2);
  const bytes = new Uint8Array(body.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function fmtValue(v, unit = 'ETH') {
  if (v === undefined || v === null || v === '') return '0';
  try {
    if (globalThis.ethers && globalThis.ethers.formatEther) return globalThis.ethers.formatEther(v) + ' ' + unit;
  } catch { /* fall through to raw */ }
  return String(v);
}

// -- UI --------------------------------------------------------------------

/**
 * Origins (lowercase) of every ACTIVE WalletConnect session — the dApp
 * browser bar reads this to show "🔗 WalletConnect" on the tab that is
 * actually paired, and to decide whether the pairing hint still applies.
 */
export function wcActiveOrigins() {
  if (!kit || typeof kit.getActiveSessions !== 'function') return [];
  try {
    return Object.values(kit.getActiveSessions() || {})
      .map((s) => { try { return new URL(s?.peer?.metadata?.url || '').origin.toLowerCase(); } catch { return ''; } })
      .filter(Boolean);
  } catch { return [];
  }
}

/** The session paired for one origin, or null. */
export function wcSessionForOrigin(origin) {
  const o = String(origin || '').toLowerCase();
  if (!o || !kit || typeof kit.getActiveSessions !== 'function') return null;
  try {
    return Object.values(kit.getActiveSessions() || {}).find((s) => {
      try { return new URL(s?.peer?.metadata?.url || '').origin.toLowerCase() === o; } catch { return false; }
    }) || null;
  } catch { return null; }
}

/** Disconnect the session paired to `origin`. Resolves true when one was closed. */
export async function disconnectWcOrigin(origin) {
  const s = wcSessionForOrigin(origin);
  if (!s) return false;
  try {
    await kit.disconnectSession({ topic: s.topic, reason: { code: 6000, message: 'User disconnected.' } });
    return true;
  } catch { return false; }
}

function renderSessions(root) {
  if (!kit) return;
  const sessions = Object.values((kit.getActiveSessions && kit.getActiveSessions()) || {});
  if (!sessions.length) {
    root.innerHTML = '<p class="small dim">No active sessions.</p>';
    return;
  }
  root.innerHTML = sessions.map((s) => `
    <div class="row wc-session" data-topic="${escapeHtml(s.topic)}">
      <span class="k">${escapeHtml((s.peer && s.peer.metadata && s.peer.metadata.name) || 'dApp')}</span>
      <button class="btn btn-sm btn-ghost" type="button" data-wc-disconnect="${escapeHtml(s.topic)}">Disconnect</button>
    </div>`).join('');
  root.querySelectorAll('[data-wc-disconnect]').forEach((b) => {
    b.onclick = async () => {
      try {
        await kit.disconnectSession({ topic: b.dataset.wcDisconnect, reason: { code: 6000, message: 'User disconnected.' } });
        toast('Disconnected.', 'info');
        renderSessions(root);
      } catch (e) {
        toast('Disconnect failed: ' + e.message, 'error');
      }
    };
  });
}

/**
 * The pairing sheet. Reached from the dApp browser menu and from the
 * "this page did not load" fallback — both moments where the user is holding a
 * wc: URI with nowhere to put it.
 */
// Tell every connected WalletConnect dApp the ACTIVE ACCOUNT moved — the
// accountsChanged event the injected provider already gets (user report
// 2026-10-08: "bug switch wallet yang sama" — a connected page kept showing
// the previous wallet after the switch). Best-effort by contract: a session
// that will not take the event keeps standing; the wallet itself switched.
export function announceAccountsChanged(address) {
  if (!kit) {
    // After a page reload the sessions are still in storage but the kit is
    // not awake until something pairs — a switch right then must still reach
    // the dApps. ensureKit() is deduped; wake it and re-run once (the guard
    // below stops any recursion if the kit came back without sessions API).
    ensureKit()
      .then(() => { if (kit) announceAccountsChanged(address); })
      .catch(() => { /* relay unavailable — wallet state stands */ });
    return;
  }
  if (typeof kit.getActiveSessions !== 'function') return;
  const list = address ? [address] : [];
  let sessions = [];
  try { sessions = Object.values(kit.getActiveSessions() || {}); } catch { return; }
  for (const s of sessions) {
    try {
      // Emit on a chain the session actually holds — an event filed under a
      // chain outside the namespace is dropped by the relay.
      const acc0 = s?.namespaces?.eip155?.accounts?.[0] || '';
      const p = acc0.split(':');
      const chainId = p.length >= 2 ? `${p[0]}:${p[1]}` : 'eip155:1';
      // The EVENT moves the dApp's UI; the SESSION keeps eth_accounts
      // answering approve-time addresses forever. Sync both, or a dApp that
      // re-reads its session (its own reload, a balance refetch) snaps back
      // to a wallet the user already switched away from.
      const ns = s?.namespaces?.eip155;
      if (address && ns) {
        const chains = Array.isArray(ns.chains) && ns.chains.length
          ? ns.chains
          : [...new Set((ns.accounts || []).map((a) => a.split(':').slice(0, 2).join(':')))];
        if (chains.length) {
          kit.updateSession({
            topic: s.topic,
            namespaces: {
              ...s.namespaces,
              eip155: { ...ns, accounts: chains.map((c) => c + ':' + address) },
            },
          }).catch((e) => console.warn('[wc] session accounts not updated:', (e && e.message) || e));
        }
      }
      kit.emitSessionEvent({
        topic: s.topic,
        chainId,
        // WC session events are keyed by `name` on the wire — the sign-client
        // validator reads event.name and rejects event.type outright
        // ("Missing or invalid. emit() event"), which is why connected dApps
        // never heard an account switch (live proof 2026-10-08).
        event: { name: 'accountsChanged', data: list },
      }).catch((e) => {
        // Silent by contract (the wallet state already moved), but never
        // invisible: live debugging of "dApp still shows the old account"
        // needs to tell an undeliverable event from an ignored one.
        console.warn('[wc] accountsChanged not delivered:', (e && e.message) || e);
      });
    } catch { /* one bad session must not silence the rest */ }
  }
}

export function openPairWalletConnect(prefill = '') {
  openModal(`
    <h2>WalletConnect</h2>
    <p class="small dim">Open the dApp in a browser tab, choose <strong>Connect wallet -&gt; WalletConnect</strong>,
    then paste the <code>wc:</code> URI here. The dApp browses outside; every signature still stops at Bear Tool.</p>
    <div class="field">
      <label for="wcPairUri">Connection URI</label>
      <input class="input" id="wcPairUri" placeholder="wc:..." spellcheck="false" autocomplete="off">
    </div>
    <div class="flex gap-8">
      <button class="btn btn-primary" id="wcPairGo" type="button">Connect</button>
      <button class="btn btn-ghost" id="wcPairPaste" type="button">Paste</button>
      <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
    </div>
    <div id="wcPairMsg" class="small" role="status" aria-live="polite"></div>
    <div id="wcSessions"></div>
  `);

  const msg = document.getElementById('wcPairMsg');
  const input = document.getElementById('wcPairUri');
  const go = document.getElementById('wcPairGo');
  const paste = document.getElementById('wcPairPaste');
  const sessionsRoot = document.getElementById('wcSessions');
  const fill = (uri) => { if (uri) { input.value = uri; input.focus(); input.select(); } };
  fill(prefill);
  // Auto-pick a wc: link the user already copied (the usual flow is: browse
  // the site in an external tab → Connect → WalletConnect → copy). Reading is
  // permission-gated, so every refusal/empty clipboard just falls through —
  // the manual Paste path below is never blocked by this.
  if (!prefill) {
    navigator.clipboard?.readText()
      .then((t) => { const s = (t || '').trim(); if (s.startsWith('wc:')) fill(s); })
      .catch(() => { /* denied or empty — the Paste button stays the answer */ });
  }
  // Auto-paste when the user RETURNS to this window with the sheet still
  // open — the real flow is: open the sheet here → browse the dApp elsewhere
  // → Connect → copy wc: → come back. The open-time read above misses that
  // copy, which used to leave the field empty behind a manual Paste. Pairing
  // still lands on the dApp's proposal consent modal: this removes the paste,
  // never the approval. Each URI is consumed once — a clipboard that still
  // holds it must not re-pair on every focus. (Live-verified 2026-10-09.)
  const seenWc = new Set(prefill ? [prefill] : []);
  const onWcReturn = async () => {
    if (!document.getElementById('wcPairUri')) { window.removeEventListener('focus', onWcReturn); return; }
    try {
      const t = (await navigator.clipboard.readText() || '').trim();
      if (!t.startsWith('wc:') || seenWc.has(t) || !isValidWcUri(t)) return;
      seenWc.add(t);
      fill(t);
      msg.textContent = 'Pairing link found in the clipboard — connecting...';
      go.click();
    } catch { /* clipboard denied — the Paste button stays the answer */ }
  };
  window.addEventListener('focus', onWcReturn);
  // Clipboard read is permission-gated on mobile Chrome: a refusal shows a
  // message instead of throwing — the manual paste path stays open.
  paste.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      fill((text || '').trim());
      if (!input.value) msg.textContent = 'Clipboard is empty.';
    } catch {
      msg.textContent = 'Clipboard refused by the browser — paste manually.';
    }
  };
  input.focus();
  renderSessions(sessionsRoot);

  go.onclick = async () => {
    const uri = (input.value || '').trim();
    if (!isValidWcUri(uri)) {
      // Validation BEFORE any import: a bad paste must never open a socket.
      msg.textContent = 'That does not look like a WalletConnect URI (it must start with "wc:" and carry @relay).';
      return;
    }
    msg.textContent = 'Connecting to the relay...';
    go.disabled = true;
    try {
      const w = await ensureKit();
      await w.pair({ uri });
      msg.textContent = 'Paired. Check the dApp - the connection request is waiting for approval here.';
      toast('WalletConnect pairing started.', 'info');
      renderSessions(sessionsRoot);
    } catch (e) {
      msg.textContent = 'Pairing failed: ' + ((e && e.message) || e);
    } finally {
      go.disabled = false;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go.click(); }
  });
}

/** Close the sheet from outside (e.g. lock). */
export function closePairWalletConnect() {
  try { closeModal(); } catch { /* already closed */ }
}

// A wc: link can reach the wallet two ways, both opening the pair sheet with
// the URI already filled: natively, Android's manifest intent-filter (wc:
// scheme) delivers the link to appUrlOpen; on plain web/PWA the same link can
// arrive as ?wc=<uri> (share sheet, bookmark, desktop shortcut). The
// Capacitor import is lazy and best-effort — without the native plugin the
// event simply never fires and the ?wc= fallback still works.
const wcDeepLinked = new Set();
export function initWcDeepLink() {
  const openFromUrl = (uri) => {
    const u = String(uri || '').trim();
    if (!u.startsWith('wc:') || wcDeepLinked.has(u)) return;
    wcDeepLinked.add(u);
    openPairWalletConnect(u);
    toast('WalletConnect link opened in Bear Tool.', 'info');
  };
  try {
    const q = new URLSearchParams(location.search).get('wc');
    if (q) openFromUrl(q);
  } catch { /* no location (worker context) — nothing to open */ }
  import('@capacitor/app')
    .then(({ App }) => App.addListener('appUrlOpen', ({ url }) => {
      // Android delivers the raw "wc:..." string; a wrapped custom-scheme URL
      // carries it as the wc query param.
      let u = String(url || '');
      try {
        if (!u.startsWith('wc:')) u = new URL(u).searchParams.get('wc') || u;
      } catch { /* raw string stands */ }
      openFromUrl(u);
    }))
    .catch(() => { /* plugin absent — the ?wc= web fallback above still works */ });
}
