// M2 (dApps triage) — the WalletConnect transaction path.
//
// handleRequest needs a live kit and DOM dialogs, so what it now DELEGATES to
// is executed here (pure helpers), and the wiring inside handleRequest is
// asserted from source — the same bargain dapp-browser-imports makes.
//
// The bugs these guard, all from reading the flow end to end (2026-10-04):
//   1. `chainId` in the confirm dialog was decoration — the tx was signed with
//      the LOCAL provider whatever the dApp asked for, so a dApp on Polygon
//      could push a transaction onto Ethereum behind a row that said
//      "eip155:137". Same class of mismatch for EIP-712 domain.chainId.
//   2. WC dApps send `gas`; ethers v6 reads gasLimit and drops `gas`, so the
//      dApp's own limit never reached the node.
//   3. fmtValue labelled EVERY native value "ETH" on every chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// state.js talks to localStorage on first get().
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

const wc = await import('../js/walletconnect.js');
const src = readFileSync(new URL('../js/walletconnect.js', import.meta.url), 'utf8');

test('the projectId is a public config constant, build-overridable', () => {
  // Reown FAQ (2026-10-07): "dApps do not need approval in order to use your
  // projectId" — so this is configuration, not a registration flow. The value
  // is public BY DESIGN (client-side relay + origin allowlist), but a build
  // must be able to swap in its own id without touching source.
  assert.match(src, /import\.meta\.env\s*&&\s*import\.meta\.env\.VITE_WC_PROJECT_ID/,
    'a VITE_WC_PROJECT_ID build env can override it');
  assert.equal(wc.WC_PROJECT_ID, '99909bde486039e2102663b92be74974',
    'node (no import.meta.env) lands on the bundled fallback');
  assert.ok(wc.WC_PROJECT_ID.length >= 32, 'and the fallback is a real 32-char id');
});

test('session metadata points at a PUBLIC url, never the WebView origin', () => {
  // A dApp shows name/url/icons from this metadata in its own connection
  // prompt. location.origin is https://localhost inside the Android app — the
  // dApp cannot fetch it, so the prompt showed a broken icon and a "localhost"
  // homepage. It must be the public web build, overridable per build.
  assert.match(src, /export const WC_PUBLIC_URL\s*=\s*[\s\S]{0,120}VITE_PUBLIC_URL/,
    'WC_PUBLIC_URL is build-overridable');
  assert.equal(wc.WC_PUBLIC_URL, 'https://nemoobc.github.io/Bear-Tool/',
    'node (no import.meta.env) lands on the public fallback');
  const meta = src.slice(src.indexOf('metadata: {'), src.indexOf('metadata: {') + 300);
  assert.doesNotMatch(meta, /location\.origin/,
    'metadata url/icons tidak boleh pakai location.origin (https://localhost di app)');
  assert.match(meta, /url: WC_PUBLIC_URL/, 'url = konstanta publik');
  assert.match(meta, /icons: \[new URL\('assets\/bear-512\.png', WC_PUBLIC_URL\)\.href, new URL\('assets\/bear\.svg', WC_PUBLIC_URL\)\.href\]/,
    'icon dibangun dari konstanta publik yang sama — PNG 512 (logo app) dulu, SVG fallback');
});

