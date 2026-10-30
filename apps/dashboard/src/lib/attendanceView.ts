/**
 * attendanceView.ts — A599 (Attendance, premium): the Attendance page's pure helpers — who sees the menu item, the period
 * presets, the colours (cards, the hours heat ramp, light and dark), the week and month layouts, the hours in words and
 * the Excel sheets. No React and no browser here, so tests/attendance-a599.test.mjs bundles and runs it directly.
 *
 * Colours: the cards and the heat ramp are DATA colours (not actions), a pleasant default palette checked on the
 * dashboard's cards in both modes; the single-series accent (the week's bars, the ranked bars) takes the shop's brand
 * colour when it has one (A597 brandChartAccent — passed in by the page), else the default teal.
 */
import { reportPresets, activePreset, type PeriodPreset } from './reportPeriods';
import type { ReportSheet } from './reportDownload';

/** The menu item: the 'attendance' flag on (ZapTill's, the admin portal), and the owner, a partner or attendance.view. */
export function showAttendanceNav(o: { flagOn: boolean; isOwner: boolean; isPartner: boolean; can: (k: string) => boolean }): boolean {
  return o.flagOn === true && (o.isOwner || o.isPartner || o.can('attendance.view'));
}

/** This week · Last week · This month · Last month (Monday → Sunday weeks, the browser's local day). */
export const ATTENDANCE_PRESET_LABELS = ['This week', 'Last week', 'This month', 'Last month'] as const;
export function attendancePresets(now: Date = new Date()): PeriodPreset[] {
  const all = reportPresets(now);
  return ATTENDANCE_PRESET_LABELS.map((l) => all.find((p) => p.label === l)!).filter(Boolean);
}
export { activePreset };

export type Mode = 'light' | 'dark';
export interface AttendancePalette {
  /** the five summary cards: hours, days, average, missed punch-outs, corrections */
  cards: { hours: string; days: string; avg: string; missed: string; corrections: string };
  accent: string;
  /** from a short day to a long one (5 steps); `off` = no hours (a day off) */
  ramp: string[];
  off: string;
  missing: string;
  ink: string;
  grid: string;
}
const LIGHT = {
  cards: { hours: '#2a78d6', days: '#1baf7a', avg: '#6250d6', missed: '#e34948', corrections: '#eda100' },
  accent: '#0d9488',
  ramp: ['#d6f5ec', '#a5e6d1', '#5fceb0', '#1fa98a', '#0b7a64'],
  off: '#e5e7eb', missing: '#dc2626', ink: '#0f172a', grid: '#e2e8f0',
};
const DARK = {
  cards: { hours: '#3987e5', days: '#199e70', avg: '#9085e9', missed: '#e66767', corrections: '#c98500' },
  accent: '#2dd4bf',
  ramp: ['#123b33', '#155e4f', '#13826b', '#1fa98a', '#5fceb0'],
  off: '#1f2937', missing: '#f87171', ink: '#f9fafb', grid: '#1f2937',
};
export function attendancePalette(mode: Mode, brandAccent?: string | null): AttendancePalette {
  const base = mode === 'dark' ? DARK : LIGHT;
  return { ...base, cards: { ...base.cards }, ramp: [...base.ramp], accent: brandAccent || base.accent };
}

/** A day's cell colour: grey with no hours (a day off), else the ramp by hours (0–4, 4–6, 6–8, 8–10, 10+). */
export function heatColour(hours: number | null | undefined, p: AttendancePalette): string {
  const h = Number(hours) || 0;
  if (h <= 0) return p.off;
  const i = h < 4 ? 0 : h < 6 ? 1 : h < 8 ? 2 : h < 10 ? 3 : 4;
  return p.ramp[i];
}
/** Black or white text on a heat cell (the darker three steps take white). */
export function heatInk(hours: number | null | undefined, mode: Mode): string {
  const h = Number(hours) || 0;
  if (mode === 'dark') return h >= 8 ? '#0f172a' : '#f9fafb';
  return h >= 8 ? '#ffffff' : '#0f172a';
}

