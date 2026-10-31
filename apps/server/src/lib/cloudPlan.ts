/**
 * cloudPlan.ts — A581 (2026-10-23): the cloud's payment plan, per business — period, amount, paid-until, payments.
 * A584 (2026-10-23): ONE set of rules for EVERY business with a date, an invoice on the first day of each period, and the
 * lock 7 days after the due date with no warning to the client.
 *
 * Owner, 2026-10-23 (A581): "if a client stops paying for the cloud … yes till continues to work, but the cloud stops syncing
 * and the till cannot be re-registered until the client pays again. add payment plan option such that i can select month on
 * month". Pricing: the CLOUD (web dashboard, online features, sync) is month to month, charged PER BUSINESS, KES 3,000 a
 * month by default; 3 / 6 / 12 months ahead recommended, no discount for paying ahead (for now).
 * Owner, 2026-10-23 (A584): "build a robust structure — some clients I had already set the licence, but build it: if it
 * expires they will call" · "an invoice is sent to the client on the first day of their billing" · "without informing them
 * when the access will be revoked" · "after 7 days the access gets revoked immediately, no warning for web".
 *
 * ONE CLOCK. Paid-until IS businesses.web_access_expires_at; the maths is lib/billingClock.ts (Nairobi days).
 *
 * WHO IS GOVERNED (A584). Every business with a paid-until date — on a plan row or not — and every business on a plan or a
 * cloud trial. A dated business with no plan row (a licence set before A581) is BRIDGED by the billing job
 * (jobs/cloudPlanReminders.ts): a plan row is made for it (the period inferred from its last invoice, else 12 months — the
 * old web-access licence was yearly; KES 3,000 a month; editable) and audited. Until then it is never locked. A
 * plan row's created_at is the day billing began, so a licence that had already run out when it was bridged is due on the
 * bridge day — an invoice, then the 7 days — never cut off by the deploy.
 *   Not governed: web access ON with NO date ("No expiry set" — unchanged, listed for the owner to put on a plan); web
 *   access switched OFF with a date and no plan ("off" — the admin turned it off; not invoiced); no web access at all.
 *
 * THE LADDER (paid): paid until → due day (the invoice, to the client, no word of any lock) → 7 unpaid days (everything
 * works; ZapTill hears on day 5) → locked at the end of day 7, Nairobi: the web dashboard paused ("Your ZapTill cloud access
 * is paused. Call 0717 675 635 to renew."), the tills' sync refused (503 CLOUD_SUBSCRIPTION_ENDED, queued on every till
 * version), no till joins. Tills keep selling. No grace beyond the 7 days, no reports-only stage, no countdown.
 * A cloud TRIAL (A569) keeps its ladder: full until its end; reports only for 7 days (sync refused); then locked.
 *
 * Record payment continues the period the invoice was for when the client is still within the 7 days (paid 28 Nov on a
 * 23 Nov due date → paid until 23 Dec); early adds on (no lost days).
 *
 * A587 (owner, 2026-10-24):
 *   - "we offset it" … then, correcting it the same day: "it's pay as you go, not pay for missed months, since they won't be
 *     using the system at that time". A LOCKED client who pays starts a fresh period from the payment day; the unpaid
 *     cloud invoice(s) of the locked time are closed — written off, "not charged: access was paused" (audited), never
 *     collected (paymentCovers). A client who pays WITHIN its 7 unpaid days (it still had access) continues from the due
 *     date, as A584. A locked client gets no further invoices.
 *   - "if they fail to pay for 3 months we assume they are not interested" — NOT_INTERESTED_MONTHS after the first unpaid
 *     due date (or the day billing began, when later): state 'not_interested' — no more invoices, the open cloud invoices
 *     written off by the job (audited), still locked; ZapTill hears once. A payment then starts afresh from the day it is
 *     made (no arrears).
 *   - a cloud TRIAL ends like a paid period: its end is its due day (an invoice), then the 7 days, then locked.
 *   - the A584 bridge keeps a licence that was already locked under the old ladder (28+ days past) locked at once, due
 *     from its own date (cloud_plans.billing_from, migration 173) — no fresh 7 days and no arrears invoice; when it pays, a
 *     fresh period starts from the payment day.
 *   - "Disable web access" is a hard off at once (state 'off'): web paused, sync refused, no POS joins — whatever the date.
 *
 * Pure rules first (the tests run them), storage after.
 */
import { supabase } from './supabase';
import { memoEnabled, writeGen } from './writeActivity';   // A593
import { CLOUD_TRIAL_KEY, TRIAL_REPORTS_ONLY_DAYS, cleanTrial, type CloudTrial } from './cloudTrial';
import {
  DAY_MS, EAT_MS, UNPAID_DAYS, ADMIN_WARN_DAY, NOT_INTERESTED_MONTHS, nairobiDay, daysUntil, effectiveDue, lockAtFor, unpaidDaysAt, paidState,
} from './billingClock';

export { daysUntil, UNPAID_DAYS, ADMIN_WARN_DAY, NOT_INTERESTED_MONTHS };
/** A587: the old A147 ladder locked the web 28 days after the date (21 days' grace + 7 of reports only). */
export const OLD_LADDER_LOCK_DAYS = 28;

/** The cloud's price per business per month (owner, 2026-10-23: KES 36,000 a year = 3,000 a month). A default only —
 *  each plan carries its own amount, which the admin may change. */
export const CLOUD_MONTHLY_KES = 3000;
/** ZapTill's number for paying and for help (no company email yet). */
export const ZAPTILL_PHONE = '0717 675 635';

