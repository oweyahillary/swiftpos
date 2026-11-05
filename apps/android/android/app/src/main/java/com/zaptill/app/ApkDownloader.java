package com.zaptill.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Downloads the approved APK and checks its SHA-256 while it streams (docs/ANDROID-APP-DESIGN.md §1.4). No Android
 * classes, so ApkDownloaderTest runs it on the build machine.
 *
 * The cloud answers the download with a redirect to the file's short-lived link on another host (GitHub today). The
 * session header is sent to the cloud only — never to the host it redirects to — and every hop must be https.
 */
final class ApkDownloader {

    /** Thrown when the bytes do not hash to the SHA-256 the cloud named; nothing is kept. */
    static final class VerifyException extends Exception {
        VerifyException(String message) { super(message); }
    }

    static final int MAX_REDIRECTS = 5;
    private static final Pattern APK_NAME = Pattern.compile("^ZapTill-\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}\\.apk$");
    private static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");

    private ApkDownloader() {}

    /** Only ZapTill-x.y.z.apk: the name becomes a file path, so nothing else is accepted. */
    static boolean isApkFileName(String name) { return name != null && APK_NAME.matcher(name).matches(); }

    static boolean isSha256(String hex) { return hex != null && SHA256_HEX.matcher(hex).matches(); }

    /** The session goes only to the address the app called: same scheme, host and port. */
    static boolean sendsAuthorizationTo(URL first, URL now) {
        return first.getProtocol().equalsIgnoreCase(now.getProtocol())
            && first.getHost().equalsIgnoreCase(now.getHost())
            && first.getPort() == now.getPort();
    }

    /** Copy `in` to `out` and return the SHA-256 of what was copied, as lowercase hex. */
    static String copyAndHash(InputStream in, OutputStream out) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IOException("SHA-256 is not available", e); }
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) != -1) {
            digest.update(buffer, 0, n);
            out.write(buffer, 0, n);
        }
        return hex(digest.digest());
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    /**
     * Download `url` into `dir/fileName`, following up to MAX_REDIRECTS https redirects, and keep it only when its
     * SHA-256 equals `expectedSha256`. Returns the file.
     */
    static File download(String url, String authorization, String expectedSha256, File dir, String fileName)
        throws IOException, VerifyException {
        if (!isApkFileName(fileName)) throw new IOException("Not an update file name: " + fileName);
        String expected = expectedSha256 == null ? "" : expectedSha256.toLowerCase(Locale.ROOT);
        if (!isSha256(expected)) throw new IOException("The update has no valid SHA-256 to check against.");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);

        URL first = new URL(url);
        URL current = first;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (hop > 0 && !"https".equalsIgnoreCase(current.getProtocol())) throw new IOException("Refusing a redirect that is not https.");
            HttpURLConnection conn = (HttpURLConnection) current.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20_000);
            conn.setReadTimeout(60_000);
            if (authorization != null && !authorization.isEmpty() && sendsAuthorizationTo(first, current)) {
                conn.setRequestProperty("Authorization", authorization);
            }
            try {
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null) throw new IOException("A redirect without a Location.");
                    current = new URL(current, location);
                    continue;
                }
                if (status != 200) throw new IOException("The update download answered HTTP " + status + ".");
                return saveVerified(conn.getInputStream(), expected, dir, fileName);
            } finally {
                conn.disconnect();
            }
        }
        throw new IOException("Too many redirects.");
    }

    /** Write the stream to a .part file, check it, then give it its name. A mismatch deletes it. */
    static File saveVerified(InputStream in, String expected, File dir, String fileName) throws IOException, VerifyException {
        File part = new File(dir, fileName + ".part");
        File done = new File(dir, fileName);
        String actual;
        try (InputStream src = in; OutputStream out = new FileOutputStream(part)) {
            actual = copyAndHash(src, out);
        } catch (IOException e) {
            part.delete();
            throw e;
        }
        if (!actual.equals(expected)) {
            part.delete();
            throw new VerifyException("The downloaded update does not match its SHA-256 — it was not installed.");
        }
        if (done.exists() && !done.delete()) throw new IOException("Cannot replace " + done);
        if (!part.renameTo(done)) throw new IOException("Cannot keep " + done);
        return done;
    }
}
