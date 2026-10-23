/**
 * cloudPlan.ts — A581 (2026-10-23): the cloud's payment plan, per business — period, amount, paid-until, payments,
 * what happens when it lapses, and the reminders.
 *
 * Owner, 2026-10-23: "if a client stops paying for the cloud … yes till continues to work, but the cloud stops syncing and
 * the till cannot be re-registered until the client pays again. add payment plan option such that i can select month on
 * month and always remind me on email about expiry and also the client". Pricing decided the same day: the desktop setup
 * is a one-off per branch; the CLOUD (web dashboard, online features, sync) is month to month, charged PER BUSINESS;
 * paying for 3 / 6 / 12 months ahead is recommended but carries no discount (for now).
 *
 * ONE CLOCK. Paid-until IS businesses.web_access_expires_at — the date lib/webAccess.ts already measures the dashboard's
 * ladder against (A147; A569's trial sets it too). No second date that could drift. "Record payment" moves it on by one
 * period from the LATER of now and the current paid-until, so paying early never loses a day.
 *
 * WHO IS ON THE PLAN ("gated"). A business with a cloud_plans row (the admin set a plan or recorded a payment) or a cloud
 * trial record (A569: every client whose first desktop licence was activated since). A business with neither — the
 * clients from before, on the legacy web_hosting switch or an undated or old expiry — is NOT gated: its tills sync as
 * before until ZapTill puts it on a plan. Every business type the same: the fee is per business.
 *
 * WHEN IT LAPSES (the existing ladder, lib/webAccess.ts — kept, not changed):
 *   paid client:  paid-until → 21 days' grace (everything works, the reminders say so) → 7 days reports only → locked.
 *   cloud trial:  no grace — reports only for 7 days straight after its end → locked ("Your cloud trial has ended").
 *   Sync and till enrolment stop when the dashboard leaves full access: after the 21-day grace for a paid client, the
 *   day after the trial for a trial (and at once when the admin pressed "End trial").
 *   - Tills keep selling exactly as now; nothing on a till checks this.
 *   - A till's writes to the cloud (sales, drawers, days, expenses, changes, the heartbeat) are answered 503
 *     CLOUD_SUBSCRIPTION_ENDED (middleware/auth.ts): 503 so every till — 1.0.19 and older too — keeps the record queued
 *     (a 5xx is "the cloud's passing state" on every version, never a refusal that parks or fails a sale); 1.0.20 reads
 *     the code and tells the manager in plain words. When the payment is recorded the gate opens at once (this server)
 *     or within a minute (another instance), and the queue drains on the till's next pass.
 *   - Its sign-in and renewals (/api/auth/*), the technician's routes (/api/tech/*), "Send logs to support" and the update
 *     state stay open — a lapsed client's till must still renew and be supportable.
 *   - A new till, or a rejoin, is refused (enrolment code redeem; the admin's "Enrolment code" and the branch server's
 *     join-code too) with words for the technician.
 *
 * REMINDERS (jobs/cloudPlanReminders.ts): 14, 7, 3 and 1 day(s) before paid-until, on the day it lapses, then every 7
 * days while lapsed (at most 8) — one email per business per milestone (cloud_plan_reminders, unique), to the owner and
 * to ZapTill (ADMIN_ALERT_EMAIL, and Telegram when set — lib/alertNotify.ts).
 *
 * Pure rules first (the tests run them), storage after.
 */
import { supabase } from './supabase';
import { ladderState, GRACE_DAYS } from './webAccess';
import { CLOUD_TRIAL_KEY, TRIAL_REPORTS_ONLY_DAYS, cleanTrial, type CloudTrial } from './cloudTrial';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const EAT_MS = 3 * 60 * 60 * 1000;   // Nairobi: UTC+3, no daylight saving

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

/** Calendar days (Nairobi) from `now` to `iso`: 0 = the same day, 1 = tomorrow, -3 = three days ago. */
export function daysUntil(iso: string, now: number): number {
  return Math.floor((Date.parse(iso) + EAT_MS) / DAY_MS) - Math.floor((now + EAT_MS) / DAY_MS);
}

export type ExtendResult = { ok: true; from: string; until: string } | { ok: false; code: string; error: string };

/**
 * The new paid-until for one payment: one period from the LATER of `now` and the current paid-until (no lost days — an
 * early payment adds to what is left; a lapsed one starts today). A custom period runs to the date given, which must be
 * after that start.
 */
