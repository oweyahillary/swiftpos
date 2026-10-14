/**
 * ownerAlertsDecision.ts — A476: the owner's email settings and every "send or not" rule, pure (no database, no clock).
 *
 * Owner, 2026-10-14: "in addition to daily email reporting to the owner, I want us to add more to that, tills not
 * confirmed or closed by manager, and any other important email but the owner can turn them off. Branch manager should
 * always get an email about tills which are not closed."
 *
 * Everything lives in the report schedule (business_settings 'report_schedule', one JSON blob, Settings › Report
 * Scheduler). A key that is missing means its default — a business that saved its schedule before A476 gets every
 * section and alert ON, the weekly summary OFF.
 *
 *   readAlerts(schedule)        the switches and amounts, defaults filled in, nonsense clamped
 *   cleanReportSchedule(value)  what POST /settings stores for 'report_schedule'
 *   openTillState / selectOpenTills   which shifts count as "not closed / not confirmed"
 *   decideBranchSlot            the branch managers' always-on email: at send_time, again at 09:00 if still open
 *   decideNotSyncing            a till not syncing: once per incident, again only after it recovered
 *   bigReversals / bigVariances a big void or refund (once per void), a confirmed shift with a big cash difference
 *   decideWeeklySend            Monday 08:00 EAT, once per week
 */
import { businessDateEAT } from '../lib/businessDay';

// ── settings ─────────────────────────────────────────────────────────────────

export interface AlertSettings {
  // What the daily email includes
  open_tills: boolean;
  variances: boolean;
  voids_refunds: boolean;
  tills_not_syncing: boolean;
  expenses: boolean;
  low_stock: boolean;
  top_products: boolean;
  // Alerts as they happen
  alert_not_syncing: boolean;
  not_syncing_hours: number;
  alert_big_void: boolean;
  big_void_amount: number;
  alert_variance: boolean;
  variance_amount: number;
  // Weekly summary
  weekly_summary: boolean;
}

export const ALERT_DEFAULTS: Readonly<AlertSettings> = Object.freeze({
  open_tills: true,
  variances: true,
  voids_refunds: true,
  tills_not_syncing: true,
  expenses: true,
  low_stock: true,
  top_products: true,
  alert_not_syncing: true,
  not_syncing_hours: 4,
  alert_big_void: true,
  big_void_amount: 5000,
  alert_variance: true,
  variance_amount: 1000,
  weekly_summary: false,
});

/** The bounds an amount may take; outside them (or not a number) the default applies. */
export const ALERT_LIMITS = Object.freeze({
  not_syncing_hours: [1, 72] as const,
  big_void_amount: [1, 100_000_000] as const,
  variance_amount: [1, 100_000_000] as const,
});

const parseObj = (v: unknown): Record<string, unknown> | null => {
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }   // stored double-encoded
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
};

/** A switch: an explicit false (or "false") turns an on-by-default one off; an explicit true turns an off one on. */
const sw = (v: unknown, dflt: boolean): boolean => {
  if (v === false || v === 'false') return false;
  if (v === true || v === 'true') return true;
  return dflt;
};

const amount = (v: unknown, dflt: number, [lo, hi]: readonly [number, number]): number => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt;
  return Math.round(n * 100) / 100;
};

