// js/native-provider.js — the EIP-1193 provider script that gets injected INTO
// the native dApp WebView (Capacitor plugin BearDappBrowser) BEFORE the page's
// own scripts run, the same role InpageBridgeWeb3.js plays in MetaMask Mobile
// (app/components/Views/BrowserTab/BrowserTab.tsx:1787, cloned 2026-10-09).
//
// Transport: window.BearNativeBridge.postMessage(json) — an @JavascriptInterface
// the Android plugin adds to the dApp WebView only. Responses come back via
// window.__bearNativeResolve(id, response) (evaluateJavascript from native),
// notifications (accountsChanged/chainChanged) via window.__bearNativeNotify.
//
// The script is a STRING on purpose: the native side cannot reach into the
// wallet bundle's modules, so everything the dApp page needs must travel as
// one self-contained, idempotent IIFE. Idempotent because onPageStarted fires
// on every navigation and re-injection must never double-define the provider.
export const NATIVE_PROVIDER_SCRIPT = `(function () {
  if (window.ethereum && window.ethereum.isBear) return; // already injected (re-navigation)
  var seq = 0;
  var pending = {};
  var handlers = {};
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return provider; }
  function off(evt, fn) { handlers[evt] = (handlers[evt] || []).filter(function (f) { return f !== fn; }); return provider; }
  function emit(evt, data) { (handlers[evt] || []).forEach(function (f) { try { f(data); } catch (e) {} }); }
  function request(args) {
    var method = args && args.method;
    if (!method) return Promise.reject(new Error('method required'));
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        window.BearNativeBridge.postMessage(JSON.stringify({ id: id, method: method, params: (args && args.params) || [] }));
      } catch (e) {
        delete pending[id];
        reject(new Error('Bear bridge unavailable: ' + (e && e.message)));
      }
    }).then(function (result) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') provider.selectedAddress = (result && result[0]) || null;
      if (method === 'eth_chainId') provider.chainId = result;
      if (method === 'wallet_switchEthereumChain' && args && args.params && args.params[0]) provider.chainId = args.params[0].chainId;
      return result;
    });
  }
  window.__bearNativeResolve = function (id, response) {
    var p = pending[id];
    // The return value is diagnosis, not protocol: the native side logs it
    // (run 38034404898 lost a resolve with every hop silent — the dapp view
    // has no WebChromeClient, so an evaluateJavascript failure logs NOTHING).
    // 'unknown-id' = the pending map lost the request (re-injection, wrong id);
    // 'resolved'/'error-sent' = the page's promise was settled for real.
    if (!p) return 'unknown-id'; // late/duplicate resolve — drop, never throw into the page
    delete pending[id];
    if (response && response.error) {
      var err = new Error(response.error.message || 'Request failed');
      if (response.error.code) err.code = response.error.code;
      p.reject(err);
      return 'error-sent';
    }
    p.resolve(response ? response.result : undefined);
    return 'resolved';
  };
  window.__bearNativeNotify = function (payload) {
    try {
      if (payload && payload.event === 'accountsChanged') provider.selectedAddress = (payload.data && payload.data[0]) || null;
      if (payload && payload.event === 'chainChanged') provider.chainId = payload.data;
      if (payload) emit(payload.event, payload.data);
    } catch (e) { /* a broken listener must not break the page */ }
  };
  var provider = {
    isBear: true,
    // Some dApps branch on isMetaMask to pick their WalletConnect fallback;
    // claiming it would be a lie about who signs. They must cope or fall back.
    isMetaMask: false,
    chainId: null,
    selectedAddress: null,
    request: request,
    enable: function () { return request({ method: 'eth_requestAccounts' }); }, // legacy EIP-1102
    send: function (methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') return request({ method: methodOrPayload, params: paramsOrCallback });
      if (typeof paramsOrCallback === 'function') { provider.sendAsync(methodOrPayload, paramsOrCallback); return; }
      return request({ method: methodOrPayload.method, params: methodOrPayload.params });
    },
    sendAsync: function (payload, callback) {
      request({ method: payload.method, params: payload.params })
        .then(function (result) { callback(null, { id: payload.id, jsonrpc: '2.0', result: result }); })
        .catch(function (e) { callback(e, { id: payload.id, jsonrpc: '2.0', error: { code: e.code || -32000, message: e.message } }); });
    },
    on: on,
    removeListener: off,
    addListener: on,
    off: off,
  };
  try {
    Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });
  } catch (e) {
    window.ethereum = provider; // very old engines without defineProperty guard
  }
  // ── EIP-6963: Multi Injected Provider Discovery ───────────────────────
  // dApps built since 2024 find wallets through this event, not just the
  // window.ethereum global (MetaMask, Brave, Rabby, Rainbow all announce —
  // research 2026-10-09). Without it a dApp can fail to SEE Bear Tool even
  // though the provider object is sitting right there. announceProvider is
  // fired once here and re-fired whenever the page asks via requestProvider.
  function _uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }
  var _info = Object.freeze({
    uuid: _uuid(),
    name: 'Bear Tool',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="34" r="20" fill="%238b5a2b"/><circle cx="18" cy="16" r="8" fill="%238b5a2b"/><circle cx="46" cy="16" r="8" fill="%238b5a2b"/><circle cx="24" cy="32" r="3" fill="%23000"/><circle cx="40" cy="32" r="3" fill="%23000"/><ellipse cx="32" cy="43" rx="7" ry="4" fill="%23d2b48c"/></svg>',
    rdns: 'com.nemoobc.beartool',
  });
  function _announce() {
    try {
      // Guarded: a test vm / very old engine without events still gets a working
      // window.ethereum — discovery is a bonus, never a hard dependency.
      if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: _info, provider: provider }) }));
    } catch (e) { /* ignore */ }
  }
  _announce();
  try { if (typeof window.addEventListener === 'function') window.addEventListener('eip6963:requestProvider', _announce); } catch (e) { /* ignore */ }
  emit('connect', { chainId: provider.chainId });
})();`;
