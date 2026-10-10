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
                // The provider must exist before the dApp's own scripts run.
                // onPageStarted is the same hook react-native-webview uses for
                // injectedJavaScriptBeforeContentLoaded on Android; the script
                // itself is idempotent, so re-runs on every navigation are safe.
                String js = providerScript;
                if (js != null && !js.isEmpty() && isWebDocument(url)) {
                    view.evaluateJavascript(js, null);
                }
                JSObject ev = new JSObject();
                ev.put("event", "loadStart");
                ev.put("url", url);
                notifyListeners("navigation", ev);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Second chance for engines that commit the document before
                // onPageStarted's evaluateJavascript lands (idempotent script).
                String js = providerScript;
                if (js != null && !js.isEmpty() && isWebDocument(url)) {
                    view.evaluateJavascript(js, null);
                }
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
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(0xCC1A1A2E);
        Button backBtn = new Button(getContext());
        backBtn.setText("\u2190");
        backBtn.setContentDescription("dapp-back");
        backBtn.setTextColor(0xFFFFFFFF);
        backBtn.setBackgroundColor(0x00000000);
        backBtn.setOnClickListener(v -> doBack());
        Button closeBtn = new Button(getContext());
        backBtn.setAllCaps(false);
        closeBtn.setText("\u2715");
        closeBtn.setContentDescription("dapp-close");
        closeBtn.setTextColor(0xFFFFFFFF);
        closeBtn.setBackgroundColor(0x00000000);
        closeBtn.setOnClickListener(v -> doClose());
        int barH = (int) (48 * getActivity().getResources().getDisplayMetrics().density); // fixed: layout math must not wait on measure timing
        bar.addView(backBtn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        bar.addView(closeBtn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        toolbar = bar;
        if (parent != null) {
            parent.addView(toolbar, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barH));
        }
        toolbar.setVisibility(View.GONE);
        // The dApp page renders BELOW the toolbar: an overlaying bar sits on
        // top of every dApp's own header (the fixture's title was under it in
        // run 38032829356). Padding on refreshLayout itself — a margin through
        // the parent's LayoutParams could be dropped whenever addView
        // regenerates params; a view property survives re-adds.
        refreshLayout.setPadding(0, barH, 0, 0);
        refreshLayout.setVisibility(View.GONE);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String provider = call.getString("providerScript", "");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
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
