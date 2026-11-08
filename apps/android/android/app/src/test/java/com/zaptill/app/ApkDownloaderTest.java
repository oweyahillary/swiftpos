package com.zaptill.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/**
 * The updater's checks, on the build machine (./gradlew testDebugUnitTest; CI's Android job runs it).
 *
 * MUTATIONS TO CONFIRM BITE: saveVerified keeping a file whose hash differs → "a mismatch keeps nothing" fails;
 * sendsAuthorizationTo comparing the host only → "another port or scheme gets no session" fails; isApkFileName
 * accepting a path → "a path is not a file name" fails.
 */
public class ApkDownloaderTest {

    // Any 64 lowercase hex characters (the shape of a SHA-256).
    private static final String SOME_SHA256 = "ad9f84d0b1e4fe2ab14bf6a2a8bcb3b38c3cbf6bac2bb3a50a33b0ac4b6b30ab";

    private static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    @Test
    public void hashesWhatItCopies() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String hex = ApkDownloader.copyAndHash(new ByteArrayInputStream(bytes("")), out);
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", hex);
        out.reset();
        String hello = ApkDownloader.copyAndHash(new ByteArrayInputStream(bytes("hello")), out);
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", hello);
        assertEquals("hello", out.toString("UTF-8"));
    }

    @Test
    public void aMatchIsKeptUnderItsName() throws Exception {
        File dir = Files.createTempDirectory("zaptill-apk").toFile();
        String expected = ApkDownloader.copyAndHash(new ByteArrayInputStream(bytes("apk bytes")), new ByteArrayOutputStream());
        File f = ApkDownloader.saveVerified(new ByteArrayInputStream(bytes("apk bytes")), expected, dir, "ZapTill-0.1.0.apk");
        assertEquals("ZapTill-0.1.0.apk", f.getName());
        assertTrue(f.isFile());
        assertFalse(new File(dir, "ZapTill-0.1.0.apk.part").exists());
    }

    @Test
    public void aMismatchKeepsNothing() throws Exception {
        File dir = Files.createTempDirectory("zaptill-apk").toFile();
        String other = "0000000000000000000000000000000000000000000000000000000000000000";
        try {
            ApkDownloader.saveVerified(new ByteArrayInputStream(bytes("tampered")), other, dir, "ZapTill-0.1.0.apk");
            fail("a mismatch must throw");
        } catch (ApkDownloader.VerifyException expected) {
            // the reason is shown to the person
        }
        String[] left = dir.list();
        assertEquals(0, left == null ? 0 : left.length);
    }

    @Test
    public void onlyAZapTillApkNameIsAFileName() {
        assertTrue(ApkDownloader.isApkFileName("ZapTill-1.2.3.apk"));
        assertFalse(ApkDownloader.isApkFileName("../ZapTill-1.2.3.apk"));
        assertFalse(ApkDownloader.isApkFileName("ZapTill-1.2.apk"));
        assertFalse(ApkDownloader.isApkFileName("other.apk"));
        assertFalse(ApkDownloader.isApkFileName(null));
    }

    @Test
    public void aSha256Is64LowercaseHex() {
        assertTrue(ApkDownloader.isSha256(SOME_SHA256));
        assertFalse(ApkDownloader.isSha256(SOME_SHA256.toUpperCase()));
        assertFalse(ApkDownloader.isSha256("abc"));
    }

    @Test
    public void theSessionGoesOnlyToTheCloud() throws Exception {
        URL cloud = new URL("https://api.zaptill.co.ke/api/app-update/android/v/0.1.0/apk");
        assertTrue(ApkDownloader.sendsAuthorizationTo(cloud, new URL("https://API.zaptill.co.ke/api/other")));
        assertFalse(ApkDownloader.sendsAuthorizationTo(cloud, new URL("https://objects.githubusercontent.com/signed/1")));
        assertFalse(ApkDownloader.sendsAuthorizationTo(cloud, new URL("http://api.zaptill.co.ke/api/x")));
        assertFalse(ApkDownloader.sendsAuthorizationTo(cloud, new URL("https://api.zaptill.co.ke:8443/api/x")));
    }
}
