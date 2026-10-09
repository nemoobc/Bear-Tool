package com.nemoobc.beartool;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
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