export const PLAN_PERIODS = ['monthly', '3_months', '6_months', '12_months', 'custom'] as const;
export type PlanPeriod = typeof PLAN_PERIODS[number];
export const PERIOD_MONTHS: Record<Exclude<PlanPeriod, 'custom'>, number> = { monthly: 1, '3_months': 3, '6_months': 6, '12_months': 12 };
export const PERIOD_LABEL: Record<PlanPeriod, string> = {
  monthly: 'Monthly (month on month)', '3_months': '3 months', '6_months': '6 months', '12_months': '12 months', custom: 'Custom end date',
};
export const PAYMENT_METHODS = ['mpesa', 'bank', 'cash', 'other'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export const isPeriod = (v: unknown): v is PlanPeriod => typeof v === 'string' && (PLAN_PERIODS as readonly string[]).includes(v);

/** The default amount for one period at a monthly price (no discount for paying ahead); null for a custom end date. */
export function defaultAmount(period: PlanPeriod, monthly: number = CLOUD_MONTHLY_KES): number | null {
  return period === 'custom' ? null : Math.round(monthly * PERIOD_MONTHS[period]);
}

/**
 * `months` calendar months after `iso`, in Nairobi's calendar, the day held to the month's end: 31 Jan → 28 Feb
 * (29 in a leap year), 31 Mar → 30 Apr, 30 Nov + 3 → 28 Feb. The time of day is kept.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const d = new Date(Date.parse(iso) + EAT_MS);
  const target = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(target / 12);
  const m = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const t = Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return new Date(t - EAT_MS).toISOString();
}

export type ExtendResult = { ok: true; from: string; until: string } | { ok: false; code: string; error: string };

/**
 * The new paid-until for one payment. The period starts at:
 *   - the current paid-until when that is still ahead (paying early adds on — no lost days);
 *   - else `continueFrom` (A584: the due date of the period still open — a client within its 7 unpaid days pays for
 *     the period its invoice was for);
 *   - else now (a locked client, a first payment, a trial converted).
 * A custom period runs to the date given, which must be after that start.
 */
export function nextPaidUntil(p: { period: PlanPeriod; now: number; paidUntil: string | null; customUntil?: string | null; continueFrom?: string | null }): ExtendResult {
  const current = p.paidUntil ? Date.parse(p.paidUntil) : NaN;
  const cont = p.continueFrom ? Date.parse(p.continueFrom) : NaN;
  const base = Number.isFinite(current) && current > p.now ? current : Number.isFinite(cont) ? cont : p.now;
  const from = new Date(base).toISOString();
  if (p.period === 'custom') {
    const end = p.customUntil ? Date.parse(p.customUntil) : NaN;
    if (!Number.isFinite(end)) return { ok: false, code: 'CUSTOM_END_REQUIRED', error: 'A custom period needs the date it is paid until.' };
    if (end <= Math.max(base, p.now)) return { ok: false, code: 'CUSTOM_END_TOO_EARLY', error: `The date must be after ${new Date(Math.max(base, p.now)).toISOString().slice(0, 10)} (what is already paid, or today).` };
    return { ok: true, from, until: new Date(end).toISOString() };
  }
  return { ok: true, from, until: addMonthsClamped(from, PERIOD_MONTHS[p.period]) };
}

/**
 * A584 bridge: the period of a licence set before the plan existed — from its last invoice's length (1 / 3 / 6 / 12
 * months, the nearest), else 12 months (the web-access licence was a yearly one).
 */
export function inferBridgePeriod(lastInvoice: { period_start?: string | null; period_end?: string | null } | null | undefined): Exclude<PlanPeriod, 'custom'> {
  const s = Date.parse(String(lastInvoice?.period_start ?? '')), e = Date.parse(String(lastInvoice?.period_end ?? ''));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return '12_months';
  const months = (e - s) / (30.44 * DAY_MS);
  const opts: Array<[Exclude<PlanPeriod, 'custom'>, number]> = [['monthly', 1], ['3_months', 3], ['6_months', 6], ['12_months', 12]];
  return opts.reduce((best, o) => (Math.abs(o[1] - months) < Math.abs(best[1] - months) ? o : best))[0];
}

// ── Standing: where a business is ─────────────────────────────────────────────────────────────────────────────────────

export interface CloudFacts {
  /** A cloud_plans row exists. */
  onPlan: boolean;
  /** When that row was made — the day billing began (A584). */
  planCreatedAt?: string | null;
  /** A587: cloud_plans.billing_from — the bridge's kept due date for a licence already locked under the old ladder. */
  billingFrom?: string | null;
  /** The A569 trial record, if any. */
  trial: CloudTrial | null;
  /** businesses.web_access_expires_at — the paid-until. */
  expiresAt: string | null;
  /** feature_flags.web_hosting (null: no row). */
  webHosting: boolean | null;
  /** businesses.status === 'suspended' (a hard off-switch of its own — not this rule's). */
  suspended?: boolean;
  /** A601: feature_flags.cloud_backup — ZapTill keeps a desktop-only business's cloud backup (goodwill). null: no row. */
  cloudBackup?: boolean | null;
  /** A601: feature_flags.desktop_updates — ZapTill releases desktop updates to a desktop-only business. null: no row. */
  desktopUpdates?: boolean | null;
}

// ── A601: desktop-only clients cut off from the cloud backup ──────────────────────────────────────────────────────────
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md): a business the cloud calls not_on_plan (no plan, no paid-until,
// no web_hosting) keeps setup, sign-in, catalogue and staff changes and support logs, but from the date ZapTill sets its
// POS no longer backs up sales, orders, shifts, drawers, reversals and day closes to the cloud, and gets no desktop update
// unless ZapTill releases one. Until the date, the POS and the admin portal show the notice.
//   DESKTOP_ONLY_CUTOFF_AT  unset or not a date: nothing changes (phase 'none'); before it: 'notice'; from it: 'cut'.
//                           A bare date (2026-12-01) is that day's start in Nairobi.
//   cloud_backup flag       admin-only (PUT /api/flags refuses every key not in CLIENT_SETTABLE_FLAGS; the admin portal's
//                           switch is a super admin's): on, the business keeps the backup with no plan.
//   desktop_updates flag    admin-only: on, the business's approved version (Desktop updates) is offered at the cut.
// No migration: both are feature_flags rows; read in the same query as web_hosting (no extra read).
export const CLOUD_BACKUP_FLAG = 'cloud_backup';
export const DESKTOP_UPDATES_FLAG = 'desktop_updates';
export const DESKTOP_ONLY_CUTOFF_ENV = 'DESKTOP_ONLY_CUTOFF_AT';
export type DesktopOnlyPhase = 'none' | 'notice' | 'cut';

/** The cut-off as an ISO instant, or null (unset, or not a date). A bare YYYY-MM-DD is 00:00 Nairobi that day. Pure. */
export function parseCutoff(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00+03:00`) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/** DESKTOP_ONLY_CUTOFF_AT as set on this server now (read each time: cheap, and a test can set it). */
export function desktopOnlyCutoffAt(): string | null { return parseCutoff(process.env[DESKTOP_ONLY_CUTOFF_ENV]); }
/** Where the switch stands at `now`. Pure. */
export function cutoffPhase(cutoffAt: string | null, now: number): DesktopOnlyPhase {
  if (!cutoffAt) return 'none';
  return now >= Date.parse(cutoffAt) ? 'cut' : 'notice';
}

export interface DesktopOnly {
  /** The business is desktop-only (the cloud calls it not_on_plan) — whatever the date. */
  is: boolean;
  /** The cloud_backup flag is on: the backup is kept. */
  exempt: boolean;
  /** The desktop_updates flag is on: the approved version is offered. */
  updatesReleased: boolean;
  /** The switch for this business: 'none' unless desktop-only and the date is set. */
  phase: DesktopOnlyPhase;
  cutoffAt: string | null;
  /** Its POS's backup writes are refused now (503 CLOUD_BACKUP_OFF). */
  backupOff: boolean;
  /** No update is offered now. */
  updatesHeld: boolean;
  /** The POS and the admin portal show the notice (before and after the date; not when exempt). */
  notice: boolean;
}
const NOT_DESKTOP_ONLY: DesktopOnly = { is: false, exempt: false, updatesReleased: false, phase: 'none', cutoffAt: null, backupOff: false, updatesHeld: false, notice: false };

/** A601: the desktop-only rule for a not_on_plan business. Pure. */
export function desktopOnlyFor(f: Pick<CloudFacts, 'cloudBackup' | 'desktopUpdates'>, now: number, cutoffAt: string | null): DesktopOnly {
  const phase = cutoffPhase(cutoffAt, now);
  const exempt = f.cloudBackup === true;
  const updatesReleased = f.desktopUpdates === true;
  return {
    is: true, exempt, updatesReleased, phase, cutoffAt: phase === 'none' ? null : cutoffAt,
    backupOff: phase === 'cut' && !exempt,
    updatesHeld: phase === 'cut' && !updatesReleased,
    notice: phase !== 'none' && !exempt,
  };
}

/**
 *   not_on_plan    no web access, no date, no plan — nothing to bill
 *   off            A587: "Disable web access" on a business with a date, a plan or a trial — a HARD off at once: web
 *                  paused, sync refused, no POS joins, not invoiced (A584: it was only "not invoiced"); "Enable" restores
 *                  it while paid-until is ahead
 *   no_expiry      web access on, no date, no plan — unchanged; listed "No expiry set"
 *   no_date        on a plan, no payment yet
 *   active         paid (or a trial within its 30 days)
 *   unpaid         due (a trial: ended), within the 7 unpaid days — everything works
 *   reports_only   A569's trial week after its end — A587: no longer given (kept in the type for older readers)
 *   locked         paused: web, sync and enrolment refused
 *   not_interested A587: unpaid 3 months after the first unpaid due date — still locked, no more invoices, the open ones
 *                  written off; a payment starts afresh
 *   ended          a trial ended early ("End trial")
 */
export type CloudState = 'not_on_plan' | 'off' | 'no_expiry' | 'no_date' | 'active' | 'unpaid' | 'reports_only' | 'locked' | 'not_interested' | 'ended';

export interface CloudStanding {
  /** Under the billing rules (A584: any business with a date, a plan or a trial). */
  gated: boolean;
  state: CloudState;
  /** An unconverted cloud trial. */
  trial: boolean;
  /** businesses.web_access_expires_at as stored. */
  paidUntil: string | null;
  /** The due moment (paid-until, or the day billing began when later); a trial: its end. */
  dueAt: string | null;
  /** When the lock falls (end of the 7th unpaid day); a trial: its end (sync), the web a week later. */
  lockAt: string | null;
  /** A581's name for when sync stops — the same as lockAt. */
  syncStopsAt: string | null;
  /** Calendar days to the due day (negative: past it); null without a date. */
  daysLeft: number | null;
  /** Unpaid days (0 on the due day); null while paid or without a date. */
  unpaidDays: number | null;
  /** Unpaid days left before the lock (2 on day 5); null unless unpaid. */
  lockInDays: number | null;
  /** Days since the lock fell (0 on its first day); null unless locked. */
  lockedDays: number | null;
  /** A dated business not yet given its plan row by the bridge (never locked meanwhile). */
  bridgePending: boolean;
  /** The tills' pushes and a new till are refused now. */
  syncRefused: boolean;
  /** The web dashboard is paused now (every web request answered 403). */
  webLocked: boolean;
  /** A587: the day billing began (the plan row's created_at; a trial: its end) — later periods are invoiced from it. */
  billingStart: string | null;
  /** A587: when an unpaid client is (or would be) taken as "Not interested" — 3 months after max(due, billingStart). */
  notInterestedAt: string | null;
  /** A601: the desktop-only cut-off (is: false for every business with a plan, a date, a trial or web access). */
  desktopOnly: DesktopOnly;
}

const validIso = (s: string | null | undefined): s is string => !!s && Number.isFinite(Date.parse(s));

/** A587: 3 months (Nairobi calendar, month ends held) after the later of the due moment and the day billing began. */
export function notInterestedAtFor(dueIso: string, billingStart?: string | null): string {
  const d = Date.parse(dueIso), b = billingStart ? Date.parse(billingStart) : NaN;
  const from = Number.isFinite(b) && b > d ? new Date(b).toISOString() : new Date(d).toISOString();
  return addMonthsClamped(from, NOT_INTERESTED_MONTHS);
}

/**
 * A587 (decision 4): was this licence already locked under the OLD ladder (A147: 21 days' grace + 7 of reports only →
 * locked from 28 days after its date) when the bridge reached it? Then it stays locked, due from its own date.
 */
export function lockedUnderOldLadder(paidUntil: string | null | undefined, now: number): boolean {
  const t = paidUntil ? Date.parse(paidUntil) : NaN;
  return Number.isFinite(t) && now >= t + OLD_LADDER_LOCK_DAYS * DAY_MS;
}

/** Where a business stands at `now`. Pure (A601: the cut-off date from the server's env unless given). */
export function cloudStanding(f: CloudFacts, now: number = Date.now(), cutoffAt: string | null = desktopOnlyCutoffAt()): CloudStanding {
  const onTrial = !!f.trial && !f.trial.converted_at;
  const dated = validIso(f.expiresAt);
  const blank: CloudStanding = {
    gated: false, state: 'not_on_plan', trial: onTrial, paidUntil: dated ? f.expiresAt : null, dueAt: null, lockAt: null, syncStopsAt: null,
    daysLeft: null, unpaidDays: null, lockInDays: null, lockedDays: null, bridgePending: false, syncRefused: false, webLocked: false,
    billingStart: null, notInterestedAt: null, desktopOnly: NOT_DESKTOP_ONLY,
  };
  // A587 (decision 5): "Disable web access" switches a client off AT ONCE — a business the rules govern (a date, a plan or a
  // trial): web paused, sync refused, no POS joins, nothing invoiced. ("End trial" is the same switch on a trial.) A
  // business with no date, no plan and no trial (desktop only) is untouched, as before.
  if (f.webHosting === false && (dated || f.onPlan || onTrial)) {
    const at = dated ? f.expiresAt as string : null;
    return {
      ...blank, gated: onTrial, state: onTrial ? 'ended' : 'off', dueAt: at, lockAt: at, syncStopsAt: at,
      daysLeft: at ? daysUntil(at, now) : null, syncRefused: true, webLocked: true,
    };
  }
  if (!dated) {
    if (onTrial || f.onPlan) return { ...blank, gated: true, state: 'no_date' };
    if (f.webHosting === true) return { ...blank, state: 'no_expiry' };
    // A601: desktop only — the one state the cut-off concerns.
    return { ...blank, state: 'not_on_plan', desktopOnly: desktopOnlyFor(f, now, cutoffAt) };
  }
  const paidUntil = f.expiresAt as string;
  let due: string; let billingStart: string | null; let bridgePending = false;
  if (onTrial) {
    // A587 (decision 2): a trial ends like a paid period — its end is the due day (the invoice), then the 7 days, then locked.
    due = paidUntil; billingStart = paidUntil;
  } else {
    bridgePending = !f.onPlan;
    // Before the bridge has made the plan row, the due moment is never in the past (nobody locked by a deploy). A587: a
    // bridged licence that was already locked keeps its own date (billing_from), so it stays locked.
    const billingFrom = f.onPlan ? (f.billingFrom ?? f.planCreatedAt ?? null) : new Date(now).toISOString();
    due = effectiveDue(paidUntil, billingFrom);
    billingStart = f.onPlan ? (f.planCreatedAt ?? null) : null;
  }
  const lockAt = lockAtFor(due);
  const ps = paidState(due, now);
  const unpaid = unpaidDaysAt(due, now);
  const niAt = bridgePending ? null : notInterestedAtFor(due, billingStart);
  const notInterested = ps === 'locked' && !!niAt && now >= Date.parse(niAt);
  const state: CloudState = notInterested ? 'not_interested' : ps;
  const locked = ps === 'locked';
  return {
    ...blank, gated: true, paidUntil, dueAt: due, lockAt, syncStopsAt: lockAt, daysLeft: daysUntil(due, now), bridgePending,
    state, unpaidDays: ps === 'active' ? null : unpaid,
    lockInDays: ps === 'unpaid' && unpaid !== null ? Math.max(0, UNPAID_DAYS - unpaid) : null,
    lockedDays: locked ? nairobiDay(now) - nairobiDay(Date.parse(lockAt)) : null,
    syncRefused: locked, webLocked: locked, billingStart, notInterestedAt: niAt,
  };
}

// ── A612: the cloud billed per branch ─────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-30 (docs/A612-per-branch-cloud.md): "monthly subscription should be per branch … if a branch does not pay
// it should not view its data and the owner should not see it too, it cuts across all users" · "if a branch has not paid
// it's cut off completely, nothing syncs" · "even price change online should not sync".
// A branch with its own plan row (branch_cloud_plans, migration 182) stands on its own paid-until — the SAME rules as a
// business (cloudStanding: due day, 7 unpaid days, locked; web_off is its "Disable"); a branch with no row follows its
// business. A locked branch is PAUSED: its POS refused everything but sign-in, the technician, support logs and the update
// state (accessRefusal — reads too: no price or menu reaches it), and nobody sees its data (middleware/auth.ts narrows every
// user to the open branches). Every branch paused: the whole web dashboard paused, as a locked business is.
export interface BranchPause {
  /** Each branch's standing — its own row's, else its business's. */
  standings: Map<string, CloudStanding>;
  /** The paused branches. */
  paused: Set<string>;
  /** The branches still open, in the business's order. */
  open: string[];
  /** Every branch paused: the web dashboard paused too. */
  allPaused: boolean;
}

/** A branch's facts: its business's (trial, web access, the flags) with the branch's own plan and paid-until. Pure. */
export function branchFactsFor(f: CloudFacts, row: Pick<BranchPlanRow, 'paid_until' | 'billing_from' | 'created_at' | 'web_off'>): CloudFacts {
  return {
    ...f, onPlan: true, planCreatedAt: row.created_at ?? null, billingFrom: row.billing_from ?? null, expiresAt: row.paid_until ?? null,
    webHosting: row.web_off ? false : f.webHosting,
  };
}

/** Where each branch stands at `now`; null when no branch has its own plan (the business is billed as one). Pure. */
export function branchPause(f: CloudFacts & { branchIds?: string[]; branchPlans?: BranchPlanRow[] }, now: number = Date.now(),
  cutoffAt: string | null = desktopOnlyCutoffAt()): BranchPause | null {
  const ids = f.branchIds ?? [], rows = f.branchPlans ?? [];
  if (!ids.length || !rows.length) return null;
  const rowBy = new Map(rows.map((r) => [String(r.branch_id), r]));
  const business = cloudStanding(f, now, cutoffAt);
  const standings = new Map<string, CloudStanding>();
  const paused = new Set<string>();
  for (const id of ids) {
    const row = rowBy.get(id);
    const st = row ? cloudStanding(branchFactsFor(f, row), now, cutoffAt) : business;
    standings.set(id, st);
    if (st.webLocked || st.syncRefused) paused.add(id);
  }
  const open = ids.filter((id) => !paused.has(id));
  return { standings, paused, open, allPaused: open.length === 0 };
}

/** The standing as the portal reads it (snake_case). */
export function standingView(s: CloudStanding) {
  return {
    gated: s.gated, state: s.state, trial: s.trial, paid_until: s.paidUntil, due_at: s.dueAt, lock_at: s.lockAt, sync_stops_at: s.syncStopsAt,
    days_left: s.daysLeft, unpaid_days: s.unpaidDays, lock_in_days: s.lockInDays, locked_days: s.lockedDays,
    bridge_pending: s.bridgePending, sync_refused: s.syncRefused, web_locked: s.webLocked,
    not_interested_at: s.notInterestedAt,   // A587: "Not interested (since …)" — and, while unpaid, when it would be
    desktop_only: desktopOnlyView(s.desktopOnly),   // A601
  };
}

/** A601: the desktop-only cut-off as the admin portal reads it (snake_case); null when the business is not desktop-only. */
export function desktopOnlyView(d: DesktopOnly) {
  return d.is ? {
    phase: d.phase, cutoff_at: d.cutoffAt, exempt: d.exempt, updates_released: d.updatesReleased,
    backup_off: d.backupOff, updates_held: d.updatesHeld, notice: d.notice,
  } : null;
}

/**
 * A601: what /api/pos/init tells a POS (`cloudBackup`) — on: the cloud takes its backup; phase: 'notice' / 'cut' for the
 * manager's notice ('none' when there is nothing to say: not desktop-only, exempt, or no date set); cutoffAt: the date.
 */
export function cloudBackupWire(s: Pick<CloudStanding, 'desktopOnly'>): { on: boolean; phase: DesktopOnlyPhase; cutoffAt: string | null } {
  const d = s.desktopOnly;
  return d.notice ? { on: !d.backupOff, phase: d.phase, cutoffAt: d.cutoffAt } : { on: true, phase: 'none', cutoffAt: null };
}

/**
 * A587: the period start invoiced now — the due date's, from its first day (Nairobi) until the lock. Pay as you go (owner,
 * 2026-10-24): a locked client is not invoiced for the time it cannot use (a licence bridged when already locked gets no
 * arrears invoice either); a payment starts it afresh.
 */
export function invoiceStarts(s: CloudStanding, _plan: unknown, now: number): string[] {
  if (!s.dueAt || (s.state !== 'active' && s.state !== 'unpaid')) return [];
  return nairobiDay(now) >= nairobiDay(Date.parse(s.dueAt)) ? [s.dueAt] : [];
}

/** An open (pending) cloud invoice, as Record payment reads it. */
export interface OpenInvoice { id: string; invoice_number: string; period_start: string | null; period_end: string | null; amount: number | string; status?: string }

type CoverInvoice = { id: string; invoice_number: string; period_start: string | null; period_end: string | null; amount: number };
export interface PaymentCover {
  /** Where the paid time starts and ends (paid-until after the payment). */
  from: string; until: string;
  /** The open invoice(s) this payment pays — within the 7 unpaid days (or early), the invoiced period's. */
  settles: CoverInvoice[];
  /** A587: the open invoices of the locked time, closed — written off, not charged ("access was paused"). */
  closes: CoverInvoice[];
  /** A587: a fresh start from the payment day (the client was locked, or "Not interested") — no arrears. */
  fresh: boolean;
}

/**
 * A587 (owner, 2026-10-24: "it's pay as you go, not pay for missed months, since they won't be using the system at that
 * time"): what one payment covers. Within the 7 unpaid days (or early): the open invoice whose period starts in the paid
 * time is paid. A fresh start (locked, or "Not interested"): nothing is collected for the locked time — every open cloud
 * invoice is closed (written off, not charged) and the payment buys a new period from today. Pure.
 */
export function paymentCovers(p: { from: string; until: string; outstanding: readonly OpenInvoice[]; fresh: boolean }): PaymentCover {
  const f = Date.parse(p.from), u = Date.parse(p.until);
  const open = p.outstanding.filter((i) => (i.status ?? 'pending') === 'pending')
    .sort((a, b) => (Date.parse(a.period_start ?? '') || 0) - (Date.parse(b.period_start ?? '') || 0))
    .map((i) => ({ id: i.id, invoice_number: i.invoice_number, period_start: i.period_start, period_end: i.period_end, amount: Number(i.amount) || 0 }));
  if (p.fresh) return { from: p.from, until: p.until, settles: [], closes: open, fresh: true };
  const settles = open.filter((i) => i.period_start && Date.parse(i.period_start) >= f - 1000 && Date.parse(i.period_start) < u);
  return { from: p.from, until: p.until, settles, closes: [], fresh: false };
}

/** The 503 a locked business's tills get for a write (the till keeps the record queued; 1.0.20 tells the manager). */
export function syncRefusalBody(s: CloudStanding): { error: string; code: 'CLOUD_SUBSCRIPTION_ENDED'; trial: boolean } {
  const what = s.trial || s.state === 'ended' ? 'ZapTill cloud trial has ended' : 'ZapTill cloud subscription has ended';
  return {
    error: `This business's ${what}. The POS keeps selling and keeps its sales; they are sent when it is renewed. Call or WhatsApp ZapTill on ${ZAPTILL_PHONE}.`,
    code: 'CLOUD_SUBSCRIPTION_ENDED',
    trial: s.trial,
  };
}

