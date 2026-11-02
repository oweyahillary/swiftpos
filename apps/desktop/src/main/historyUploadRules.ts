/**
 * historyUploadRules.ts — A602: the pure rules of "going online later" (historyUpload.ts has the story and the storage).
 * No database, no Electron: the tests run them as they are.
 */

/** How far back the history goes up (the owner's choice). Older sales stay on this PC only (sync_queue 'local_only'). */
export type HistoryWindow = '3m' | '12m' | 'all';
export const HISTORY_WINDOWS: readonly HistoryWindow[] = ['3m', '12m', 'all'];
export const HISTORY_WINDOW_LABEL: Record<HistoryWindow, string> = { '3m': 'the last 3 months', '12m': 'the last 12 months', all: 'everything' };

export interface HistorySettings {
  window: HistoryWindow;
  /** Quiet hours, this PC's local time, 'HH:MM'. From after To wraps past midnight (22:00–06:00). Equal: no window. */
  quietFrom: string;
  quietTo: string;
}
export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { window: '3m', quietFrom: '22:00', quietTo: '06:00' };

/** New sales first: while the history goes up, the normal push sends only what was sold in the last 48 hours. */
export const NEW_FIRST_MS = 48 * 3_600_000;
/** A queue this long (pending sales) is a backlog even without a cut-off: new first, the rest by the backfill. */
export const BACKLOG_THRESHOLD = 500;
/** Sales per backfill call (the cloud takes at most this many — apps/server/src/lib/backfill.ts). */
export const BATCH_MAX = 500;
/** The POS idle this long (no key, no sale) counts as quiet at any hour. */
export const IDLE_MS = 10 * 60_000;
/** Its own rate: a pause between two calls. */
export const BATCH_GAP_MS = 4_000;
/** At most this long of uploading inside one sync pass (the pass is single-flight: a sale's own push waits behind it). */
export const PASS_BUDGET_MS = 25_000;
/** A batch whose JSON would pass this is halved (the cloud's limit is 12 MB inflated). */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
/** A sale whose drawer the cloud did not have (424) is not offered again for this long. */
export const DRAWER_WAIT_RETRY_MS = 15 * 60_000;
/** The call's own time limit (the cloud stops starting sales after 40 s; a branch server's gateway waits 60 s). */
export const BACKFILL_TIMEOUT_MS = 90_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 'HH:MM' → minutes after midnight, or null. Pure. */
export function minutesOf(s: unknown): number | null {
  const m = typeof s === 'string' ? HHMM.exec(s.trim()) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The settings as stored or sent, with anything unusable replaced by the default. Pure. */
export function cleanHistorySettings(v: unknown, base: HistorySettings = DEFAULT_HISTORY_SETTINGS): HistorySettings {
  const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  const window = HISTORY_WINDOWS.includes(o.window as HistoryWindow) ? o.window as HistoryWindow : base.window;
  const quietFrom = minutesOf(o.quietFrom) !== null ? String(o.quietFrom).trim() : base.quietFrom;
  const quietTo = minutesOf(o.quietTo) !== null ? String(o.quietTo).trim() : base.quietTo;
  return { window, quietFrom, quietTo };
}

/** Is `now` (this PC's local time) inside the quiet hours? From > To wraps past midnight; From = To: never. Pure. */
export function inQuietWindow(now: Date, from: string, to: string): boolean {
  const f = minutesOf(from), t = minutesOf(to);
  if (f === null || t === null || f === t) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return f < t ? m >= f && m < t : m >= f || m < t;
}

/**
 * May the history upload send a batch now? Pure.
 *   - never while a sale is under way (the cart has items, the payment screen is open, a print is queued): it pauses at once
 *   - in the owner's quiet hours, or
 *   - when nobody has used this POS for IDLE_MS (a key, a click, a sale)
 */
export function quietVerdict(o: { now: number; settings: HistorySettings; lastUse: number; busy: string | null }): { go: boolean; why: string } {
  const hours = `${o.settings.quietFrom}–${o.settings.quietTo}`;
  if (o.busy) return { go: false, why: `paused: ${o.busy}` };
  if (inQuietWindow(new Date(o.now), o.settings.quietFrom, o.settings.quietTo)) return { go: true, why: `in quiet hours (${hours})` };
  const idle = Math.max(0, o.now - (o.lastUse || 0));
  if (idle >= IDLE_MS) return { go: true, why: `the POS has been idle ${Math.floor(idle / 60_000)} min` };
  return { go: false, why: `waits for quiet hours (${hours}) or 10 minutes without use` };
}

/** The oldest sale the owner's window keeps sending (ISO), or null for everything. Calendar months, this PC's time. Pure. */
export function windowStart(window: HistoryWindow, now: number): string | null {
  if (window === 'all') return null;
  const d = new Date(now);
  d.setMonth(d.getMonth() - (window === '12m' ? 12 : 3));
  return d.toISOString();
}

export interface CashTablesLike<T = any> { business_days: T[]; shifts: T[]; floats: T[]; expenses: T[]; kitchen_voids: T[] }
const at = (v: unknown): number => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : Number.NaN; };

