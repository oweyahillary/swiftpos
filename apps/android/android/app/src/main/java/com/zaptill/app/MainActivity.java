package com.zaptill.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** The one screen: Capacitor's WebView with the app's own screens (apps/android/src), and ZapTill's native plugins
 *  (Till stage 1 adds RawPrinter — tickets to a network printer — and BranchServer — joining and printing through it). */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        CrashReporter.install(getApplicationContext());
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(CrashReportsPlugin.class);
        registerPlugin(RawPrinterPlugin.class);
        registerPlugin(BranchServerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