/** The technician's words when a till cannot join (enrolment code, rejoin, a branch server's join code). */
export function enrolRefusalBody(): { error: string; code: 'CLOUD_SUBSCRIPTION_ENDED' } {
  return {
    error: `This business's ZapTill cloud subscription has ended, so a POS cannot be joined (or rejoined) until it is renewed. Ask the owner to pay, or call ZapTill on ${ZAPTILL_PHONE}. Points of sale already joined keep selling.`,
    code: 'CLOUD_SUBSCRIPTION_ENDED',
  };
}

/** A584: the plain words for a paused web dashboard (sign-in and every web request). No blame, no dates. */
export const PAUSED_WORDS = `Your ZapTill cloud access is paused. Call ${ZAPTILL_PHONE} to renew.`;
export const TRIAL_ENDED_WORDS = 'Your cloud trial has ended. Contact ZapTill to keep the web dashboard — your points of sale keep working.';

/** The 403 a paused business's web requests get (the dashboard shows the paused screen). */
export function webRefusalBody(s: Pick<CloudStanding, 'trial' | 'state'>): { error: string; code: 'CLOUD_ACCESS_PAUSED' | 'CLOUD_TRIAL_ENDED' } {
  return s.trial || s.state === 'ended' ? { error: TRIAL_ENDED_WORDS, code: 'CLOUD_TRIAL_ENDED' } : { error: PAUSED_WORDS, code: 'CLOUD_ACCESS_PAUSED' };
}

