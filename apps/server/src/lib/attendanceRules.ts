/**
 * attendanceRules.ts — A599 (Attendance, premium): the pure rules behind /api/attendance. No database here, so the tests
 * run every rule directly.
 *
 * Owner, 2026-10-27/28: attendance comes ONLY from a ZKTeco device (first model the K90 Pro) — for everyone, cashiers,
 * managers and the attendance-only people (cooks, cleaners, guards) alike. Fingerprints never leave the device; the cloud
 * keeps who, when and which device. Premium: the per-business feature flag 'attendance', set by ZapTill in the admin portal
 * only; off → nothing attendance-related anywhere and every route 403 ATTENDANCE_OFF.
 *
 * THE PAIRING RULE (the device's in / out status is not trusted — people press the wrong key, or none):
 *   1. A person's punches (device punches, PIN clock events kept from before, and manager corrections; voided ones left
 *      out) are put in time order.
 *   2. A punch within DOUBLE_TAP_S (2 minutes) of the previous one is a double tap and ignored for the pairing (still
 *      listed for the day).
 *   3. A616 (owner, 2026-10-31, from a real ZKTeco export): the punches are grouped into WORK DAYS first, then paired
 *      within each day alone — so one forgotten punch never shifts the following days (before, the pairing ran across
 *      days: one missed punch-out paired 18:31 with the next morning's 08:21 and every day after went wrong).
 *      A work day starts at DAY_START_MIN (06:00: a punch 00:00-05:59 is the night before's punch-out), or 6 h before
 *      the person's pinned shift (nights 18:00 → noon), or — not pinned — at whichever of 06:00, noon and 6 h before
 *      each of their branch's shifts their punches fit best (chooseDayStart). The sales day cut-off plays no part.
 *   4. Within a day, alternately: the first is an IN, the next an OUT, … An odd last punch is a MISSING PUNCH-OUT:
 *      flagged, not counted.
 *   5. A night shift 22:00 → 06:00 is one shift of the day it started.
 *   6. Per person per work day: first in, last out, worked = the sum of the paired intervals, missing punch-outs
 *      flagged. A pair over LONG_SHIFT_HOURS (12 h) is flagged "check".
 *   7. A616 shifts (per branch, migration 184): the day's shift is the person's pinned one, else the one starting
 *      nearest their first punch; LATE when the first punch is more than the shift's grace after its start (minutes
 *      counted from the start).
 * Hours are rounded to 2 dp for display; minutes are kept whole for sums.
 *
 * THE DEVICE NUMBER (attendance_no): one per person, unique per BUSINESS (a person may punch at another branch's device
 * and stays the same person); the system suggests the smallest free number (nextFreeNumber). A number stays with its
 * person once given (a deactivated person keeps it, so their history keeps its name).
 */

export const ATTENDANCE_FLAG = 'attendance';
export const ATTENDANCE_OFF_MESSAGE = 'Attendance is part of ZapTill Premium — contact ZapTill to enable it.';
/** POST /api/staff/clock while the flag is on: punches come from the device only. */
export const CLOCK_BY_DEVICE_MESSAGE = 'Clocking in and out is done on the attendance device for this business.';

export const DOUBLE_TAP_S = 120;
export const MAX_SHIFT_HOURS = 16;
export const LONG_SHIFT_HOURS = 12;
/** A616: a work day starts at 06:00 by default (owner: a punch 00:00-05:59 belongs to the night before). */
export const DAY_START_MIN = 360;
/** A616: a pinned shift's work day starts this long before the shift. */
export const DAY_BEFORE_SHIFT_MIN = 360;
export const MAX_RANGE_DAYS = 93;
export const MAX_ATTENDANCE_NO = 999_999_999;
/** The most punches one ingest call may carry (the branch server sends more in further calls). */
export const INGEST_MAX = 500;
/** A punch more than this far in the future (the device's clock badly wrong) is refused, not stored. */
export const FUTURE_SLACK_MS = 10 * 60_000;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const EAT_MS = 3 * 60 * MIN_MS;

// ── Business day ──────────────────────────────────────────────────────────────────────────────────────────────────

