/**
 * reportPeriods.ts — the Reports period presets (A467).
 *
 * Owner, 2026-10-13: "some I might want daily, some monthly, some weekly". Today · Yesterday · This week · Last week ·
 * This month · Last month. Weeks run Monday → Sunday (Kenya's working week). Every date is the browser's LOCAL calendar
 * day (Kenya, EAT) through localDateStr — never toISOString, which is the UTC day and lands on yesterday in the EAT
 * evening/early morning. The maths walks local calendar days with new Date(y, m, d), so it never crosses a UTC boundary.
 *
 * `now` is injectable so the maths can be tested for a fixed "today".
 */
import { localDateStr } from './localDate';

export interface PeriodPreset { label: string; from: string; to: string }

/** A local calendar day `days` after (or before) `d`, at local midnight. */
function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** The Monday of the week holding `d` (Monday → Sunday weeks). */
export function weekStart(d: Date): Date {
  const back = (d.getDay() + 6) % 7;   // Mon 0 … Sun 6
  return addDays(d, -back);
}

export function reportPresets(now: Date = new Date()): PeriodPreset[] {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today = localDateStr(day);
  const yesterday = localDateStr(addDays(day, -1));
  const mon = weekStart(day);
  const lastMon = addDays(mon, -7);
  const lastSun = addDays(mon, -1);
  const monthFirst = new Date(day.getFullYear(), day.getMonth(), 1);
  const lastMonthFirst = new Date(day.getFullYear(), day.getMonth() - 1, 1);
  const lastMonthEnd = new Date(day.getFullYear(), day.getMonth(), 0);   // day 0 = the last day of the month before
  return [
    { label: 'Today',      from: today,                         to: today },
    { label: 'Yesterday',  from: yesterday,                     to: yesterday },
    { label: 'This week',  from: localDateStr(mon),             to: today },
    { label: 'Last week',  from: localDateStr(lastMon),         to: localDateStr(lastSun) },
    { label: 'This month', from: localDateStr(monthFirst),      to: today },
    { label: 'Last month', from: localDateStr(lastMonthFirst),  to: localDateStr(lastMonthEnd) },
  ];
}
