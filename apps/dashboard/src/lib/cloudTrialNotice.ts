/**
 * cloudTrialNotice.ts — A569 (2026-10-22): the owner's quiet notice in the last 7 days of the cloud trial.
 *
 * Owner: "they should get a 1 month trial plan for cloud if they have subscribed on the desktop platform". The trial
 * (30 days from the first desktop licence; apps/server/src/lib/cloudTrial.ts) ends on its own; the owner hears of it in
 * its last week — "Your cloud trial ends on {date} — contact ZapTill to keep the dashboard" — and, in the week of reports
 * only after it, that it has ended. The owner only (GET /api/business/cloud-trial answers { trial: null } to anyone
 * else); never a cashier, never a till.
 *
 * Pure, so the test runs it.
 */
export const NOTICE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialAnswer { ends_at: string; phase: 'active' | 'reports_only' | 'ended' | 'converted' }

/** "22 Nov 2026", in Nairobi time. */
export function noticeDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' });
}

/** The notice's words, or null when there is none to show (no trial, paid, more than 7 days left). */
export function trialNotice(trial: TrialAnswer | null | undefined, now: number = Date.now()): string | null {
  if (!trial || !trial.ends_at) return null;
  const end = Date.parse(trial.ends_at);
  if (Number.isNaN(end)) return null;
  if (trial.phase === 'active') {
    if (end - now > NOTICE_DAYS * DAY_MS || end <= now) return null;
    return `Your cloud trial ends on ${noticeDate(trial.ends_at)} — contact ZapTill to keep the dashboard.`;
  }
  if (trial.phase === 'reports_only') {
    return `Your cloud trial ended on ${noticeDate(trial.ends_at)}. Reports stay open for a few more days — contact ZapTill to keep the dashboard.`;
  }
  return null;
}