function cleanCut(m: unknown): number {
  const n = Number(m);
  return Number.isFinite(n) && n >= 0 && n <= 360 ? Math.round(n) : 0;
}
/** The business date (YYYY-MM-DD, East Africa Time) of a moment, with the owner's cut-off — as lib/businessDay.ts. */
export function businessDate(at: string | number | Date, cutoffMinutes = 0): string {
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  return new Date(t + EAT_MS - cleanCut(cutoffMinutes) * MIN_MS).toISOString().slice(0, 10);
}
/** The clock time HH:MM in East Africa Time. */
export function eatTime(at: string | number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  return new Date(t + EAT_MS).toISOString().slice(11, 16);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dayNumber(s: string): number | null {
  if (!ISO_DATE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}
/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const a = dayNumber(from), b = dayNumber(to);
  if (a === null || b === null || b < a) return [];
  const out: string[] = [];
  for (let d = a; d <= b; d++) out.push(new Date(d * DAY_MS).toISOString().slice(0, 10));
  return out;
}
/** Why a requested period is refused (400), or null. At most MAX_RANGE_DAYS days, from on or before to. */
export function rangeError(from: unknown, to: unknown): { error: string; code: string } | null {
  const a = typeof from === 'string' ? dayNumber(from) : null, b = typeof to === 'string' ? dayNumber(to) : null;
  if (a === null || b === null) return { error: 'from and to must be dates (YYYY-MM-DD).', code: 'BAD_RANGE' };
  if (b < a) return { error: 'from must be on or before to.', code: 'BAD_RANGE' };
  if (b - a + 1 > MAX_RANGE_DAYS) return { error: `Choose a period of at most ${MAX_RANGE_DAYS} days.`, code: 'RANGE_TOO_LONG' };
  return null;
}

// ── Pairing ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Punch {
  id: string;
  /** ISO instant. */
  at: string;
  source?: string | null;
  /** A correction's reason (source 'correction'). */
  reason?: string | null;
}
export interface Shift { in: string; out: string | null; minutes: number; long: boolean; inId: string; outId: string | null }
/** A branch's work shift (migration 184): start / end in minutes after midnight (end <= start: past midnight). */
export interface WorkShift { id: string; name: string; start_min: number; end_min: number; grace_min: number }
export interface DayShift { id: string; name: string; start_min: number; end_min: number }
export interface DayResult {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  minutes: number;
  hours: number;
  shifts: Shift[];
  /** An IN without a punch-out (rule 4): flagged, not counted. */
  missingOut: boolean;
  long: boolean;
  punches: number;
  doubleTaps: number;
  /** A616: the work shift of the day (the pinned one, else the one starting nearest the first punch); null without shifts. */
  shift?: DayShift | null;
  /** A616: minutes after the shift's start of the first punch, when beyond its grace; 0 = on time. */
  lateMin?: number;
}
export interface PairOptions {
  /** The person's branch's active shifts. */
  shifts?: readonly WorkShift[];
  /** The shift pinned to the person (attendance_people.shift_id). */
  pinned?: WorkShift | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MIN = 1440;
const wrap = (m: number) => ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
/** The work date of a moment for a work day starting `dayStart` minutes after midnight (East Africa Time). */
export function workDate(at: string | number, dayStart: number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  return new Date(t + EAT_MS - wrap(dayStart) * MIN_MS).toISOString().slice(0, 10);
}
/** Minutes after midnight, East Africa Time. */
const clockMin = (at: string | number) => { const t = typeof at === 'number' ? at : Date.parse(at); return Math.floor(wrap((t + EAT_MS) / MIN_MS)); };
/** a − b on the 24 h clock, in (−720, 720]. */
export function clockDiff(a: number, b: number): number { const d = wrap(a - b); return d > DAY_MIN / 2 ? d - DAY_MIN : d; }
/** A shift's work day starts DAY_BEFORE_SHIFT_MIN before it: 09:00 → 03:00, 18:00 (nights) → 12:00. */
export const dayStartOf = (s: Pick<WorkShift, 'start_min'>): number => wrap(s.start_min - DAY_BEFORE_SHIFT_MIN);
/** The shift starting nearest a clock time (ties: the earlier start). */
export function nearestShift<S extends Pick<WorkShift, 'start_min'>>(shifts: readonly S[], minute: number): S | null {
  let best: S | null = null, gap = Infinity;
  for (const s of [...shifts].sort((a, b) => a.start_min - b.start_min)) { const g = Math.abs(clockDiff(minute, s.start_min)); if (g < gap) { best = s; gap = g; } }
  return best;
}

const sortPunches = (punches: readonly Punch[]) =>
  [...punches].filter((p) => Number.isFinite(Date.parse(p.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));

function pairByDay(sorted: readonly Punch[], dayStart: number): Map<string, DayResult> {
  const days = new Map<string, DayResult>();
  const day = (date: string): DayResult => {
    let d = days.get(date);
    if (!d) { d = { date, firstIn: null, lastOut: null, minutes: 0, hours: 0, shifts: [], missingOut: false, long: false, punches: 0, doubleTaps: 0 }; days.set(date, d); }
    return d;
  };
  const kept = new Map<string, Punch[]>();
  let last = -Infinity;
  for (const p of sorted) {
    const t = Date.parse(p.at);
    const d = day(workDate(t, dayStart));
    d.punches++;
    if (t - last < DOUBLE_TAP_S * 1000) { d.doubleTaps++; last = t; continue; }
    last = t;
    (kept.get(d.date) ?? kept.set(d.date, []).get(d.date)!).push(p);
  }
  for (const [date, list] of kept) {
    const d = days.get(date)!;
    for (let i = 0; i < list.length; i += 2) {
      const a = list[i], b = list[i + 1];
      if (!b) { d.shifts.push({ in: a.at, out: null, minutes: 0, long: false, inId: a.id, outId: null }); d.missingOut = true; continue; }
      const minutes = Math.round((Date.parse(b.at) - Date.parse(a.at)) / MIN_MS);
      const long = minutes > LONG_SHIFT_HOURS * 60;
      d.shifts.push({ in: a.at, out: b.at, minutes, long, inId: a.id, outId: b.id });
      d.minutes += minutes;
      if (long) d.long = true;
    }
  }
  for (const d of days.values()) {
    const ins = d.shifts.map((s) => s.in).sort();
    const outs = d.shifts.map((s) => s.out).filter((x): x is string => !!x).sort();
    d.firstIn = ins[0] ?? null;
    d.lastOut = outs[outs.length - 1] ?? null;
    d.hours = r2(d.minutes / 60);
  }
  return days;
}

/** A pair is long beyond 12 h, or beyond its shift's length + 2 h when that is more (a 12 h night guard is not "long"). */
const longAfter = (s?: Pick<WorkShift, 'start_min' | 'end_min'> | null) => Math.max(LONG_SHIFT_HOURS * 60, s ? shiftLength(s) + 120 : 0);

/** How badly a grouping fits: a missing punch-out 240, a long pair 600, a first punch's distance to the nearest shift start (≤ 360). */
function misfit(days: Map<string, DayResult>, shifts: readonly WorkShift[]): number {
  const longest = shifts.reduce((m, s) => Math.max(m, longAfter(s)), longAfter(null));
  let cost = 0;
  for (const d of days.values()) {
    if (d.missingOut) cost += 240;
    cost += 600 * d.shifts.filter((s) => s.minutes > longest).length;
    if (shifts.length && d.firstIn) cost += Math.min(Math.abs(clockDiff(clockMin(d.firstIn), nearestShift(shifts, clockMin(d.firstIn))!.start_min)), 360);
  }
  return cost;
}

/**
 * When a person's work day starts (minutes after midnight): their pinned shift's start less 6 h; else, of 06:00 (the
 * owner's rule: 00:00-05:59 is the night before), noon, and 6 h before each of their branch's shifts, the one their punches
 * fit best (misfit; ties: that order). So a night guard 18:00 → 06:10 pairs without being pinned.
 */
export function chooseDayStart(punches: readonly Punch[], opts: PairOptions = {}): number {
  if (opts.pinned) return dayStartOf(opts.pinned);
  const shifts = opts.shifts ?? [];
  const sorted = sortPunches(punches);
  const candidates = [...new Set([DAY_START_MIN, 720, ...shifts.map(dayStartOf)])];
  let best = DAY_START_MIN, bestCost = Infinity;
  for (const c of candidates) { const cost = misfit(pairByDay(sorted, c), shifts); if (cost < bestCost) { best = c; bestCost = cost; } }
  return best;
}

/** The day's shift and lateness (A616): the pinned shift, else the one starting nearest the first punch. */
export function shiftOfDay(firstIn: string | null, opts: PairOptions = {}): { shift: DayShift | null; lateMin: number } {
  if (!firstIn) return { shift: null, lateMin: 0 };
  const s = opts.pinned ?? nearestShift(opts.shifts ?? [], clockMin(firstIn));
  if (!s) return { shift: null, lateMin: 0 };
  const late = clockDiff(clockMin(firstIn), s.start_min);
  return { shift: { id: s.id, name: s.name, start_min: s.start_min, end_min: s.end_min }, lateMin: late > s.grace_min ? late : 0 };
}

/**
 * One person's punches → their shifts by work day (the rule above). Punches may arrive in any order; voided ones must
 * already be left out. Returns a map date → day (only days that have a punch), and the work day's start used.
 */
export function pairWorkDays(punches: readonly Punch[], opts: PairOptions = {}): { days: Map<string, DayResult>; dayStart: number } {
  const dayStart = chooseDayStart(punches, opts);
  const days = pairByDay(sortPunches(punches), dayStart);
  if (opts.pinned || opts.shifts?.length) {
    for (const d of days.values()) {
      const s = shiftOfDay(d.firstIn, opts);
      d.shift = s.shift; d.lateMin = s.lateMin;
      for (const x of d.shifts) x.long = x.minutes > longAfter(s.shift);
      d.long = d.shifts.some((x) => x.long);
    }
  }
  return { days, dayStart };
}
export const pairPunches = (punches: readonly Punch[], opts: PairOptions = {}): Map<string, DayResult> => pairWorkDays(punches, opts).days;

// ── A person's period ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Correction {
  id: string;
  kind: 'added' | 'moved' | 'removed';
  at: string | null;
  was: string | null;
  reason: string;
  by: string | null;
  byName: string | null;
  when: string;
}
export interface PersonDay extends DayResult { corrections: Correction[] }
export interface PersonTotals { minutes: number; hours: number; daysWorked: number; avgHours: number; missedOuts: number; corrections: number; longShifts: number; lateDays: number; lateMinutes: number }
export interface PersonPeriod { days: PersonDay[]; totals: PersonTotals; dayStart: number }

/**
 * The days of [from, to] for one person — every work day in the period. `punches` should start a day before the period
 * (so an OUT just after it is not read as an IN) and end a day after it.
 */
export function personPeriod(punches: readonly Punch[], from: string, to: string, opts: PairOptions = {}, corrections: readonly Correction[] = []): PersonPeriod {
  const { days: all, dayStart } = pairWorkDays(punches, opts);
  const days: PersonDay[] = [];
  for (const [date, d] of [...all.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (date < from || date > to) continue;
    days.push({ ...d, corrections: [] });
  }
  for (const c of corrections) {
    const at = c.at ?? c.was;
    if (!at) continue;
    const date = workDate(at, dayStart);
    if (date < from || date > to) continue;
    let d = days.find((x) => x.date === date);
    if (!d) {
      d = { date, firstIn: null, lastOut: null, minutes: 0, hours: 0, shifts: [], missingOut: false, long: false, punches: 0, doubleTaps: 0, corrections: [] };
      days.push(d); days.sort((a, b) => a.date.localeCompare(b.date));
    }
    d.corrections.push(c);
  }
  const minutes = days.reduce((s, d) => s + d.minutes, 0);
  const worked = days.filter((d) => d.minutes > 0).length;
  const late = days.filter((d) => (d.lateMin ?? 0) > 0);
  return {
    days,
    dayStart,
    totals: {
      minutes, hours: r2(minutes / 60), daysWorked: worked, avgHours: worked ? r2(minutes / 60 / worked) : 0,
      missedOuts: days.reduce((s, d) => s + d.shifts.filter((x) => !x.out).length, 0),
      corrections: days.reduce((s, d) => s + d.corrections.length, 0),
      longShifts: days.reduce((s, d) => s + d.shifts.filter((x) => x.long).length, 0),
      lateDays: late.length, lateMinutes: late.reduce((s, d) => s + (d.lateMin ?? 0), 0),
    },
  };
}

// ── Shifts (A616) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** "09:00" / "9:05" / 540 → minutes after midnight (0 … 1439); "24:00" is 00:00. Else null. */
export function clockMinutes(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < DAY_MIN ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h === 24 && mi === 0) return 0;
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
/** Minutes after midnight → "HH:MM". */
export const clockText = (m: number) => `${String(Math.floor(wrap(m) / 60)).padStart(2, '0')}:${String(wrap(m) % 60).padStart(2, '0')}`;
/** A shift's length in minutes (an end at or before the start runs past midnight). */
export const shiftLength = (s: Pick<WorkShift, 'start_min' | 'end_min'>) => wrap(s.end_min - s.start_min) || DAY_MIN;
/**
 * A shift as sent ({ name, start, end, grace? } — times "HH:MM" or minutes), checked: a name of 1-40 characters, start and
 * end clock times, at most 16 h long, grace 0-120 minutes (default 10). Returns the reason it is refused instead.
 */
export function cleanShift(raw: unknown): { name: string; start_min: number; end_min: number; grace_min: number } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'A shift needs a name, a start and an end.' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > 40) return { error: 'A shift name is 1-40 characters.' };
  const start = clockMinutes(r.start ?? r.start_min), end = clockMinutes(r.end ?? r.end_min);
  if (start === null || end === null) return { error: 'Start and end are times like 09:00.' };
  if (start === end) return { error: 'A shift cannot start and end at the same time.' };
  if (shiftLength({ start_min: start, end_min: end }) > MAX_SHIFT_HOURS * 60) return { error: `A shift is at most ${MAX_SHIFT_HOURS} hours.` };
  const g = r.grace ?? r.grace_min;
  const grace = g === undefined || g === null || g === '' ? 10 : Number(g);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120) return { error: 'Grace is 0-120 minutes.' };
  return { name, start_min: start, end_min: end, grace_min: grace };
}