/** The owner's switches and amounts from the stored schedule — every missing or bad key is its default. */
export function readAlerts(schedule: unknown): AlertSettings {
  const s = parseObj(schedule) ?? {};
  const d = ALERT_DEFAULTS;
  return {
    open_tills: sw(s.open_tills, d.open_tills),
    variances: sw(s.variances, d.variances),
    voids_refunds: sw(s.voids_refunds, d.voids_refunds),
    tills_not_syncing: sw(s.tills_not_syncing, d.tills_not_syncing),
    expenses: sw(s.expenses, d.expenses),
    // low_stock is today's behaviour; the page's older checkbox (include_low_stock) still counts when low_stock is unset
    low_stock: sw(s.low_stock !== undefined ? s.low_stock : s.include_low_stock, d.low_stock),
    top_products: sw(s.include_top_products, d.top_products),
    alert_not_syncing: sw(s.alert_not_syncing, d.alert_not_syncing),
    not_syncing_hours: amount(s.not_syncing_hours, d.not_syncing_hours, ALERT_LIMITS.not_syncing_hours),
    alert_big_void: sw(s.alert_big_void, d.alert_big_void),
    big_void_amount: amount(s.big_void_amount, d.big_void_amount, ALERT_LIMITS.big_void_amount),
    alert_variance: sw(s.alert_variance, d.alert_variance),
    variance_amount: amount(s.variance_amount, d.variance_amount, ALERT_LIMITS.variance_amount),
    weekly_summary: sw(s.weekly_summary, d.weekly_summary),
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

/**
 * What POST /api/business/settings stores for 'report_schedule': the known keys only, each cleaned (a bad send time is
 * 21:00, recipients are real-looking addresses, at most 20; amounts in range). null = not a schedule at all.
 */
export function cleanReportSchedule(value: unknown): Record<string, unknown> | null {
  const s = parseObj(value);
  if (!s) return null;
  const recipients = Array.isArray(s.recipients)
    ? [...new Set(s.recipients.map((r) => String(r ?? '').trim().toLowerCase()).filter((r) => r.length <= 254 && EMAIL.test(r)))].slice(0, 20)
    : [];
  const a = readAlerts(s);
  return {
    enabled: s.enabled === true,
    send_time: typeof s.send_time === 'string' && HHMM.test(s.send_time) ? s.send_time : '21:00',
    recipients,
    include_low_stock: a.low_stock,
    include_top_products: a.top_products,
    monthly_pack: s.monthly_pack === true,
    open_tills: a.open_tills,
    variances: a.variances,
    voids_refunds: a.voids_refunds,
    tills_not_syncing: a.tills_not_syncing,
    expenses: a.expenses,
    low_stock: a.low_stock,
    alert_not_syncing: a.alert_not_syncing,
    not_syncing_hours: a.not_syncing_hours,
    alert_big_void: a.alert_big_void,
    big_void_amount: a.big_void_amount,
    alert_variance: a.alert_variance,
    variance_amount: a.variance_amount,
    weekly_summary: a.weekly_summary,
  };
}

// ── open / unconfirmed tills ─────────────────────────────────────────────────

export interface ShiftLite {
  id: string;
  branch_id: string;
  status: string;
  opened_at: string;
  closed_at?: string | null;
  business_date?: string | null;
  declared_methods?: unknown;
  confirmed_at?: string | null;
}

export type OpenTillState = 'open' | 'awaiting_confirm';

/**
 * 'open' = the drawer was never closed; 'awaiting_confirm' = the cashier closed it (declared every method, A365) and no
 * manager has confirmed the count. A forced close (closed_unreconciled) or one closed before migration 110 is neither.
 */
export function openTillState(s: ShiftLite): OpenTillState | null {
  if (s.status === 'open') return 'open';
  if (s.declared_methods != null && !s.confirmed_at) return 'awaiting_confirm';
  return null;
}

/** The business day a shift belongs to: the one the till stamped, else the EAT day it opened (with the cut-off). */
export function shiftBusinessDate(s: ShiftLite, cutoffMinutes = 0): string {
  if (s.business_date && /^\d{4}-\d{2}-\d{2}/.test(s.business_date)) return s.business_date.slice(0, 10);
  const t = Date.parse(s.opened_at);
  return Number.isFinite(t) ? businessDateEAT(new Date(t), cutoffMinutes) : '0000-00-00';
}

export interface OpenTillRow<T extends ShiftLite = ShiftLite> { shift: T; state: OpenTillState; businessDate: string; older: boolean }

/**
 * Which shifts an email lists.
 *   'report' / 'evening'  every open or unconfirmed shift — today's, and any older one still not done ("open since")
 *   'morning'             (the 09:00 repeat) only those from an earlier business day: a till opened at 08:00 this
 *                         morning is trading, not forgotten
 * Sorted: oldest first within each branch.
 */
export function selectOpenTills<T extends ShiftLite>(
  shifts: T[], reportDate: string, cutoffMinutes = 0, slot: 'report' | 'evening' | 'morning' = 'report',
): OpenTillRow<T>[] {
  const out: OpenTillRow<T>[] = [];
  const seen = new Set<string>();
  for (const s of shifts) {
    if (!s || seen.has(s.id)) continue;
    const state = openTillState(s);
    if (!state) continue;
    const businessDate = shiftBusinessDate(s, cutoffMinutes);
    const older = businessDate < reportDate;
    if (slot === 'morning' && !older) continue;
    seen.add(s.id);
    out.push({ shift: s, state, businessDate, older });
  }
  return out.sort((a, b) => (a.shift.branch_id < b.shift.branch_id ? -1 : a.shift.branch_id > b.shift.branch_id ? 1 : 0)
    || String(a.shift.opened_at).localeCompare(String(b.shift.opened_at)));
}

// ── the branch managers' always-on email ─────────────────────────────────────

export const MORNING_REPEAT = '09:00';

const toMin = (s: string): number => {
  const m = HHMM.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

export type BranchSlot = 'evening' | 'morning';

/**
 * Which slot is due now for a branch, or null. Two slots a day: the business's send_time ('evening', default 21:00)
 * and 09:00 ('morning'). The latest slot whose time has passed today is the current one; it is due unless it was the
 * last stamped (`<date>:<slot>`). Not switchable, and independent of the owner's daily report being on.
 */
export function decideBranchSlot(
  nowEatDate: string, nowEatHHMM: string, sendTime: string | null | undefined, lastSent: string | null,
): { slot: BranchSlot; stamp: string } | null {
  const now = toMin(nowEatHHMM);
  if (now < 0) return null;
  const evening = toMin(sendTime ?? '') >= 0 ? toMin(sendTime as string) : toMin('21:00');
  const morning = toMin(MORNING_REPEAT);
  const passed: { slot: BranchSlot; at: number }[] = [];
  if (evening <= now) passed.push({ slot: 'evening', at: evening });
  if (morning <= now && morning !== evening) passed.push({ slot: 'morning', at: morning });
  if (!passed.length) return null;
  const current = passed.sort((a, b) => b.at - a.at)[0];
  const stamp = `${nowEatDate}:${current.slot}`;
  return lastSent === stamp ? null : { slot: current.slot, stamp };
}

// ── alert: a till not syncing ────────────────────────────────────────────────

export interface DeviceLite {
  id: string;
  device_id?: string | null;
  branch_id?: string | null;
  status?: string | null;
  retired_at?: string | null;
  last_seen_at?: string | null;
  last_sync_at?: string | null;
  session_lost_at?: string | null;
  /** A477 (migration 131): another computer seems to hold this till's data. */
  security_alert_at?: string | null;
}

/**
 * A477: a till's sign-in used from another computer — once per incident (`security:<device row>:<when>` in the alert
 * state's `sent`), and only an incident within the look-back (the `sent` memory is kept 7 days, longer than that).
 */
export function decideSecurityAlert(d: DeviceLite, sent: Record<string, string>, now: Date, lookbackMs = 48 * 3_600_000): { send: boolean; key: string | null } {
  if (!d.security_alert_at) return { send: false, key: null };
  const at = Date.parse(d.security_alert_at);
  if (!Number.isFinite(at) || now.getTime() - at > lookbackMs) return { send: false, key: null };
  const key = `security:${d.id}:${d.security_alert_at}`;
  return { send: !sent[key], key };
}

const hoursSince = (now: Date, iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (now.getTime() - t) / 3_600_000 : null;
};

/**
 * Is the till's branch trading now? The branch has a drawer open in the cloud, or this till itself was seen after its
 * last sync within the hour (it is on and talking, but its sales are not arriving).
 */
export function tillTrading(d: DeviceLite, branchesWithOpenShift: Set<string>, now: Date): boolean {
  if (d.branch_id && branchesWithOpenShift.has(d.branch_id)) return true;
  const seen = hoursSince(now, d.last_seen_at);
  const sync = d.last_sync_at ? Date.parse(d.last_sync_at) : 0;
  return seen !== null && seen <= 1 && Date.parse(d.last_seen_at as string) > sync;
}

export interface NotSyncingDecision {
  send: boolean;
  kind: 'stale' | 'refused' | null;
  hours: number | null;          // hours since the last sync (stale)
  next: string | null;           // the incident to remember (null = cleared: recovered)
}

/**
 * Once per incident. An incident is 'refused:<session_lost_at>' (the cloud refused its sign-in and it could not sign
 * back in — needs rejoin) or 'stale:<last_sync_at>' (not synced for `hours` while its branch trades). It is remembered
 * until the till recovers (synced within the threshold, not refused); a new incident after that alerts again.
 */
export function decideNotSyncing(
  d: DeviceLite, now: Date, thresholdHours: number, trading: boolean, prev: string | null | undefined,
): NotSyncingDecision {
  const keep = prev ?? null;
  if (d.status && d.status !== 'approved') return { send: false, kind: null, hours: null, next: null };
  if (d.retired_at) return { send: false, kind: null, hours: null, next: null };
  const stale = hoursSince(now, d.last_sync_at);
  if (d.session_lost_at) {
    const key = `refused:${d.session_lost_at}`;
    return { send: keep !== key, kind: 'refused', hours: stale, next: key };
  }
  if (stale === null) return { send: false, kind: null, hours: null, next: keep };   // never synced: a new till
  if (stale >= thresholdHours) {
    if (!trading) return { send: false, kind: null, hours: stale, next: keep };      // closed for the night: wait
    const key = `stale:${d.last_sync_at}`;
    return { send: keep !== key, kind: 'stale', hours: stale, next: key };
  }
  return { send: false, kind: null, hours: stale, next: null };                         // recovered
}

// ── alert: a big void / refund, a big variance ───────────────────────────────

export interface ReversalLite { id: string; kind: 'void' | 'refund'; amount: number }

/** Voids / refunds at or above the amount that were not alerted before (key `void:<id>` / `refund:<id>`). */
export function bigReversals<T extends ReversalLite>(rows: T[], threshold: number, alerted: Record<string, string>): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key) || alerted[key]) return false;
    seen.add(key);
    return Number(r.amount) >= threshold;
  });
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const methodCash = (v: unknown): number | null => {
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  return num((o as Record<string, unknown>).cash);
};

