/**
 * billingClock.ts — A584 (2026-10-23): the ONE clock for a business's cloud access, in Nairobi days. Pure, no imports, so
 * the dashboard's sign-in ladder (lib/webAccess.ts), the till gate and the billing job (lib/cloudPlan.ts) and the tests all
 * read the same maths.
 *
 * Owner, 2026-10-23: "an invoice is sent to the client on the first day of their billing" · "after 7 days the access gets
 * revoked immediately, no warning for web".
 *
 *   paid-until   businesses.web_access_expires_at — the moment the paid period ends and the next one begins.
 *   due          that moment, or the day the business was put on the plan when that is later (a licence that had
 *                already run out when it was bridged — A584 — starts its clock on the bridge day: nobody is cut off by a
 *                deploy). The due day (Nairobi) is "day 0": the invoice goes out that day.
 *   unpaid       day 0 … day 7 after the due day: everything still works (no notice to the client, no reports-only
 *                stage, no grace beyond this).
 *   locked       from the END of day 7 (00:00 Nairobi on day 8): the web dashboard is paused, the cloud refuses the tills'
 *                sync and no till can be joined. The tills keep selling. Recording a payment opens it at once.
 *
 * A587 (owner, 2026-10-24): a cloud TRIAL ends like a paid period — its end day is its due day (an invoice), then the same
 * 7 days, then locked (A569's week of reports only is gone; trialState is kept for older callers). And a client unpaid for
 * NOT_INTERESTED_MONTHS months after its first unpaid due date is "Not interested": no more invoices, the open ones written
 * off, still locked; a payment then starts afresh from the day it is made.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Nairobi: UTC+3, no daylight saving. */
export const EAT_MS = 3 * 60 * 60 * 1000;
/** Unpaid days after the due day before the lock (the lock falls at the end of the last one). */
export const UNPAID_DAYS = 7;
/** ZapTill (the admin, never the client) hears on this unpaid day that the lock is near. */
export const ADMIN_WARN_DAY = 5;
/** A587 (owner: "if they fail to pay for 3 months we assume they are not interested"): months after the first unpaid due date. */
export const NOT_INTERESTED_MONTHS = 3;
/** A569's trial: reports only for this many days after it ended (A587: no longer used by the rules — kept for older callers). */
export const TRIAL_READ_DAYS = 7;

const parse = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** The Nairobi calendar day number of a moment (days since 1970-01-01, Nairobi time). */
export function nairobiDay(ms: number): number {
  return Math.floor((ms + EAT_MS) / DAY_MS);
}

/** 00:00 Nairobi of the day holding `ms`. */
export function nairobiDayStart(ms: number): number {
  return nairobiDay(ms) * DAY_MS - EAT_MS;
}

/** Calendar days (Nairobi) from `now` to `iso`: 0 = the same day, 1 = tomorrow, -3 = three days ago. */
export function daysUntil(iso: string, now: number): number {
  return nairobiDay(Date.parse(iso)) - nairobiDay(now);
}

/** The due moment: paid-until, or the day billing began for this business when that is later. */
export function effectiveDue(paidUntil: string, billingFrom?: string | null): string {
  const pu = parse(paidUntil), bf = parse(billingFrom);
  return Number.isFinite(bf) && bf > pu ? new Date(bf).toISOString() : new Date(pu).toISOString();
}

/** The lock: 00:00 Nairobi after the 7th unpaid day (due day 23 Nov → locked from 1 Dec 00:00). */
export function lockAtFor(dueIso: string): string {
  return new Date(nairobiDayStart(Date.parse(dueIso)) + (UNPAID_DAYS + 1) * DAY_MS).toISOString();
}

/** Unpaid days at `now` (0 on the due day itself), or null while still paid. */
export function unpaidDaysAt(dueIso: string, now: number): number | null {
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due) || now < due) return null;
  return nairobiDay(now) - nairobiDay(due);
}

export type PaidState = 'active' | 'unpaid' | 'locked';

/** Where a paid business stands: within the paid period, in its 7 unpaid days, or locked. */
export function paidState(dueIso: string, now: number): PaidState {
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due) || now < due) return 'active';
  return now < Date.parse(lockAtFor(dueIso)) ? 'unpaid' : 'locked';
}

export type TrialState = 'active' | 'reports_only' | 'locked';

/** A569's trial ladder (A587: superseded — a trial now ends like a paid period, cloudPlan.ts cloudStanding). Kept for older callers. */
export function trialState(endIso: string, now: number): TrialState {
  const end = Date.parse(endIso);
  if (now < end) return 'active';
  return now < end + TRIAL_READ_DAYS * DAY_MS ? 'reports_only' : 'locked';
}
