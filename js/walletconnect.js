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
// The heavy dependency is imported dynamically inside ensureKit(): importing
// this module costs nothing at boot and opens no socket until the user
// actually pastes a wc: URI.
import { openModal, closeModal, confirmTx, escapeHtml, toast } from './ui.js';
import { get } from './state.js';

export const WC_PROJECT_ID = '99909bde486039e2102663b92be74974';

// Exactly the methods this wallet will answer — what the session grants is
// what the confirm dialog can actually deliver. eth_sign is absent on
// purpose: it signs raw digests with no readable content, and MetaMask refuses
// it by default for the same reason.
export const WC_SIGN_METHODS = ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'];

const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };
const METHOD_UNSUPPORTED = { code: -32601, message: 'Method not supported by Bear Tool.' };

let kit = null;
let initing = null;

// -- pure helpers (unit-tested without a browser or a network) -------------

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

async function ensureKit() {
  if (kit) return kit;
  if (!initing) {
    initing = (async () => {
      const [{ WalletKit }, { Core }] = await Promise.all([
        import('@reown/walletkit'),
        import('@walletconnect/core'),
      ]);
      const core = Core.init({ projectId: WC_PROJECT_ID });
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
      w.on('session_delete', () => toast('WalletConnect session closed by the dApp.', 'info'));
      kit = w;
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
      { k: 'Can request', v: WC_SIGN_METHODS.join(', ') },
    ],
    confirmText: 'Connect',
  });
  if (!ok) {
    await kit.rejectSession({ id, reason: USER_REJECTED }).catch(() => {});
    return;
  }
  await kit.approveSession({
    id,
    namespaces: {
      eip155: {
        accounts: chains.map((c) => c + ':' + addr),
        chains,
        methods: WC_SIGN_METHODS,
        events: ['chainChanged', 'accountsChanged'],
      },
    },
  });
  toast('Connected to ' + dappName + '.', 'info');
}

async function handleRequest({ id, topic, params }) {
  const method = params?.request?.method;
  const chainId = params?.chainId || 'eip155:1';
  const signer = get('signer');
  if (!signer) {
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
      confirmText: 'Sign',
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    return respond(topic, id, await signer.signMessage(hexToBytes(hex)));
  }

  if (method === 'eth_signTypedData_v4') {
    const raw = params.request.params && params.request.params[1];
    let parsed = {};
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { parsed = {}; }
    const domain = parsed.domain || {};
    const ok = await confirmTx({
      title: 'Sign typed data?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'Domain', v: String(domain.name || '?') + (domain.version ? ' v' + domain.version : '') },
        { k: 'Primary type', v: String(parsed.primaryType || '?') },
        { k: 'Account', v: shortAddr(signer.address) },
      ],
      confirmText: 'Sign',
    });
    if (!ok) return respondError(topic, id, USER_REJECTED);
    const types = { ...(parsed.types || {}) };
    delete types.EIP712Domain;
    return respond(topic, id, await signer.signTypedData(domain, types, parsed.message || {}));
  }

  if (method === 'eth_sendTransaction') {
    const tx = { ...((params.request.params && params.request.params[0]) || {}) };
    const provider = get('provider');
    if (!provider) {
      return respondError(topic, id, { code: -32000, message: 'No provider for the current network.' });
    }
    const ok = await confirmTx({
      title: 'Send transaction?',
      rows: [
        { k: 'Chain', v: chainId },
        { k: 'To', v: shortAddr(tx.to || '') },
        { k: 'Value', v: fmtValue(tx.value) },
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

function fmtValue(v) {
  if (v === undefined || v === null || v === '') return '0';
  try {
    if (globalThis.ethers && globalThis.ethers.formatEther) return globalThis.ethers.formatEther(v) + ' ETH';
  } catch { /* fall through to raw */ }
  return String(v);
}

// -- UI --------------------------------------------------------------------

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
export function openPairWalletConnect(prefill = '') {
  openModal(`
    <button class="modal-close" type="button" data-close-modal>Close</button>
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
