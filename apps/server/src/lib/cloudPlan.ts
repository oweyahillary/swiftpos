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
 * 23 Nov due date → paid until 23 Dec); early adds on (no lost days); a locked client starts again from the day it pays.
 *
 * Pure rules first (the tests run them), storage after.
 */
import { supabase } from './supabase';
import { CLOUD_TRIAL_KEY, TRIAL_REPORTS_ONLY_DAYS, cleanTrial, type CloudTrial } from './cloudTrial';
import {
  DAY_MS, EAT_MS, UNPAID_DAYS, ADMIN_WARN_DAY, nairobiDay, daysUntil, effectiveDue, lockAtFor, unpaidDaysAt, paidState, trialState,
} from './billingClock';

export { daysUntil, UNPAID_DAYS, ADMIN_WARN_DAY };

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
  /** The A569 trial record, if any. */
  trial: CloudTrial | null;
  /** businesses.web_access_expires_at — the paid-until. */
  expiresAt: string | null;
  /** feature_flags.web_hosting (null: no row). */
  webHosting: boolean | null;
  /** businesses.status === 'suspended' (a hard off-switch of its own — not this rule's). */
  suspended?: boolean;
}

/**
 *   not_on_plan  no web access, no date, no plan — nothing to bill
 *   off          web access switched off with a date and no plan (A584: not invoiced; listed)
 *   no_expiry    web access on, no date, no plan — unchanged; listed "No expiry set"
 *   no_date      on a plan, no payment yet
 *   active       paid (or a trial within its 30 days)
 *   unpaid       due, within the 7 unpaid days — everything works
 *   reports_only a trial's week after its end (sync refused; the web reads only)
 *   locked       paused: web, sync and enrolment refused
 *   ended        a trial ended early ("End trial")
 */
export type CloudState = 'not_on_plan' | 'off' | 'no_expiry' | 'no_date' | 'active' | 'unpaid' | 'reports_only' | 'locked' | 'ended';

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
}

const validIso = (s: string | null | undefined): s is string => !!s && Number.isFinite(Date.parse(s));

/** Where a business stands at `now`. Pure. */
export function cloudStanding(f: CloudFacts, now: number = Date.now()): CloudStanding {
  const onTrial = !!f.trial && !f.trial.converted_at;
  const dated = validIso(f.expiresAt);
  const blank: CloudStanding = {
    gated: false, state: 'not_on_plan', trial: onTrial, paidUntil: dated ? f.expiresAt : null, dueAt: null, lockAt: null, syncStopsAt: null,
    daysLeft: null, unpaidDays: null, lockInDays: null, lockedDays: null, bridgePending: false, syncRefused: false, webLocked: false,
  };
  // ── A569 trial: its own ladder ──
  if (onTrial) {
    if (!dated) return { ...blank, gated: true, state: 'no_date' };
    const end = f.expiresAt as string;
    const base = { ...blank, gated: true, dueAt: end, lockAt: end, syncStopsAt: end, daysLeft: daysUntil(end, now) };
    if (f.webHosting === false) return { ...base, state: 'ended', syncRefused: true, webLocked: true };   // "End trial": at once
    const t = trialState(end, now);
    return { ...base, state: t, syncRefused: t !== 'active', webLocked: t === 'locked' };
  }
  if (!dated) {
    if (f.onPlan) return { ...blank, gated: true, state: 'no_date' };
    return { ...blank, state: f.webHosting === true ? 'no_expiry' : 'not_on_plan' };
  }
  const paidUntil = f.expiresAt as string;
  // Switched off by the admin, a date kept, never on a plan: not billed (the dashboard reads its date as before).
  const off = !f.onPlan && f.webHosting === false;
  const bridgePending = !f.onPlan && !off;
  // Before the bridge has made the plan row, the due moment is never in the past (nobody locked by a deploy).
  const billingFrom = f.onPlan ? (f.planCreatedAt ?? null) : off ? null : new Date(now).toISOString();
  const due = effectiveDue(paidUntil, billingFrom);
  const lockAt = lockAtFor(due);
  const ps = paidState(due, now);
  const unpaid = unpaidDaysAt(due, now);
  const s: CloudStanding = {
    ...blank, gated: !off, paidUntil, dueAt: due, lockAt, syncStopsAt: lockAt, daysLeft: daysUntil(due, now), bridgePending,
    state: off ? 'off' : ps, unpaidDays: ps === 'active' ? null : unpaid,
    lockInDays: ps === 'unpaid' && unpaid !== null ? Math.max(0, UNPAID_DAYS - unpaid) : null,
    lockedDays: ps === 'locked' ? nairobiDay(now) - nairobiDay(Date.parse(lockAt)) : null,
  };
  if (off) return { ...s, unpaidDays: null, lockInDays: null, lockedDays: null };
  return { ...s, syncRefused: ps === 'locked', webLocked: ps === 'locked' };
}

