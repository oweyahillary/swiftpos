package com.zaptill.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import org.json.JSONObject;

/**
 * BranchServer — the shop network's branch server, for joining through it and printing through it (Till stage 1,
 * docs/ANDROID-APP-DESIGN.md §4.3, §11). The same A427 / A489 flow as a desktop POS being installed:
 *
 *   listen({ ms })               the server's beacons on UDP 4199 → { heard: [{ ip, text }] } (the app parses them)
 *   readCert({ url })            GET /node/tls — the certificate is public, handed to anyone → { cert, code } | { old }
 *   request({ url, method, headers, body, cert })
 *                                one request over TLS trusting ONLY that certificate (PinnedTls) → { status, body }
 *
 * Nothing goes to a branch server in plain HTTP but the public certificate itself: a server too old to have one is not
 * joined ("update the branch server"), so the join's answer (the branch access code, this POS's device key) and every
 * ticket travel encrypted.
 */
@CapacitorPlugin(name = "BranchServer")
public class BranchServerPlugin extends Plugin {
    static final int BEACON_PORT = 4199;
    private static final int MAX_ANSWER = 256 * 1024;
    private final ExecutorService workers = Executors.newCachedThreadPool();

    @PluginMethod
    public void listen(PluginCall call) {
        final int ms = Math.max(1000, Math.min(15000, call.getInt("ms", 6000)));
        workers.execute(() -> {
            JSArray heard = new JSArray();
            // Android drops broadcast packets to save power unless a multicast lock is held while listening.
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("zaptill-beacon") : null;
            if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
            try (DatagramSocket s = new DatagramSocket(null)) {
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(BEACON_PORT));
                long until = System.currentTimeMillis() + ms;
                byte[] buf = new byte[2048];
                while (System.currentTimeMillis() < until) {
                    s.setSoTimeout((int) Math.max(1, until - System.currentTimeMillis()));
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try { s.receive(p); } catch (SocketTimeoutException e) { break; }
                    JSObject one = new JSObject();
                    one.put("ip", p.getAddress().getHostAddress());
                    one.put("text", new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    heard.put(one);
                    if (heard.length() >= 50) break;
                }
            } catch (IOException e) {
                // nothing heard (no Wi-Fi, the port taken) — the technician enters the enrolment code instead
            } finally {
                if (lock != null) lock.release();
            }
            JSObject out = new JSObject();
            out.put("heard", heard);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void readCert(PluginCall call) {
        final String url = call.getString("url", "");
        workers.execute(() -> {
            try {
                URL u = new URL(url);
                if (!"http".equals(u.getProtocol())) { call.reject("Not a branch server's address.", "BAD_ADDRESS"); return; }
                String answer = plainGet(u.getHost(), u.getPort() > 0 ? u.getPort() : 80, "/node/tls");
                JSObject out = new JSObject();
                String status = answer.substring(0, answer.indexOf('\n'));
                if ("404".equals(status)) { out.put("old", true); call.resolve(out); return; }   // a server before A489
                if (!"200".equals(status)) { call.reject("The branch server did not answer.", "UNREACHABLE"); return; }
                String pem = new JSONObject(answer.substring(answer.indexOf('\n') + 1)).optString("cert", "");
                byte[] der = PinnedTls.derOf(pem);
                if (der == null) { out.put("old", true); call.resolve(out); return; }
                out.put("cert", PinnedTls.pemOf(der));
                out.put("code", PinnedTls.securityCode(der));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("The branch server did not answer.", "UNREACHABLE");
            }
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers", new JSObject());
        final int timeout = Math.max(2000, Math.min(30000, call.getInt("timeoutMs", 10000)));
        final byte[] pinned = PinnedTls.derOf(call.getString("cert", ""));
        if (pinned == null) { call.reject("No certificate to trust for the branch server.", "NO_PIN"); return; }
        workers.execute(() -> {
            HttpsURLConnection c = null;
            try {
                URL plain = new URL(url);
                // The server answers TLS and plain HTTP on the same port (lanTls.ts); a saved http:// address goes as https://.
                URL u = new URL("https", plain.getHost(), plain.getPort(), plain.getFile());
                SSLContext tls = SSLContext.getInstance("TLS");
                tls.init(null, new TrustManager[] { PinnedTls.trusting(pinned) }, null);
                c = (HttpsURLConnection) u.openConnection();
                c.setSSLSocketFactory(tls.getSocketFactory());
                c.setHostnameVerifier((host, session) -> true);   // the certificate itself is pinned — no name to check
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setInstanceFollowRedirects(false);
                c.setRequestMethod(method);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) { String k = keys.next(); c.setRequestProperty(k, headers.getString(k)); }
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                JSObject out = new JSObject();
                out.put("status", status);
                out.put("body", in == null ? "" : readCapped(in));
                call.resolve(out);
            } catch (javax.net.ssl.SSLException e) {
                call.reject("The branch server's identity changed — it is not the server this POS joined. A technician joins it again.", "IDENTITY_CHANGED");
            } catch (Exception e) {
                call.reject("The branch server did not answer.", "UNREACHABLE");
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    /** A minimal HTTP/1.0 GET over a plain socket — only for the public certificate (Android refuses cleartext elsewhere). */
    static String plainGet(String host, int port, String path) throws IOException {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 4000);
            s.setSoTimeout(4000);
            OutputStream out = s.getOutputStream();
            out.write(("GET " + path + " HTTP/1.0\r\nHost: " + host + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            String raw = readCapped(s.getInputStream());
            int headEnd = raw.indexOf("\r\n\r\n");
            String statusLine = raw.substring(0, Math.max(0, raw.indexOf("\r\n")));
            String[] parts = statusLine.split(" ");
            String status = parts.length > 1 ? parts[1] : "0";
            return status + "\n" + (headEnd >= 0 ? raw.substring(headEnd + 4) : "");
        }
    }

    static String readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) {
            if (buf.size() + n > MAX_ANSWER) throw new IOException("answer too large");
            buf.write(chunk, 0, n);
        }
        return buf.toString("UTF-8");
    }
}
