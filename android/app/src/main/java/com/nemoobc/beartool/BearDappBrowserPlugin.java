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

import com.getcapacitor.JSArray;
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
 *
 * Tabs + network (2026-10-11, user: "ga ada fitur tabs, change network"):
 *   - Every tab owns its own WebView + SwipeRefreshLayout (own history, own
 *     provider). Only the active one is visible; the ⧉ chip opens the sheet.
 *   - The ◆ chip asks the WALLET to change its active chain: the wallet opens
 *     its Networks picker (flash-to-wallet), then pushes the new chain back
 *     via setChain(), which updates the chip and fires chainChanged into every
 *     open tab — the EIP-1193 event a dApp listens for.
 *   - The toolbar is fully opaque: 0xCC/0x33 alphas let the wallet dashboard
 *     bleed through the bar ("tembus"), which is the bug this palette fixes.
 */
@CapacitorPlugin(name = "BearDappBrowser")
public class BearDappBrowserPlugin extends Plugin {

    // dappView / refreshLayout always point at the ACTIVE tab, so the existing
    // confirm/visibility plumbing (and its tests) keep one obvious target.
    private WebView dappView = null;
    private SwipeRefreshLayout refreshLayout = null;
    private String providerScript = "";
    private ViewGroup parent = null;
    private View toolbar = null;
    private android.widget.EditText addressField = null;
    private Button backBtn = null;
    private Button forwardBtn = null;
    private Button menuBtn = null;
    private android.widget.TextView tabCountBadge = null;

    // ⋯ overflow sheet. Built fresh per open (its rows reflect THIS tab's URL)
    // and torn down on dismiss, so it can never show a stale page's actions.
    private android.widget.FrameLayout menuRoot = null;

    // Tabs. `stack` holds every tab's own wrapper; only one is VISIBLE.
    private android.widget.FrameLayout stack = null;
    private View tabPanel = null;
    private LinearLayout tabList = null;
    private Button tabBtn = null;
    private Button netBtn = null;
    private final java.util.List<Tab> tabs = new java.util.ArrayList<>();
    private int activeTab = -1;

    // Opaque toolbar palette — the whole point of the "tembus" fix: nothing
    // behind the bar (wallet dashboard, dApp under it) may show through.
    private static final int BAR_BG = 0xFF161622;
    private static final int ADDRESS_LOADING = 0xFF243B7A;  // opaque blue tint while loading
    private static final int ADDRESS_IDLE = 0xFF2A2A3E;     // opaque idle field
    // The page band under the toolbar is opaque as well: until a page paints,
    // the wallet's cartoon dashboard used to show through the browser (user
    // report 2026-10-11: "ui dalem dapp cartoon"). One dark surface = one load.
    private static final int PAGE_BG = 0xFF0E0E16;
    // OKX-parity dark chrome: one surface family for the toolbar, the tab sheet
    // and the confirm sheet (user: "semua chrome gelap bersih gaya OKX").
    private static final int SHEET_BG = 0xFF161622;
    private static final int SHEET_KEY = 0xFF8E93A8;
    private static final int SHEET_VAL = 0xFFE6E6F0;
    private static final int ACCENT = 0xFF7C4DFF;
    private int barH = 0;

    // A 3dp indeterminate bar pinned just below the toolbar: page loads had no
    // visible progress at all (user report 2026-10-11: "loading web ga ada").
    private android.widget.ProgressBar progressBar = null;

    // Native confirm sheet (Connect / Sign / Send). It is drawn ON TOP of the
    // dapp WebView, so the page stays visible behind a dim scrim and the wallet
    // never has to hide the browser around a prompt.
    private android.view.View confirmRoot = null;
    private android.widget.TextView confirmTitleView = null;
    private android.widget.LinearLayout confirmRowsBox = null;
    private PluginCall pendingConfirm = null;
    // The loaded URL, written on the MAIN thread (onPageStarted) and read by
    // Bridge.postMessage on the JavaBridge thread. WebView.getUrl() THROWS
    // off-thread — checkThread() — and postMessage's silent catch ate it:
    // run 38032829356 (2026-10-10) proved every dapp RPC dying there
    // ("A WebView method was called on thread 'JavaBridge'" -> getUrl ->
    // Bridge.postMessage), the request pending forever while the connect
    // prompt never appeared. A volatile field is the one source BOTH threads
    // may touch — and it stays native-side: a page can never name its own
    // origin, same trust as getUrl() (the navigation lifecycle, not the page).
    // With tabs only the ACTIVE tab writes it (setActiveTab seeds it on switch).
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

    /** One browser tab: its own WebView (own history, own provider) and the
     *  SwipeRefreshLayout that wraps it. */
    private class Tab {
        WebView view;
        SwipeRefreshLayout wrap;
        String title = "";
        String url = "";
    }

