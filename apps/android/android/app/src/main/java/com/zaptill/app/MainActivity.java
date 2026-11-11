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
     * why the WebView sat under the clock on every screen. We inset the content view ourselves by the system-bar insets,
     * with the dark app colour showing behind the bars — ONE place, every screen.
     *
     * ── THE KEYBOARD IS THE WEBVIEW'S JOB, NOT OURS ──────────────────────────────
     * We do NOT touch the IME inset here. The earlier code lifted the content by the keyboard height itself, which left a
     * band of the dark background between the content and the keyboard (owner, 2026-11-09, three times: "the black section
     * is still there"). Instead windowSoftInputMode="adjustResize" + the viewport's `interactive-widget=resizes-content`
     * (apps/android/index.html) let the WebView resize its own layout for the keyboard — so 100dvh, and a fixed modal's
     * backdrop, shrink to sit exactly on the keyboard with no gap. If we also inset by the IME here, the two fight and the
     * band comes back — so this listener is SYSTEM BARS ONLY.
     */
    private void fitContentInsideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        final View content = findViewById(android.R.id.content);
        content.setBackgroundColor(0xFF050D12);   // the app background (styles.css --bg), shown behind the status/nav bars
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            // System bars + the camera cutout only. The keyboard is handled by the WebView (adjustResize + interactive-widget),
            // never here. We do NOT consume the insets, so the IME inset still reaches the WebView for its own resize.
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
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