/** 7.5 → "7 h 30 min"; 0 → "0 h"; 8 → "8 h". */
export function hoursWords(h: number | null | undefined): string {
  const mins = Math.round((Number(h) || 0) * 60);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
/** An ISO instant's clock time in East Africa Time ("07:58"), — when none. */
export function clockEAT(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 3 * 3_600_000).toISOString().slice(11, 16) : '—';
}
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** "2026-10-26" → "Mon 26". */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WD[wd]} ${d}`;
}

/**
 * The month view: the period's dates laid out in Monday-first weeks (null = a cell before the first or after the last
 * date). Every date appears exactly once.
 */
export function monthGrid(dates: readonly string[]): Array<Array<string | null>> {
  if (!dates.length) return [];
  const [y, m, d] = dates[0].split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const cells: Array<string | null> = [...Array(lead).fill(null), ...dates];
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
/** The week view (a bar a day) for a short period; the month view (the calendar) for a longer one. */
export const preferredView = (dates: readonly string[]): 'week' | 'month' => (dates.length <= 14 ? 'week' : 'month');

// ── The cloud's answer (GET /api/attendance/report) ─────────────────────────────────────────────────────────────────
export interface AttShift { in: string; out: string | null; minutes: number; long: boolean; inId: string; outId: string | null }
export interface AttCorrection { id: string; kind: 'added' | 'moved' | 'removed'; at: string | null; was: string | null; reason: string; byName: string | null; when: string }
export interface AttDay { date: string; firstIn: string | null; lastOut: string | null; hours: number; minutes: number; shifts: AttShift[]; missingOut: boolean; long: boolean; corrections: AttCorrection[] }
export interface AttTotals { hours: number; daysWorked: number; avgHours: number; missedOuts: number; corrections: number; longShifts: number }
export interface AttPerson {
  key: string; person_id: string | null; user_id: string | null; name: string; attendance_no: number | null; attendance_only: boolean;
  active: boolean; branch_id: string | null; branch_name: string | null; totals: AttTotals; daily: Record<string, number>; missing: string[];
  hourly_rate?: number | null; pay?: number | null; days?: AttDay[];
}
export interface AttReport { from: string; to: string; dates: string[]; payVisible: boolean; people: AttPerson[]; team: { hours: number; people: number; missedOuts: number; corrections: number; pay?: number } }

/** The Excel download: Summary (one row a person; pay only when the cloud sent it) and the chosen person's days. */
export function attendanceSheets(r: AttReport, person?: AttPerson | null): ReportSheet[] {
  const pay = r.payVisible === true;
  const sheets: ReportSheet[] = [{
    name: 'Summary',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'no', label: 'Device number' }, { key: 'branch', label: 'Branch' },
      { key: 'hours', label: 'Hours', dp: 2 }, { key: 'days', label: 'Days worked' }, { key: 'avg', label: 'Average hours a day', dp: 2 },
      { key: 'missed', label: 'Missed punch-outs' }, { key: 'corrections', label: 'Corrections' },
      ...(pay ? [{ key: 'rate', label: 'Hourly rate', money: true }, { key: 'pay', label: 'Estimated pay', money: true }] : []),
    ],
    rows: r.people.map((p) => ({
      name: p.name, no: p.attendance_no ?? '', branch: p.branch_name ?? '', hours: p.totals.hours, days: p.totals.daysWorked,
      avg: p.totals.avgHours, missed: p.totals.missedOuts, corrections: p.totals.corrections,
      ...(pay ? { rate: p.hourly_rate ?? '', pay: p.pay ?? '' } : {}),
    })),
  }, {
    name: 'Hours by day',
    columns: [{ key: 'name', label: 'Name' }, ...r.dates.map((d) => ({ key: d, label: d, dp: 2 }))],
    rows: r.people.map((p) => ({ name: p.name, ...Object.fromEntries(r.dates.map((d) => [d, p.daily[d] ?? 0])) })),
  }];
  if (person?.days) {
    sheets.push({
      name: person.name,
      columns: [{ key: 'date', label: 'Date' }, { key: 'in', label: 'First in' }, { key: 'out', label: 'Last out' },
        { key: 'hours', label: 'Hours', dp: 2 }, { key: 'flag', label: 'Check' }, { key: 'corr', label: 'Corrections' }],
      rows: person.days.map((d) => ({
        date: d.date, in: clockEAT(d.firstIn), out: clockEAT(d.lastOut), hours: d.hours,
        flag: [d.missingOut ? 'Missing punch-out' : '', d.long ? 'Over 12 h' : ''].filter(Boolean).join(', '),
        corr: d.corrections.map((c) => `${c.kind}: ${c.reason}${c.byName ? ` (${c.byName})` : ''}`).join('; '),
      })),
    });
  }
  return sheets;
}
