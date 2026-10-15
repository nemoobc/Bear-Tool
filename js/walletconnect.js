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
import { renderSignMessage, stripInvisible as stripInvisibleShared, typedDataFields } from './sign-render.js';
import { openModal, closeModal, confirmTx, escapeHtml, toast } from './ui.js';
import { t } from './i18n.js';
import { get, set, requireUnlock } from './state.js';
import { getNetworkById, getNetwork, sanitizeChainRequest, installRequestedChain, rpcLabel } from './network.js';
// The user's own site lists and the same pre-load gate the dApp browser
// applies (blocklist / phishing shapes) — a pairing request is a site asking
// for keys, so it is vetted by the same rules before its sheet appears.
import { listBlocked, listTrusted } from './dapp-sessions.js';
import { inspectUrl, VERDICT } from './dapp-safety.js';
// One source of truth shared with the injected and native paths: split both
// personal_sign param orders, validate typed data, build/validate a send
// transaction (buildSendTx), run the security detectors (scanSignCall), and
// guard the chain a broadcast actually goes out on. This path re-implemented
// each by hand and disagreed with the others about what was even signable —
// see the branches below.
import { splitSignParams, splitTypedParams, parseTyped, typedParts, providerOnCurrentChain, buildSendTx, scanSignCall, signPayload, currentChainId } from './dapp-exec.js';

export const WC_PROJECT_ID =
  (import.meta.env && import.meta.env.VITE_WC_PROJECT_ID) || '99909bde486039e2102663b92be74974';

// Public home of the web build — what the dApp reads from the session metadata
// (name / url / icons) and shows in its own connection prompt. It CANNOT be
// location.origin: inside the Android app the WebView serves from
// https://localhost, which no dApp can fetch — the prompt rendered a broken
// icon and a "localhost" homepage. Override per build with VITE_PUBLIC_URL.
export const WC_PUBLIC_URL =
  (import.meta.env && import.meta.env.VITE_PUBLIC_URL) || 'https://nemoobc.github.io/Bear-Tool/';

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

/** Hex payload -> readable preview. personal_sign sends UTF-8 as hex; some
 *  dApps send bytes that are not text at all, so failures degrade to the raw
 *  hex instead of throwing inside a confirm dialog. */

// -- runtime (needs a real wallet + network) -------------------------------

function address() {
  return get('signer')?.address || '';
}