    private Tab tabOf(WebView v) {
        for (Tab t : tabs) if (t.view == v) return t;
        return null;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void applySettings(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
    }

    /** Build a fresh tab (blank WebView + swiperefresh wrapper), added to the
     *  stack hidden. The caller decides when to make it active. */
    @SuppressLint("SetJavaScriptEnabled")
    private Tab newTab() {
        Tab t = new Tab();
        t.view = new WebView(getContext());
        applySettings(t.view);
        t.view.addJavascriptInterface(new Bridge(), "BearNativeBridge");
        t.view.setWebViewClient(new BrowserClient());
        t.wrap = new SwipeRefreshLayout(getContext());
        t.wrap.setColorSchemeColors(0xFF7C4DFF, 0xFF448AFF, 0xFF18FFFF);
        t.wrap.setOnRefreshListener(this::reloadActive);
        t.wrap.addView(t.view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        t.view.setBackgroundColor(PAGE_BG); // no white/see-through flash before the first paint
        t.wrap.setVisibility(View.GONE);
        if (stack != null) {
            stack.addView(t.wrap, barInsetParams());
        }
        tabs.add(t);
        return t;
    }

    /** LayoutParams for a tab's SwipeRefreshLayout: a top MARGIN equal to the
     *  toolbar height, so the whole page band starts BELOW the bar. This is a
     *  margin and NOT padding on purpose: SwipeRefreshLayout paints its
     *  pull-to-refresh spinner at the top of its own bounds, and with a top
     *  PADDING that strip sits under the (z-topmost) toolbar — the spinner was
     *  invisible (user report 2026-10-11). A margin set here survives the
     *  setVisibility() toggles; setActiveTab re-asserts it (idempotent). */
    private android.widget.FrameLayout.LayoutParams barInsetParams() {
        android.widget.FrameLayout.LayoutParams lp = new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.topMargin = barH;
        return lp;
    }

    /** Re-assert the toolbar inset on a wrapper whose LayoutParams an addView
     *  may have regenerated (the old padding version existed for this reason;
     *  the margin is simply re-applied instead of trusted). */
    private void applyBarInset(View v) {
        if (v == null || barH <= 0) return;
        ViewGroup.LayoutParams p = v.getLayoutParams();
        if (p instanceof android.widget.FrameLayout.LayoutParams
                && ((android.widget.FrameLayout.LayoutParams) p).topMargin != barH) {
            android.widget.FrameLayout.LayoutParams lp =
                new android.widget.FrameLayout.LayoutParams(p.width, p.height);
            lp.topMargin = barH;
            v.setLayoutParams(lp);
        }
    }

    /** 3dp indeterminate bar under the toolbar — a visible load cue for every
     *  navigation (the address-bar tint alone was too subtle: user report
     *  2026-10-11 "loading web ga ada"). */
    private void buildProgressBar(final float density) {
        progressBar = new android.widget.ProgressBar(getContext(), null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(true);
        progressBar.setVisibility(View.GONE);
        android.widget.FrameLayout.LayoutParams lp = new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, (int) (3 * density));
        lp.topMargin = barH;
        if (stack != null) stack.addView(progressBar, lp);
    }

    private void showLoadingBar() {
        if (progressBar == null) return;
        progressBar.setVisibility(View.VISIBLE);
        progressBar.bringToFront(); // above the tab wrappers, which are re-added per tab
    }

    private void hideLoadingBar() {
        if (progressBar != null) progressBar.setVisibility(View.GONE);
    }

    /**
     * Wallet → native: show the Connect / Sign / Send consent sheet ABOVE the
     * dapp. The wallet's own confirm modal lives in the wallet webview, which
     * this full-screen overlay covers — so before this the browser had to be
     * hidden around every prompt and a tap on the dApp's "Connect" looked like
     * being kicked out of the browser (user report 2026-10-11). OKX/MetaMask
     * draw the prompt over the page; now so do we. Resolves {ok:boolean}.
     */
    @PluginMethod
    public void confirm(PluginCall call) {
        final String title = call.getString("title", "Confirm");
        final String confirmText = call.getString("confirmText", "Confirm");
        final String cancelText = call.getString("cancelText", "Cancel");
        final JSArray rows = call.getArray("rows");
        getActivity().runOnUiThread(() -> {
            if (dappView == null) {          // no browser open: nothing to sit above
                JSObject r = new JSObject();
                r.put("ok", false);
                call.resolve(r);
                return;
            }
            showNativeConfirm(call, title, rows, confirmText, cancelText);
        });
    }

    private void showNativeConfirm(PluginCall call, String title, JSArray rows, String confirmText, String cancelText) {
        final float density = getActivity().getResources().getDisplayMetrics().density;
        // A second prompt can only replace the first: resolve the old one as a
        // refusal, or the wallet JS would wait forever on a sheet that is gone.
        finishConfirm(false);

        android.widget.FrameLayout root = new android.widget.FrameLayout(getContext());
        root.setBackgroundColor(0x99000000); // dim scrim — the dapp shows through
        root.setOnClickListener(v -> finishConfirm(false)); // tap outside = cancel

        LinearLayout sheet = new LinearLayout(getContext());
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setClickable(true);            // taps on the sheet body do not dismiss
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(SHEET_BG);
        float r = 18 * density;
        bg.setCornerRadii(new float[]{ r, r, r, r, 0f, 0f, 0f, 0f });
        sheet.setBackground(bg);
        int pad = (int) (18 * density);
        sheet.setPadding(pad, pad, pad, pad);

        confirmTitleView = new android.widget.TextView(getContext());
        confirmTitleView.setText(title == null ? "" : title);
        confirmTitleView.setTextColor(0xFFFFFFFF);
        confirmTitleView.setTextSize(17);
        confirmTitleView.setPadding(0, 0, 0, (int) (12 * density));
        sheet.addView(confirmTitleView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        confirmRowsBox = new LinearLayout(getContext());
        confirmRowsBox.setOrientation(LinearLayout.VERTICAL);
        if (rows != null) {
            for (int i = 0; i < rows.length(); i++) {
                org.json.JSONObject o = rows.optJSONObject(i);
                if (o == null) continue;
                addSheetRow(confirmRowsBox, o.optString("k", ""), o.optString("v", ""), density);
            }
        }
        sheet.addView(confirmRowsBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout btns = new LinearLayout(getContext());
        btns.setOrientation(LinearLayout.HORIZONTAL);
        btns.setPadding(0, (int) (18 * density), 0, 0);

        android.widget.TextView cancel = new android.widget.TextView(getContext());
        cancel.setText(cancelText == null ? "Cancel" : cancelText);
        cancel.setTextColor(SHEET_VAL);
        cancel.setTextSize(15);
        cancel.setGravity(android.view.Gravity.CENTER);
        cancel.setPadding(0, (int) (12 * density), 0, (int) (12 * density));
        cancel.setContentDescription("dapp-confirm-cancel");
        cancel.setOnClickListener(v -> finishConfirm(false));

        android.widget.TextView ok = new android.widget.TextView(getContext());
        ok.setText(confirmText == null ? "Confirm" : confirmText);
        ok.setTextColor(0xFFFFFFFF);
        ok.setTextSize(15);
        ok.setGravity(android.view.Gravity.CENTER);
        ok.setTypeface(ok.getTypeface(), android.graphics.Typeface.BOLD);
        ok.setPadding(0, (int) (12 * density), 0, (int) (12 * density));
        ok.setContentDescription("dapp-confirm-ok");
        android.graphics.drawable.GradientDrawable okBg = new android.graphics.drawable.GradientDrawable();
        okBg.setColor(ACCENT);
        okBg.setCornerRadius(12 * density);
        ok.setBackground(okBg);
        ok.setOnClickListener(v -> finishConfirm(true));

        btns.addView(cancel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        android.widget.Space sp = new android.widget.Space(getContext());
        btns.addView(sp, new LinearLayout.LayoutParams((int) (12 * density), 1));
        btns.addView(ok, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        sheet.addView(btns, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(sheet, new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.BOTTOM));

        confirmRoot = root;
        pendingConfirm = call;
        if (parent != null) {
            parent.addView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.bringToFront();
            setBackgroundA11yInert(true);   // modal: the page behind is inert now
            // Diagnostic, not behaviour: on some emulators `uiautomator dump`
            // dies while walking this app's WebView tree (platform bug —
            // AccessibilityNodeInfoDumper.childNafCheck dereferences a null
            // child) and leaves a STALE /sdcard/uidump.xml, so a host-side E2E
            // cannot always find this button by label. Reporting the button's
            // real on-screen rect lets the driver press what it verified instead
            // of guessing coordinates (live capture 2026-10-11, run 38127365427).
            ok.post(() -> {
                try {
                    int[] loc = new int[2];
                    ok.getLocationOnScreen(loc);
                    android.util.Log.i("BearToolE2E", "confirm-ok-rect "
                        + loc[0] + "," + loc[1] + "," + ok.getWidth() + "," + ok.getHeight());
                } catch (Exception ignored) { /* never break the sheet for a log */ }
            });
        } else {
            finishConfirm(false);   // nowhere to draw: refuse rather than hang
        }
    }

    private void addSheetRow(LinearLayout box, String k, String v, float density) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, (int) (6 * density), 0, (int) (6 * density));

        android.widget.TextView kv = new android.widget.TextView(getContext());
        kv.setText(k);
        kv.setTextColor(SHEET_KEY);
        kv.setTextSize(13);

        android.widget.TextView vv = new android.widget.TextView(getContext());
        vv.setText(v);
        vv.setTextColor(SHEET_VAL);
        vv.setTextSize(13);
        vv.setGravity(android.view.Gravity.END);
        vv.setSingleLine(true);
        vv.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);

        row.addView(kv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(vv, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        box.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /** Resolve + tear down the sheet. Safe to call when nothing is pending. */
    private void finishConfirm(boolean ok) {
        PluginCall c = pendingConfirm;
        pendingConfirm = null;
        if (confirmRoot != null) {
            ViewGroup pp = (ViewGroup) confirmRoot.getParent();
            if (pp != null) pp.removeView(confirmRoot);
            confirmRoot = null;
        }
        confirmTitleView = null;
        confirmRowsBox = null;
        setBackgroundA11yInert(false);   // the modal is gone — the page is reachable again
        if (c != null) {
            JSObject r = new JSObject();
            r.put("ok", ok);
            c.resolve(r);
        }
    }

    // A consent sheet is a MODAL: the page behind it stops being touchable
    // behind the scrim, so it must stop being readable too. Marking the live
    // WebViews NO_HIDE_DESCENDANTS makes the accessibility tree match what the
    // user can actually act on — a screen reader reads the sheet, not the wallet
    // underneath. It also keeps the platform dumper alive: `uiautomator dump`
    // walks every node and calls AccessibilityNodeInfoDumper.childNafCheck,
    // which dereferences a nullable child, so the huge WebView tree can kill the
    // dump process mid-walk and leave a stale file. With the WebViews out of the
    // tree, only the small native sheet is left to walk. AUTO on teardown puts
    // the page back for the next screen reader that asks.
    private void setBackgroundA11yInert(boolean inert) {
        final int mode = inert
            ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO;
        try {
            WebView wallet = getBridge().getWebView();
            if (wallet != null) wallet.setImportantForAccessibility(mode);
        } catch (Exception ignored) { /* bridge not ready — nothing to hide */ }
        try {
            if (dappView != null) dappView.setImportantForAccessibility(mode);
        } catch (Exception ignored) { /* no browser open — nothing to hide */ }
    }

    /** Swipe-to-refresh reloads the ACTIVE page (a hidden tab cannot be pulled). */
    private void reloadActive() {
        if (dappView != null) dappView.reload();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createView() {
        final float density = getActivity().getResources().getDisplayMetrics().density;
        parent = (ViewGroup) getBridge().getWebView().getParent();
        stack = new android.widget.FrameLayout(getContext());
        stack.setBackgroundColor(PAGE_BG); // opaque: the wallet never shows through the page band
        if (parent != null) {
            parent.addView(stack, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        buildToolbar(density);
        buildTabPanel(density);
        newTab();            // a blank tab so the toolbar always has an active view
        buildProgressBar(density);
        setActiveTab(0);
        stack.setVisibility(View.GONE);
    }

    // OKX-style toolbar: [ ← ] [ → ] [ address ....... ] [ ◆ net ] [ ⧉ n ] [ ⟳ ] [ ✕ ].
    // Opaque, full-width band: the page is padded BELOW it (never under it) and
    // the wallet dashboard can never bleed through it.
    private void buildToolbar(final float density) {
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(BAR_BG);
        bar.setElevation(8 * density);
        int navW = (int) (40 * density);

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

        // ◆ Change network — the OKX/MetaMask chip. It never switches by
        // itself: it asks the WALLET to open its own Networks picker (the
        // wallet owns the network list). The answer comes back through
        // setChain(), which updates this chip and tells every tab.
        netBtn = new Button(getContext());
        netBtn.setText("\u25C6");
        netBtn.setContentDescription("dapp-network");
        netBtn.setAllCaps(false);
        netBtn.setTextColor(0xFFB9B9FF);
        netBtn.setBackgroundColor(0x00000000);
        netBtn.setOnClickListener(v -> {
            JSObject ev = new JSObject();
            ev.put("command", "openNetworkPicker");
            notifyListeners("walletCommand", ev);
        });

        // ⧉ Tabs — opens the switcher sheet. The count is a BADGE pinned to the
        // icon's top-right (OKX's "2"), not text jammed into the glyph: a
        // multi-digit count would otherwise squeeze the bar.
        tabBtn = new Button(getContext());
        tabBtn.setText("\u29C9");
        tabBtn.setContentDescription("dapp-tabs");
        tabBtn.setAllCaps(false);
        tabBtn.setTextColor(0xFFFFFFFF);
        tabBtn.setBackgroundColor(0x00000000);
        tabBtn.setOnClickListener(v -> toggleTabPanel());
        tabCountBadge = new android.widget.TextView(getContext());
        tabCountBadge.setTextColor(0xFFFFFFFF);
        tabCountBadge.setTextSize(9);
        tabCountBadge.setGravity(android.view.Gravity.CENTER);
        android.graphics.drawable.GradientDrawable badgeBg = new android.graphics.drawable.GradientDrawable();
        badgeBg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        badgeBg.setColor(0xFF6C5CE7);
        tabCountBadge.setBackground(badgeBg);
        tabCountBadge.setContentDescription("dapp-tabs-count");

        Button reloadBtn = new Button(getContext());
        reloadBtn.setText("\u27F3");
        reloadBtn.setContentDescription("dapp-reload");
        reloadBtn.setAllCaps(false);
        reloadBtn.setTextColor(0xFFFFFFFF);
        reloadBtn.setBackgroundColor(0x00000000);
        reloadBtn.setOnClickListener(v -> reloadActive());

        Button closeBtn = new Button(getContext());
        closeBtn.setText("\u2715");
        closeBtn.setContentDescription("dapp-close");
        closeBtn.setAllCaps(false);
        closeBtn.setTextColor(0xFFFFFFFF);
        closeBtn.setBackgroundColor(0x00000000);
        closeBtn.setOnClickListener(v -> doClose());

        // ⋯ Menu — the OKX overflow. Everything that is NOT a one-tap
        // navigation action lives here instead of crowding the 48dp bar:
        // copy/share/favorite, plus the page-level tools (reminder, desktop
        // mode, this site's transactions, cache).
        menuBtn = new Button(getContext());
        menuBtn.setText("\u22EF");
        menuBtn.setContentDescription("dapp-menu");
        menuBtn.setAllCaps(false);
        menuBtn.setTextColor(0xFFFFFFFF);
        menuBtn.setBackgroundColor(0x00000000);
        menuBtn.setOnClickListener(v -> showDappMenu());

        int barH = (int) (48 * density); // fixed: layout math must not wait on measure timing
        this.barH = barH;
        bar.addView(backBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(forwardBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(addressField, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        bar.addView(netBtn, new LinearLayout.LayoutParams((int) (52 * density), ViewGroup.LayoutParams.MATCH_PARENT));
        android.widget.FrameLayout tabWrap = new android.widget.FrameLayout(getContext());
        tabWrap.addView(tabBtn, new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        android.widget.FrameLayout.LayoutParams badgeLp = new android.widget.FrameLayout.LayoutParams(
            (int) (16 * density), (int) (16 * density), android.view.Gravity.TOP | android.view.Gravity.END);
        badgeLp.rightMargin = (int) (1 * density);
        badgeLp.topMargin = (int) (3 * density);
        tabWrap.addView(tabCountBadge, badgeLp);
        bar.addView(tabWrap, new LinearLayout.LayoutParams((int) (44 * density), ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(reloadBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(menuBtn, new LinearLayout.LayoutParams((int) (40 * density), ViewGroup.LayoutParams.MATCH_PARENT));
        bar.addView(closeBtn, new LinearLayout.LayoutParams(navW, ViewGroup.LayoutParams.MATCH_PARENT));
        toolbar = bar;
        if (parent != null) {
            parent.addView(toolbar, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barH));
        }
        toolbar.setVisibility(View.GONE);
    }

    // The tab sheet. Opaque, sits under the toolbar (padding top = barH) so the
    // toolbar's back/close stay reachable while the user picks a tab.
    private void buildTabPanel(final float density) {
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(0xFF0E0E16);
        panel.setPadding(0, barH, 0, 0);

        android.widget.TextView h = new android.widget.TextView(getContext());
        h.setText("Tabs");
        h.setTextColor(0xFFFFFFFF);
        h.setTextSize(16);
        h.setPadding((int) (14 * density), 0, 0, 0);

        Button add = new Button(getContext());
        add.setText("+ New tab");
        add.setAllCaps(false);
        add.setTextColor(0xFFFFFFFF);
        add.setBackgroundColor(0x00000000);
        add.setContentDescription("dapp-tab-new");
        add.setOnClickListener(v -> {
            newTab();
            setActiveTab(tabs.size() - 1);
            closeTabPanel();
        });

        Button done = new Button(getContext());
        done.setText("\u2715");
        done.setAllCaps(false);
        done.setTextColor(0xFFFFFFFF);
        done.setBackgroundColor(0x00000000);
        done.setContentDescription("dapp-tab-done");
        done.setOnClickListener(v -> closeTabPanel());

        LinearLayout head = new LinearLayout(getContext());
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.addView(h, new LinearLayout.LayoutParams(0, (int) (44 * density), 1));
        head.addView(add, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) (44 * density)));
        head.addView(done, new LinearLayout.LayoutParams((int) (44 * density), (int) (44 * density)));
        panel.addView(head, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (44 * density)));

        tabList = new LinearLayout(getContext());
        tabList.setOrientation(LinearLayout.VERTICAL);
        android.widget.ScrollView scroll = new android.widget.ScrollView(getContext());
        scroll.addView(tabList, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        tabPanel = panel;
        tabPanel.setVisibility(View.GONE);
        if (parent != null) {
            parent.addView(tabPanel, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
    }

    private void toggleTabPanel() {
        if (tabPanel == null) return;
        if (tabPanel.getVisibility() == View.VISIBLE) closeTabPanel();
        else openTabPanel();
    }

    // ── ⋯ overflow sheet (OKX parity) ──────────────────────────────────────
    // Four one-tap actions as icons, four page tools as rows. Built over the
    // dApp (the page stays visible behind a scrim, same contract as the confirm
    // sheet) and torn down on any choice, on a tap outside, or on BACK.
    private void showDappMenu() {
        if (parent == null || dappView == null) return;
        closeDappMenu();
        final float density = getActivity().getResources().getDisplayMetrics().density;
        final String url = dappView.getUrl() == null ? "" : dappView.getUrl();

        android.widget.FrameLayout root = new android.widget.FrameLayout(getContext());
        root.setBackgroundColor(0x99000000);
        root.setContentDescription("dapp-menu-scrim");
        root.setOnClickListener(v -> closeDappMenu());

        LinearLayout sheet = new LinearLayout(getContext());
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setClickable(true);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(SHEET_BG);
        float r = 18 * density;
        bg.setCornerRadii(new float[]{ r, r, r, r, 0f, 0f, 0f, 0f });
        sheet.setBackground(bg);
        int pad = (int) (18 * density);
        sheet.setPadding(pad, pad, pad, pad);

        // Drag handle — the sheet says "pull me down" the way OKX's does.
        android.view.View handle = new android.view.View(getContext());
        android.graphics.drawable.GradientDrawable hg = new android.graphics.drawable.GradientDrawable();
        hg.setColor(0x55FFFFFF);
        hg.setCornerRadius(3 * density);
        handle.setBackground(hg);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams((int) (40 * density), (int) (4 * density));
        hlp.gravity = android.view.Gravity.CENTER_HORIZONTAL;
        hlp.bottomMargin = (int) (14 * density);
        sheet.addView(handle, hlp);

        // Icon row: Copy URL / Favorite / Refresh / Share.
        LinearLayout icons = new LinearLayout(getContext());
        icons.setOrientation(LinearLayout.HORIZONTAL);
        icons.setGravity(android.view.Gravity.CENTER);
        icons.addView(menuIconTile(density, "\u29C9", "Copy URL", "dapp-menu-copy",
            v -> { copyToClipboard(getContext(), url); closeDappMenu(); }));
        icons.addView(menuIconTile(density, "\u2606", "Favourite", "dapp-menu-fav",
            v -> { toggleBookmark(url); closeDappMenu(); }));
        icons.addView(menuIconTile(density, "\u27F3", "Refresh", "dapp-menu-refresh",
            v -> { closeDappMenu(); reloadActive(); }));
        icons.addView(menuIconTile(density, "\u2197", "Share", "dapp-menu-share",
            v -> { shareUrl(url); closeDappMenu(); }));
        sheet.addView(icons, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // Page tools. Every row here has a handler that ACTUALLY does the thing:
        // "Set DApp reminder" was dropped from the OKX reference on purpose —
        // Bear Tool has no reminder store, so the row would have been a button
        // that looks alive and does nothing.
        sheet.addView(menuRow(density, "\uD83D\uDCDD", "Switch to desktop mode", "dapp-menu-desktop",
            v -> { openExternally(url); closeDappMenu(); }));
        sheet.addView(menuRow(density, "\u21C9", "Transaction history", "dapp-menu-history",
            v -> { walletCommand("openActivity", url); closeDappMenu(); }));
        sheet.addView(menuRow(density, "\uD83D\uDDD1", "Clear cache", "dapp-menu-clearcache",
            v -> { clearDappCache(); closeDappMenu(); }));

        root.addView(sheet, new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.BOTTOM));
        menuRoot = root;
        if (parent != null) {
            parent.addView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.bringToFront();
        }
        if (toolbar != null) toolbar.bringToFront();
    }

    /** A sheet icon + its caption. Square tile, label under it. */
    private View menuIconTile(float density, String glyph, String label, String desc, android.view.View.OnClickListener onClick) {
        LinearLayout tile = new LinearLayout(getContext());
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setGravity(android.view.Gravity.CENTER_HORIZONTAL);
        tile.setClickable(true);
        tile.setContentDescription(desc);
        tile.setOnClickListener(onClick);
        android.widget.TextView icon = new android.widget.TextView(getContext());
        icon.setText(glyph);
        icon.setTextColor(0xFFFFFFFF);
        icon.setTextSize(20);
        icon.setGravity(android.view.Gravity.CENTER);
        android.graphics.drawable.GradientDrawable ib = new android.graphics.drawable.GradientDrawable();
        ib.setColor(0xFF2A2A3A);
        ib.setCornerRadius(14 * density);
        icon.setBackground(ib);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams((int) (52 * density), (int) (52 * density));
        tile.addView(icon, ip);
        android.widget.TextView cap = new android.widget.TextView(getContext());
        cap.setText(label);
        cap.setTextColor(0xFFB9B9C9);
        cap.setTextSize(11);
        cap.setGravity(android.view.Gravity.CENTER);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cp.topMargin = (int) (6 * density);
        tile.addView(cap, cp);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        rowLp.leftMargin = (int) (6 * density);
        rowLp.rightMargin = (int) (6 * density);
        return tile;
    }

    /** A full-width sheet row: icon, title, tap target. */
    private View menuRow(float density, String glyph, String label, String desc, android.view.View.OnClickListener onClick) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setClickable(true);
        row.setContentDescription(desc);
        row.setOnClickListener(onClick);
        android.widget.TextView icon = new android.widget.TextView(getContext());
        icon.setText(glyph);
        icon.setTextColor(0xFFE6E6F0);
        icon.setTextSize(16);
        row.addView(icon, new LinearLayout.LayoutParams((int) (30 * density), (int) (44 * density)));
        android.widget.TextView tv = new android.widget.TextView(getContext());
        tv.setText(label);
        tv.setTextColor(0xFFFFFFFF);
        tv.setTextSize(15);
        row.addView(tv, new LinearLayout.LayoutParams(0, (int) (44 * density), 1));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (44 * density));
        lp.topMargin = (int) (2 * density);
        return row;
    }

    private void closeDappMenu() {
        if (menuRoot == null) return;
        ViewGroup pp = (ViewGroup) menuRoot.getParent();
        if (pp != null) pp.removeView(menuRoot);
        menuRoot = null;
    }

    // ── menu actions ───────────────────────────────────────────────────────
    private static void copyToClipboard(android.content.Context ctx, String url) {
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText("url", url));
            android.widget.Toast.makeText(ctx, "Link copied", android.widget.Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) { /* clipboard unavailable — nothing to claim */ }
    }

    private void shareUrl(String url) {
        try {
            android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(android.content.Intent.EXTRA_TEXT, url);
            getActivity().startActivity(android.content.Intent.createChooser(i, "Share"));
        } catch (Exception ignored) { /* no app can receive it — stay silent, not wrong */ }
    }

    /** Open outside the in-app browser (the "desktop mode" escape hatch). */
    private void openExternally(String url) {
        try {
            android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW,
                android.net.Uri.parse(url));
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
        } catch (Exception ignored) { /* no browser to hand it to */ }
    }

    /** The WALLET owns reminders/history — ask it, never answer for it here. */
    private void walletCommand(String command, String url) {
        JSObject ev = new JSObject();
        ev.put("command", command);
        ev.put("url", url == null ? "" : url);
        notifyListeners("walletCommand", ev);
    }

    private void clearDappCache() {
        try {
            if (dappView != null) {
                dappView.clearCache(true);
                android.webkit.WebStorage.getInstance().deleteAllData();
            }
            android.widget.Toast.makeText(getContext(), "Cache cleared", android.widget.Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) { /* nothing cached, nothing cleared */ }
    }

    // Bookmarks live with the wallet (dapp-sessions/bookmarks), so the menu only
// asks the wallet to toggle. Java cannot read the wallet's bookmark list, so
// the star stays a neutral outline and the wallet's toast is the verdict —
// a filled star here would claim state Java cannot see.
private void toggleBookmark(String url) { walletCommand("toggleBookmark", url); }

    private void closeTabPanel() {
        if (tabPanel != null) tabPanel.setVisibility(View.GONE);
    }

    // Site tile helpers: the leading circle on each tab card (OKX leads with the
    // site logo; we lead with the host's initial on a stable colour).
    private static String hostInitial(Tab t) {
        String src = (t != null && t.url != null && !t.url.isEmpty()) ? t.url
            : (t != null && t.title != null && !t.title.isEmpty() ? t.title : "");
        String host = src;
        int at = src.indexOf('@');
        int colon = src.indexOf("://");
        int slash = src.indexOf('/', colon >= 0 ? colon + 3 : 0);
        if (at >= 0) host = src.substring(at + 1);
        else if (slash >= 0) host = src.substring(colon >= 0 ? colon + 3 : 0, slash);
        if (host.isEmpty()) return "?";
        return host.substring(0, 1).toUpperCase(java.util.Locale.ROOT);
    }

    // Deterministic per-host colour so the same site always gets the same tile.
    private static int tileColor(Tab t) {
        String key = hostInitial(t) + (t != null && t.url != null ? t.url : "");
        int h = 0;
        for (int i = 0; i < key.length(); i++) h = h * 31 + key.charAt(i);
        int[] palette = { 0xFF6C5CE7, 0xFF00B894, 0xFFE17055, 0xFF0984E3, 0xFFD63031, 0xFF00CEC9 };
        return palette[Math.abs(h) % palette.length];
    }

    private void openTabPanel() {
        if (tabPanel == null || tabList == null) return;
        final float density = getActivity().getResources().getDisplayMetrics().density;
        tabList.removeAllViews();
        for (int i = 0; i < tabs.size(); i++) {
            final int idx = i;
            Tab t = tabs.get(i);
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setBackgroundColor(i == activeTab ? 0xFF23233A : 0x00000000);
            // Site tile: a coloured initial on the host, the way OKX leads each
            // card with the site's logo. A favicon would need a synchronous
            // image fetch per tab — the tab sheet opens on a tap, so a network
            // round-trip there is a visible stall, and a letter tile is always
            // instant and never a broken-image box.
            android.widget.TextView tile = new android.widget.TextView(getContext());
            tile.setText(hostInitial(t));
            tile.setTextColor(0xFFFFFFFF);
            tile.setTextSize(15);
            tile.setGravity(android.view.Gravity.CENTER);
            android.graphics.drawable.GradientDrawable tileBg = new android.graphics.drawable.GradientDrawable();
            tileBg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            tileBg.setColor(tileColor(t));
            tile.setBackground(tileBg);
            LinearLayout.LayoutParams tileLp = new LinearLayout.LayoutParams((int) (34 * density), (int) (34 * density));
            tileLp.gravity = android.view.Gravity.CENTER_VERTICAL;
            tileLp.rightMargin = (int) (2 * density);
            row.addView(tile, tileLp);
            android.widget.TextView tv = new android.widget.TextView(getContext());
            String title = (t.title != null && !t.title.isEmpty())
                ? t.title
                : (t.url != null && !t.url.isEmpty() ? t.url : "New tab");
            tv.setText(title);
            tv.setTextColor(0xFFE6E6F0);
            tv.setTextSize(14);
            tv.setSingleLine(true);
            tv.setEllipsize(android.text.TextUtils.TruncateAt.END);
            tv.setPadding((int) (10 * density), 0, 0, 0);
            tv.setContentDescription("dapp-tab-row-" + i);
            tv.setOnClickListener(v -> {
                setActiveTab(idx);
                closeTabPanel();
            });
            row.addView(tv, new LinearLayout.LayoutParams(0, (int) (52 * density), 1));

            Button x = new Button(getContext());
            x.setText("\u2715");
            x.setAllCaps(false);
            x.setTextColor(0xFFE6E6F0);
            x.setBackgroundColor(0x00000000);
            x.setContentDescription("dapp-tab-close-" + i);
            x.setOnClickListener(v -> closeTab(idx));
            row.addView(x, new LinearLayout.LayoutParams((int) (48 * density), (int) (52 * density)));

            tabList.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (52 * density)));
        }
        tabPanel.setVisibility(View.VISIBLE);
        tabPanel.bringToFront();
        // Keep the toolbar tappable above the sheet (its own ✕ closes it too).
        if (toolbar != null) toolbar.bringToFront();
    }

    /** Close one tab. The last tab is never closed — it is the browser's floor. */
    private void closeTab(int i) {
        if (i < 0 || i >= tabs.size()) return;
        if (tabs.size() <= 1) { closeTabPanel(); return; }
        Tab t = tabs.remove(i);
        if (stack != null) stack.removeView(t.wrap);
        try { t.view.destroy(); } catch (Throwable ignore) { /* already gone */ }
        if (activeTab > i) activeTab -= 1;
        else if (activeTab == i) activeTab = Math.min(i, tabs.size() - 1);
        setActiveTab(activeTab);
        openTabPanel(); // rebuild the sheet with the new set
    }

    private void setActiveTab(int i) {
        if (i < 0 || i >= tabs.size()) return;
        if (activeTab >= 0 && activeTab < tabs.size() && activeTab != i) {
            tabs.get(activeTab).wrap.setVisibility(View.GONE);
        }
        activeTab = i;
        Tab t = tabs.get(i);
        dappView = t.view;
        refreshLayout = t.wrap;
        hideLoadingBar();   // a tab switch settles any bar left by the previous tab
        // Page content stays clear of the native toolbar: a top margin on the
        // wrapper (set once at addView, re-asserted here). A margin — not the
        // padding this used to be — keeps the pull-to-refresh spinner in the
        // band BELOW the bar instead of hidden underneath it.
        applyBarInset(refreshLayout);
        refreshLayout.setVisibility(View.VISIBLE);
        if (stack != null) refreshLayout.bringToFront();
        currentUrl = t.url == null ? "" : t.url;   // the active tab owns the RPC origin
        if (addressField != null) {
            addressField.setText(t.url == null ? "" : t.url);
            addressField.setBackgroundColor(ADDRESS_IDLE);
        }
        updateNavButtons();
        // Badge, not glyph text: "⧉ 12" would push the address bar out of a
        // 48dp bar. Hidden at 1 — a lone tab needs no "you have one tab" chip.
        if (tabCountBadge != null) {
            int n = tabs.size();
            tabCountBadge.setText(n > 99 ? "99+" : String.valueOf(n));
            tabCountBadge.setVisibility(n > 1 ? View.VISIBLE : View.GONE);
        }
        if (tabPanel != null && tabPanel.getVisibility() == View.VISIBLE) openTabPanel();
    }

    /** History state on the native toolbar (main thread only). */
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

    /** Per-tab navigation lifecycle. Each tab has its own instance so the
     *  hooks drive THAT tab's title/state, while the shared toolbar follows
     *  only the active one. */
    private class BrowserClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            Tab t = tabOf(view);
            if (t != null) t.url = url == null ? "" : url;
            // Only the ACTIVE tab owns the RPC origin (a background tab
            // navigating must not rewrite the origin of the visible page).
            if (view == dappView) {
                currentUrl = url == null ? "" : url; // main thread — the ONLY writer the bridge thread reads
                if (addressField != null) {
                    addressField.setText(url == null ? "" : url);
                    addressField.setBackgroundColor(ADDRESS_LOADING);
                }
                showLoadingBar();   // visible progress while the page loads
                updateNavButtons();
            }
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
            Tab t = tabOf(view);
            if (t != null) {
                t.url = url == null ? "" : url;
                t.title = view.getTitle() == null ? "" : view.getTitle();
            }
            injectProvider(view, "finish", url);
            if (view == dappView) {
                // Address bar settles: idle tint, live back/forward state.
                if (addressField != null) {
                    addressField.setText(url == null ? "" : url);
                    addressField.setBackgroundColor(ADDRESS_IDLE);
                }
                hideLoadingBar();
                updateNavButtons();
            }
            if (t != null && t.wrap != null) t.wrap.setRefreshing(false); // pull-to-refresh spinner stops once the page lands
            JSObject ev = new JSObject();
            ev.put("event", "loadEnd");
            ev.put("url", url);
            notifyListeners("navigation", ev);
        }

        @Override
        public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
            if (!request.isForMainFrame()) return;
            if (view == dappView) hideLoadingBar();  // a dead load must not leave the bar spinning
            JSObject ev = new JSObject();
            ev.put("event", "loadError");
            ev.put("url", request.getUrl().toString());
            ev.put("description", String.valueOf(error.getDescription()));
            notifyListeners("navigation", ev);
        }
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
                if (parent != null && stack != null && stack.getParent() == null) {
                    parent.addView(stack, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                }
                if (stack != null) {
                    stack.setVisibility(View.VISIBLE);
                    stack.bringToFront();
                }
                if (refreshLayout != null) {
                    refreshLayout.setVisibility(View.VISIBLE);
                    refreshLayout.bringToFront();
                }
                if (toolbar != null) {
                    toolbar.setVisibility(View.VISIBLE);
                    toolbar.bringToFront(); // above the dapp view, always
                }
                dappView.setVisibility(View.VISIBLE);
                // The ACTIVE tab is the destination — the E2E and card taps
                // both expect one obvious view, and tabs are opened explicitly
                // by the user ("+ New tab"), never implicitly per navigation.
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

    private void hideDappView() {
        finishConfirm(false);   // a pending consent dies with the browser — never hang the wallet JS
        closeDappMenu();
        closeTabPanel();
        if (stack != null) stack.setVisibility(View.GONE);
        if (refreshLayout != null) {
            refreshLayout.setRefreshing(false);
            refreshLayout.setVisibility(View.GONE);
        }
        if (toolbar != null) toolbar.setVisibility(View.GONE);
        // The tab SESSION survives a hide on purpose: closing the browser must
        // not kill the pages the user left open — they can reopen any tab from
        // the wallet's DApps view ("diluar daaps ga ada tabs", report
        // 2026-10-11). Background tabs were never blanked; the active tab is
        // now consistent with them. destroy() in handleOnDestroy still tears
        // everything down.
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
                if (stack != null) stack.setVisibility(visible ? View.VISIBLE : View.GONE);
                if (refreshLayout != null) {
                    refreshLayout.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (visible) refreshLayout.bringToFront();
                }
                if (toolbar != null) {
                    toolbar.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (visible) toolbar.bringToFront(); // toolbar stays topmost
                }
                if (!visible && tabPanel != null) tabPanel.setVisibility(View.GONE);
            }
            call.resolve();
        });
    }

    /**
     * Wallet → native: the open tabs, so the wallet's own DApps page can offer
     * a "Tabs" entry and reopen the browser on any of them (user report
     * 2026-10-11: "diluar daaps ga ada tabs" — tabs were only reachable from
     * inside the browser). The session survives while the overlay is hidden.
     */
    @PluginMethod
    public void getTabs(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            ret.put("open", dappView != null);
            ret.put("active", activeTab);
            JSArray arr = new JSArray();
            for (int i = 0; i < tabs.size(); i++) {
                Tab t = tabs.get(i);
                JSObject o = new JSObject();
                String title = (t.title == null || t.title.isEmpty()) ? (t.url == null ? "" : t.url) : t.title;
                o.put("title", title);
                o.put("url", t.url == null ? "" : t.url);
                arr.put(o);
            }
            ret.put("tabs", arr);
            call.resolve(ret);
        });
    }

    /** Wallet → native: bring tab <index> to the front and show the browser. */
    @PluginMethod
    public void selectTab(PluginCall call) {
        Integer idx = call.getInt("index");
        getActivity().runOnUiThread(() -> {
            if (idx != null && idx >= 0 && idx < tabs.size()) setActiveTab(idx);
            if (dappView != null) {
                if (stack != null) stack.setVisibility(View.VISIBLE);
                if (refreshLayout != null) { refreshLayout.setVisibility(View.VISIBLE); refreshLayout.bringToFront(); }
                if (toolbar != null) { toolbar.setVisibility(View.VISIBLE); toolbar.bringToFront(); }
            }
            call.resolve();
        });
    }

    /**
     * Wallet → native: the active chain changed (the user picked a network in
     * the wallet's picker, or a dApp switched it). Update the ◆ chip and fire
     * EIP-1193 chainChanged into EVERY open tab, so a dApp listening on
     * window.ethereum hears the move exactly once.
     */
    @PluginMethod
    public void setChain(PluginCall call) {
        String label = call.getString("label", "");
        final String chainHex = call.getString("chainId", "");
        getActivity().runOnUiThread(() -> {
            if (netBtn != null && label != null && !label.isEmpty()) netBtn.setText(label);
            // chainHex is wallet-supplied (trusted) but still validated before
            // it is embedded in evaluateJavascript: only a 0x-hex literal
            // reaches the page — never an arbitrary string.
            if (chainHex != null && chainHex.matches("0x[0-9a-fA-F]+")) {
                final String js = "(function(){try{if(window.__bearNativeNotify)"
                    + "window.__bearNativeNotify({event:'chainChanged',data:'" + chainHex + "'});"
                    + "return 'ok';}catch(e){return 'ERR';}})()";
                for (Tab t : tabs) {
                    try { t.view.evaluateJavascript(js, null); } catch (Throwable ignore) { /* tab gone */ }
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
            finishConfirm(false);   // destroy must not leave a wallet-side promise hanging
            for (Tab t : tabs) {
                if (t.view != null) {
                    t.view.destroy();
                    t.view = null;
                }
            }
            tabs.clear();
            dappView = null;
            refreshLayout = null;
            closeDappMenu();
            menuRoot = null;
        });
        super.handleOnDestroy();
    }
}