export interface VarianceShiftLite {
  id: string;
  confirmed_at?: string | null;
  expected_methods?: unknown;
  confirmed_methods?: unknown;
  cash_variance?: unknown;
}

/** Counted − expected cash for a confirmed shift (the manager's count, A365); the till's cash_variance when unknown. */
export function cashDifference(s: VarianceShiftLite): number | null {
  const counted = methodCash(s.confirmed_methods), expected = methodCash(s.expected_methods);
  if (counted !== null && expected !== null) return Math.round((counted - expected) * 100) / 100;
  return num(s.cash_variance);
}

/** Confirmed shifts with |cash difference| ≥ the amount, not alerted before (key `shift:<id>`). */
export function bigVariances<T extends VarianceShiftLite>(shifts: T[], threshold: number, alerted: Record<string, string>): Array<T & { difference: number }> {
  const out: Array<T & { difference: number }> = [];
  const seen = new Set<string>();
  for (const s of shifts) {
    const key = `shift:${s.id}`;
    if (!s.confirmed_at || seen.has(key) || alerted[key]) continue;
    seen.add(key);
    const diff = cashDifference(s);
    if (diff !== null && Math.abs(diff) >= threshold) out.push({ ...s, difference: diff });
  }
  return out;
}

// ── what the alert job remembers ─────────────────────────────────────────────

