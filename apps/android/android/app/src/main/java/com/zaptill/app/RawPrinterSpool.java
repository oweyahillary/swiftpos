package com.zaptill.app;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * RawPrinterSpool — how a Shop POS sends a ticket to a network printer (Till stage 1, docs/ANDROID-APP-DESIGN.md §11.4).
 *
 * Port 9100 takes one connection at a time (pinch point 2), and a ticket must reach the paper whole:
 *   - ONE JOB, ONE CONNECTION: a ticket's bytes are written on a connection of their own, then it is closed. Nothing of
 *     another ticket is ever written on it, so two tickets cannot interleave on the paper.
 *   - ONE AT A TIME PER PRINTER ON THIS TABLET: a fair lock per "host:port" — the kitchen fire and the receipt of one sale,
 *     or two cashiers' sales, go out in the order they were asked, never side by side.
 *   - ANOTHER TABLET ON THE SAME PRINTER: while it holds the printer, our connection is refused or times out; we wait a
 *     random 50–500 ms and try again (the jitter keeps two tablets from retrying in step), up to ATTEMPTS times. Then the
 *     printer is reported as not answering — the sale itself is already saved in the cloud.
 * Plain Java (no Android), so RawPrinterSpoolTest runs these rules.
 */
public final class RawPrinterSpool {
    /** A ticket is a few kilobytes (a logo raster included); anything far larger is not a ticket. */
    public static final int MAX_JOB_BYTES = 512 * 1024;
    public static final int ATTEMPTS = 6;
    public static final int CONNECT_TIMEOUT_MS = 3000;
    public static final int WRITE_TIMEOUT_MS = 10000;

    private static final Pattern IPV4 = Pattern.compile("^((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)$");
    private static final Pattern HOSTNAME = Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$");

    /** An IPv4 address or a plain host name on the shop network — never a URL, never anything with a path. */
    public static boolean isPrinterAddress(String host) {
        return host != null && host.length() <= 253 && (IPV4.matcher(host).matches() || HOSTNAME.matcher(host).matches());
    }

    public static final class PrinterException extends Exception {
        public final String code;
        PrinterException(String message, String code) { super(message); this.code = code; }
    }

    /** The connection, so the test can stand in for a printer. */
    public interface Link {
        OutputStream open(String host, int port) throws IOException;
        void close() throws IOException;
    }

    /** The real one: a TCP socket. */
    public static final class SocketLink implements Link {
        private final ThreadLocal<Socket> current = new ThreadLocal<>();
        @Override public OutputStream open(String host, int port) throws IOException {
            Socket s = new Socket();
            s.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            s.setSoTimeout(WRITE_TIMEOUT_MS);
            s.setTcpNoDelay(true);
            current.set(s);
            return s.getOutputStream();
        }
        @Override public void close() throws IOException {
            Socket s = current.get();
            current.remove();
            if (s == null) return;
            try { s.shutdownOutput(); } catch (IOException ignored) { /* the printer closed first */ }
            s.close();
        }
    }

    public interface Sleeper { void sleep(long ms) throws InterruptedException; }

    private final Link link;
    private final Sleeper sleeper;
    private final Random random;
    private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    public RawPrinterSpool(Link link) { this(link, Thread::sleep, new Random()); }
    public RawPrinterSpool(Link link, Sleeper sleeper, Random random) { this.link = link; this.sleeper = sleeper; this.random = random; }

    /** 50–500 ms. */
    long jitterMs() { return 50L + random.nextInt(451); }

    /** Send one ticket. Returns once every byte is written and the connection closed; throws with words for the screen. */
    public void send(String host, int port, byte[] bytes) throws PrinterException {
        ReentrantLock lock = locks.computeIfAbsent(host + ":" + port, k -> new ReentrantLock(true));
        lock.lock();
        try {
            writeWhole(connect(host, port), host, bytes);
        } finally {
            lock.unlock();
        }
    }

    /** A connection of this ticket's own; while another tablet holds the printer, wait a little and try again. */
    private OutputStream connect(String host, int port) throws PrinterException {
        for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
            try { return link.open(host, port); }
            catch (IOException e) {
                closeQuietly();
                if (attempt < ATTEMPTS) pause();
            }
        }
        throw new PrinterException("The printer at " + host + " is not answering. Check it is on and connected to the shop network.",
            "PRINTER_UNREACHABLE");
    }

    /** Every byte, then close. A ticket cut off half-way is never sent again by itself — a second, partial copy is worse. */
    private void writeWhole(OutputStream out, String host, byte[] bytes) throws PrinterException {
        try {
            out.write(bytes);
            out.flush();
            link.close();
        } catch (IOException e) {
            closeQuietly();
            throw new PrinterException("The printer at " + host + " stopped answering while printing. Check the paper and reprint if needed.",
                "PRINTER_FAILED");
        }
    }

    private void closeQuietly() {
        try { link.close(); } catch (IOException ignored) { /* nothing open, or already gone */ }
    }

    private void pause() throws PrinterException {
        try { sleeper.sleep(jitterMs()); }
        catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PrinterException("Printing was stopped.", "PRINTER_FAILED");
        }
    }
}