/** Estimated pay: hours × the hourly rate, 2 dp — null without a rate. */
export function estimatePay(hours: number, rate: unknown): number | null {
  const r = Number(rate);
  if (rate === null || rate === undefined || !Number.isFinite(r) || r <= 0) return null;
  return r2(hours * r);
}

// ── Device numbers ────────────────────────────────────────────────────────────────────────────────────────────────

/** The smallest whole number ≥ 1 nobody has. */
export function nextFreeNumber(taken: Iterable<number | string | null | undefined>): number {
  const used = new Set<number>();
  for (const t of taken) { const n = Number(t); if (Number.isInteger(n) && n > 0) used.add(n); }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
/** A device number as stored (1 … 999,999,999), or null when it is not one. Accepts "0012" (a device's own form). */
export function cleanAttendanceNo(v: unknown): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_ATTENDANCE_NO ? n : null;
}
/** A person's name as the cloud keeps it: trimmed, inner spaces single, 1–60 characters; null when empty. */
export function cleanPersonName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s && s.length <= 60 ? s : null;
}
/** The name written to the device: its user record holds 24 bytes (one kept for the end), plain letters kept. */
export function deviceName(name: string): string {
  let out = '';
  for (const ch of name) { if (Buffer.byteLength(out + ch, 'utf8') > 23) break; out += ch; }
  return out;
}

