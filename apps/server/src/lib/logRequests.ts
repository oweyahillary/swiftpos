/**
 * logRequests.ts — A533: ZapTill support pulls a till's (or a branch server's) log from the admin portal.
 *
 * Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
 * investigating such issues" — and, looking at the admin portal's Desktop updates tab: "how do I pull logs".
 *
 * A request (public.log_requests, migration 152) is made in the admin portal (routes/logRequestsAdmin.ts) for one device
 * of the client. The till learns of it two ways, neither a new poll loop:
 *   - the doorbell: the business's push-channel sockets (A531, lib/liveHub.ts) hear { type: 'log_request', device_id };
 *     the till named asks GET /api/support/log-requests/mine (its own session) for the request itself;
 *   - the 90 s beat the till already runs for remote closes (A521) asks the same GET — a till behind a branch server
 *     (which holds no socket of its own) and a till whose socket is down learn within about 90 seconds.
 * The till answers with A519's upload (POST /api/support/logs + request_id): the same redaction, gzip and size cap; the
 * cloud links the stored log and marks the request delivered. A request still waiting 7 days after it was asked expires
 * (on any read of it — no job needed).
 *
 * Pure helpers plus the expiry write; the routes call them.
 */
import { supabase } from './supabase';

export const RANGE_HOURS = [24, 72, 168] as const;
export type RangeHours = typeof RANGE_HOURS[number];
export const EXPIRES_AFTER_MS = 7 * 86_400_000;
/** A533: 20 requests per admin per hour — a support case is a handful; a loop or a stolen admin session is stopped. */
export const REQUESTS_PER_ADMIN_HOUR = 20;
/** The till version that answers a pull (1.0.20). Older tills can only send from their Tech page (from 1.0.18). */
export const ANSWERS_FROM_VERSION = '1.0.20';
export const SENDS_FROM_VERSION = '1.0.18';
export const REASON_MAX = 300;

/** The reason as stored: control characters out, spaces collapsed, at most REASON_MAX; '' when nothing is left. */
export function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

/** 24 / 72 / 168, or null (anything else is refused, never rounded). Absent → 24. */
export function rangeOf(raw: unknown): RangeHours | null {
  if (raw === undefined || raw === null || raw === '') return 24;
  const n = Number(raw);
  return (RANGE_HOURS as readonly number[]).includes(n) ? n as RangeHours : null;
}

/** What else to send, as stored: { auth: true } for the sign-in history; nothing else is honoured. */
export function includeOf(raw: unknown): { auth: boolean } {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return { auth: o.auth === true };
}

function parts(v: string): number[] { return String(v).replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0); }
/** a < b as x.y.z (a missing version is older than everything). */
export function versionBelow(a: string | null | undefined, b: string): boolean {
  if (!a) return true;
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0); }
  return false;
}

/**
 * A554: what the cloud knows about a device beyond its version — it reports `log_pull: true` in its update state (a till
 * from A554 on: user_devices.update_state, A534), or it has answered a pull already. Either says it answers, whatever its
 * version reads (B Foods, 2026-10-21: a test build labelled 1.0.19 with the 1.0.20 code was warned about, then delivered).
 */
export interface PullAbility { reportsLogPull?: boolean; answeredBefore?: boolean }

/** Whether the device answers a pull: it says so, it did before, or its version is one that does. */
export function canAnswerPull(version: string | null | undefined, a: PullAbility = {}): boolean {
  return a.reportsLogPull === true || a.answeredBefore === true || !versionBelow(version, ANSWERS_FROM_VERSION);
}

/** What the admin portal says about a device's version: null when it can answer a pull. */
export function versionNote(version: string | null | undefined, a: PullAbility = {}): string | null {
  if (canAnswerPull(version, a)) return null;
  const v = version ? `runs ${version}` : 'has not reported its version';
  // A554: "may wait" — the version is all the cloud knows (an older till reports nothing more); a build that answers anyway is not held back.
  return `This POS ${v} — it can only send logs from its Tech page from ${SENDS_FROM_VERSION}, and answer a pull from ${ANSWERS_FROM_VERSION}. The request may wait until it updates (kept 7 days).`;
}

/** Waiting requests past their 7 days become expired (of a business; of one device when named). Never throws. */
export async function expireWaiting(businessId: string, deviceId?: string | null, nowMs = Date.now()): Promise<void> {
  try {
    let q = supabase.from('log_requests').update({ status: 'expired' })
      .eq('business_id', businessId).eq('status', 'waiting').lt('expires_at', new Date(nowMs).toISOString());
    if (deviceId) q = q.eq('device_id', deviceId);
    const { error } = await q;
    if (error) console.warn(`[log-requests] expiry not written: ${error.message}`);
  } catch (e) { console.warn(`[log-requests] expiry failed: ${(e as Error)?.message ?? e}`); }
}