/** The standing as the portal reads it (snake_case). */
export function standingView(s: CloudStanding) {
  return {
    gated: s.gated, state: s.state, trial: s.trial, paid_until: s.paidUntil, due_at: s.dueAt, lock_at: s.lockAt, sync_stops_at: s.syncStopsAt,
    days_left: s.daysLeft, unpaid_days: s.unpaidDays, lock_in_days: s.lockInDays, locked_days: s.lockedDays,
    bridge_pending: s.bridgePending, sync_refused: s.syncRefused, web_locked: s.webLocked,
  };
}

/** The 503 a locked business's tills get for a write (the till keeps the record queued; 1.0.20 tells the manager). */
export function syncRefusalBody(s: CloudStanding): { error: string; code: 'CLOUD_SUBSCRIPTION_ENDED'; trial: boolean } {
  const what = s.trial || s.state === 'ended' ? 'ZapTill cloud trial has ended' : 'ZapTill cloud subscription has ended';
  return {
    error: `This business's ${what}. The till keeps selling and keeps its sales; they are sent when it is renewed. Call or WhatsApp ZapTill on ${ZAPTILL_PHONE}.`,
    code: 'CLOUD_SUBSCRIPTION_ENDED',
    trial: s.trial,
  };
}

/** The technician's words when a till cannot join (enrolment code, rejoin, a branch server's join code). */
export function enrolRefusalBody(): { error: string; code: 'CLOUD_SUBSCRIPTION_ENDED' } {
  return {
    error: `This business's ZapTill cloud subscription has ended, so a till cannot be joined (or rejoined) until it is renewed. Ask the owner to pay, or call ZapTill on ${ZAPTILL_PHONE}. Tills already joined keep selling.`,
    code: 'CLOUD_SUBSCRIPTION_ENDED',
  };
}

/** A584: the plain words for a paused web dashboard (sign-in and every web request). No blame, no dates. */
export const PAUSED_WORDS = `Your ZapTill cloud access is paused. Call ${ZAPTILL_PHONE} to renew.`;
export const TRIAL_ENDED_WORDS = 'Your cloud trial has ended. Contact ZapTill to keep the web dashboard — your tills keep working.';

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
 *   trial_end the day a cloud trial ends
 */
export type AdminMilestone = 'invoice' | 'unpaid_5' | 'locked' | 'trial_end';
export function adminMilestones(s: CloudStanding, now: number): AdminMilestone[] {
  if (!s.gated || !s.dueAt) return [];
  if (s.trial) return s.state === 'active' ? [] : ['trial_end'];
  if (s.state === 'locked') return ['locked'];
  const out: AdminMilestone[] = [];
  if (s.state === 'active' || s.state === 'unpaid') {
    if (nairobiDay(now) >= nairobiDay(Date.parse(s.dueAt))) out.push('invoice');
    if (s.state === 'unpaid' && (s.unpaidDays ?? 0) >= ADMIN_WARN_DAY) out.push('unpaid_5');
  }
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
}

export type CloudFactsRow = CloudFacts & { plan: CloudPlanRow | null; name?: string; ownerId?: string | null; email?: string | null };