/**
 * A till's write the lapse gate leaves open: its sign-in and renewals, the technician's routes, its logs for support and
 * its update state. Everything else a desktop surface writes (sales, sync, drawers, changes, the heartbeat, a manager's
 * edits on the till, the join code) waits.
 */
const OPEN_WHILE_LAPSED: RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/tech\//,
  /^\/api\/support\/logs$/,
  /^\/api\/desktop-update\/state$/,
];
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const cleanPath = (path: string) => String(path || '').split('?')[0].replace(/\/+$/, '') || '/';

/** Does the lapse gate apply to this request? Only a till's (desktop surface) writes, never a web or KDS one, never a read. */
export function lapseGateApplies(surface: string | null | undefined, method: string, path: string): boolean {
  if (surface !== 'desktop') return false;
  if (!WRITES.has(String(method).toUpperCase())) return false;
  const p = cleanPath(path);
  return !OPEN_WHILE_LAPSED.some((re) => re.test(p));
}

/**
 * A601: a desktop-only POS's BACKUP writes, refused from the cut-off (503 CLOUD_BACKUP_OFF): sales and their voids /
 * refunds, the sync push (shifts, floats, expenses, trading days, kitchen voids, the heartbeat), a drawer's close,
 * force-close, confirmations and its read-only POSTs for the web's part (foreign-cash / foreign-orders), the web's day-close
 * acknowledgement and a credit sale's offline replay. Everything else stays open: sign-in and enrolment (/api/auth/*),
 * the technician, support logs, the update state, the catalogue and staff changes (/api/changes, a station's categories,
 * prices, wastage, a logo), the branch server's join code, a manager's screens, and every read.
 */