/**
 * New first, with what each record needs: the drawers and days the normal push may send while the history waits. Held for
 * the backfill (it sends them with their sales): a CLOSED drawer that closed before `cutoff`, its floats, expenses and
 * kitchen voids (unless a sale the normal push sends now is in it), and a closed day from before `cutoff` that no drawer
 * being sent belongs to. Everything else goes as
 * before — an open drawer always (a sale rung now needs it on the cloud), a day a drawer being sent belongs to always
 * (the cloud refuses a drawer whose day it does not have). Pure.
 */
export function splitRecentCash<T extends Record<string, any>>(t: CashTablesLike<T>, cutoff: string, keepShiftIds: Iterable<string> = []): { send: CashTablesLike<T>; held: CashTablesLike<T> } {
  const c = at(cutoff);
  const keep = new Set([...keepShiftIds].map(String));   // the drawers of sales the normal push sends now (a clock's odd edge)
  const oldShift = (s: T) => s.status !== 'open' && at(s.closed_at ?? s.opened_at) < c && !keep.has(String(s.id));
  const heldShifts = t.shifts.filter(oldShift);
  const heldIds = new Set(heldShifts.map((s) => String(s.id)));
  const sendShifts = t.shifts.filter((s) => !heldIds.has(String(s.id)));
  const neededDays = new Set(sendShifts.map((s) => String(s.business_day_id ?? '')).filter(Boolean));
  const oldDay = (d: T) => d.status === 'closed' && at(d.closed_at ?? d.opened_at) < c && !neededDays.has(String(d.id));
  const ofHeld = (r: T) => !!r.shift_id && heldIds.has(String(r.shift_id));
  return {
    send: { business_days: t.business_days.filter((d) => !oldDay(d)), shifts: sendShifts,
      floats: t.floats.filter((r) => !ofHeld(r)), expenses: t.expenses.filter((r) => !ofHeld(r)), kitchen_voids: t.kitchen_voids.filter((r) => !ofHeld(r)) },
    held: { business_days: t.business_days.filter(oldDay), shifts: heldShifts,
      floats: t.floats.filter(ofHeld), expenses: t.expenses.filter(ofHeld), kitchen_voids: t.kitchen_voids.filter(ofHeld) },
  };
}

/**
 * The cash rows one batch of sales needs: their drawers (pending), the days of those drawers (pending), and those drawers'
 * floats, expenses and kitchen voids (pending). Pure.
 */
export function cashForShifts<T extends Record<string, any>>(t: CashTablesLike<T>, shiftIds: Iterable<string>): CashTablesLike<T> {
  const ids = new Set([...shiftIds].map(String));
  const shifts = t.shifts.filter((s) => ids.has(String(s.id)));
  const days = new Set(shifts.map((s) => String(s.business_day_id ?? '')).filter(Boolean));
  const mine = (r: T) => !!r.shift_id && ids.has(String(r.shift_id));
  return { business_days: t.business_days.filter((d) => days.has(String(d.id))), shifts,
    floats: t.floats.filter(mine), expenses: t.expenses.filter(mine), kitchen_voids: t.kitchen_voids.filter(mine) };
}

/** "45% (12,300 of 27,000 sales)". Pure. */
export function progressLabel(done: number, remaining: number): { percent: number; text: string } {
  const total = Math.max(0, done) + Math.max(0, remaining);
  const percent = total > 0 ? Math.floor((Math.max(0, done) / total) * 100) : 100;
  const n = (x: number) => Math.max(0, Math.round(x)).toLocaleString('en-US');
  return { percent, text: `${percent}% (${n(done)} of ${n(total)} sales)` };
}
