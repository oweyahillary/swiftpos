package com.zaptill.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

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
        fitContentInsideSystemBars();
        makeItFeelNative();
    }

    /**
     * Android 15+ FORCES edge-to-edge, and this app targets SDK 36: the window draws BEHIND the status bar and the
     * navigation bar, and @capacitor/status-bar's setOverlaysWebView(false) / setBackgroundColor(...) are no-ops. That is
     * why the WebView sat under the clock on every screen. We inset the content view ourselves by the system-bar insets
     * (and lift it above the keyboard), with the dark app colour showing behind the bars — ONE place, every screen.
     */
    private void fitContentInsideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        final View content = findViewById(android.R.id.content);
        content.setBackgroundColor(0xFF050D12);   // the app background (styles.css --bg), shown behind the status/nav bars
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime  = insets.getInsets(WindowInsetsCompat.Type.ime());
            // Top/left/right: never under a bar or the camera cutout. Bottom: clear of the nav bar, and lifted above the
            // keyboard when it is open (max of the two), so a field (enrolment code, payment amount) is never covered.
            // This manual IME lift is the ONLY one: the manifest sets windowSoftInputMode="adjustNothing" (NOT adjustResize),
            // because with setDecorFitsSystemWindows(false) adjustResize ALSO shrinks the window for the keyboard — the two
            // together lifted the WebView by ~2× the keyboard height and left a band of this dark background showing between
            // the content and the keyboard (owner, 2026-11-09: "the black section is still there").
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), content);
        controller.setAppearanceLightStatusBars(false);        // light icons, for our dark status strip
        controller.setAppearanceLightNavigationBars(false);
        ViewCompat.requestApplyInsets(content);
    }

    /** WebView settings so the POS reads as an app, not a web page: no overscroll glow, no pinch/zoom, and system font
     *  scaling cannot blow the counter layout apart. */
    private void makeItFeelNative() {
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web == null) return;
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
    }
}