export const BACKUP_WRITES: RegExp[] = [
  /^\/api\/orders(\/|$)/,
  /^\/api\/sync\/push$/,
  /^\/api\/sync\/backfill$/,   // A602: the sales history in bulk
  /^\/api\/shifts\/[^/]+\/(close|force-close|foreign-cash|foreign-orders|confirm|manager-confirm)$/,
  /^\/api\/day-close\/ack$/,
  /^\/api\/credit\/sales\/[^/]+\/replay$/,
];
/** A601: is this one of a POS's backup writes? Only a desktop surface's writes, never a read. */
export function backupGateApplies(surface: string | null | undefined, method: string, path: string): boolean {
  if (surface !== 'desktop') return false;
  if (!WRITES.has(String(method).toUpperCase())) return false;
  const p = cleanPath(path);
  return BACKUP_WRITES.some((re) => re.test(p));
}

/**
 * A601: the 503 a desktop-only POS's backup write gets from the cut-off. 503 (not 402): every POS version keeps a 503'd
 * record queued, never failed or parked (A581) — a POS before A601 keeps its sales for A602's "going online later"; from
 * A601 the code tells the POS to stop sending quietly.
 */
export function backupRefusalBody(s: Pick<CloudStanding, 'desktopOnly'>): { error: string; code: 'CLOUD_BACKUP_OFF'; cutoffAt: string | null } {
  return {
    error: `This POS no longer backs up to the ZapTill cloud: the business has no online licence. Its sales stay on the POS. To keep online backup and the web dashboard, ask ZapTill about the online licence (${ZAPTILL_PHONE}).`,
    code: 'CLOUD_BACKUP_OFF',
    cutoffAt: s.desktopOnly.cutoffAt,
  };
}

/** A584: the web pause covers every web request (reads too) but sign-in housekeeping (/api/auth/* — sign out, renew). */
export function webGateApplies(surface: string | null | undefined, path: string): boolean {
  if (surface === 'desktop' || surface === 'kds') return false;
  return !/^\/api\/auth\//.test(cleanPath(path));
}

// ── ZapTill's notices (A584: the client gets the invoice only — and a receipt) ────────────────────────────────────────

/**
 * The admin-only notices due at `now`, each sent once per (business, due date, milestone):
 *   invoice   the due day (and after, until the lock): the invoice raised and emailed to the client; ZapTill's copy
 *   unpaid_5  the 5th unpaid day: "locks in 2 days"
 *   locked    once when locked (the morning digest lists locked clients after)
 *   not_interested  A587: once, 3 months unpaid — the open invoices written off, no more invoices
 *   trial_end A569/A584's trial notice — A587: a trial's end is its due day, so it gets the 'invoice' (kept for history)
 * A587: a trial is billed like a paid client. A locked client gets no invoice (pay as you go — a payment starts afresh).
 */
export type AdminMilestone = 'invoice' | 'unpaid_5' | 'locked' | 'not_interested' | 'trial_end';
export function adminMilestones(s: CloudStanding, now: number): AdminMilestone[] {
  if (!s.gated || !s.dueAt) return [];
  if (s.state === 'not_interested') return ['not_interested'];
  if (s.state !== 'active' && s.state !== 'unpaid' && s.state !== 'locked') return [];
  const out: AdminMilestone[] = [];
  if (s.state === 'locked') return ['locked'];
  if (nairobiDay(now) >= nairobiDay(Date.parse(s.dueAt))) out.push('invoice');
  if (s.state === 'unpaid' && (s.unpaidDays ?? 0) >= ADMIN_WARN_DAY) out.push('unpaid_5');
  return out;
}

/** The job's daytime window, Nairobi (it runs hourly; the due day's invoice goes from 07:00). */
export function reminderHour(now: number): boolean {
  const h = new Date(now + EAT_MS).getUTCHours();
  return h >= 7 && h < 20;
}

