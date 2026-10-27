/**
 * businessDay.ts — 0.6.34: when a trading day ends (the owner's "Business day ends at").
 *
 * Owner, 2026-10-03 (a hotel bar trading past midnight): with the day ending at midnight, a till whose day was not
 * closed refused to sell at 00:00 — mid-service — until a manager counted the cash and closed it. The owner sets the
 * time the business day ends, 00:00 to 06:00 (default 00:00 = midnight, as before). A sale at 01:30 with the day ending
 * at 04:00 belongs to YESTERDAY's business day: the till keeps trading through the night and the day is closed after
 * service; the cloud's reports and the daily email count it to the same night.
 *
 * Stored as the business setting 'business_day_cutoff' ("HH:MM"), overridable per branch (as continuous_operation).
 *
 * ONE file: shared/businessDay.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export const BUSINESS_DAY_CUTOFF_KEY = 'business_day_cutoff';
/** The latest the business day may end: 06:00 (minutes after midnight). */
export const MAX_CUTOFF_MINUTES = 6 * 60;

/**
 * Minutes after midnight the business day ends: 0 (midnight) … 360 (06:00). Accepts "HH:MM", "H:MM", a number of minutes,
 * or nothing ('' / null / undefined = 0, midnight). undefined = not a valid time (the caller refuses it).
 */
export function cleanCutoff(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return 0;
  let v: unknown = raw;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^"|"$/g, '');
    if (s === '') return 0;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (m) {
      const h = Number(m[1]), min = Number(m[2]);
      if (h > 23 || min > 59) return undefined;
      v = h * 60 + min;
    } else if (/^\d+$/.test(s)) {
      v = Number(s);
    } else {
      return undefined;
    }
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_CUTOFF_MINUTES) return undefined;
  return v;
}

/** "04:00" for 240. */
export function cutoffLabel(minutes: number): string {
  const m = Math.max(0, Math.min(MAX_CUTOFF_MINUTES, Math.round(Number(minutes) || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** What to store for the setting ("HH:MM"), or null when the value is not a valid cut-off. */
export function cutoffSettingValue(raw: unknown): string | null {
  const m = cleanCutoff(raw);
  return m === undefined ? null : cutoffLabel(m);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The business date (YYYY-MM-DD) of a moment, in THIS machine's local time — the till. Before the cut-off it is still the
 * previous calendar day.
 */
export function businessDateLocal(d: Date, cutoffMinutes = 0): string {
  const t = new Date(d.getTime() - (cleanCutoff(cutoffMinutes) ?? 0) * 60_000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** The moment (this machine's local time) a business date's day ends — the next calendar day at the cut-off. */
export function businessDayEndLocal(businessDate: string, cutoffMinutes = 0): Date {
  const [y, m, d] = businessDate.split('-').map(Number);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return new Date(end.getTime() + (cleanCutoff(cutoffMinutes) ?? 0) * 60_000);
}

/** The cloud's zone: East Africa Time, UTC+3, no daylight saving (as every cloud report). */
export const BUSINESS_UTC_OFFSET_MINUTES = 3 * 60;

/** The business date of a moment in East Africa Time (the cloud). */
export function businessDateEAT(d: Date, cutoffMinutes = 0): string {
  const t = new Date(d.getTime() + (BUSINESS_UTC_OFFSET_MINUTES - (cleanCutoff(cutoffMinutes) ?? 0)) * 60_000);
  return t.toISOString().slice(0, 10);
}

/**
 * The UTC instants a run of business dates covers (East Africa Time): from `fromDate` at the cut-off to the day after
 * `toDate` at the cut-off (exclusive end, as an inclusive "…59.999" instant for `lte` filters).
 */
export function businessRangeEAT(fromDate: string, toDate: string, cutoffMinutes = 0): { start: string; end: string } {
  const c = (cleanCutoff(cutoffMinutes) ?? 0) - BUSINESS_UTC_OFFSET_MINUTES;
  const at = (date: string, plusDays: number) => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d + plusDays, 0, 0, 0, 0) + c * 60_000;
  };
  return { start: new Date(at(fromDate, 0)).toISOString(), end: new Date(at(toDate, 1) - 1).toISOString() };
}