// ── Ingest (the branch server's batch) ────────────────────────────────────────────────────────────────────────────

export interface IncomingPunch { device_user_id: string; at: string; status: number | null; punch: number | null; uid: number | null }
/**
 * One punch of the branch server's batch, checked: the device's user id (what a person types on the device — digits),
 * a time that parses and is not in the future (beyond FUTURE_SLACK_MS), the device's status / punch / uid as small
 * whole numbers or null. Returns the reason it is refused instead.
 */
export function cleanIncomingPunch(raw: unknown, now = Date.now()): IncomingPunch | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const uidRaw = r.device_user_id ?? r.user_id;
  const device_user_id = typeof uidRaw === 'number' ? String(uidRaw) : typeof uidRaw === 'string' ? uidRaw.trim() : '';
  if (!/^[0-9A-Za-z]{1,9}$/.test(device_user_id)) return { error: 'device_user_id must be 1-9 letters or digits' };
  const t = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
  if (!Number.isFinite(t)) return { error: 'at must be an ISO time' };
  if (t > now + FUTURE_SLACK_MS) return { error: 'at is in the future (check the device clock)' };
  if (t < Date.UTC(2015, 0, 1)) return { error: 'at is before 2015 (check the device clock)' };
  const small = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535 ? (v as number) : null);
  return { device_user_id, at: new Date(Math.floor(t / 1000) * 1000).toISOString(), status: small(r.status), punch: small(r.punch), uid: small(r.uid) };
}

