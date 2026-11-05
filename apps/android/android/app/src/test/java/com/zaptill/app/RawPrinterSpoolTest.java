package com.zaptill.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/**
 * How a Shop POS sends a ticket to a network printer (RawPrinterSpool; Till stage 1, docs/ANDROID-APP-DESIGN.md §11.4).
 * On the build machine: ./gradlew testDebugUnitTest (CI's Android job runs it).
 *
 * A stand-in printer records what each CONNECTION carried, and fails the test if two connections are ever open at once.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - send() without the per-printer lock                        → "two cashiers at once: one connection at a time" fails
 *   - connect() trying once (ATTEMPTS = 1)                        → "a printer busy with another tablet still prints" fails
 *   - jitterMs() returning a fixed 50                            → "the wait is 50–500 ms, not always the same" fails
 *   - writeWhole() retrying after a write failed                 → "a ticket cut off is never sent twice" fails
 *   - isPrinterAddress() accepting "http://10.0.0.5"              → "only an address" fails
 */
public class RawPrinterSpoolTest {

    /** A printer: refuses the first `busy` connections (another tablet holds it), records each connection's bytes. */
    static final class FakePrinter implements RawPrinterSpool.Link {
        final AtomicInteger refusals;
        final AtomicInteger open = new AtomicInteger();
        final AtomicInteger opens = new AtomicInteger();
        volatile boolean overlapped = false;
        volatile boolean failWrites = false;
        final List<byte[]> jobs = Collections.synchronizedList(new ArrayList<>());
        private final ThreadLocal<ByteArrayOutputStream> current = new ThreadLocal<>();

        FakePrinter(int busy) { refusals = new AtomicInteger(busy); }

        @Override public OutputStream open(String host, int port) throws IOException {
            opens.incrementAndGet();
            if (refusals.getAndDecrement() > 0) throw new IOException("connection refused");
            if (open.incrementAndGet() > 1) overlapped = true;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            current.set(buf);
            return new OutputStream() {
                @Override public void write(int b) throws IOException {
                    if (failWrites) throw new IOException("broken pipe");
                    buf.write(b);
                    if (buf.size() % 64 == 0) Thread.yield();   // give another sender every chance to cut in
                }
            };
        }

        @Override public void close() {
            ByteArrayOutputStream buf = current.get();
            current.remove();
            if (buf == null) return;
            jobs.add(buf.toByteArray());
            open.decrementAndGet();
        }
    }

    private static final List<Long> waits = Collections.synchronizedList(new ArrayList<>());
    private static RawPrinterSpool spoolFor(FakePrinter p) { waits.clear(); return new RawPrinterSpool(p, waits::add, new Random(7)); }
    private static byte[] ticket(char c, int n) { byte[] b = new byte[n]; java.util.Arrays.fill(b, (byte) c); return b; }

    @Test
    public void aTicketGoesOutWholeOnItsOwnConnection() throws Exception {
        FakePrinter p = new FakePrinter(0);
        byte[] t = "RECEIPT\n".getBytes(StandardCharsets.US_ASCII);
        spoolFor(p).send("192.168.1.50", 9100, t);
        assertEquals(1, p.jobs.size());
        assertArrayEquals(t, p.jobs.get(0));
    }

    @Test
    public void twoCashiersAtOnceOneConnectionAtATime() throws Exception {
        FakePrinter p = new FakePrinter(0);
        RawPrinterSpool spool = spoolFor(p);
        int senders = 8;
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < senders; i++) {
            final char c = (char) ('A' + i);
            Thread t = new Thread(() -> {
                try { go.await(); spool.send("192.168.1.50", 9100, ticket(c, 4096)); }
                catch (Throwable e) { errors.add(e); }
            });
            threads.add(t); t.start();
        }
        go.countDown();
        for (Thread t : threads) t.join(10_000);
        assertTrue(errors.toString(), errors.isEmpty());
        assertFalse("two connections to one printer were open at once", p.overlapped);
        assertEquals(senders, p.jobs.size());
        for (byte[] job : p.jobs) {   // each connection carried exactly one ticket, never a mix of two
            for (byte b : job) assertEquals(job[0], b);
            assertEquals(4096, job.length);
        }
    }

    @Test
    public void aPrinterBusyWithAnotherTabletStillPrints() throws Exception {
        FakePrinter p = new FakePrinter(3);   // another tablet holds it for three tries
        spoolFor(p).send("10.0.0.7", 9100, ticket('K', 100));
        assertEquals(1, p.jobs.size());
        assertEquals(4, p.opens.get());
        assertEquals(3, waits.size());
    }

    @Test
    public void theWaitIsBetween50And500MsNotAlwaysTheSame() throws Exception {
        FakePrinter p = new FakePrinter(RawPrinterSpool.ATTEMPTS - 1);
        spoolFor(p).send("10.0.0.7", 9100, ticket('K', 10));
        for (long w : waits) assertTrue("wait " + w, w >= 50 && w <= 500);
        assertTrue("the jitter should vary", waits.stream().distinct().count() > 1);
    }

    @Test
    public void aPrinterThatIsOffIsReportedInWords() {
        FakePrinter p = new FakePrinter(1000);
        try {
            spoolFor(p).send("10.0.0.9", 9100, ticket('R', 10));
            fail("expected PRINTER_UNREACHABLE");
        } catch (RawPrinterSpool.PrinterException e) {
            assertEquals("PRINTER_UNREACHABLE", e.code);
            assertTrue(e.getMessage(), e.getMessage().contains("10.0.0.9") && e.getMessage().contains("not answering"));
            assertEquals(RawPrinterSpool.ATTEMPTS, p.opens.get());
        }
    }

    @Test
    public void aTicketCutOffIsNeverSentTwice() {
        FakePrinter p = new FakePrinter(0);
        p.failWrites = true;
        try {
            spoolFor(p).send("10.0.0.9", 9100, ticket('R', 10));
            fail("expected PRINTER_FAILED");
        } catch (RawPrinterSpool.PrinterException e) {
            assertEquals("PRINTER_FAILED", e.code);
            assertEquals(1, p.opens.get());
        }
    }

    @Test
    public void onlyAnAddress() {
        assertTrue(RawPrinterSpool.isPrinterAddress("192.168.1.50"));
        assertTrue(RawPrinterSpool.isPrinterAddress("kitchen-printer"));
        assertFalse(RawPrinterSpool.isPrinterAddress("http://10.0.0.5"));
        assertFalse(RawPrinterSpool.isPrinterAddress("10.0.0.5/print"));
        assertFalse(RawPrinterSpool.isPrinterAddress(""));
        assertFalse(RawPrinterSpool.isPrinterAddress(null));
    }
}
