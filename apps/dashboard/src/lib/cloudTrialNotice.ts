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

// ── A581: the cloud plan (paid-until, per business) ─────────────────────────────────────────────────────────────────
/** The owner sees the plan's notice in the last this-many days before paid-until, and while it is lapsed. */
export const PLAN_NOTICE_DAYS = 14;
export const ZAPTILL_PHONE = '0717 675 635';

export interface PlanAnswer {
  paid_until: string; days_left: number | null; state: string; trial: boolean;
  sync_stops_at: string | null; sync_refused: boolean; amount: number; currency: string; period: string;
  /** "KES 3,000" — formatted by the cloud, which owns the price. */
  amount_label?: string;
}

const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The owner's notice for the plan, or null (not on the plan, a trial — trialNotice speaks for it — or more than 14 days left). */
export function planNotice(plan: PlanAnswer | null | undefined): string | null {
  if (!plan || !plan.paid_until || plan.trial || plan.days_left === null || plan.days_left === undefined) return null;
  const d = plan.days_left;
  if (d > PLAN_NOTICE_DAYS) return null;
  const pay = `${plan.amount_label || 'the plan amount'}${plan.period === 'monthly' ? ' a month' : ''} — WhatsApp or call ZapTill on ${ZAPTILL_PHONE}`;
  if (plan.sync_refused) {
    return `Your ZapTill cloud subscription ended on ${noticeDate(plan.paid_until)}. Your tills keep selling, but the cloud has stopped syncing them until it is paid (${pay}).`;
  }
  if (d > 0) return `Your ZapTill cloud subscription is paid until ${noticeDate(plan.paid_until)} (${dayWord(d)} left). To renew: ${pay}.`;
  if (d === 0) return `Your ZapTill cloud subscription is due today. To renew: ${pay}.`;
  const stops = plan.sync_stops_at ? ` — syncing stops on ${noticeDate(plan.sync_stops_at)}` : '';
  return `Your ZapTill cloud subscription ended on ${noticeDate(plan.paid_until)}${stops}. To renew: ${pay}.`;
}
