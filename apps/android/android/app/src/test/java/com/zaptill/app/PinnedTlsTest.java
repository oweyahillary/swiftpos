package com.zaptill.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.X509TrustManager;
import org.junit.Test;

/**
 * The branch server's certificate, trusted byte for byte (PinnedTls; Till stage 1, docs/ANDROID-APP-DESIGN.md §11.3).
 * On the build machine: ./gradlew testDebugUnitTest (CI's Android job runs it).
 *
 * The two certificates below were made by the desktop's own lanTls.makeServerIdentity (as a branch server makes its own),
 * and SERVER_A_CODE is what the desktop's lanTls.securityCode shows for SERVER_A on the server's screen — the tablet must
 * show the same code for the technician to compare.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - checkServerTrusted comparing only the subject (both are "ZapTill branch server")  → "another server is refused" fails
 *   - securityCode taking the hash of the PEM text, not the DER bytes                   → "the server's own code" fails
 */
public class PinnedTlsTest {
    static final String SERVER_A =
        "-----BEGIN CERTIFICATE-----\n" +
        "MIIBUDCB96ADAgECAhBOOELbEcD3c4wiC2tskq1PMAoGCCqGSM49BAMCMCAxHjAc\n" +
        "BgNVBAMMFVphcFRpbGwgYnJhbmNoIHNlcnZlcjAeFw0yMDAxMDEwMDAwMDBaFw00\n" +
        "NjEwMzExMDQwMTJaMCAxHjAcBgNVBAMMFVphcFRpbGwgYnJhbmNoIHNlcnZlcjBZ\n" +
        "MBMGByqGSM49AgEGCCqGSM49AwEHA0IABCpDd2wHaszKYBlx7PEq9IvNEJGwA19i\n" +
        "m6rHmXyXv66sKqrTqTq5mchbn4591TxFcwZDN/BVD3SXHyHVg+rOKnWjEzARMA8G\n" +
        "A1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgIl5wX9swJ8h4D03iV3my\n" +
        "QOiiGo5qfr285ZOBD9BzHjACIQCA159cTiHV8kv60k0KJBnU8zSSnkYwjooKjLvF\n" +
        "jeEiGw==\n" +
        "-----END CERTIFICATE-----\n";
    static final String SERVER_B =
        "-----BEGIN CERTIFICATE-----\n" +
        "MIIBUDCB96ADAgECAhB1/t+Tdwj6PiN/UFxON8UeMAoGCCqGSM49BAMCMCAxHjAc\n" +
        "BgNVBAMMFVphcFRpbGwgYnJhbmNoIHNlcnZlcjAeFw0yMDAxMDEwMDAwMDBaFw00\n" +
        "NjEwMzExMDQwMTJaMCAxHjAcBgNVBAMMFVphcFRpbGwgYnJhbmNoIHNlcnZlcjBZ\n" +
        "MBMGByqGSM49AgEGCCqGSM49AwEHA0IABKQYYg1tuix8beQDSTHC4jZ/fIL0nRhO\n" +
        "zniXL8P+ejxHQ6E4uFNKMEgzOUxpmm4AiwXHdFvRvGIuaFO/fWdIgg+jEzARMA8G\n" +
        "A1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgNKMD73DeGpvpsMWaMEhA\n" +
        "+Xl26ty9dOJ1OOM0DKlnak0CIQCv2HAcQmy7h/Hlb1kC7tDgyRT6JR57LZ6u1Kly\n" +
        "ufYNUw==\n" +
        "-----END CERTIFICATE-----\n";
    static final String SERVER_A_CODE = "3A2B-AB25-A2DD";

    private static X509Certificate cert(String pem) throws Exception {
        return (X509Certificate) CertificateFactory.getInstance("X.509")
            .generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
    }

    @Test
    public void theServersOwnCode() {
        assertEquals(SERVER_A_CODE, PinnedTls.securityCode(PinnedTls.derOf(SERVER_A)));
    }

    @Test
    public void thePinnedServerIsTrusted() throws Exception {
        X509TrustManager tm = PinnedTls.trusting(PinnedTls.derOf(SERVER_A));
        tm.checkServerTrusted(new X509Certificate[] { cert(SERVER_A) }, "ECDHE_ECDSA");
    }

    @Test
    public void anotherServerIsRefused() throws Exception {
        X509TrustManager tm = PinnedTls.trusting(PinnedTls.derOf(SERVER_A));
        try {
            tm.checkServerTrusted(new X509Certificate[] { cert(SERVER_B) }, "ECDHE_ECDSA");
            fail("a server with another certificate must be refused");
        } catch (CertificateException expected) { /* refused */ }
        try {
            tm.checkServerTrusted(new X509Certificate[0], "ECDHE_ECDSA");
            fail("no certificate must be refused");
        } catch (CertificateException expected) { /* refused */ }
    }

    @Test
    public void notACertificate() {
        assertNull(PinnedTls.derOf("not a certificate"));
        assertNull(PinnedTls.derOf(null));
        assertEquals(SERVER_A_CODE, PinnedTls.securityCode(PinnedTls.derOf(PinnedTls.pemOf(PinnedTls.derOf(SERVER_A)))));
    }
}