test('the pair sheet auto-picks a copied wc: link, never blocking on the clipboard', () => {
  // The real flow is copy-then-paste; auto-fill removes the paste. It must
  // (a) only fire when no URI was passed in, (b) only accept something that
  // actually looks like a pairing URI, and (c) swallow every refusal —
  // clipboard-read is permission-gated and a denial must not break the sheet.
  const openFn = src.slice(src.indexOf('export function openPairWalletConnect'));
  assert.match(openFn, /if \(!prefill\)/, 'skipped when a URI was handed in');
  assert.match(openFn, /readText\(\)/, 'reads the clipboard');
  assert.match(openFn, /startsWith\('wc:'\)/, 'only a wc: link is trusted');
  assert.match(openFn, /\.catch\(\(\) => \{/, 'a refused clipboard falls through silently');
});
const browserSrc = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');

// normalizeWcTx (the local alias mapper) is GONE — buildSendTx (dapp-exec.js)
// owns the `gas` spelling together with the validation, so all three send
// paths normalize identically. Its behavioural tests live in
// dapp-exec.test.js, next to the function.


test('nativeUnit falls back to ETH only when the network carries no symbol', () => {
  assert.strictEqual(wc.nativeUnit({ symbol: 'BNB' }), 'BNB');
  assert.strictEqual(wc.nativeUnit({ symbol: 'MATIC' }), 'MATIC');
  assert.strictEqual(wc.nativeUnit({ id: 'custom' }), 'ETH');
  assert.strictEqual(wc.nativeUnit(null), 'ETH');
});

test('sendTransaction path: mismatch refused BEFORE confirm, tx normalized, unit from network', () => {
  const i = src.indexOf("method === 'eth_sendTransaction'");
  assert.ok(i !== -1, 'eth_sendTransaction branch must exist');
  const body = src.slice(i);
  const mismatchAt = body.search(/reqChain !== null/);
  const confirmAt = body.indexOf('confirmTx(');
  assert.ok(mismatchAt !== -1, 'the requested-vs-local chain comparison must exist');
  assert.ok(confirmAt !== -1, 'confirm dialog must exist');
  assert.ok(mismatchAt < confirmAt, 'mismatch must be decided BEFORE the confirm dialog — never behind it');
  assert.match(body, /respondError\(topic, id, \{ code: -32000, message: msg \}\)/,
    'a mismatch must answer the dApp with an error, not send');
  assert.match(body, /buildSendTx\(/,
    'the incoming tx must pass the shared validator (shape, from, chainId, whitelist, gas→gasLimit)');
  assert.match(body, /nativeUnit\(localNet\)/, 'value display must use the active network symbol');
  assert.ok(!/fmtValue\(tx\.value\)\s*\}/.test(body), 'fmtValue must not be called without a unit');
});

test('signTypedData_v4 path: a domain targeting another chain is refused, not signed', () => {
  const i = src.indexOf("method === 'eth_signTypedData_v4'");
  assert.ok(i !== -1, 'eth_signTypedData_v4 branch must exist');
  const body = src.slice(i, src.indexOf("method === 'eth_sendTransaction'", i));
  const guardAt = body.search(/Number\.isNaN\(domChain\)|Number\.isFinite\(domChain\)/);
  const confirmAt = body.indexOf('confirmTx(');
  assert.ok(guardAt !== -1, 'the domain.chainId comparison must exist');
  assert.ok(confirmAt !== -1 && guardAt < confirmAt,
    'domain chain mismatch must be decided BEFORE the confirm dialog');
  assert.match(body, /respondError\(topic, id, \{ code: -32000, message: msg \}\)/,
    'a cross-chain signature must be refused with the reason');
});

test('dApp browser keeps dApp names: go() forwards, Recent/Bookmark chips carry them', () => {
  assert.match(browserSrc, /function go\(raw, name\)/, 'go() must accept the name');
  assert.match(browserSrc, /navigate\(raw, name\)/, 'go() must forward the name to navigate');
  assert.match(browserSrc, /data-open="\$\{escapeHtml\(b\.url\)\}" data-name="\$\{escapeHtml\(b\.name/,
    'bookmark chips must carry data-name');
  assert.match(browserSrc, /data-open="\$\{escapeHtml\(h\.url\)\}" data-name="\$\{escapeHtml\(h\.name/,
    'recent chips must carry data-name');
  assert.match(browserSrc, /go\(b\.dataset\.open, b\.dataset\.name\)/,
    'chip clicks must pass the name — dropping it renames the tab to the hostname');
});

// ── Connect path (2026-10-05): the dApp could not FINISH connecting ────────
// The session granted only the three signing methods. WalletConnect validates
// the approved namespace against the dApp's requiredNamespaces, so a dApp
// asking for eth_accounts / wallet_switchEthereumChain (most do) rejected the
// session outright — "cannot connect", before any signature.

test('the session grants the read/chain methods a dApp needs to connect', () => {
  assert.deepStrictEqual(wc.WC_SIGN_METHODS,
    ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'],
    'the sign/spend set must not drift');
  for (const m of ['eth_chainId', 'net_version', 'eth_accounts', 'eth_requestAccounts',
                   'wallet_switchEthereumChain', 'wallet_addEthereumChain']) {
    assert.ok(wc.WC_READ_METHODS.includes(m), `${m} must be grantable — dApps require it to connect`);
  }
  assert.deepStrictEqual(wc.WC_SESSION_METHODS,
    [...wc.WC_SIGN_METHODS, ...wc.WC_READ_METHODS],
    'the granted namespace = sign/spend + read/chain, no more, no less');
  assert.ok(!wc.WC_SESSION_METHODS.includes('eth_sign'),
    'eth_sign must stay out of the grant — it signs unreadable digests');
  assert.match(src, /methods: WC_SESSION_METHODS/,
    'approveSession must grant WC_SESSION_METHODS — granting WC_SIGN_METHODS here is the bug');
});

test('wallet_switchEthereumChain: unknown chain → 4902, refusal before any write', () => {
  const i = src.indexOf("method === 'wallet_switchEthereumChain'");
  assert.ok(i !== -1, 'the switch branch must exist');
  const body = src.slice(i, src.indexOf('respondError(topic, id, METHOD_UNSUPPORTED)'));
  // Order: parse → known-network lookup → refuse → THEN act.
  const lookupAt = body.indexOf('getNetwork(want)');
  const refuseAt = body.search(/CHAIN_UNKNOWN\(want\)/);
  const actAt = body.indexOf("set('networkId', net.id)");
  assert.ok(lookupAt !== -1 && refuseAt !== -1, 'an unknown chain must be refused');
  assert.ok(refuseAt < actAt, 'the refusal must come BEFORE any state is written');
  assert.match(body, /respond\(topic, id, null\)/, 'a successful switch answers null (EIP-3326)');
  // Covered by both entry points, so an add for a known chain cannot slip through
  // a switch-only check.
  assert.match(src, /method === 'wallet_switchEthereumChain' \|\| method === 'wallet_addEthereumChain'/,
    'switch and add must share one handler');
});

// 2026-10-15 (user: "wc connect add network gabisa", dApp on a new testnet):
// the flat 4902 left no road forward. wallet_addEthereumChain for an UNKNOWN
// chain now OFFERS a sanitized, user-confirmed add — but the dApp's raw
// parameters still never install themselves: the sanitizer is the only gate,
// the sheet shows the sanitized values, and a cancel refuses the dApp.
test('wallet_addEthereumChain: unknown chain → sanitize → sheet → install, never raw', () => {
  const i = src.indexOf("method === 'wallet_switchEthereumChain'");
  const body = src.slice(i, src.indexOf('respondError(topic, id, METHOD_UNSUPPORTED)'));
  assert.match(body, /offerAddChainWc\(topic,/, 'the add path must go through the WC offer helper');
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/rpcUrls|blockExplorerUrls/.test(code),
    'the raw dApp chain parameters must never be touched here — the sanitizer owns them');
  // ...and the helper itself is the only road into the registry.
  const h = src.indexOf('async function offerAddChainWc');
  assert.ok(h !== -1, 'the helper must exist');
  const hb = src.slice(h, src.indexOf('// -- small runtime helpers'));
  assert.match(hb, /sanitizeChainRequest\(params0\)/, 'sanitize before anything');
  assert.match(hb, /await confirmTx\(\{/, 'the user must get a cancel/confirm sheet');
  assert.match(hb, /confirmText: t\('dapp\.addChain\.confirm'\)/, 'the sheet confirms the add explicitly');
  assert.match(hb, /await installRequestedChain\(/, 'only an approved sheet reaches the registry');
  assert.match(hb, /USER_REJECTED/, 'a declined sheet refuses the dApp');
});

test('a dApp-driven switch repaints the wallet and tells the dApp (chainChanged)', () => {
  const i = src.indexOf("method === 'wallet_switchEthereumChain'");
  const body = src.slice(i, src.indexOf('respondError(topic, id, METHOD_UNSUPPORTED)'));
  assert.match(body, /set\('networkId', net\.id\)/, 'the active network must actually change');
  assert.match(body, /localStorage\.setItem\('bear\.networkId', net\.id\)/,
    'the switch must persist — a reload would silently revert it');
  assert.match(body, /import\('\.\/app\.js'\)/,
    'repaint must go through app.js (topbar + dashboard live there)');
  assert.match(body, /app\?\.updateTopbar\?\.\(\)/, 'the network pill must follow the switch');
  assert.match(body, /app\?\.refreshView\?\.\('dashboard'\)/, 'the dashboard must reload on the new chain');
  assert.match(body, /emitSessionEvent/, 'EIP-1193 promises chainChanged — a dApp UI must not have to poll');
  assert.match(body, /return respond\(topic, id, null\)/, 'the dApp must get its null result');
  // app.js must actually export what we call, or the optional call is a silent no-op.
  const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(appSrc, /export function updateTopbar\(\)/,
    'app.js must export updateTopbar — without it the pill lies after a switch');
});

test('accounts and chain id are answered, not refused — connect must be able to finish', () => {
  const fallthrough = src.indexOf('respondError(topic, id, METHOD_UNSUPPORTED)');
  const acct = src.indexOf("method === 'eth_accounts'");
  const chain = src.indexOf("method === 'eth_chainId'");
  assert.ok(acct !== -1 && acct < fallthrough, 'eth_accounts must be handled before the refusal');
  assert.ok(chain !== -1 && chain < fallthrough, 'eth_chainId must be handled before the refusal');
  const acctBody = src.slice(acct, src.indexOf('eth_chainId', acct));
  assert.ok(!acctBody.includes('confirmTx'), 'reading your own address is not a dialog — no prompt');
  assert.match(acctBody, /\[signer\.address\]/, 'accounts = the connected address, the only honest answer');
  // eth_requestAccounts rides the same branch — a dApp reconnecting after
  // approval must not hit -32601.
  assert.match(src, /method === 'eth_accounts' \|\| method === 'eth_requestAccounts'/);
});


// ── S1 (2026-10-16): perketat — one validator, findings, proposal gate ──────
test('eth_sendTransaction runs the SHARED validator, and the sheet shows what is signed', () => {
  const i = src.indexOf("method === 'eth_sendTransaction'");
  const body = src.slice(i, src.indexOf("method === 'eth_accounts'", i));
  assert.match(body, /buildSendTx\(\(params\.request\.params \|\| \[\]\)\[0\]/,
    'the incoming tx must pass the shared validator — malformed shape, from, chainId, whitelist');
  assert.match(body, /t\('sign\.contractCreation'\)/,
    'a missing `to` is a contract creation and must SAY so, not render an empty row');
  assert.match(body, /t\('cf\.none\.a\.plain\.transfer'\)/,
    'no calldata says "plain transfer" — not a bare em-dash');
  assert.match(body, /String\(tx\.data\)\.slice\(0, 74\)/,
    'the sheet shows the calldata itself, truncated — not a byte count');
  assert.match(body, /t\('cf\.flags'\)/, 'security findings reach the WC sheet');
  assert.match(body, /t\('cf\.why'\)/, 'and the worst finding explains itself');
  assert.match(body, /t\('cf\.sendAnyway'\)/, 'a failing finding changes the confirm text');
  assert.match(body, /tx: \{ to: tx\.to, data: tx\.data, value: tx\.value \}/,
    'the money line prices the request, same as the injected sheet');
  assert.match(body, /danger: !!\(worst && worst\.level === 'fail'\)/,
    'danger is driven by findings, not by the mere presence of calldata');
});

test('every WC sign sheet runs the shared detectors and names the peer', () => {
  assert.match(src, /const findings = scanSignCall\(method, \(params\.request && params\.request\.params\) \|\| \[\]\)/,
    'scanSignCall must run on this path — it used to run in app.js only');
  const sign = src.slice(src.indexOf("method === 'personal_sign'"));
  assert.match(sign, /\.\.\.\(peer \? \[\{ k: t\('cf\.site'\), v: peer \}\] : \[\]\)/,
    'the sheets name the paired dApp');
  assert.ok(!/hexToBytes\(/.test(src), 'the local byte converter is gone — signPayload owns it');
  assert.match(src, /signMessage\(signPayload\(hex\)\)/, 'personal_sign signs through the shared converter');
  assert.match(src, /typedDataFields\(message\)\.slice\(0, 8\)/,
    'the WC typed sheet shows the payload FIELDS, like the native one');
});

test('a pairing request is vetted by the same gate as the browser, and refused when blocked', () => {
  const i = src.indexOf('async function handleProposal');
  const body = src.slice(i, src.indexOf('async function handleRequest'));
  assert.match(body, /inspectUrl\(dappUrl, \[\], \{ blockedHosts: listBlocked\(\), trustedHosts: listTrusted\(\) \}\)/,
    "the proposal is scanned with the user's own lists");
  assert.match(body, /safety\.verdict === VERDICT\.BLOCKED \|\| safety\.verdict === VERDICT\.DANGER/,
    'blocked and danger hosts are refused');
  const refuseAt = body.indexOf('This site is blocked in Bear Tool');
  const sheetAt = body.indexOf('confirmTx(');
  assert.ok(refuseAt !== -1 && sheetAt !== -1 && refuseAt < sheetAt,
    'the refusal lands BEFORE the connect sheet');
  assert.match(body, /rejectSession\(\{ id, reason: \{ code: 4001/,
    'the dApp is told the pairing was rejected');
  assert.match(body, /k: t\('wc\.host'\)/, 'the sheet shows the host it actually scanned');
});