export interface AlertState {
  /** device row id → the incident alerted ('stale:…' / 'refused:…') */
  not_syncing: Record<string, string>;
  /** 'void:<id>' / 'refund:<id>' / 'shift:<id>' → when it was alerted (ISO) */
  sent: Record<string, string>;
  /** false until the first run recorded what was already there — switching A476 on does not email two days of old voids */
  seeded: boolean;
}

export function readAlertState(raw: unknown): AlertState {
  const o = parseObj(raw) ?? {};
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') out[k] = x;
    }
    return out;
  };
  return { not_syncing: strMap(o.not_syncing), sent: strMap(o.sent), seeded: o.seeded === true };
}

/** Forget alerted voids / shifts after `days` (the job looks back 2 days, so 7 can never re-alert one). */
export function pruneSent(sent: Record<string, string>, now: Date, days = 7): Record<string, string> {
  const cut = now.getTime() - days * 86_400_000;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sent)) { const t = Date.parse(v); if (Number.isFinite(t) && t >= cut) out[k] = v; }
  return out;
}

// ── the weekly summary ───────────────────────────────────────────────────────

const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export interface WeekPlan { stamp: string; thisFrom: string; thisTo: string; prevFrom: string; prevTo: string }

/**
 * Monday from 08:00 EAT, once per week (stamped with that Monday's date): last week (Mon–Sun) against the week before.
 * Only when the owner switched it on.
 */
export function decideWeeklySend(enabled: boolean, nowEatDate: string, nowEatHHMM: string, lastSent: string | null): WeekPlan | null {
  if (!enabled) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nowEatDate)) return null;
  const [y, m, d] = nowEatDate.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 1) return null;   // Monday
  if (toMin(nowEatHHMM) < toMin('08:00')) return null;
  if (lastSent === nowEatDate) return null;
  return {
    stamp: nowEatDate,
    thisFrom: addDays(nowEatDate, -7), thisTo: addDays(nowEatDate, -1),
    prevFrom: addDays(nowEatDate, -14), prevTo: addDays(nowEatDate, -8),
  };
}
