// tests/native-dapp.test.js — the native dApp browser's two halves that can be
// proven without an Android device:
//  1) the injected provider script (NATIVE_PROVIDER_SCRIPT) executed in a vm
//     sandbox against a mocked BearNativeBridge — request/response, legacy
//     APIs, notifications, idempotent re-injection;
//  2) source gates on the wiring: the plugin file, the injection hook, the
//     native-over-iframe routing order in both browser entries.
// The Java plugin itself compiles only in an Android build (no SDK on this
// machine) — these gates pin its contract, not its bytecode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROVIDER_SCRIPT } from '../js/native-provider.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makePage() {
  const sent = [];
  const dispatched = [];
  const listeners = {};
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.BearNativeBridge = { postMessage: (json) => sent.push(JSON.parse(json)) };
  // Minimal DOM event shims so the EIP-6963 announce path is exercisable in the vm.
  sandbox.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; };
  sandbox.dispatchEvent = (ev) => { dispatched.push(ev); return true; };
  sandbox.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.removeEventListener = (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); };
  sandbox.fire = (type) => (listeners[type] || []).forEach((fn) => fn({ type }));
  vm.createContext(sandbox);
  vm.runInContext(NATIVE_PROVIDER_SCRIPT, sandbox);
  return { sandbox, sent, dispatched };
}

test('provider script defines window.ethereum with the EIP-1193 surface', () => {
  const { sandbox } = makePage();
  const eth = sandbox.ethereum;
  assert.equal(eth.isBear, true);
  assert.equal(eth.isMetaMask, false, 'claiming isMetaMask would lie about who signs');
  for (const fn of ['request', 'enable', 'send', 'sendAsync', 'on', 'removeListener']) {
    assert.equal(typeof eth[fn], 'function', fn + ' missing');
  }
});