/** The dedupe key of a device punch (the unique index of migration 180): device serial + device user id + time. */
export const punchKey = (serial: string, deviceUserId: string, at: string) => `${serial}|${deviceUserId}|${new Date(at).toISOString()}`;

// ── The device's users ────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceUser { device_user_id: string; name: string | null; privilege: number | null; uid: number | null }
/**
 * "New on the device": the device's users whose number nobody in the system has — shown to link to a staff member or
 * to make an attendance-only person, never created by themselves. A device admin (privilege ≠ 0) is listed too, marked.
 */
export function newOnDevice(deviceUsers: readonly DeviceUser[], people: ReadonlyArray<{ attendance_no: number | null }>): DeviceUser[] {
  const known = new Set(people.map((p) => p.attendance_no).filter((n): n is number => n !== null));
  return deviceUsers.filter((u) => { const n = cleanAttendanceNo(u.device_user_id); return n === null || !known.has(n); });
}

/**
 * Who holds each number on ONE device, as far as this system knows (the device's own list may hold strangers too): the
 * latest action for that number on that device that is done or still pending — a write_user gives it to its person, a
 * delete_user frees it. Cancelled and failed actions give nothing (a refused write never took the slot), nor does a
 * pending write that may not overwrite (it is refused if the slot is someone else's when it runs). `actions` in
 * any order; `created_at` decides. Map attendance_no → person id (or null = freed by us).
 *
 * WHY (found on a real K40, 2026-10-28): a device bought before ZapTill already holds its people (138 on the first one
 * read), numbered from 1. A number on the device that this system never wrote or linked is SOMEONE ELSE'S fingerprint —
 * writing our name onto it (fingerprints are kept) would put that person's punches on our staff member.
 */