/** The invoice for the period starting at `due`: its end (one period on; custom: the plan's date when later) and amount. */
export function invoicePeriod(plan: { period?: PlanPeriod | null; amount?: number | string | null; custom_until?: string | null } | null, due: string): { start: string; end: string | null; amount: number; period: PlanPeriod } {
  const period: PlanPeriod = plan?.period && isPeriod(plan.period) ? plan.period : 'monthly';
  const amount = Number(plan?.amount ?? defaultAmount(period) ?? CLOUD_MONTHLY_KES);
  let end: string | null = null;
  if (period === 'custom') end = validIso(plan?.custom_until) && Date.parse(plan!.custom_until!) > Date.parse(due) ? new Date(Date.parse(plan!.custom_until!)).toISOString() : null;
  else end = addMonthsClamped(due, PERIOD_MONTHS[period]);
  return { start: due, end, amount: Number.isFinite(amount) ? amount : CLOUD_MONTHLY_KES, period };
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CloudPlanRow {
  business_id: string;
  period: PlanPeriod;
  amount: number;
  currency: string;
  custom_until: string | null;
  notes: string | null;
  updated_by: string | null;
  created_at?: string;
  updated_at?: string;
  /** A587 (migration 173): the bridge's kept due date for a licence already locked under the old ladder. */
  billing_from?: string | null;
}

/** A612 (migration 182): a branch's own plan — the cloud billed per branch. */
export interface BranchPlanRow {
  branch_id: string;
  business_id: string;
  period: PlanPeriod;
  amount: number | string;
  currency: string;
  custom_until: string | null;
  paid_until: string | null;
  billing_from: string | null;
  web_off: boolean;
  /** A612 phase 4: the branch's premium features, and the Premium package (every one). */
  premium?: string[] | null;
  package?: boolean | null;
  notes?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type CloudFactsRow = CloudFacts & {
  plan: CloudPlanRow | null; name?: string; ownerId?: string | null; email?: string | null;
  /** A612: the business's branches (ids) and the branches' own plans (empty: the business is billed as one, as before). */
  branchIds?: string[]; branchPlans?: BranchPlanRow[];
};

/** The facts for several businesses (the admin list, the billing job, the gate). A failed read leaves them unknown — never locked. */
export async function readCloudFacts(businessIds: string[]): Promise<Map<string, CloudFactsRow>> {
  const out = new Map<string, CloudFactsRow>();
  if (!businessIds.length) return out;
  const [plans, trials, bizs, flags, branchRows, branchPlanRows] = await Promise.all([
    supabase.from('cloud_plans').select('*').in('business_id', businessIds),
    supabase.from('business_settings').select('business_id, value').eq('key', CLOUD_TRIAL_KEY).in('business_id', businessIds),
    supabase.from('businesses').select('id, name, owner_id, email, status, web_access_expires_at').in('id', businessIds),
    // A601: the cut-off's two flags ride the same read (no extra query).
    supabase.from('feature_flags').select('business_id, key, enabled').in('key', ['web_hosting', CLOUD_BACKUP_FLAG, DESKTOP_UPDATES_FLAG]).in('business_id', businessIds),
    // A612: the branches and their own plans ride the same read set (two queries for every business asked, not two each).
    supabase.from('branches').select('id, business_id').in('business_id', businessIds),
    supabase.from('branch_cloud_plans').select('*').in('business_id', businessIds),
  ]);
  // Plans unreadable (migration 170 not applied, a timeout): every dated business reads as not yet bridged — never locked.
  if (plans.error) warnOnce('cloud_plans', plans.error.message);
  // A612: branch plans unreadable (migration 182 not applied, a timeout) — every branch follows its business, as before.
  if (branchPlanRows.error) warnOnce('branch_cloud_plans', branchPlanRows.error.message);
  if (bizs.error) return out;
  const branchesBy = new Map<string, string[]>();
  // Branches unreadable: none known — the branch rules then never apply (a business-wide answer, as before).
  for (const r of (branchRows.error ? [] : branchRows.data ?? []) as Array<{ id: string; business_id: string }>) {
    branchesBy.set(r.business_id, [...(branchesBy.get(r.business_id) ?? []), String(r.id)]);
  }
  const branchPlansBy = new Map<string, BranchPlanRow[]>();
  for (const r of (branchPlanRows.error || branchRows.error ? [] : branchPlanRows.data ?? []) as BranchPlanRow[]) {
    branchPlansBy.set(r.business_id, [...(branchPlansBy.get(r.business_id) ?? []), r]);
  }
  const planBy = new Map(((plans.data ?? []) as CloudPlanRow[]).map((p) => [p.business_id, p]));
  const trialBy = new Map<string, CloudTrial>();
  for (const r of (trials.data ?? []) as Array<{ business_id: string; value: unknown }>) { const t = cleanTrial(r.value); if (t) trialBy.set(r.business_id, t); }
  const flagRows = (flags.data ?? []) as Array<{ business_id: string; key?: string; enabled: boolean }>;
  const flagOf = (key: string) => new Map(flagRows.filter((f) => (f.key ?? 'web_hosting') === key).map((f) => [f.business_id, f.enabled === true]));
  const flagBy = flagOf('web_hosting');
  const backupBy = flagOf(CLOUD_BACKUP_FLAG), updatesBy = flagOf(DESKTOP_UPDATES_FLAG);   // A601
  for (const b of (bizs.data ?? []) as Array<{ id: string; name: string; owner_id: string | null; email: string | null; status: string | null; web_access_expires_at: string | null }>) {
    const plan = planBy.get(b.id) ?? null;
    out.set(b.id, {
      onPlan: !!plan, planCreatedAt: plan?.created_at ?? null, billingFrom: plan?.billing_from ?? null, plan, trial: trialBy.get(b.id) ?? null,
      expiresAt: b.web_access_expires_at ?? null, webHosting: flagBy.has(b.id) ? flagBy.get(b.id)! : null,
      suspended: b.status === 'suspended', name: b.name, ownerId: b.owner_id, email: b.email,
      cloudBackup: backupBy.has(b.id) ? backupBy.get(b.id)! : null, desktopUpdates: updatesBy.has(b.id) ? updatesBy.get(b.id)! : null,
      branchIds: branchesBy.get(b.id) ?? [], branchPlans: branchPlansBy.get(b.id) ?? [],
    });
  }
  return out;
}

/**
 * A584: the ids of every business the billing rules may concern — a plan row, a trial record, a paid-until date, or web
 * access on (for "No expiry set").
 */
export async function cloudBusinessIds(): Promise<string[]> {
  const [plans, trials, dated, flags] = await Promise.all([
    supabase.from('cloud_plans').select('business_id').limit(10000),
    supabase.from('business_settings').select('business_id').eq('key', CLOUD_TRIAL_KEY).limit(10000),
    supabase.from('businesses').select('id').not('web_access_expires_at', 'is', null).limit(10000),
    supabase.from('feature_flags').select('business_id').eq('key', 'web_hosting').eq('enabled', true).limit(10000),
  ]);
  if (plans.error) warnOnce('cloud_plans', plans.error.message);
  const ids = new Set<string>();
  for (const r of [...((plans.data ?? []) as Array<{ business_id: string }>), ...((trials.data ?? []) as Array<{ business_id: string }>),
    ...((flags.data ?? []) as Array<{ business_id: string }>)]) if (r.business_id) ids.add(r.business_id);
  for (const r of (dated.data ?? []) as Array<{ id: string }>) if (r.id) ids.add(r.id);
  return [...ids];
}
/** A581's name, kept for its callers: now every business the rules concern (A584). */
export const gatedBusinessIds = cloudBusinessIds;

/**
 * A593: the facts of every business the billing rules concern (cloudBusinessIds + readCloudFacts: 8 reads), kept up to
 * 30 minutes (A598 — 10 before, the watchdog's own interval, so a run every 10 minutes always found them just expired
 * and read them again) while nothing is written with no business of its own (an admin portal write, a job's) and
 * nothing forgot a standing (a payment, a plan, web access — forgetStanding). The standing is still worked out at the
 * caller's own time. A change made straight in SQL: within 30 minutes. A591_MEMO=off: read every time, as before.
 */
export const GOVERNED_QUIET_MS = 30 * 60_000;
let governedKept: { at: number; gen: string; fg: number; facts: Map<string, CloudFactsRow> } | null = null;
export async function governedFacts(now: number = Date.now()): Promise<Map<string, CloudFactsRow>> {
  const gen = writeGen('*');   // no business is named '*': the generation every business shares
  if (memoEnabled() && governedKept && governedKept.gen === gen && governedKept.fg === factsGeneration && now - governedKept.at < GOVERNED_QUIET_MS) {
    return governedKept.facts;
  }
  const fg = factsGeneration;
  const facts = await readCloudFacts(await cloudBusinessIds());
  // kept even when none is governed (the common case — 8 reads for nothing every 10 minutes otherwise)
  if (memoEnabled() && fg === factsGeneration) governedKept = { at: now, gen, fg, facts };
  return facts;
}

/**
 * The businesses whose tills the cloud refuses now (locked). The watchdog and the owner's alerts leave their tills out of
 * "on but not syncing" — that is the plan's decision, not a fault. A failed read: none.
 */
export async function lapsedBusinessIds(now: number = Date.now(), candidates?: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const facts = await governedFacts(now);   // A593: kept while nothing is written (8 reads every watchdog run before)
    for (const [id, f] of facts) if (!f.suspended && cloudStanding(f, now).syncRefused) out.add(id);
    // A601: from the cut-off, a desktop-only business's POSs send no backup on purpose — not "not syncing". The watchdog
    // names the businesses it is about to check (`candidates`): one not governed (no plan, date, trial or web access) is
    // desktop only; one governed is checked by its standing; the cloud_backup flag keeps it in (one read, kept as above).
    const cutoff = desktopOnlyCutoffAt();
    // (no governed business read at all = the read failed: nobody is taken as desktop only on it)
    if (candidates?.length && facts.size > 0 && cutoffPhase(cutoff, now) === 'cut') {
      const exempt = await backupExemptIds(now);
      for (const id of new Set(candidates)) {
        if (!id || out.has(id) || exempt.has(id)) continue;
        const f = facts.get(id);
        if (!f || (!f.suspended && cloudStanding(f, now, cutoff).desktopOnly.backupOff)) out.add(id);
      }
    }
  } catch (e) { console.warn('[cloud-plan] lapsed businesses not read:', (e as Error)?.message ?? e); }
  return out;
}

/** A601: the businesses whose cloud_backup flag is on — kept like governedFacts (30 minutes while nothing is written). */
let exemptKept: { at: number; gen: string; fg: number; ids: Set<string> } | null = null;
async function backupExemptIds(now: number): Promise<Set<string>> {
  const gen = writeGen('*');
  if (memoEnabled() && exemptKept && exemptKept.gen === gen && exemptKept.fg === factsGeneration && now - exemptKept.at < GOVERNED_QUIET_MS) return exemptKept.ids;
  const fg = factsGeneration;
  const { data, error } = await supabase.from('feature_flags').select('business_id').eq('key', CLOUD_BACKUP_FLAG).eq('enabled', true).limit(10000);
  if (error) throw new Error(`cloud_backup flags not read: ${error.message}`);   // never skip a business on a failed read
  const ids = new Set(((data ?? []) as Array<{ business_id: string }>).map((r) => r.business_id));
  if (memoEnabled() && fg === factsGeneration) exemptKept = { at: now, gen, fg, ids };
  return ids;
}

/**
 * A584: the morning digest's billing lines for ZapTill — the locked clients (every morning while locked), the unpaid
 * ones with the days to their lock, and how many have no expiry set. Empty when there is nothing to say.
 */
export async function billingDigestLines(now: number = Date.now()): Promise<string[]> {
  try {
    const facts = await readCloudFacts(await cloudBusinessIds());
    const locked: string[] = [], unpaid: string[] = []; let noExpiry = 0;
    for (const [, f] of facts) {
      if (f.suspended) continue;
      const s = cloudStanding(f, now);
      const name = f.name ?? 'a client';
      // A587: a "Not interested" client (ZapTill heard once) and one switched off by the admin are not listed daily.
      if (s.state === 'not_interested' || s.state === 'off') continue;
      if (s.syncRefused) locked.push(`${name} — ${s.state === 'ended' ? 'trial ended' : `${s.trial ? 'trial ended, ' : ''}locked ${s.lockedDays ?? 0} day${s.lockedDays === 1 ? '' : 's'}`}`);
      else if (s.state === 'unpaid') unpaid.push(`${name} — unpaid ${s.unpaidDays} day${s.unpaidDays === 1 ? '' : 's'}, locks in ${s.lockInDays} day${s.lockInDays === 1 ? '' : 's'}`);
      else if (s.state === 'no_expiry') noExpiry++;
    }
    const lines: string[] = [];
    if (locked.length) lines.push(`💳 Cloud locked (${locked.length}):`, ...locked.map((x) => `• ${x}`));
    if (unpaid.length) lines.push(`💳 Cloud unpaid (${unpaid.length}):`, ...unpaid.map((x) => `• ${x}`));
    if (noExpiry) lines.push(`💳 ${noExpiry} client${noExpiry === 1 ? '' : 's'} with web access and no expiry set — put them on a plan (admin portal › Clients › No expiry set).`);
    return lines;
  } catch { return []; }
}

/**
 * A589: the same clients as billingDigestLines — locked and unpaid — as rows of the daily billing summary's table
 * (lib/adminAlertPolicy.ts billingSummaryEmail): client | invoice | amount | due | status. A failed read: none.
 */
export async function billingStandingRows(now: number = Date.now()): Promise<Array<{ client: string; invoice: string | null; amount: number | null; currency: string; due: string | null; status: string }>> {
  try {
    const facts = await readCloudFacts(await cloudBusinessIds());
    const rows: Array<{ client: string; invoice: string | null; amount: number | null; currency: string; due: string | null; status: string }> = [];
    for (const [, f] of facts) {
      if (f.suspended) continue;
      const s = cloudStanding(f, now);
      if (s.state === 'not_interested' || s.state === 'off') continue;
      const base = { client: f.name ?? 'a client', invoice: null, amount: f.plan?.amount != null ? Number(f.plan.amount) : null, currency: f.plan?.currency ?? 'KES', due: s.dueAt };
      const d = (n: number | null | undefined) => `${n ?? 0} day${n === 1 ? '' : 's'}`;
      if (s.syncRefused) rows.push({ ...base, status: s.state === 'ended' ? 'Trial ended' : `${s.trial ? 'Trial ended, l' : 'L'}ocked ${d(s.lockedDays)}` });
      else if (s.state === 'unpaid') rows.push({ ...base, status: `Unpaid ${d(s.unpaidDays)} — locks in ${d(s.lockInDays)}` });
    }
    return rows;
  } catch { return []; }
}

/** The next INV-YYYY-NNNN (the same series as the admin's invoices). */
export async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).like('invoice_number', `INV-${year}-%`);
  return `INV-${year}-${String((count ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * A584: write a cloud invoice (kind 'cloud' — migration 172; one per business and period start, unique). A cloud whose
 * migration 172 has not run yet writes it without the kind (the claim in cloud_plan_reminders still keeps it to one).
 */
export async function insertCloudInvoice(row: Record<string, unknown>): Promise<{ data: { id: string; invoice_number: string } | null; error: { code?: string; message: string } | null }> {
  // business_id: every caller's row carries the client's business_id (the job and Record payment build it).
  const first = await supabase.from('invoices').insert({ ...row, kind: 'cloud' }).select('id, invoice_number').single();
  if (!first.error) return { data: first.data as { id: string; invoice_number: string }, error: null };
  const e = first.error as { code?: string; message: string };
  if (e.code === '42703' || e.code === 'PGRST204' || /kind/.test(String(e.message))) {
    // business_id: the same row as above.
    const again = await supabase.from('invoices').insert(row).select('id, invoice_number').single();
    return { data: (again.data as { id: string; invoice_number: string } | null) ?? null, error: (again.error as { code?: string; message: string } | null) ?? null };
  }
  return { data: null, error: e };
}

/** A587: a business's open (pending) cloud invoices, oldest first. A failed read: none (a payment then raises its own). */
export async function openCloudInvoices(businessId: string): Promise<OpenInvoice[]> {
  const { data, error } = await supabase.from('invoices').select('id, invoice_number, period_start, period_end, amount, status')
    .eq('business_id', businessId).eq('kind', 'cloud').eq('status', 'pending').order('period_start', { ascending: true }).limit(100);
  if (error) { console.warn('[cloud-plan] open invoices not read:', error.message); return []; }
  return (data ?? []) as OpenInvoice[];
}

/** A587: the invoice status a write-off sets ('written_off' — migration 173; a cloud before it: 'failed', A584's word). */
export const WRITTEN_OFF = 'written_off';

/**
 * A587: the business's open cloud invoices (or the ones named) are closed — written off, not charged: on "Not interested",
 * and when a locked client pays (pay as you go — the locked time is not charged). Returns the numbers closed.
 * A cloud whose migration 173 has not run refuses the new status (a check constraint): 'failed' instead.
 */
export async function writeOffCloudInvoices(businessId: string, only?: readonly string[]): Promise<{ numbers: string[]; status: string; error: string | null }> {
  const ids = only ? [...only] : (await openCloudInvoices(businessId)).map((i) => i.id);
  if (!ids.length) return { numbers: [], status: WRITTEN_OFF, error: null };
  let status = WRITTEN_OFF;
  let r = await supabase.from('invoices').update({ status }).eq('business_id', businessId).eq('status', 'pending').in('id', ids).select('invoice_number');
  if (r.error && ((r.error as { code?: string }).code === '23514' || /invoices_status_check/.test(String(r.error.message)))) {
    status = 'failed';
    r = await supabase.from('invoices').update({ status }).eq('business_id', businessId).eq('status', 'pending').in('id', ids).select('invoice_number');
  }
  if (r.error) return { numbers: [], status, error: r.error.message };
  return { numbers: ((r.data ?? []) as Array<{ invoice_number: string }>).map((x) => x.invoice_number), status, error: null };
}

const warned = new Set<string>();
function warnOnce(what: string, msg: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[cloud-plan] could not read ${what} (migration 170 not applied?): ${msg} — no business is gated until it reads`);
}

