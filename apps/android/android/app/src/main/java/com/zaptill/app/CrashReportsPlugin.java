package com.zaptill.app;

import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * CrashReports — what src/errors/reporter.ts needs from Android: the native crash kept since the last run
 * (CrashReporter), and a short description of the device for the admin portal's alert.
 */
@CapacitorPlugin(name = "CrashReports")
public class CrashReportsPlugin extends Plugin {

    @PluginMethod
    public void takePendingCrash(PluginCall call) {
        String[] crash = CrashReporter.takePending(getContext());
        JSObject ret = new JSObject();
        if (crash == null) {
            ret.put("crash", JSObject.NULL);
        } else {
            JSObject c = new JSObject();
            c.put("message", crash[0]);
            c.put("stack", crash[1]);
            ret.put("crash", c);
        }
        call.resolve(ret);
    }

    /** "Android 14 (API 34), samsung SM-T220" — the make and model only, no serial number or name. */
    @PluginMethod
    public void deviceSummary(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("summary", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), " + Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(ret);
    }

    /**
     * A stable per-device id (Settings.Secure.ANDROID_ID): it survives a clean reinstall of the app, so a re-installed
     * Shop POS is recognised as the SAME device (A182-style machine identity) instead of enrolling as a new one. It is not
     * a serial number — it is scoped to the app's signing key and the device/user. "" when the platform withholds it, and
     * the JS side then falls back to a generated id.
     */
    @PluginMethod
    public void hardwareId(PluginCall call) {
        JSObject ret = new JSObject();
        String id = "";
        try {
            id = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception e) { /* withheld: the JS side generates one instead */ }
        ret.put("id", id == null ? "" : id);
        call.resolve(ret);
    }
}
