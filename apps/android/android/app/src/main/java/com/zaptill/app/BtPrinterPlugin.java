package com.zaptill.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * BtPrinter — ESC/POS bytes to a PAIRED Bluetooth thermal printer (Bluetooth Classic SPP), the third receipt-printer
 * transport after RawPrinter (a network printer) and the branch server (a USB printer on a PC). docs/designs/ANDROID-APP-DESIGN.md §4.6.
 *
 *   listPaired()                      -> { devices: [{ name, address }] }    the bonded devices to pick from
 *   print({ address, data: base64 })  -> { bytes }                           rejects BT_PERMISSION / BT_OFF / BT_ADDRESS / BT_UNREACHABLE / BT_FAILED
 *
 * WHY Classic SPP (UUID 00001101-…), not BLE: essentially every 58/80 mm receipt printer speaks RFCOMM/SPP; BLE printers
 * are rare and slower for bulk bytes. WHY bonded-only (no scanning): the person pairs the printer once in Android Settings,
 * so the app needs only BLUETOOTH_CONNECT (API 31+) — no scan, no location. The bytes are rendered by shared/printing in the
 * web POS screens; this only carries them (never Android's PrintManager, which rasterises). One job per connection, on a
 * worker thread.
 */
@CapacitorPlugin(name = "BtPrinter", permissions = {
    @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
})
public class BtPrinterPlugin extends Plugin {
    private static final String BLUETOOTH = "bluetooth";
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int MAX_JOB_BYTES = 200_000;
    private final ExecutorService workers = Executors.newCachedThreadPool();

    /** BLUETOOTH_CONNECT is a RUNTIME permission only from API 31 (S); below that Bluetooth is an install-time permission. */
    private boolean needsRuntimePermission() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S; }
    private boolean hasPermission() { return !needsRuntimePermission() || getPermissionState(BLUETOOTH) == PermissionState.GRANTED; }

    private BluetoothAdapter adapter() {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return mgr != null ? mgr.getAdapter() : null;
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (!hasPermission()) { requestPermissionForAlias(BLUETOOTH, call, "permCallback"); return; }
        doListPaired(call);
    }

    @PluginMethod
    public void print(PluginCall call) {
        if (!hasPermission()) { requestPermissionForAlias(BLUETOOTH, call, "permCallback"); return; }
        doPrint(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (!hasPermission()) { call.reject("Allow Bluetooth so the app can use a Bluetooth printer.", "BT_PERMISSION"); return; }
        if ("print".equals(call.getMethodName())) doPrint(call); else doListPaired(call);
    }

    private void doListPaired(PluginCall call) {
        try {
            BluetoothAdapter adapter = adapter();
            if (adapter == null) { call.reject("This device has no Bluetooth.", "BT_OFF"); return; }
            if (!adapter.isEnabled()) { call.reject("Turn Bluetooth on, then try again.", "BT_OFF"); return; }
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            JSArray devices = new JSArray();
            if (bonded != null) {
                for (BluetoothDevice d : bonded) {
                    JSObject o = new JSObject();
                    String name = d.getName();
                    o.put("name", name != null && !name.isEmpty() ? name : d.getAddress());
                    o.put("address", d.getAddress());
                    devices.put(o);
                }
            }
            JSObject out = new JSObject();
            out.put("devices", devices);
            call.resolve(out);
        } catch (SecurityException e) {
            call.reject("Allow Bluetooth so the app can use a Bluetooth printer.", "BT_PERMISSION");
        } catch (Exception e) {
            call.reject("Could not read the paired Bluetooth devices.", "BT_FAILED");
        }
    }

    private void doPrint(PluginCall call) {
        final String address = call.getString("address", "");
        final String data = call.getString("data", "");
        final BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Turn Bluetooth on, then try again.", "BT_OFF"); return; }
        if (!BluetoothAdapter.checkBluetoothAddress(address)) { call.reject("That is not a Bluetooth printer address.", "BT_ADDRESS"); return; }
        final byte[] bytes;
        try { bytes = Base64.decode(data, Base64.DEFAULT); }
        catch (IllegalArgumentException e) { call.reject("Nothing to print.", "BT_FAILED"); return; }
        if (bytes.length == 0 || bytes.length > MAX_JOB_BYTES) { call.reject("Nothing to print.", "BT_FAILED"); return; }

        workers.execute(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(address);
                socket = device.createRfcommSocketToServiceRecord(SPP);
                adapter.cancelDiscovery();   // discovery in progress slows or breaks a connect
                socket.connect();
                OutputStream os = socket.getOutputStream();
                os.write(bytes);
                os.flush();
                // Let the printer drain before the socket closes, or the tail of the receipt is cut off.
                try { Thread.sleep(150); } catch (InterruptedException ignored) {}
                os.close();
                JSObject out = new JSObject();
                out.put("bytes", bytes.length);
                call.resolve(out);
            } catch (SecurityException e) {
                call.reject("Allow Bluetooth so the app can use a Bluetooth printer.", "BT_PERMISSION");
            } catch (IOException e) {
                call.reject("The Bluetooth printer did not answer. Check it is on, in range and paired.", "BT_UNREACHABLE");
            } catch (Exception e) {
                call.reject("The Bluetooth printer could not print this.", "BT_FAILED");
            } finally {
                if (socket != null) { try { socket.close(); } catch (Exception ignored) {} }
            }
        });
    }
}
