package com.zaptill.app;

import android.os.Build;
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
}
