package com.zaptill.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ApkUpdater — the in-app updater's native half (src/native/plugins.ts, src/updates/updater.ts).
 *
 * download: the approved APK into the app's private cache (cache/updates/), its SHA-256 checked while it streams
 *           (ApkDownloader). install: Android's package installer, through this app's FileProvider, which shares only
 *           that folder (res/xml/file_paths.xml). Android shows its own prompt and refuses an APK signed by anyone but
 *           ZapTill. Installing needs "Install unknown apps" allowed for ZapTill (canInstall / openInstallSettings).
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private static final String APK_MIME = "application/vnd.android.package-archive";
    /** One download at a time, off the plugin thread (an APK takes a while on a slow line). */
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();

    private File updatesDir() { return new File(getContext().getCacheDir(), "updates"); }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String authorization = call.getString("authorization");
        String sha256 = call.getString("sha256");
        String fileName = call.getString("fileName");
        if (url == null || sha256 == null || fileName == null) { call.reject("url, sha256 and fileName are required", "BAD_REQUEST"); return; }
        downloads.execute(() -> {
            try {
                File file = ApkDownloader.download(url, authorization, sha256, updatesDir(), fileName);
                JSObject ret = new JSObject();
                ret.put("path", file.getAbsolutePath());
                ret.put("size", file.length());
                call.resolve(ret);
            } catch (ApkDownloader.VerifyException e) {
                call.reject(e.getMessage(), "VERIFY_FAILED");
            } catch (IOException e) {
                call.reject(e.getMessage() == null ? "The update could not be downloaded." : e.getMessage(), "DOWNLOAD_FAILED");
            }
        });
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file;
        try {
            file = path == null ? null : new File(path).getCanonicalFile();
            // Only a file this plugin downloaded: inside cache/updates, named ZapTill-x.y.z.apk.
            if (file == null || !file.isFile() || !file.getParentFile().equals(updatesDir().getCanonicalFile())
                || !ApkDownloader.isApkFileName(file.getName())) {
                call.reject("Not a downloaded update.", "BAD_REQUEST");
                return;
            }
        } catch (IOException e) {
            call.reject("Not a downloaded update.", "BAD_REQUEST");
            return;
        }
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, APK_MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void clearDownloads(PluginCall call) {
        File[] files = updatesDir().listFiles();
        if (files != null) for (File f : files) f.delete();
        call.resolve();
    }
}