export function nextPaidUntil(p: { period: PlanPeriod; now: number; paidUntil: string | null; customUntil?: string | null }): ExtendResult {
  const current = p.paidUntil ? Date.parse(p.paidUntil) : NaN;
  const base = Number.isFinite(current) && current > p.now ? current : p.now;
  const from = new Date(base).toISOString();
  if (p.period === 'custom') {
    const end = p.customUntil ? Date.parse(p.customUntil) : NaN;
    if (!Number.isFinite(end)) return { ok: false, code: 'CUSTOM_END_REQUIRED', error: 'A custom period needs the date it is paid until.' };
    if (end <= base) return { ok: false, code: 'CUSTOM_END_TOO_EARLY', error: `The date must be after ${from.slice(0, 10)} (what is already paid, or today).` };
    return { ok: true, from, until: new Date(end).toISOString() };
  }
  return { ok: true, from, until: addMonthsClamped(from, PERIOD_MONTHS[p.period]) };
}

// ── Standing: where a business is on its plan ─────────────────────────────────────────────────────────────────────────

export interface CloudFacts {
  /** A cloud_plans row exists. */
  onPlan: boolean;
  /** The A569 trial record, if any. */
  trial: CloudTrial | null;
  /** businesses.web_access_expires_at — the paid-until. */
  expiresAt: string | null;
  /** feature_flags.web_hosting (null: no row). */
  webHosting: boolean | null;
  /** businesses.status === 'suspended' (a hard off-switch of its own — not this rule's). */
  suspended?: boolean;
}

export type CloudState = 'not_on_plan' | 'no_date' | 'active' | 'grace' | 'reports_only' | 'locked' | 'ended';

export interface CloudStanding {
  /** On the plan rule at all (a plan or a trial). */
  gated: boolean;
  state: CloudState;
  /** An unconverted cloud trial. */
  trial: boolean;
  paidUntil: string | null;
  /** When sync and enrolment stop (paid-until + the grace; a trial: its end). */
  syncStopsAt: string | null;
  /** Calendar days to paid-until (negative: lapsed that many days); null without a date. */
  daysLeft: number | null;
  /** The tills' pushes and a new till are refused now. */
  syncRefused: boolean;
}

/** Where a business stands at `now`. Pure. */
export function cloudStanding(f: CloudFacts, now: number = Date.now()): CloudStanding {
  const onTrial = !!f.trial && !f.trial.converted_at;
  const gated = f.onPlan || !!f.trial;
  const base = { gated, trial: onTrial, paidUntil: f.expiresAt, syncStopsAt: null as string | null, daysLeft: null as number | null };
  if (!gated) return { ...base, state: 'not_on_plan', syncRefused: false };
  if (!f.expiresAt || !Number.isFinite(Date.parse(f.expiresAt))) return { ...base, paidUntil: null, state: 'no_date', syncRefused: false };
  const stops = new Date(Date.parse(f.expiresAt) + (onTrial ? 0 : GRACE_DAYS) * DAY_MS).toISOString();
  const daysLeft = daysUntil(f.expiresAt, now);
  // A569: "End trial" (web access switched off during the trial) is over at once.
  if (onTrial && f.webHosting === false) return { ...base, syncStopsAt: stops, daysLeft, state: 'ended', syncRefused: true };
  const state = ladderState(f.expiresAt, now, onTrial);
  if (state === 'none') return { ...base, syncStopsAt: stops, daysLeft, state: 'ended', syncRefused: true };
  return { ...base, syncStopsAt: stops, daysLeft, state, syncRefused: state === 'reports_only' || state === 'locked' };
}

/** The 503 a lapsed business's tills get for a write (the till keeps the record queued; 1.0.20 tells the manager). */
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

/** Does the lapse gate apply to this request? Only a till's (desktop surface) writes, never a web or KDS one, never a read. */
export function lapseGateApplies(surface: string | null | undefined, method: string, path: string): boolean {
  if (surface !== 'desktop') return false;
  if (!WRITES.has(String(method).toUpperCase())) return false;
  const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  return !OPEN_WHILE_LAPSED.some((re) => re.test(p));
}

// ── Reminders ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const REMINDER_DAYS_BEFORE = [14, 7, 3, 1] as const;
export const LAPSED_EVERY_DAYS = 7;
/** While lapsed: a reminder every 7 days, at most this many (8 weeks), then quiet. */
export const LAPSED_REMINDERS_MAX = 8;
/** Owner-side dashboard notice: the last this-many days before paid-until (and while lapsed). */
export const PLAN_NOTICE_DAYS = 14;

/**
 * The reminder due at `daysLeft` (calendar days to paid-until), or null. One per milestone: the job records each
 * (business, paid-until, milestone) once, so the same one is never sent twice, and a new paid-until starts afresh.
 *   14..8 → before_14 · 7..4 → before_7 · 3..2 → before_3 · 1 → before_1 · 0..-6 → lapse_day · -7.. → lapsed_w1..w8
 * A missed day (the cloud asleep) sends the milestone it is in, not every one it skipped.
 */