test('request() bridges to native and resolves via __bearNativeResolve', async () => {
  const { sandbox, sent } = makePage();
  const p = sandbox.ethereum.request({ method: 'eth_requestAccounts', params: [] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'eth_requestAccounts');
  assert.equal(typeof sent[0].id, 'number');
  sandbox.__bearNativeResolve(sent[0].id, { result: ['0xAbC0000000000000000000000000000000000001'] });
  const accounts = await p;
  assert.deepEqual(accounts, ['0xAbC0000000000000000000000000000000000001']);
  assert.equal(sandbox.ethereum.selectedAddress, accounts[0], 'selectedAddress must track eth_requestAccounts');
});

test('an error response rejects with the wallet error code', async () => {
  const { sandbox, sent } = makePage();
  const p = sandbox.ethereum.request({ method: 'personal_sign', params: ['0x6869', '0x0'] });
  sandbox.__bearNativeResolve(sent[0].id, { error: { code: 4001, message: 'User rejected the request.' } });
  await assert.rejects(p, (e) => e.code === 4001 && /rejected/.test(e.message));
});

test('re-injection is idempotent (onPageStarted fires per navigation)', () => {
  const { sandbox } = makePage();
  const before = sandbox.ethereum;
  vm.runInContext(NATIVE_PROVIDER_SCRIPT, sandbox); // second navigation
  assert.equal(sandbox.ethereum, before, 'provider object must not be replaced');
});

test('provider announces itself via EIP-6963 and answers requestProvider', () => {
  const { sandbox, dispatched } = makePage();
  const ann = dispatched.filter((e) => e.type === 'eip6963:announceProvider');
  assert.equal(ann.length, 1, 'announceProvider fired once on inject');
  const detail = ann[0].detail;
  assert.equal(detail.provider, sandbox.ethereum, 'detail.provider is the injected provider');
  assert.equal(detail.info.name, 'Bear Tool');
  assert.equal(detail.info.rdns, 'com.nemoobc.beartool', 'rdns must be a valid reverse-DNS id');
  assert.match(detail.info.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid v4 shape');
  assert.match(detail.info.icon, /^data:image\//, 'icon must be a data URI');
  sandbox.fire('eip6963:requestProvider');
  assert.equal(dispatched.filter((e) => e.type === 'eip6963:announceProvider').length, 2, 're-announce on requestProvider');
});

test('notifications update state and reach page listeners', () => {
  const { sandbox } = makePage();
  const seen = [];
  sandbox.ethereum.on('accountsChanged', (a) => seen.push(a));
  sandbox.__bearNativeNotify({ event: 'accountsChanged', data: ['0xDef0000000000000000000000000000000000002'] });
  assert.deepEqual(seen, [['0xDef0000000000000000000000000000000000002']]);
  assert.equal(sandbox.ethereum.selectedAddress, '0xDef0000000000000000000000000000000000002');
});

test('legacy send() and sendAsync() keep old dApps working', async () => {
  const { sandbox, sent } = makePage();
  const r = sandbox.ethereum.send('eth_chainId', []);
  assert.equal(sent[0].method, 'eth_chainId');
  sandbox.__bearNativeResolve(sent[0].id, { result: '0x1' });
  assert.equal(await r, '0x1');
  await new Promise((resolve) => {
    sandbox.ethereum.sendAsync({ id: 9, method: 'net_version', params: [] }, (err, res) => {
      assert.equal(err, null);
      assert.equal(res.id, 9);
      assert.equal(res.result, '0x1');
      resolve();
    });
    sandbox.__bearNativeResolve(sent[1].id, { result: '0x1' });
  });
});

test('a missing bridge rejects instead of hanging the page', async () => {
  const sandbox = { console, Promise, JSON };
  sandbox.window = sandbox; // no BearNativeBridge on purpose
  vm.createContext(sandbox);
  vm.runInContext(NATIVE_PROVIDER_SCRIPT, sandbox);
  await assert.rejects(sandbox.ethereum.request({ method: 'eth_chainId' }), /bridge unavailable/i);
});

test('Android plugin carries the full transport contract', () => {
  const src = readFileSync(join(root, 'android/app/src/main/java/com/nemoobc/beartool/BearDappBrowserPlugin.java'), 'utf8');
  assert.match(src, /@CapacitorPlugin\(name = "BearDappBrowser"\)/, 'plugin annotation');
  assert.match(src, /addJavascriptInterface\(new Bridge\(\), "BearNativeBridge"\)/, 'page-facing interface name must match the provider script');
  assert.match(src, /onPageStarted/, 'provider injected at onPageStarted');
  assert.match(src, /window\.__bearNativeResolve\(/, 'resolve path into the dApp page');
  assert.match(src, /getUrl\(\)/, 'origin taken from the native side, never the page');
  assert.match(src, /MAX_MESSAGE_LENGTH/, 'page→native message size cap present');
  assert.match(src, /json\.length\(\) > MAX_MESSAGE_LENGTH/, 'oversized page message dropped before the JSON parser');
  assert.match(src, /isWebDocument\(url\)/, 'provider injection gated to web documents (no PDF/XML)');
});

test('MainActivity registers the plugin BEFORE super.onCreate (or the bridge never sees it)', () => {
  let ma = readFileSync(join(root, 'android/app/src/main/java/com/nemoobc/beartool/MainActivity.java'), 'utf8');
  ma = ma.replace(/\/\/.*$/gm, ''); // strip line comments so prose can't shadow the real call
  const iReg = ma.indexOf('registerPlugin(BearDappBrowserPlugin.class)');
  const iSuper = ma.indexOf('super.onCreate(');
  assert.ok(iReg > -1, 'MainActivity must registerPlugin(BearDappBrowserPlugin.class)');
  assert.ok(iSuper > -1, 'MainActivity must call super.onCreate');
  assert.ok(iReg < iSuper,
    'registerPlugin must run BEFORE super.onCreate — the bridge is built inside it (BridgeActivity.load→create); after it, staging a plugin has no effect');
});

test('native dApp browser has pull-to-refresh (SwipeRefreshLayout wraps the WebView)', () => {
  const src = readFileSync(join(root, 'android/app/src/main/java/com/nemoobc/beartool/BearDappBrowserPlugin.java'), 'utf8');
  assert.match(src, /SwipeRefreshLayout/, 'SwipeRefreshLayout used');
  assert.match(src, /setOnRefreshListener/, 'a pull registers a refresh listener');
  assert.match(src, /dappView\.reload\(\)/, 'releasing the pull reloads the current page');
  assert.match(src, /setRefreshing\(false\)/, 'spinner stops when the page finishes');
  const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
  assert.match(gradle, /androidx\.swiperefreshlayout:swiperefreshlayout/, 'SwipeRefreshLayout dependency declared');
});

test('native routing wins BEFORE the iframe machinery in both browser entries', () => {
  const dbr = readFileSync(join(root, 'js/dapp-browser.js'), 'utf8');
  const iGuard = dbr.indexOf('isNativeDappBrowser())');
  const iOverlay = dbr.indexOf('if (!overlay) build();');
  assert.ok(iGuard > -1 && iOverlay > -1 && iGuard < iOverlay,
    'openDappBrowser must branch to native before building the iframe overlay');
  const dapps = readFileSync(join(root, 'js/dapps.js'), 'utf8');
  const g2 = dapps.indexOf('isNativeDappBrowser())');
  const f2 = dapps.indexOf('frameable === false');
  assert.ok(g2 > -1 && f2 > -1 && g2 < f2,
    'dapps.js must skip the web-only frameable/notice branch in native mode');
  const app = readFileSync(join(root, 'js/app.js'), 'utf8');
  assert.match(app, /initNativeDappRpc/, 'wallet app boots the native RPC listener');
});

test('native RPC glue refuses to sign while locked and falls back honestly', () => {
  const src = readFileSync(join(root, 'js/native-dapp.js'), 'utf8');
  assert.match(src, /code: 5100/, 'locked wallet answers 5100 like the WalletConnect path');
  assert.match(src, /code: 4200/, 'unknown methods get 4200, not silence');
  assert.match(src, /User rejected the request/, 'user rejection is a proper EIP-1193 error');
  assert.doesNotMatch(src, /isMetaMask: true/, 'the glue must never claim to be MetaMask');
});

// TEMPORARY diagnostic build (remove once the "not implemented" root cause is
// pinned on device) — pin the instrumentation so it cannot be lost silently,
// and so removing it later is a deliberate, visible act.
test('diagnostic build: open failures surface verbatim + plugin ping at boot', () => {
  const src = readFileSync(join(root, 'js/native-dapp.js'), 'utf8');
  assert.match(src, /open failed: /,
    'openNativeDapp toasts the exact failure — the old silent catch hid the root cause');
  assert.match(src, /diagNativeDapp\(\); \/\/ TEMPORARY/,
    'boot runs the bridge-state diagnostic on native');
  assert.match(src, /ping\.back=/, 'the diagnostic reports the native ping result');
  assert.match(src, /ping timeout 2500ms/, 'a hung bridge is reported, not hung forever');
  const apk = readFileSync(join(root, '.github/workflows/apk.yml'), 'utf8');
  assert.match(apk, /VITE_BUILD_SHA: \$\{\{ github\.sha \}\}/,
    'the CI build stamps its own commit into the bundle so a screenshot names the build');
});
