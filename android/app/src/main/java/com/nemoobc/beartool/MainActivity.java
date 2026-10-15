package com.nemoobc.beartool;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // LIGHT-ONLY, the same on every phone. The wallet has no dark variant
        // (no prefers-color-scheme anywhere in css/), so letting the system's
        // dark mode through only buys algorithmic WebView darkening and dark
        // native dialogs — user, APK 2026-10-15: "ui dappas masih hitam".
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
        // Register BEFORE super.onCreate(): the Capacitor bridge is built inside
        // super.onCreate() (BridgeActivity.load() → bridgeBuilder.create(), node_modules
        // @capacitor/android BridgeActivity.java:48). registerPlugin() only stages the
        // class into bridgeBuilder (:54-56), so a plugin added AFTER the bridge is
        // created never reaches it — a compiled-but-unregistered @CapacitorPlugin is
        // invisible to the JS registerPlugin('BearDappBrowser') call (js/native-dapp.js:52).
        registerPlugin(BearDappBrowserPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
