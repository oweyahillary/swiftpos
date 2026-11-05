package com.zaptill.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** The one screen: Capacitor's WebView with the app's own screens (apps/android/src), and ZapTill's two native plugins. */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        CrashReporter.install(getApplicationContext());
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(CrashReportsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