export function reminderMilestone(daysLeft: number): string | null {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft > REMINDER_DAYS_BEFORE[0]) return null;
  if (daysLeft >= 1) {
    let m: number = REMINDER_DAYS_BEFORE[0];
    for (const d of REMINDER_DAYS_BEFORE) if (daysLeft <= d) m = d;
    return `before_${m}`;
  }
  const past = -daysLeft;
  if (past < LAPSED_EVERY_DAYS) return 'lapse_day';
  const week = Math.floor(past / LAPSED_EVERY_DAYS);
  return week <= LAPSED_REMINDERS_MAX ? `lapsed_w${week}` : null;
}

/** Reminders go out in the day, Nairobi time (the job runs hourly; a milestone waits for the morning). */
export function reminderHour(now: number): boolean {
  const h = new Date(now + EAT_MS).getUTCHours();
  return h >= 7 && h < 20;
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

/** The facts for several businesses (the admin list, the reminders job). A failed read leaves them unknown — not gated. */
export async function readCloudFacts(businessIds: string[]): Promise<Map<string, CloudFacts & { plan: CloudPlanRow | null; name?: string; ownerId?: string | null; email?: string | null }>> {
  const out = new Map<string, CloudFacts & { plan: CloudPlanRow | null; name?: string; ownerId?: string | null; email?: string | null }>();
  if (!businessIds.length) return out;
  const [plans, trials, bizs, flags] = await Promise.all([
    supabase.from('cloud_plans').select('*').in('business_id', businessIds),
    supabase.from('business_settings').select('business_id, value').eq('key', CLOUD_TRIAL_KEY).in('business_id', businessIds),
    supabase.from('businesses').select('id, name, owner_id, email, status, web_access_expires_at').in('id', businessIds),
    supabase.from('feature_flags').select('business_id, enabled').eq('key', 'web_hosting').in('business_id', businessIds),
  ]);
  if (plans.error) warnOnce('cloud_plans', plans.error.message);
  const planBy = new Map(((plans.data ?? []) as CloudPlanRow[]).map((p) => [p.business_id, p]));
  const trialBy = new Map<string, CloudTrial>();
  for (const r of (trials.data ?? []) as Array<{ business_id: string; value: unknown }>) { const t = cleanTrial(r.value); if (t) trialBy.set(r.business_id, t); }
  const flagBy = new Map(((flags.data ?? []) as Array<{ business_id: string; enabled: boolean }>).map((f) => [f.business_id, f.enabled === true]));
  for (const b of (bizs.data ?? []) as Array<{ id: string; name: string; owner_id: string | null; email: string | null; status: string | null; web_access_expires_at: string | null }>) {
    out.set(b.id, {
      onPlan: planBy.has(b.id), plan: planBy.get(b.id) ?? null, trial: trialBy.get(b.id) ?? null,
      expiresAt: b.web_access_expires_at ?? null, webHosting: flagBy.has(b.id) ? flagBy.get(b.id)! : null,
      suspended: b.status === 'suspended', name: b.name, ownerId: b.owner_id, email: b.email,
    });
  }
  return out;
}

/** The ids of every business on the plan rule (a plan row or a trial record). */
export async function gatedBusinessIds(): Promise<string[]> {
  const [plans, trials] = await Promise.all([
    supabase.from('cloud_plans').select('business_id').limit(10000),
    supabase.from('business_settings').select('business_id').eq('key', CLOUD_TRIAL_KEY).limit(10000),
  ]);
  if (plans.error) warnOnce('cloud_plans', plans.error.message);
  const ids = new Set<string>();
  for (const r of [...((plans.data ?? []) as Array<{ business_id: string }>), ...((trials.data ?? []) as Array<{ business_id: string }>)]) if (r.business_id) ids.add(r.business_id);
  return [...ids];
}

/**
 * The businesses whose tills the cloud refuses now (lapsed past the grace). The watchdog and the owner's alerts leave
 * their tills out of "on but not syncing" — that is the plan's decision, not a fault. A failed read: none.
 */
export async function lapsedBusinessIds(now: number = Date.now()): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const facts = await readCloudFacts(await gatedBusinessIds());
    for (const [id, f] of facts) if (!f.suspended && cloudStanding(f, now).syncRefused) out.add(id);
  } catch (e) { console.warn('[cloud-plan] lapsed businesses not read:', (e as Error)?.message ?? e); }
  return out;
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

/** The standing for the lapse gate, remembered a minute. A failed read answers null (never refuse on a failed read). */
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

/** May a till join this business now? (enrolment code redeem, the admin's code, a branch server's join code) */
export async function enrolRefusal(businessId: string): Promise<ReturnType<typeof enrolRefusalBody> | null> {
  const s = await standingFor(businessId);
  return s && s.syncRefused ? enrolRefusalBody() : null;
}

export { TRIAL_REPORTS_ONLY_DAYS };
