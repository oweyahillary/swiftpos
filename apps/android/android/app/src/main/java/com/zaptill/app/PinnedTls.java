package com.zaptill.app;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Base64;
import javax.net.ssl.X509TrustManager;

/**
 * PinnedTls — the branch server's certificate, trusted byte for byte (A489, the desktop's lanTls.ts rule, on Android).
 *
 * The branch server makes its own self-signed certificate; a POS trusts THAT certificate and nothing else — never a public
 * CA, never a host name. A server answering with any other certificate is refused. Both screens show the same SECURITY
 * CODE (the first 12 hex digits of the certificate's SHA-256, in threes) for the technician to compare.
 * Plain Java (no Android), so PinnedTlsTest runs it.
 */
public final class PinnedTls {
    private PinnedTls() {}

    /** The certificate's DER bytes from its PEM text, or null when it is not one certificate. */
    public static byte[] derOf(String pem) {
        if (pem == null) return null;
        try {
            CertificateFactory f = CertificateFactory.getInstance("X.509");
            X509Certificate c = (X509Certificate) f.generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
            return c.getEncoded();
        } catch (Exception e) {
            return null;
        }
    }

    /** "1A2B-3C4D-5E6F" — what the server's screens show (lanTls.securityCode). */
    public static String securityCode(byte[] der) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 6; i++) hex.append(String.format("%02X", h[i]));
            return hex.substring(0, 4) + "-" + hex.substring(4, 8) + "-" + hex.substring(8, 12);
        } catch (Exception e) {
            return null;
        }
    }

    /** Trusts exactly one certificate: the one pinned. */
    public static X509TrustManager trusting(final byte[] pinned) {
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("not a server");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
                if (!MessageDigest.isEqual(chain[0].getEncoded(), pinned)) {
                    throw new CertificateException("the branch server's identity changed — it is not the server this POS joined");
                }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }

    /** The PEM text of DER bytes (what the app keeps). */
    public static String pemOf(byte[] der) {
        String b64 = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(der);
        return "-----BEGIN CERTIFICATE-----\n" + b64 + "\n-----END CERTIFICATE-----\n";
    }
}