// Both of these used to be implemented HERE as well as in the approval sheets,
// which is how the native sheet ended up showing "104,101,108,108,111" while
// this one showed "hello". They are now the shared implementation, re-exported
// under the names this file has always used.
export const stripInvisible = stripInvisibleShared;
export const hexToPreview = renderSignMessage;

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
          url: WC_PUBLIC_URL,
          icons: [new URL('assets/bear-512.png', WC_PUBLIC_URL).href, new URL('assets/bear.svg', WC_PUBLIC_URL).href],
        },
      });
      w.on('session_proposal', (args) => { handleProposal(args).catch((e) => toast('WalletConnect: ' + e.message, 'error')); });
      // Every request MUST end in a respond() — success, refusal, or error.
      //
      // The engine marks its request queue "active" on emit and only clears it
      // inside respond() (or when a request expires, which takes days). handleRequest
      // had three awaits that throw in ordinary use — signMessage, signTypedData,
      // and a sendTransaction that fails on insufficient funds, a stale nonce, a
      // reverting estimate or a dead RPC — and none of them were caught here, so
      // the catch only showed a toast. The queue stayed active and every LATER
      // request from EVERY paired dApp was dropped in silence: the dApp spins on
      // "signing…" forever, no error reaches anyone, and the only cure is an app
      // restart. One insufficient-funds error was enough to do it.
      w.on('session_request', (args) => {
        const { id, topic } = args;
        handleRequest(args).catch(async (e) => {
          toast('WalletConnect: ' + (e && e.message ? e.message : String(e)), 'error');
          try {
            await respondError(topic, id, {
              code: -32603,
              message: (e && e.message) || 'The request could not be completed.',
            });
          } catch { /* the dApp is gone too; nothing left to tell */ }
        });
      });
      w.on('session_delete', (args) => {
        // Topics WE disconnected during re-approve cleanup are not the dApp
        // closing anything — no toast for those.
        const topicId = args && args.topic;
        if (topicId && silentDeleteTopics.delete(topicId)) return;
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
  const dappUrl = String(params?.proposer?.metadata?.url || '');
  const chains = collectEip155Chains(params?.requiredNamespaces, params?.optionalNamespaces);
  const addr = address();
  if (!addr) {
    await kit.rejectSession({ id, reason: { code: 5100, message: 'Wallet is locked.' } }).catch(() => {});
    toast('Unlock Bear Tool before connecting a dApp.', 'error');
    return;
  }
  // The same pre-load gate the dApp browser applies to a site before it loads
  // (dapp-safety.js). A pairing request is that site asking for the keys, and
  // it used to arrive with zero risk signal — the sheet showed a name the dApp
  // picked for itself and nothing else, so a homograph or phishing host got
  // the same treatment as a catalogue app. A host the user BLOCKED, or one
  // matching the shapes phishing actually uses, is refused BEFORE the sheet:
  // the browser's own report sheet offers no "open anyway" for a DANGER site,
  // and neither does this.
  let safety = null;
  try {
    if (/^https?:\/\//i.test(dappUrl)) {
      safety = inspectUrl(dappUrl, [], { blockedHosts: listBlocked(), trustedHosts: listTrusted() });
    }
  } catch { safety = null; }
  if (safety && (safety.verdict === VERDICT.BLOCKED || safety.verdict === VERDICT.DANGER)) {
    const why = safety.signals && safety.signals[0];
    await kit.rejectSession({ id, reason: { code: 4001, message: 'This site is blocked in Bear Tool.' } }).catch(() => {});
    toast(`Blocked ${safety.host || dappUrl}: ${why ? why.label : 'flagged by the site checks'}.`, 'error');
    return;
  }
  const ok = await confirmTx({
    title: t('site.connectTitle', { site: dappName }),
    rows: [
      { k: t('site.site'), v: dappName },
      ...(safety && safety.host ? [{ k: t('wc.host'), v: safety.host }] : []),
      ...(safety && safety.signals && safety.signals.length
        ? [{ k: t('cf.flags'), v: safety.signals.map((s) => `${s.level.toUpperCase()}: ${s.label}`).join(' · ') }]
        : []),
      { k: t('site.account'), v: shortAddr(addr) },
      { k: t('wc.chains'), v: chains.join(', ') },
      { k: t('site.canRequest'), v: WC_SESSION_METHODS.join(', ') },
    ],
    confirmText: t('site.connect'),
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
  const dappUrlNorm = dappUrl.toLowerCase().replace(/\/+$/, '');
  const staleTopics = dappUrlNorm
    ? Object.values(kit.getActiveSessions?.() || {})
        .filter((s) => String(s?.peer?.metadata?.url || '').toLowerCase().replace(/\/+$/, '') === dappUrlNorm)
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

  // The same transaction detectors the injected path runs before its sheet
  // (scanSignCall, dapp-exec.js). They lived in app.js only, so this path —
  // and the native one — showed no findings at all while the Security Center
  // said "every signing or spending call from a dApp is scanned". A request
  // that is not a transaction yields [] and its sheet is unchanged.
  const findings = scanSignCall(method, (params.request && params.request.params) || []);
  const worst = findings.find((f) => f.level === 'fail') || findings.find((f) => f.level === 'warn');
  const peer = wcPeerName(topic);

  if (method === 'personal_sign') {
    // BOTH orders — [message, address] is the spec, [address, message] the
    // legacy one real dApps still send. Taking params[0] blindly signed the
    // ADDRESS's 20 bytes as the message: the old local hex converter happily
    // turned it into bytes, the dialog previewed "(binary, 20 bytes)", and the
    // signature verified over the wrong payload, so the dApp's login check
    // failed after the user approved something they could not read.
    // splitSignParams is the same function the injected signer uses
    // (dapp-exec.js).
    const { message: hex } = splitSignParams(params.request.params || []);
    if (hex == null) {
      return respondError(topic, id, { code: 32602, message: 'personal_sign expects [message, address].' });
    }
    const ok = await confirmTx({
      title: t('sign.title'),
      danger: !!(worst && worst.level === 'fail'),
      rows: [
        ...(peer ? [{ k: t('cf.site'), v: peer }] : []),
        { k: t('site.chain'), v: chainId },
        { k: t('site.account'), v: shortAddr(signer.address) },
        { k: t('site.message'), v: hexToPreview(hex) },
        ...(findings.length ? [{ k: t('cf.flags'), v: findings.map((f) => `${f.level.toUpperCase()}: ${f.title}`).join(' · ') }] : []),
        ...(worst ? [{ k: t('cf.why'), v: worst.detail }] : []),
      ],
      confirmText: worst && worst.level === 'fail' ? t('cf.sendAnyway') : t('sign.action'),
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    // signPayload (dapp-exec.js), NOT a local converter: the old local
    // hexToBytes floored the last nibble off an odd-length hex string, so the
    // signature covered different bytes than the sheet had previewed. The
    // shared function and sign-render.js agree byte for byte.
    return respond(topic, id, await signer.signMessage(signPayload(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    // BOTH orders — [address, typedData] (the convention real dApps send) and
    // the legacy [typedData, address]. splitTypedParams finds the payload by
    // SHAPE (object / JSON string), never by address length: a40-hex rule
    // rejects stand-in addresses like "0x0", reads them as the payload, and
    // the parse below dies — the wallet answers 32602 with no sheet at all.
    const { typed } = splitTypedParams(params.request.params || []);
    if (typed == null) {
      return respondError(topic, id, { code: 32602, message: 'Expected [typedData, address].' });
    }
    // parseTyped/typedParts THROW 32602 on anything that cannot be signed —
    // that is their job. The local try/catch they replace turned every failure
    // into {}: the chain guard then saw no chainId (so refused nothing), the
    // dialog showed all-"?" rows, and the wallet signed EMPTY DATA. A dApp
    // sending an unparseable payload got a useless signature instead of the
    // 32602 it can correct and retry on. Same functions as the injected and
    // native paths, so all three accept and refuse identical payloads.
    let parsed, domain, types, message;
    try {
      parsed = parseTyped(typed);
      ({ domain, types, message } = typedParts(parsed));
    } catch (e) {
      return respondError(topic, id, { code: (e && e.code) || 32602, message: (e && e.message) || String(e) });
    }
    // A typed-data signature is only valid for the domain's chain. Signing a
    // Polygon-domain payload while the wallet sits on Ethereum produces a
    // signature the dApp can never use, behind a dialog that looked fine.
    const domChain = Number(domain.chainId);
    const localNet = getNetworkById(get('networkId'));
    const localLabel = `${localNet?.name} (chain ${localNet?.chainId})`;
    if (Number.isFinite(domChain) && localNet && Number(localNet.chainId) !== domChain) {
      const msg = `This signature targets chain ${domChain}, but Bear Tool is on ${localLabel}. Switch network first — nothing was signed.`;
      toast(msg, 'error');
      return respondError(topic, id, { code: -32000, message: msg });
    }
    const ok = await confirmTx({
      title: t('sign.typedTitle'),
      danger: !!(worst && worst.level === 'fail'),
      rows: [
        ...(peer ? [{ k: t('cf.site'), v: peer }] : []),
        { k: t('site.chain'), v: chainId },
        { k: t('site.domain'), v: String(domain.name || '?') + (domain.version ? ' v' + domain.version : '') },
        { k: t('site.primaryType'), v: String(parsed.primaryType || '?') },
        // The fields themselves — the same flattener the native sheet uses
        // (typedDataFields, sign-render.js). The type name is chosen by the
        // site, and a payload that moves tokens can call itself "Mail"; this
        // path used to show only the name.
        ...typedDataFields(message).slice(0, 8).map((f) => ({ k: f.k, v: f.v })),
        { k: t('site.account'), v: shortAddr(signer.address) },
        ...(findings.length ? [{ k: t('cf.flags'), v: findings.map((f) => `${f.level.toUpperCase()}: ${f.title}`).join(' · ') }] : []),
        ...(worst ? [{ k: t('cf.why'), v: worst.detail }] : []),
      ],
      confirmText: worst && worst.level === 'fail' ? t('cf.sendAnyway') : t('sign.action'),
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    // `types` already has EIP712Domain stripped and `message` is already the
    // object-or-{} the signer needs — typedParts owns both, exactly as in the
    // injected and native paths, so the local copy/delete/default is gone.
    return respond(topic, id, await signer.signTypedData(domain, types, message));
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
      const msg = `This dApp asked for chain ${reqChain}, but Bear Tool is on ${`${localNet.name} (chain ${localNet.chainId})`}. Switch network in Bear Tool and ask again — nothing was sent.`;
      toast(msg, 'error');
      return respondError(topic, id, { code: -32000, message: msg });
    }
    // The SAME validator the injected and native paths call (buildSendTx,
    // dapp-exec.js): a malformed request → 32602 — the old `|| {}` fallback
    // turned a dApp that sent its transaction as an object (not the [tx]
    // array every real dApp sends) into a sheet with empty rows and a garbage
    // send — plus a foreign `from` → 4100, the transaction's own chainId →
    // 4902, `to`/`data` format, field whitelist and BigInt. Refusals reach
    // the dApp as-is so it can correct the request.
    let tx;
    try {
      tx = buildSendTx((params.request.params || [])[0], {
        activeAddress: signer.address || get('address') || '',
        chainId: Number(localNet?.chainId) || currentChainId(),
      });
    } catch (e) {
      return respondError(topic, id, { code: (e && e.code) || 32602, message: (e && e.message) || String(e) });
    }
    const ok = await confirmTx({
      title: (worst ? (worst.level === 'fail' ? '🚨 ' : '⚠️ ') : '') + t('sign.txTitle'),
      danger: !!(worst && worst.level === 'fail'),
      rows: [
        ...(peer ? [{ k: t('cf.site'), v: peer }] : []),
        { k: t('site.chain'), v: chainId },
        { k: t('site.to'), v: tx.to ? shortAddr(tx.to) : t('sign.contractCreation') },
        { k: t('site.value'), v: fmtValue(tx.value, nativeUnit(localNet)) },
        // The calldata itself, truncated — not a byte count. A user signing a
        // swap must see what the dApp is spending, not "244 bytes".
        { k: t('site.data'), v: tx.data && tx.data !== '0x'
            ? String(tx.data).slice(0, 74) + (String(tx.data).length > 74 ? '…' : '')
            : t('cf.none.a.plain.transfer') },
        ...(findings.length ? [{ k: t('cf.flags'), v: findings.map((f) => `${f.level.toUpperCase()}: ${f.title}`).join(' · ') }] : []),
        ...(worst ? [{ k: t('cf.why'), v: worst.detail }] : []),
      ],
      confirmText: worst && worst.level === 'fail' ? t('cf.sendAnyway') : t('sign.send'),
      // Money line parity with the injected sheet: confirmTx prices the value
      // and the estimated gas for what the dApp asked to send.
      tx: { to: tx.to, data: tx.data, value: tx.value },
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    // Guard the TRANSPORT, not just the id. The chain check at the top of this
    // branch compares against networkId — which activateNetwork() writes
    // SYNCHRONOUSLY, while the provider object is rebuilt later behind a
    // multi-endpoint probe that can even fail and leave the OLD provider in
    // state. So a switch-then-send passed that check against the NEW chain and
    // still broadcast through the OLD provider: wrong chain, dialog naming the
    // right one. Checked here, at the last possible moment, the dialog's own
    // wait has given a transient swap time to land — this refuses only a
    // provider genuinely still elsewhere, which must not broadcast.
    let provider;
    try {
      provider = await providerOnCurrentChain();
    } catch (e) {
      return respondError(topic, id, { code: (e && e.code) || -32603, message: (e && e.message) || String(e) });
    }
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
    // A non-EVM network (BTC/SOL/XRP — receive-only) has NO EVM chain id.
    // Answering the `|| 1` fallback here would tell the dApp "you are on
    // Ethereum" while the wallet's own pill says Bitcoin, and the dApp would go
    // on to build a mainnet transaction the wallet cannot sign. Same refusal as
    // dapp-exec's currentChainId, same code.
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
    // A chain the wallet already knows is SWITCHED to — what dApps actually
    // want, for both methods.
    //
    // A chain the wallet does NOT know is where EIP-3085 says the wallet may
    // ask, and as of 2026-10-15 it does: "wc connect add network gabisa" for
    // a dApp on a new testnet — the flat 4902 left no road forward at all.
    // The raw dApp payload still never installs itself: offerAddChainWc runs
    // it through network.js's sanitizer (https/loopback-only URL, capped
    // name, symbol/decimals clamped), shows a cancel/confirm sheet with the
    // SANITIZED values, and only then registers + probes via
    // installRequestedChain. wallet_switchEthereumChain for an unknown chain
    // keeps returning 4902 (EIP-3326): a switch must not double as an add.
    let net = getNetwork(want);
    if (!net) {
      if (method === 'wallet_switchEthereumChain') return respondError(topic, id, CHAIN_UNKNOWN(want));
      const added = await offerAddChainWc(topic, (params.request.params && params.request.params[0]) || {});
      if (added.error) return respondError(topic, id, added.error);
      net = added.net;
    }
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

// ── EIP-3085, WalletConnect flavour ──────────────────────────────
// Sanitize → cancel/confirm sheet → install. `params0` is the raw
// request params[0]; its rpcUrls are read ONLY inside network.js's
// sanitizer, which is the single gate into the registry.
// @returns {{net:object} | {error:{code:number,message:string}}}
async function offerAddChainWc(topic, params0) {
  const san = sanitizeChainRequest(params0);
  if (!san.ok) return { error: { code: san.code || -32602, message: san.message } };
  const peer = wcPeerName(topic);
  const ok = await confirmTx({
    title: t('dapp.addChain.title'),
    rows: [
      ...(peer ? [{ k: t('cf.site'), v: peer }] : []),
      { k: t('dapp.addChain.name'), v: san.net.name },
      { k: t('dapp.addChain.id'), v: 'eip155:' + san.net.chainId },
      { k: t('dapp.addChain.rpc'), v: rpcLabel(san.net.rpc[0]) },
      { k: t('dapp.addChain.symbol'), v: san.net.symbol },
      { k: t('dapp.addChain.note'), v: t('dapp.addChain.noteText') },
    ],
    confirmText: t('dapp.addChain.confirm'),
  });
  if (!ok) return { error: USER_REJECTED };
  const ins = await installRequestedChain(san.net);
  if (!ins.ok) return { error: { code: ins.code || -32602, message: ins.message } };
  return { net: ins.net };
}

// Session peer name for a confirm sheet — best effort, never blocks the flow.
function wcPeerName(topic) {
  try {
    const meta = kit?.getActiveSessions?.()?.[topic]?.peer?.metadata;
    return String(meta?.name || '').slice(0, 40);
  } catch { return ''; }
}

// -- small runtime helpers -------------------------------------------------

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
    root.innerHTML = `<p class="small dim">${escapeHtml(t('wc.noSessions'))}</p>`;
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
    <div>
      <button class="btn btn-primary btn-block" id="wcPairGo" type="button">Connect</button>
      <button class="btn btn-ghost btn-block mt-8" id="wcPairPaste" type="button">Paste</button>
      <button class="btn btn-ghost btn-block mt-8" type="button" data-close-modal>Cancel</button>
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
      .then((txt) => { const s = (txt || '').trim(); if (s.startsWith('wc:')) fill(s); })
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
    // The sheet is gone: nothing to auto-pair into.
    if (!document.getElementById('wcPairUri')) { window.__bearWcFocusHook = null; return; }
    try {
      const txt = (await navigator.clipboard.readText() || '').trim();
      if (!txt.startsWith('wc:') || seenWc.has(txt) || !isValidWcUri(txt)) return;
      seenWc.add(txt);
      fill(txt);
      msg.textContent = t('wc.clipboardFound');
      go.click();
    } catch { /* clipboard denied — the Paste button stays the answer */ }
  };

  // ONE focus listener for the life of the app, pointing at whatever sheet is
  // currently open. It used to be added on every openPairWalletConnect() and
  // only removed inside its own handler on a LATER focus — so opening the sheet
  // N times stacked N listeners, each with its own `seenWc`, and the next focus
  // made all N run and all N call pair() for the same URI. The duplicates
  // rejected into a "Pairing failed" toast, which is how a perfectly good paste
  // came to look broken.
  if (!window.__bearWcFocusHook) {
    window.__bearWcFocusHook = null;
    window.addEventListener('focus', () => {
      const h = window.__bearWcFocusHook;
      if (typeof h === 'function') h();
    });
  }
  window.__bearWcFocusHook = onWcReturn;
  // Clipboard read is permission-gated on mobile Chrome: a refusal shows a
  // message instead of throwing — the manual paste path stays open.
  paste.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      fill((text || '').trim());
      if (!input.value) msg.textContent = t('wc.clipboardEmpty');
    } catch {
      msg.textContent = t('wc.clipboardDenied');
    }
  };
  input.focus();
  renderSessions(sessionsRoot);

  go.onclick = async () => {
    const uri = (input.value || '').trim();
    if (!isValidWcUri(uri)) {
      // Validation BEFORE any import: a bad paste must never open a socket.
      msg.textContent = t('wc.badUri');
      return;
    }
    msg.textContent = t('wc.connecting');
    go.disabled = true;
    try {
      const w = await ensureKit();
      await w.pair({ uri });
      msg.textContent = t('wc.paired');
      toast('WalletConnect pairing started.', 'info');
      renderSessions(sessionsRoot);
    } catch (e) {
      msg.textContent = t('wc.pairFailed') + ' ' + ((e && e.message) || e);
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
