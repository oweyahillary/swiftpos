/**
 * overviewDate.ts — A441 (owner, 2026-10-10: "under overview can we add select date to view that date?").
 *
 * The Overview shows one trading day: today unless the manager picks another. These are the rules, kept apart from React
 * so the test runs them as they are: the range the reports are asked for, the word the cards use ("today", "yesterday",
 * "Sat 4 Oct"), and stepping a day back or forward (never past today).
 */
import type { ReportRangeArg } from './posApi';

const pad = (n: number) => String(n).padStart(2, '0');
/** A local calendar day as YYYY-MM-DD. */
export function ymdOf(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function todayYmd(now: Date = new Date()): string { return ymdOf(now); }

const valid = (d: string | null | undefined): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** What the reports are asked for: today's preset (the business-day cut-off applies), else that one whole day. */
export function overviewRange(date: string | null | undefined, now: Date = new Date()): ReportRangeArg {
  if (!valid(date) || date >= todayYmd(now)) return { preset: 'today' };
  return { preset: 'custom', from: date, to: date };
}

/** "today", "yesterday", else the day ("Sat 4 Oct"; with the year when it is not this year). */
export function dayWord(date: string | null | undefined, now: Date = new Date()): string {
  if (!valid(date) || date >= todayYmd(now)) return 'today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (date === ymdOf(y)) return 'yesterday';
  const [Y, M, D] = date.split('-').map(Number);
  const d = new Date(Y, M - 1, D);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(Y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** A day back (-1) or forward (+1); forward stops at today (null = today). */
export function stepDay(date: string | null | undefined, by: -1 | 1, now: Date = new Date()): string | null {
  const today = todayYmd(now);
  const from = valid(date) && date < today ? date : today;
  const [Y, M, D] = from.split('-').map(Number);
  const next = ymdOf(new Date(Y, M - 1, D + by));
  return next >= today ? null : next;
}