// ── The gate's memory (one read set per business per minute — a till writes every few seconds) ──────────────────────

export const STANDING_TTL_MS = 60_000;
const memo = new Map<string, { at: number; facts: CloudFactsRow | null }>();

/**
 * A593 (owner, 2026-10-26: "logs are full already" — ~82,000 Supabase calls a day): every POS write (its sale, a drawer's
 * read-only POST every 20 s) and every web request passed this gate, and a minute's memory meant FOUR reads (plan, trial,
 * business, flag) per business per minute all day. Now the FACTS are kept — the standing is worked out from them at each
 * request's own time (a grace period runs out by the clock, with no write) — up to 10 minutes while nothing is written for
 * the business through this server (lib/writeActivity.ts; a payment, a plan, web access changed in the admin portal also
 * forget it at once, forgetStanding), and when they must be read, ONE read set refreshes every business the gate has
 * asked about (4 reads for all, not 4 each). A change made straight in SQL: within 10 minutes. A591_MEMO=off: as before.
 */
export const STANDING_QUIET_MS = 10 * 60_000;
const factsKept = new Map<string, { at: number; gen: string; facts: CloudFactsRow | null }>();
let factsReading: Promise<void> | null = null;
let factsGeneration = 0;
let standingClock: () => number = () => Date.now();   // A593: a test seam
export function _setStandingClock(fn: (() => number) | null): void { standingClock = fn ?? (() => Date.now()); }
/** Test seam. */
export function _resetStanding(): void { memo.clear(); factsKept.clear(); governedKept = null; exemptKept = null; factsGeneration++; }
const standingOf = (f: CloudFactsRow | null, now: number): CloudStanding | null => (f && !f.suspended ? cloudStanding(f, now) : null);

