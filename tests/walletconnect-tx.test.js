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
const browserSrc = readFileSync(new URL('../js/dapp-browser.js', import.meta.url), 'utf8');

test('normalizeWcTx maps the WC `gas` spelling onto ethers gasLimit', () => {
  assert.deepStrictEqual(wc.normalizeWcTx({ gas: '0x5208' }), { gasLimit: '0x5208' });
  assert.deepStrictEqual(wc.normalizeWcTx({ gas: '0x1', gasLimit: '0x2' }), { gasLimit: '0x2' },
    'an explicit gasLimit must win over the alias');
  assert.deepStrictEqual(wc.normalizeWcTx({ to: '0xabc', value: '0x0' }), { to: '0xabc', value: '0x0' });
  assert.deepStrictEqual(wc.normalizeWcTx(undefined), {});
  assert.ok(!('gas' in wc.normalizeWcTx({ gas: '0x1' })),
    'the alias must be dropped — ethers v6 must never see the key it ignores');
});

test('wcChainNumber parses eip155 ids and refuses to guess', () => {
  assert.strictEqual(wc.wcChainNumber('eip155:1'), 1);
  assert.strictEqual(wc.wcChainNumber('eip155:137'), 137);
  assert.strictEqual(wc.wcChainNumber('eip155:0'), 0);
  assert.strictEqual(wc.wcChainNumber('solana:5eykt4Us'), null, 'other namespaces are not a number to compare');
  assert.strictEqual(wc.wcChainNumber('eip155:x'), null);
  assert.strictEqual(wc.wcChainNumber(''), null);
  assert.strictEqual(wc.wcChainNumber(undefined), null);
});

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
  assert.match(body, /normalizeWcTx\(/, 'the incoming tx must pass gas→gasLimit normalization');
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

test('wallet_switchEthereumChain: unknown chain → 4902, dApp rpcUrls never installed', () => {
  const i = src.indexOf("method === 'wallet_switchEthereumChain'");
  assert.ok(i !== -1, 'the switch branch must exist');
  const body = src.slice(i, src.indexOf('respondError(topic, id, METHOD_UNSUPPORTED)'));
  // Order: parse → known-network lookup → refuse → THEN act.
  const lookupAt = body.indexOf('getNetwork(want)');
  const refuseAt = body.search(/CHAIN_UNKNOWN\(want\)/);
  const actAt = body.indexOf("set('networkId', net.id)");
  assert.ok(lookupAt !== -1 && refuseAt !== -1, 'an unknown chain must be refused');
  assert.ok(refuseAt < actAt, 'the refusal must come BEFORE any state is written');
  // wallet_addEthereumChain lands in this same branch: switch-if-known only.
  // Comments are stripped first: the WHY-comment above deliberately says
  // "rpcUrls are never installed", and a regex that reads prose as code
  // turns honest documentation into a red test.
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/rpcUrls|blockExplorerUrls|addNetwork|addCustomNetwork/.test(code),
    'the dApp\'s chain parameters must never be installed — only our registry counts');
  assert.match(body, /respond\(topic, id, null\)/, 'a successful switch answers null (EIP-3326)');
  // Covered by both entry points, so an add for a known chain cannot slip through
  // a switch-only check.
  assert.match(src, /method === 'wallet_switchEthereumChain' \|\| method === 'wallet_addEthereumChain'/,
    'switch and add must share one handler');
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
