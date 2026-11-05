package com.zaptill.app;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Keeps a native crash on disk so the app can report it at its next start (src/errors/reporter.ts → POST
 * /api/app-errors → the admin portal's alerts). A crashing process cannot be trusted to reach the network, so it only
 * writes one small file (files/crash/pending.txt: the message on the first line, then the stack) and hands the crash on
 * to Android's own handler. A newer crash replaces an unreported one.
 */
final class CrashReporter {

    private static final int MAX_STACK_CHARS = 4000;

    private CrashReporter() {}

    private static File pendingFile(Context ctx) { return new File(new File(ctx.getFilesDir(), "crash"), "pending.txt"); }

    /** Called once, first thing in MainActivity.onCreate. */
    static void install(Context appContext) {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try { write(appContext, error); } catch (Throwable ignored) { /* never stand in the way of the crash */ }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    private static void write(Context ctx, Throwable error) throws IOException {
        File file = pendingFile(ctx);
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
        StringWriter stack = new StringWriter();
        error.printStackTrace(new PrintWriter(stack));
        String text = String.valueOf(error) + "\n" + stack.toString();
        if (text.length() > MAX_STACK_CHARS) text = text.substring(0, MAX_STACK_CHARS);
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** The kept crash as {message, stack}, removed once read; null when there is none. */
    static String[] takePending(Context ctx) {
        File file = pendingFile(ctx);
        if (!file.isFile()) return null;
        try {
            String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            int nl = text.indexOf('\n');
            return nl < 0 ? new String[] { text, "" } : new String[] { text.substring(0, nl), text.substring(nl + 1) };
        } catch (IOException e) {
            return null;
        } finally {
            file.delete();
        }
    }
}