async function refreshFacts(businessId: string, now: number): Promise<void> {
  const ids = [businessId, ...[...factsKept.keys()].filter((k) => k !== businessId)].slice(0, 200);
  const gens = new Map(ids.map((id) => [id, writeGen(id)]));   // before the read
  const fg = factsGeneration;
  let read: Map<string, CloudFactsRow> | null = null;
  try { read = await readCloudFacts(ids); }
  catch (e) { console.warn('[cloud-plan] standing read failed — not gated this time:', (e as Error)?.message ?? e); }
  if (fg !== factsGeneration) return;   // forgotten meanwhile: not kept (the next ask reads again)
  // Nothing at all came back for any of them: the read failed (bizs unreadable) — not gated, asked again in a minute.
  const failed = !read || (read.size === 0 && ids.length > 0);
  for (const id of ids) {
    factsKept.delete(id);
    factsKept.set(id, { at: now, gen: failed ? '' : gens.get(id)!, facts: failed ? null : (read!.get(id) ?? null) });
  }
  while (factsKept.size > 5000) { const first = factsKept.keys().next().value; if (first === undefined) break; factsKept.delete(first); }
}

/** A593: a job about to ask the standing of many businesses (ownerAlerts' tick) — ONE read set for all that are not kept. */
export async function primeStandings(businessIds: string[], now: number = standingClock()): Promise<void> {
  if (!memoEnabled() || !businessIds.length) return;
  const stale = businessIds.filter((id) => {
    const e = factsKept.get(id);
    return !(e && (now - e.at < STANDING_TTL_MS || (e.gen !== '' && e.gen === writeGen(id) && now - e.at < STANDING_QUIET_MS)));
  });
  if (!stale.length) return;
  for (const id of stale.slice(1)) if (!factsKept.has(id)) factsKept.set(id, { at: 0, gen: '', facts: null });   // asked with it
  await refreshFacts(stale[0], now);
}

/** The business's facts as the gates read them (kept as below). A failed read answers null (never refuse on a failed read). */
async function factsFor(businessId: string, now: number): Promise<CloudFactsRow | null> {
  if (memoEnabled()) {   // A593
    const fresh = (e: { at: number; gen: string } | undefined) => !!e && (now - e.at < STANDING_TTL_MS
      || (e.gen !== '' && e.gen === writeGen(businessId) && now - e.at < STANDING_QUIET_MS));
    let e = factsKept.get(businessId);
    if (!fresh(e)) {
      if (!factsReading) factsReading = refreshFacts(businessId, now).finally(() => { factsReading = null; });
      await factsReading;
      e = factsKept.get(businessId);
      if (!fresh(e)) { await refreshFacts(businessId, now); e = factsKept.get(businessId); }   // read for others meanwhile
    }
    return e?.facts ?? null;
  }
  const hit = memo.get(businessId);
  if (hit && now - hit.at < STANDING_TTL_MS) return hit.facts;
  let facts: CloudFactsRow | null = null;
  try {
    facts = (await readCloudFacts([businessId])).get(businessId) ?? null;
  } catch (e) {
    console.warn('[cloud-plan] standing read failed — not gated this time:', (e as Error)?.message ?? e);
    facts = null;
  }
  memo.set(businessId, { at: now, facts });
  if (memo.size > 5000) memo.clear();
  return facts;
}

/** The standing for the gates, remembered a minute. A failed read answers null (never refuse on a failed read). */
export async function standingFor(businessId: string, now: number = standingClock()): Promise<CloudStanding | null> {
  return standingOf(await factsFor(businessId, now), now);
}

/** A612: the business's facts as the gates keep them (premium per branch reads its branches' rows from here). */
export async function cloudFactsFor(businessId: string, now: number = standingClock()): Promise<CloudFactsRow | null> {
  return factsFor(businessId, now);
}

/** A612: the business's paused branches, from the same kept facts; null when it is billed as one (or unreadable / suspended). */
export async function branchPauseFor(businessId: string, now: number = standingClock()): Promise<BranchPause | null> {
  const f = await factsFor(businessId, now);
  return f && !f.suspended ? branchPause(f, now) : null;
}

/** A payment, a plan or web access changed — the next request reads afresh (this server; another one within a minute). */
export function forgetStanding(businessId?: string): void {
  factsGeneration++;   // A593: a read already under way is not kept
  if (businessId) { memo.delete(businessId); factsKept.delete(businessId); } else { memo.clear(); factsKept.clear(); }
}

/** The refusal for a till's write, or null when it may go. */
export async function lapseRefusal(businessId: string | null | undefined, surface: string | null | undefined, method: string, path: string): Promise<ReturnType<typeof syncRefusalBody> | null> {
  if (!businessId || !lapseGateApplies(surface, method, path)) return null;
  const s = await standingFor(businessId);
  return s && s.syncRefused ? syncRefusalBody(s) : null;
}

/**
 * A584: every gate in one — a till's write while locked → 503 CLOUD_SUBSCRIPTION_ENDED (A581); a web request while paused
 * → 403 CLOUD_ACCESS_PAUSED (a trial: CLOUD_TRIAL_ENDED). null when it may go.
 */
export async function accessRefusal(businessId: string | null | undefined, surface: string | null | undefined, method: string, path: string,
  branchId: string | null = null):
  Promise<{ status: 503; body: ReturnType<typeof syncRefusalBody> } | { status: 503; body: ReturnType<typeof backupRefusalBody> }
    | { status: 403; body: ReturnType<typeof webRefusalBody> } | null> {
  if (!businessId) return null;
  // A612: a POS (or a person on it) of a PAUSED branch — every request but the open ones, reads included: nothing goes up,
  // nothing comes down (not even a price changed on the web). 503 as a lapsed business's, so every POS version keeps it queued.
  if (surface === 'desktop' && branchId && !OPEN_WHILE_LAPSED.some((re) => re.test(cleanPath(path)))) {
    const p = await branchPauseFor(businessId);
    const st = p?.paused.has(branchId) ? p.standings.get(branchId) : undefined;
    if (st) return { status: 503, body: syncRefusalBody(st) };
  }
  if (lapseGateApplies(surface, method, path)) {
    const s = await standingFor(businessId);
    // A612: billed per branch — the business's own date no longer stops a branch (its branch's standing did, above).
    const perBranch = !!(await branchPauseFor(businessId));
    if (s && s.syncRefused && !perBranch) return { status: 503, body: syncRefusalBody(s) };
    // A601: a desktop-only business from the cut-off — its POS's backup writes only (setup, changes, logs stay open).
    if (s && s.desktopOnly.backupOff && backupGateApplies(surface, method, path)) return { status: 503, body: backupRefusalBody(s) };
    return null;
  }
  if (webGateApplies(surface, path)) {
    // A612: billed per branch — the web is paused only when every branch is (one paused branch is hidden: middleware/auth.ts).
    const p = await branchPauseFor(businessId);
    if (p) {
      const first = p.allPaused ? p.standings.values().next().value : undefined;
      return first ? { status: 403, body: webRefusalBody(first) } : null;
    }
    const s = await standingFor(businessId);
    return s && s.webLocked ? { status: 403, body: webRefusalBody(s) } : null;
  }
  return null;
}

/** May a till join this business now? (enrolment code redeem, the admin's code, a branch server's join code) */
export async function enrolRefusal(businessId: string, branchId: string | null = null): Promise<ReturnType<typeof enrolRefusalBody> | null> {
  // A612: billed per branch — a POS joins only an open branch (a paused one, or none named while every branch is paused: no).
  const p = await branchPauseFor(businessId);
  if (p) return (branchId ? p.paused.has(branchId) : p.allPaused) ? enrolRefusalBody() : null;
  const s = await standingFor(businessId);
  return s && s.syncRefused ? enrolRefusalBody() : null;
}

export { TRIAL_REPORTS_ONLY_DAYS, DAY_MS };