export function slotClaims(actions: ReadonlyArray<{ attendance_no: number; action: string; person_id: string | null; status: string; overwrite?: boolean | null; created_at?: string | null }>): Map<number, string | null> {
  // a pending automatic write (overwrite false) is not a claim yet: the slot may hold someone else by the time it runs
  const live = actions.filter((a) => a.status === 'done' || (a.status === 'pending' && (a.action !== 'write_user' || a.overwrite === true)))
    .slice().sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const out = new Map<number, string | null>();
  for (const a of live) out.set(a.attendance_no, a.action === 'write_user' ? (a.person_id ?? null) : null);
  return out;
}

/**
 * What the device should hold (the branch's active people with a number) against what it reported:
 *   write     a person whose number is EMPTY on the device, or holds THEIR OWN user (claimed: we wrote / linked it) under
 *             another name (a rename), or holds an unclaimed user under exactly their name (written once, to claim it)
 *   clashes   a person whose number on the device holds a user we never wrote or linked — never overwritten; shown to the
 *             manager (give the person the number they really have on the device, or a new one)
 *   remove    numbers of people deactivated / moved away, only where the slot is OURS (claimed) — a stranger is never
 *             deleted, and a device admin is never touched
 * `claims` is slotClaims() for this device.
 */
export function deviceDiff(want: ReadonlyArray<{ attendance_no: number; name: string; id?: string }>, have: readonly DeviceUser[], retired: Iterable<number>,
  claims: ReadonlyMap<number, string | null> = new Map()): {
  write: Array<{ attendance_no: number; name: string; id?: string }>; remove: number[];
  clashes: Array<{ attendance_no: number; name: string; id?: string; name_on_device: string | null }>;
} {
  const on = new Map<number, DeviceUser>();
  for (const u of have) { const n = cleanAttendanceNo(u.device_user_id); if (n !== null) on.set(n, u); }
  const write: Array<{ attendance_no: number; name: string; id?: string }> = [];
  const clashes: Array<{ attendance_no: number; name: string; id?: string; name_on_device: string | null }> = [];
  for (const p of want) {
    const u = on.get(p.attendance_no);
    if (!u) { write.push(p); continue; }
    if ((u.privilege ?? 0) !== 0) { clashes.push({ ...p, name_on_device: u.name ?? null }); continue; }   // an admin's slot: never overwritten
    const mine = claims.has(p.attendance_no) && claims.get(p.attendance_no) !== null && (p.id === undefined || claims.get(p.attendance_no) === p.id);
    // not ours: a different name is a stranger (a clash); the same name is them — written once (no change on the device) so the slot is claimed
    if (!mine) { if ((u.name ?? '') !== deviceName(p.name)) clashes.push({ ...p, name_on_device: u.name ?? null }); else write.push(p); continue; }
    if ((u.name ?? '') !== deviceName(p.name)) write.push(p);
  }
  const wanted = new Set(want.map((p) => p.attendance_no));
  const remove = [...new Set(retired)].filter((n) => !wanted.has(n) && on.has(n) && (on.get(n)!.privilege ?? 0) === 0 && (claims.get(n) ?? null) !== null);
  return { write, remove, clashes };
}
