/**
 * plugins.ts — the app's own native plugins (android/app/src/main/java/com/zaptill/app/). Small on purpose: only what
 * a WebView cannot do.
 *
 *   ApkUpdater    download the approved APK, check its SHA-256 while it streams, hand it to Android's installer
 *   CrashReports  the last native crash (kept on disk by the crash handler until the app reports it) and the device's
 *                 Android version and model, for error reports
 *   RawPrinter    Till stage 1: a ticket's ESC/POS bytes to a network printer (TCP 9100), one connection per ticket and one
 *                 ticket at a time per printer (RawPrinterSpool.java)
 *   BranchServer  Till stage 1: the branch server on the shop network — its beacon (UDP 4199), its public certificate, and
 *                 requests over TLS trusting only that certificate (PinnedTls.java)
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

export interface RawPrinterPlugin {
  /** Rejects with code PRINTER_UNREACHABLE (off, or busy past the retries), PRINTER_FAILED (cut off while printing) or
   *  PRINTER_ADDRESS (not a network address), each with words for the screen. */
  send(options: { host: string; port: number; data: string }): Promise<{ bytes: number }>;
}

export interface BranchServerPlugin {
  /** Every UDP packet heard on the beacon port for ms milliseconds — the app keeps only real beacons (shop/branchServer.ts). */
  listen(options: { ms: number }): Promise<{ heard: Array<{ ip: string; text: string }> }>;
  /** The server's certificate (public) and its security code; old: a server too old to have one (not joined). */
  readCert(options: { url: string }): Promise<{ cert?: string; code?: string; old?: boolean }>;
  /** One request over TLS trusting only cert. Rejects with UNREACHABLE, or IDENTITY_CHANGED for any other certificate. */
  request(options: { url: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; cert: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
}

export const ApkUpdater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');
export const CrashReports = registerPlugin<CrashReportsPlugin>('CrashReports');
export const RawPrinter = registerPlugin<RawPrinterPlugin>('RawPrinter');
export const BranchServer = registerPlugin<BranchServerPlugin>('BranchServer');