/** The facts for several businesses (the admin list, the billing job, the gate). A failed read leaves them unknown — never locked. */
export async function readCloudFacts(businessIds: string[]): Promise<Map<string, CloudFactsRow>> {
  const out = new Map<string, CloudFactsRow>();
  if (!businessIds.length) return out;
  const [plans, trials, bizs, flags] = await Promise.all([
    supabase.from('cloud_plans').select('*').in('business_id', businessIds),
    supabase.from('business_settings').select('business_id, value').eq('key', CLOUD_TRIAL_KEY).in('business_id', businessIds),
    supabase.from('businesses').select('id, name, owner_id, email, status, web_access_expires_at').in('id', businessIds),
    supabase.from('feature_flags').select('business_id, enabled').eq('key', 'web_hosting').in('business_id', businessIds),
  ]);
  // Plans unreadable (migration 170 not applied, a timeout): every dated business reads as not yet bridged — never locked.
  if (plans.error) warnOnce('cloud_plans', plans.error.message);
  if (bizs.error) return out;
  const planBy = new Map(((plans.data ?? []) as CloudPlanRow[]).map((p) => [p.business_id, p]));
  const trialBy = new Map<string, CloudTrial>();
  for (const r of (trials.data ?? []) as Array<{ business_id: string; value: unknown }>) { const t = cleanTrial(r.value); if (t) trialBy.set(r.business_id, t); }
  const flagBy = new Map(((flags.data ?? []) as Array<{ business_id: string; enabled: boolean }>).map((f) => [f.business_id, f.enabled === true]));
  for (const b of (bizs.data ?? []) as Array<{ id: string; name: string; owner_id: string | null; email: string | null; status: string | null; web_access_expires_at: string | null }>) {
    const plan = planBy.get(b.id) ?? null;
    out.set(b.id, {
      onPlan: !!plan, planCreatedAt: plan?.created_at ?? null, plan, trial: trialBy.get(b.id) ?? null,
      expiresAt: b.web_access_expires_at ?? null, webHosting: flagBy.has(b.id) ? flagBy.get(b.id)! : null,
      suspended: b.status === 'suspended', name: b.name, ownerId: b.owner_id, email: b.email,
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
 * The businesses whose tills the cloud refuses now (locked). The watchdog and the owner's alerts leave their tills out of
 * "on but not syncing" — that is the plan's decision, not a fault. A failed read: none.
 */
export async function lapsedBusinessIds(now: number = Date.now()): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const facts = await readCloudFacts(await cloudBusinessIds());
    for (const [id, f] of facts) if (!f.suspended && cloudStanding(f, now).syncRefused) out.add(id);
  } catch (e) { console.warn('[cloud-plan] lapsed businesses not read:', (e as Error)?.message ?? e); }
  return out;
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
      if (s.syncRefused) locked.push(`${name} — ${s.trial ? 'trial ended' : `locked ${s.lockedDays ?? 0} day${s.lockedDays === 1 ? '' : 's'}`}`);
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

const warned = new Set<string>();
function warnOnce(what: string, msg: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[cloud-plan] could not read ${what} (migration 170 not applied?): ${msg} — no business is gated until it reads`);
}

// ── The gate's memory (one read set per business per minute — a till writes every few seconds) ──────────────────────

export const STANDING_TTL_MS = 60_000;
const memo = new Map<string, { at: number; standing: CloudStanding | null }>();

/** The standing for the gates, remembered a minute. A failed read answers null (never refuse on a failed read). */
export async function standingFor(businessId: string, now: number = Date.now()): Promise<CloudStanding | null> {
  const hit = memo.get(businessId);
  if (hit && now - hit.at < STANDING_TTL_MS) return hit.standing;
  let standing: CloudStanding | null = null;
  try {
    const facts = (await readCloudFacts([businessId])).get(businessId);
    standing = facts && !facts.suspended ? cloudStanding(facts, now) : null;
  } catch (e) {
    console.warn('[cloud-plan] standing read failed — not gated this time:', (e as Error)?.message ?? e);
    standing = null;
  }
  memo.set(businessId, { at: now, standing });
  if (memo.size > 5000) memo.clear();
  return standing;
}

/** A payment, a plan or web access changed — the next request reads afresh (this server; another one within a minute). */
export function forgetStanding(businessId?: string): void {
  if (businessId) memo.delete(businessId); else memo.clear();
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
export async function accessRefusal(businessId: string | null | undefined, surface: string | null | undefined, method: string, path: string):
  Promise<{ status: 503; body: ReturnType<typeof syncRefusalBody> } | { status: 403; body: ReturnType<typeof webRefusalBody> } | null> {
  if (!businessId) return null;
  if (lapseGateApplies(surface, method, path)) {
    const s = await standingFor(businessId);
    return s && s.syncRefused ? { status: 503, body: syncRefusalBody(s) } : null;
  }
  if (webGateApplies(surface, path)) {
    const s = await standingFor(businessId);
    return s && s.webLocked ? { status: 403, body: webRefusalBody(s) } : null;
  }
  return null;
}

/** May a till join this business now? (enrolment code redeem, the admin's code, a branch server's join code) */
export async function enrolRefusal(businessId: string): Promise<ReturnType<typeof enrolRefusalBody> | null> {
  const s = await standingFor(businessId);
  return s && s.syncRefused ? enrolRefusalBody() : null;
}

export { TRIAL_REPORTS_ONLY_DAYS };
