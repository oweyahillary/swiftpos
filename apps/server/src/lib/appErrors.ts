/**
 * appErrors.ts — crash and error reports from the ZapTill Android app, into the admin portal's alerts (A589's bell).
 * PURE but for the small in-memory gate below: no database, no network.
 *
 * The desktop keeps its errors in its own log (A299) and sends the log when support asks (A519/A533); the Android app
 * has no technician at its side, so it reports a crash on its own (routes/appErrors.ts). Each report is cleaned here:
 * trimmed to APP_ERROR_LIMITS and passed through the log redactor (no tokens, keys or phone numbers reach the cloud's
 * tables). The same crash from a hundred devices is ONE bell row per ERROR_NOTIFY_WINDOW_MS: the fingerprint is the
 * surface, the version and the first line of the message and of the stack — never the device.
 */
import crypto from 'node:crypto';
import { APP_ERROR_KINDS, APP_ERROR_LIMITS, ANDROID_SURFACE_LABELS, isAndroidSurface, isAppVersion, type AppErrorReport } from '@zaptill/core/androidApp';
import { redactLog } from '@zaptill/core/logRedact';
import type { NotificationRow } from './adminAlertPolicy';

const clip = (v: unknown, max: number): string => redactLog(String(v ?? '')).replace(/\r/g, '').slice(0, max).trim();

/** The body → a clean report, or null when it is not one (the route answers 400). */
export function cleanErrorReport(body: unknown): AppErrorReport | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isAndroidSurface(b.surface)) return null;
  if (!(APP_ERROR_KINDS as readonly unknown[]).includes(b.kind)) return null;
  if (!isAppVersion(b.appVersion)) return null;
  const message = clip(b.message, APP_ERROR_LIMITS.message);
  if (!message) return null;
  const stack = clip(b.stack, APP_ERROR_LIMITS.stack);
  const device = clip(b.device, APP_ERROR_LIMITS.device);
  return {
    surface: b.surface, kind: b.kind as AppErrorReport['kind'], appVersion: b.appVersion, message,
    ...(stack ? { stack } : {}), ...(device ? { device } : {}),
  };
}

/** Which reports are "the same problem": surface, version, kind, the message's and the stack's first lines. */
export function errorFingerprint(r: AppErrorReport): string {
  const first = (s: string | undefined) => String(s ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  const basis = [r.surface, r.appVersion, r.kind, first(r.message), first(r.stack)].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** The bell row for a report (category app_errors — the admin portal only, never an email per crash). */
export function errorNotification(r: AppErrorReport, businessId: string | null, fingerprint: string): NotificationRow {
  const what = r.kind === 'crash' ? 'crashed' : 'reported an error';
  const lines = [r.message, r.stack ? r.stack.split('\n').slice(0, 6).join('\n') : null, r.device ? `Device: ${r.device}` : null];
  return {
    category: 'app_errors',
    business_id: businessId,
    alert_key: `app_error:${fingerprint}`,
    title: `ZapTill for Android ${r.appVersion} (${ANDROID_SURFACE_LABELS[r.surface]}) ${what}`,
    detail: lines.filter(Boolean).join('\n'),
    data: { surface: r.surface, kind: r.kind, app_version: r.appVersion, fingerprint },
  };
}

/** One bell row per fingerprint per window, per cloud instance (a restart may ring once more — never a flood). */
export const ERROR_NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED = 500;

export class ErrorGate {
  private seen = new Map<string, number>();
  constructor(private windowMs = ERROR_NOTIFY_WINDOW_MS) {}

  /** True the first time a fingerprint is seen in the window (and remembers it). */
  shouldNotify(fingerprint: string, now = Date.now()): boolean {
    const at = this.seen.get(fingerprint);
    if (at !== undefined && now - at < this.windowMs) return false;
    this.seen.delete(fingerprint);
    this.seen.set(fingerprint, now);
    if (this.seen.size > MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}
