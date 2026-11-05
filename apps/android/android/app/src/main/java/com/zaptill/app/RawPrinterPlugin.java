package com.zaptill.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RawPrinter — ESC/POS bytes to a network printer over raw TCP (port 9100), Till stage 1 (docs/ANDROID-APP-DESIGN.md
 * §4.6, §11). The bytes are rendered by shared/printing in the web POS screens; this only carries them. Never Android's
 * PrintManager (it rasterises; §4.6).
 *
 *   send({ host, port, data: base64 }) → { bytes }    rejects with code PRINTER_UNREACHABLE or PRINTER_FAILED
 *
 * The rules (one job per connection, one connection per printer at a time on this tablet, a jittered retry when the
 * printer is busy with another tablet) are in RawPrinterSpool, which has no Android in it so its unit test runs it.
 */
@CapacitorPlugin(name = "RawPrinter")
public class RawPrinterPlugin extends Plugin {
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final RawPrinterSpool spool = new RawPrinterSpool(new RawPrinterSpool.SocketLink());

    @PluginMethod
    public void send(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 9100);
        final String data = call.getString("data", "");
        if (!RawPrinterSpool.isPrinterAddress(host) || port < 1 || port > 65535) {
            call.reject("That is not a printer's network address.", "PRINTER_ADDRESS");
            return;
        }
        final byte[] bytes;
        try { bytes = Base64.decode(data, Base64.DEFAULT); }
        catch (IllegalArgumentException e) { call.reject("Nothing to print.", "PRINTER_FAILED"); return; }
        if (bytes.length == 0 || bytes.length > RawPrinterSpool.MAX_JOB_BYTES) { call.reject("Nothing to print.", "PRINTER_FAILED"); return; }
        workers.execute(() -> {
            try {
                spool.send(host, port, bytes);
                JSObject out = new JSObject();
                out.put("bytes", bytes.length);
                call.resolve(out);
            } catch (RawPrinterSpool.PrinterException e) {
                call.reject(e.getMessage(), e.code);
            }
        });
    }
}
