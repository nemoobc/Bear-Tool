package com.nemoobc.beartool;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * BearDappBrowser — the native dApp browser, MetaMask-Mobile style.
 *
 * MetaMask opens every dApp as a TOP-LEVEL WebView navigation
 * (BrowserTab.tsx:1786, source={uri}) and injects the EIP-1193 provider before
 * the page's scripts run (injectedJavaScriptBeforeContentLoaded, line 1787).
 * We do the same, because X-Frame-Options / frame-ancestors only guard
 * FRAMING: app.uniswap.org refuses an iframe from any origin (measured
 * 2026-10-09) but renders fully as a top-level document — which is exactly
 * what this WebView is.
 *
 * Transport (mirrors react-native-webview's RNCWebViewBridge):
 *   dApp page  --window.BearNativeBridge.postMessage(json)-->  this plugin
 *   plugin     --notifyListeners("rpcRequest", {id, origin, payload})--> wallet app
 *   wallet app --call.resolve({id, response})--> plugin --evaluateJavascript
 *               window.__bearNativeResolve(id, response)--> dApp page
 *
 * The origin is taken from WebView.getUrl() (native side), never from the
 * page. The interface exposes no wallet state — it is a dumb pipe; every
 * answer including eth_accounts requires the user's consent in the wallet UI.
 */
@CapacitorPlugin(name = "BearDappBrowser")
public class BearDappBrowserPlugin extends Plugin {

    private WebView dappView = null;
    private String providerScript = "";
    private ViewGroup parent = null;
    private SwipeRefreshLayout refreshLayout = null;
    private View toolbar = null;
    private android.widget.EditText addressField = null;
    private Button backBtn = null;
    private Button forwardBtn = null;
    private static final int ADDRESS_LOADING = 0x663355FF;  // blue tint while the page loads
    private static final int ADDRESS_IDLE = 0x33222244;     // dim idle field
    // The loaded URL, written on the MAIN thread (onPageStarted) and read by
    // Bridge.postMessage on the JavaBridge thread. WebView.getUrl() THROWS
    // off-thread — checkThread() — and postMessage's silent catch ate it:
    // run 38032829356 (2026-10-10) proved every dapp RPC dying there
    // ("A WebView method was called on thread 'JavaBridge'" -> getUrl ->
    // Bridge.postMessage), the request pending forever while the connect
    // prompt never appeared. A volatile field is the one source BOTH threads
    // may touch — and it stays native-side: a page can never name its own
    // origin, same trust as getUrl() (the navigation lifecycle, not the page).
    private volatile String currentUrl = "";

    // MetaMask caps the page→native message (BackgroundBridge MAX_MESSAGE_LENGTH)
    // so a hostile page cannot flood the native side with an unbounded string.
    // 1 MB is far above any real RPC payload (even large typed data) and far
    // below a memory-exhaustion flood. trust-web3-provider does the same.
    private static final int MAX_MESSAGE_LENGTH = 1000000;

    // Inject the EIP-1193 provider only into real web documents. A PDF/XML/image
    // resource is not a dApp page; injecting a wallet bridge into a binary
    // document is pointless and widens the attack surface (MetaMask gates the
    // same way in scripts/inpage-bridge/src/index.js).
    private static boolean isWebDocument(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        String[] nonWeb = { ".pdf", ".xml", ".xhtml", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".apk", ".zip", ".bin" };
        for (String ext : nonWeb) {
            if (u.endsWith(ext)) return false;
        }
        return true;
    }


    @SuppressLint("SetJavaScriptEnabled")
    private void createView() {
        dappView = new WebView(getContext());
        WebSettings settings = dappView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        dappView.addJavascriptInterface(new Bridge(), "BearNativeBridge");
        dappView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                currentUrl = url == null ? "" : url; // main thread — the ONLY writer the bridge thread reads
                // Address bar follows the navigation; blue tint = loading.
                if (addressField != null) {
                    addressField.setText(url == null ? "" : url);
                    addressField.setBackgroundColor(ADDRESS_LOADING);
                }
                updateNavButtons();
                injectProvider(view, "start", url);
                JSObject ev = new JSObject();
                ev.put("event", "loadStart");
                ev.put("url", url);
                notifyListeners("navigation", ev);
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // THE RACE-CLOSER (run 38047794274): onPageStarted is
                // PRE-commit — its evaluateJavascript can execute against the
                // OLD document (fixture parsed with window.ethereum missing
                // while the previous run injected fine: a race, not a bug).
                // onPageFinished is post-parser — too late for dApps that read
                // window.ethereum at parse time. onPageCommitVisible fires once
                // the NEW document has committed and the parser is still
                // waiting on the network: provider lands BEFORE the dApp's own
                // scripts, deterministically. Idempotent script makes the
                // triple injection safe on every navigation.
                injectProvider(view, "commit", url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectProvider(view, "finish", url);
                // Address bar settles: idle tint, live back/forward state.
                if (addressField != null) {
                    addressField.setText(url == null ? "" : url);
                    addressField.setBackgroundColor(ADDRESS_IDLE);
                }
                updateNavButtons();
                if (refreshLayout != null) refreshLayout.setRefreshing(false); // pull-to-refresh spinner stops once the page lands
                JSObject ev = new JSObject();
                ev.put("event", "loadEnd");
                ev.put("url", url);
                notifyListeners("navigation", ev);
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (!request.isForMainFrame()) return;
                JSObject ev = new JSObject();
                ev.put("event", "loadError");
                ev.put("url", request.getUrl().toString());
                ev.put("description", String.valueOf(error.getDescription()));
                notifyListeners("navigation", ev);
            }
        });
        // Pull-to-refresh: a SwipeRefreshLayout wraps the WebView. It only lets a
        // pull begin when the WebView is scrolled to the top (canChildScrollUp), so
        // dragging down at the top of a dApp and releasing reloads the page — the
        // standard wallet dApp-browser gesture (MetaMask/Trust).
        refreshLayout = new SwipeRefreshLayout(getContext());
        refreshLayout.setColorSchemeColors(0xFF7C4DFF, 0xFF448AFF, 0xFF18FFFF);
        refreshLayout.setOnRefreshListener(() -> {
            if (dappView != null) dappView.reload();
        });
        refreshLayout.addView(dappView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent = (ViewGroup) getBridge().getWebView().getParent();
        if (parent != null) {
            parent.addView(refreshLayout, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        // A native toolbar ON TOP of the dapp view: back through the dapp's
        // own history, and close to return to the wallet. The wallet's own UI
        // lives UNDERNEATH this overlay — openDappBrowser()'s native branch
        // builds no UI of its own (the iframe toolbar is web-only) — so
        // without native controls the user is trapped in the dapp forever.
        // The contentDescription names each button for accessibility AND for
        // the E2E driver's uiautomator tap (tests/emulator-e2e.test.js).
        // OKX-style toolbar: [ ← ] [ → ] [ address ......... ] [ ⟳ ] [ ✕ ].
        // Address bar navigates like a browser: Enter loads the typed URL
        // (https:// prepended when bare), guarded by the same http/https gate
        // as open(). Back/forward reflect the WebView history live.
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(0xCC1A1A2E);
        final float density = getActivity().getResources().getDisplayMetrics().density;
        int navW = (int) (46 * density);

        backBtn = new Button(getContext());
        backBtn.setText("\u2190");
        backBtn.setContentDescription("dapp-back");
        backBtn.setAllCaps(false);
        backBtn.setTextColor(0xFFFFFFFF);
        backBtn.setBackgroundColor(0x00000000);
        backBtn.setEnabled(false);
        backBtn.setOnClickListener(v -> doBack());

        forwardBtn = new Button(getContext());
        forwardBtn.setText("\u2192");
        forwardBtn.setContentDescription("dapp-forward");
        forwardBtn.setAllCaps(false);
        forwardBtn.setTextColor(0xFFFFFFFF);
        forwardBtn.setBackgroundColor(0x00000000);
        forwardBtn.setEnabled(false);
        forwardBtn.setOnClickListener(v -> {
            if (dappView != null && dappView.canGoForward()) dappView.goForward();
        });

        addressField = new android.widget.EditText(getContext());
        addressField.setContentDescription("dapp-address");
        addressField.setSingleLine(true);
        addressField.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        addressField.setHint("Search or enter address");
        addressField.setHintTextColor(0x99FFFFFF);
        addressField.setTextColor(0xFFFFFFFF);
        addressField.setTextSize(14);
        addressField.setBackgroundColor(ADDRESS_IDLE);
        addressField.setPadding((int) (10 * density), 0, (int) (10 * density), 0);
        addressField.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        addressField.setImeActionLabel("Go", android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        addressField.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_GO
                    || actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
                loadFromAddress();
                return true;
            }
            return false;
        });

        Button refreshBtn = new Button(getContext());
        refreshBtn.setText("\u27F3");
        refreshBtn.setContentDescription("dapp-reload");
        refreshBtn.setAllCaps(false);
        refreshBtn.setTextColor(0xFFFFFFFF);
        refreshBtn.setBackgroundColor(0x00000000);
        refreshBtn.setOnClickListener(v -> {
            if (dappView != null) dappView.reload();
        });

        Button closeBtn = new Button(getContext());
        closeBtn.setText("\u2715");
        closeBtn.setContentDescription("dapp-close");
        closeBtn.setAllCaps(false);
        closeBtn.setTextColor(0xFFFFFFFF);
        closeBtn.setBackgroundColor(0x00000000);
        closeBtn.setOnClickListener(v -> doClose());

        int barH = (int) (48 * density); // fixed: layout math must not wait on measure timing
        bar.addView(backBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(forwardBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(addressField, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        bar.addView(refreshBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(closeBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        toolbar = bar;
        if (parent != null) {
            parent.addView(toolbar, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barH));
        }
        // Page content stays clear of the native overlay: shrink the WebView
        // by the toolbar height instead of letting pages hide underneath it.
        // Top padding — the toolbar is the top band, so the page starts BELOW it.
        if (refreshLayout != null) refreshLayout.setPadding(0, barH, 0, 0);
        toolbar.setVisibility(View.GONE);
        // The dApp page renders BELOW the toolbar: an overlaying bar sits on
        // top of every dApp's own header (the fixture's title was under it in
        // run 38032829356). Padding on refreshLayout itself — a margin through
        // the parent's LayoutParams could be dropped whenever addView
        // regenerates params; a view property survives re-adds.
        refreshLayout.setPadding(0, barH, 0, 0);
        refreshLayout.setVisibility(View.GONE);
    }

    // Inject the provider on a lifecycle hook AND prove where it landed:
    // every stage logs inject@<stage>->true/false — silent misses are how
    // run 38047794274 reached hasProvider=false with no trace. true means
    // window.ethereum.isBear was visible in THAT document right after the
    // stage ran (idempotent script: extra trues are re-confirms, not bugs).
    // NOTE: keep this helper OUT from between any @PluginMethod annotation
    // and its method — an orphaned annotation rebinds to THIS declaration,
    // open() drops out of PluginHeaders, and JS throws
    // "BearDappBrowser.open() is not implemented on android" (run 38048894477).
    private void injectProvider(final WebView view, final String stage, final String url) {
        final String js = providerScript;
        if (js == null || js.isEmpty() || !isWebDocument(url)) return;
        view.evaluateJavascript(js, null);
        view.evaluateJavascript(
            "(function(){try{return String(!!(window.ethereum&&window.ethereum.isBear));}catch(e){return 'ERR';}})()",
            value -> android.util.Log.d("BearDappBrowser", "inject@" + stage + "->" + value + " :: " + url));
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String provider = call.getString("providerScript", "");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        // Scheme guard (MetaMask parity: their in-app browser only ever loads
        // http/https). Everything else — javascript:, data:, file:, wc: — was
        // previously handed straight to loadUrl(): javascript: would execute
        // IN THIS VIEW, data:/file: render local content with no server, and
        // wc: renders an error page. All three are refused HERE at the native
        // gate, on the main thread, before any WebView work happens. The
        // wallet-side JS mirror (openNativeDapp) catches the same shapes for
        // an immediate toast; this is the authoritative second layer.
        String u = url.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            String scheme = u.contains(":") ? u.substring(0, u.indexOf(':')) : "none";
            call.reject("unsupported scheme \"" + scheme + "\" — the dApp browser opens http/https URLs only");
            return;
        }
        providerScript = provider == null ? "" : provider;
        getActivity().runOnUiThread(() -> {
            try {
                if (dappView == null) createView();
                if (parent != null && refreshLayout.getParent() == null) {
                    parent.addView(refreshLayout, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                }
                refreshLayout.setVisibility(View.VISIBLE);
                refreshLayout.bringToFront();
                if (toolbar != null) {
                    toolbar.setVisibility(View.VISIBLE);
                    toolbar.bringToFront(); // above the dapp view, always
                }
                dappView.setVisibility(View.VISIBLE);
                dappView.loadUrl(url);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("open failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            doClose();
            call.resolve();
        });
    }

    private void doClose() {
        if (dappView != null) {
            dappView.stopLoading();
            hideDappView();
        }
    }

    /** History back inside the dApp; hides the view when there is nothing to go back to. */
    @PluginMethod
    public void back(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            ret.put("handled", doBack());
            call.resolve(ret);
        });
    }

    private boolean doBack() {
        if (dappView != null && dappView.canGoBack()) {
            dappView.goBack();
            return true;
        }
        hideDappView();
        return false;
    }

    /** Address-bar navigation with the same http/https gate as open(). */
    private void loadFromAddress() {
        if (addressField == null || dappView == null) return;
        String raw = addressField.getText().toString().trim();
        if (raw.isEmpty()) return;
        String url = raw;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        dappView.loadUrl(url);
    }

    /** Reflect WebView history state on the native toolbar (main thread only). */
    private void updateNavButtons() {
        if (backBtn != null) {
            boolean can = dappView != null && dappView.canGoBack();
            backBtn.setEnabled(can);
            backBtn.setAlpha(can ? 1f : 0.35f);
        }
        if (forwardBtn != null) {
            boolean can = dappView != null && dappView.canGoForward();
            forwardBtn.setEnabled(can);
            forwardBtn.setAlpha(can ? 1f : 0.35f);
        }
    }

    private void hideDappView() {
        if (refreshLayout != null) {
            refreshLayout.setRefreshing(false);
            refreshLayout.setVisibility(View.GONE);
        }
        if (toolbar != null) toolbar.setVisibility(View.GONE);
        if (dappView != null) dappView.loadUrl("about:blank");
    }

    /**
     * Flash to the wallet while a confirmation is up.
     *
     * handleNativeRpc's confirmTx renders in the WALLET's webview — which this
     * full-screen overlay covers. Without this the Connect/Sign/Send prompt is
     * drawn underneath the dapp: invisible, unclickable, every confirmation-
     * bound RPC hanging forever on a tap nobody can make. The wallet JS hides
     * the dapp around each confirm and restores it after (depth-counted, so
     * two simultaneous requests cannot restore under the first prompt).
     * A no-op when the browser was never opened.
     */
    @PluginMethod
    public void setVisible(PluginCall call) {
        Boolean visible = call.getBoolean("visible", false);
        getActivity().runOnUiThread(() -> {
            if (dappView != null) {
                if (refreshLayout != null) {
                    refreshLayout.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (visible) refreshLayout.bringToFront();
                }
                if (toolbar != null) {
                    toolbar.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (visible) toolbar.bringToFront(); // toolbar stays topmost
                }
            }
            call.resolve();
        });
    }

    /** Deliver a wallet answer back into the dApp page. */
    @PluginMethod
    public void resolve(PluginCall call) {
        Integer id = call.getInt("id");
        String response = call.getString("response", "");
        if (id == null) {
            call.reject("id required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (dappView != null) {
                // response is JSON built by the wallet app (trusted side) —
                // embedded verbatim so __bearNativeResolve sees a real object.
                // Wrapped in try/catch WITH a logged outcome: the dapp view
                // has no WebChromeClient, so a failed evaluateJavascript (or a
                // missing __bearNativeResolve) logs NOTHING anywhere — run
                // 38034404898 lost a whole resolve chain to that silence. The
                // provider returns 'resolved'/'error-sent'/'unknown-id'; an
                // exception or a null result (script never ran) is just as
                // loud. One bounded Log.d per RPC — trusted side, real trips
                // only, same budget as the rpcRequest drop line.
                String js = "(function () { try { return String(window.__bearNativeResolve("
                    + id + "," + response + ")) + '|same=' + (window.__pageResolve === window.__bearNativeResolve); } catch (e) { return 'ERR ' + (e && e.message); } })()";
                dappView.evaluateJavascript(js, value ->
                    android.util.Log.d("BearDappBrowser", "resolve#" + id + "->" + value + " :: " + response));
            }
            call.resolve();
        });
    }

    /** dApp page → wallet app: a dumb pipe, no state, no secrets. */
    private class Bridge {
        @JavascriptInterface
        public void postMessage(String json) {
            // Drop oversized/empty payloads BEFORE the JSON parser — a hostile
            // page must not be able to flood native with an unbounded string
            // (MetaMask/trust-web3-provider both cap the page→native channel).
            if (json == null || json.length() == 0 || json.length() > MAX_MESSAGE_LENGTH) return;
            try {
                int id = new JSONObject(json).optInt("id", 0);
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("origin", currentUrl); // NEVER dappView.getUrl(): checkThread() throws on JavaBridge
                ev.put("payload", json);
                notifyListeners("rpcRequest", ev);
            } catch (Exception e) {
                // Malformed JSON from a hostile page: drop, never crash the view —
                // but NEVER silently: the empty catch above hid a dead RPC path
                // for a whole run (38032829356). Bounded diagnosis: the
                // exception CLASS only — the page's own payload never reaches
                // the log (log injection), the fixed string never grows.
                android.util.Log.w("BearDappBrowser", "rpcRequest dropped: " + e.getClass().getSimpleName());
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            if (dappView != null) {
                dappView.destroy();
                dappView = null;
            }
        });
        super.handleOnDestroy();
    }
}
