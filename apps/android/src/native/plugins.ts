/**
 * plugins.ts — the app's own native plugins (android/app/src/main/java/com/zaptill/app/). Small on purpose: only what
 * a WebView cannot do.
 *
 *   ApkUpdater    download the approved APK, check its SHA-256 while it streams, hand it to Android's installer
 *   CrashReports  the last native crash (kept on disk by the crash handler until the app reports it) and the device's
 *                 Android version and model, for error reports
 */
import { registerPlugin } from '@capacitor/core';

export interface ApkUpdaterPlugin {
  /**
   * Download `url` (the cloud's /apk route; `authorization` is sent to the cloud only — never to the host it redirects
   * to) into the app's private update folder, checking the bytes against `sha256`. Rejects with code VERIFY_FAILED, and
   * keeps nothing, when they differ.
   */
  download(options: { url: string; authorization?: string; sha256: string; fileName: string }): Promise<{ path: string; size: number }>;
  /** May this app ask Android to install packages ("Install unknown apps" allowed for ZapTill)? */
  canInstall(): Promise<{ allowed: boolean }>;
  /** Open Android's "Install unknown apps" page for ZapTill. */
  openInstallSettings(): Promise<void>;
  /** Hand a downloaded APK (from download()) to Android's installer; Android asks the person to confirm. */
  install(options: { path: string }): Promise<void>;
  /** Remove every downloaded APK (after an update, and on Reset app). */
  clearDownloads(): Promise<void>;
}

export interface CrashReportsPlugin {
  /** The native crash kept since the last run, if any — removed once read. */
  takePendingCrash(): Promise<{ crash: { message: string; stack: string } | null }>;
  /** "Android 14 (API 34), samsung SM-T220" — no serial numbers, no names. */
  deviceSummary(): Promise<{ summary: string }>;
}

export const ApkUpdater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');
export const CrashReports = registerPlugin<CrashReportsPlugin>('CrashReports');
