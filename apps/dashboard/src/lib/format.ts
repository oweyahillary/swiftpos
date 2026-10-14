// A471: one way to show money, numbers and dates on every dashboard screen.
//
// Pure — no React, no imports beyond lib/localDate — so it is bundled and run by tests/format.test.mjs.
//
//   money(1250)                    → "KES 1,250.00"      (en-KE grouping, 2 dp, a plain space after the code)
//   money(-1250, 'UGX')            → "-UGX 1,250.00"
//   money(1250, 'KES', { decimals: 'auto' }) → "KES 1,250"   ('auto' drops ".00" on a whole amount only)
//   money(null) / money(NaN)       → "KES 0.00"
//   num(1234) → "1,234"   pct(12.5) → "12.5%"   litres(1234.5) → "1,234.50 L"   compactMoney(1_234_567) → "KES 1.2M"
//   dateShort('2026-10-13') → "13 Oct 2026"   time(iso) → "14:05"   dateTime(iso) → "13 Oct 2026, 14:05"
//   dayTime(iso) → "13 Oct, 14:05"   relative(iso) → "5m ago" / "2h 10m ago" / "yesterday"   elapsed(iso) → "2h 10m"
//
// Dates are the browser's local time (Kenya, EAT) — the same convention as lib/localDate.
// NOT for <input value> (inputs take plain numbers), CSV/Excel (raw numbers — lib/reportDownload) or receipts
// (lib/print*, lib/escposRenderer, lib/documentSpecs have their own fixed layouts).

import { localDateStr } from './localDate';

const LOCALE = 'en-KE';

type Num = unknown;   // a number, a numeric string (Postgres numeric), null, undefined — anything else is 0

/** A finite number, or 0 for null / undefined / NaN / '' / junk. */
function n0(v: Num): number {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function group(v: number, min: number, max: number): string {
  return v.toLocaleString(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max });
}

export interface MoneyOpts {
  /** 2 (default), 0 (whole shillings), or 'auto' (2 dp, but ".00" dropped on a whole amount). */
  decimals?: 0 | 2 | 'auto';
  /** Prefix a positive amount with "+" (a negative always shows "-"). */
  sign?: boolean;
  /** Shown instead when the amount is null / undefined (e.g. '—' or 'unavailable'). Without it, null reads as 0. */
  blank?: string;
}

/** "KES 1,250.00" — the business currency code, a plain space, en-KE grouping. Negatives "-KES 1,250.00". */
export function money(n: Num, currency: string = 'KES', opts: MoneyOpts = {}): string {
  if (opts.blank !== undefined && n == null) return opts.blank;
  const v = n0(n);
  const d = opts.decimals ?? 2;
  const abs = Math.abs(v);
  let dp: number;
  if (d === 'auto') dp = Math.round(abs * 100) % 100 === 0 ? 0 : 2;
  else dp = d;
  const body = group(abs, dp, dp);
  const isZero = Number(abs.toFixed(dp)) === 0;
  const prefix = isZero ? '' : v < 0 ? '-' : opts.sign ? '+' : '';
  return `${prefix}${currency || 'KES'} ${body}`;
}

/** A count or quantity with grouping, exactly `dp` decimals: num(1234) → "1,234", num(2.5, 1) → "2.5". */
export function num(n: Num, dp: number = 0): string {
  return group(n0(n), dp, dp);
}

/** A quantity with grouping and up to `maxDp` decimals, trailing zeros dropped: qty(2.5) → "2.5", qty(3) → "3". */
export function qty(n: Num, maxDp: number = 3): string {
  return group(n0(n), 0, maxDp);
}

/** A percentage: pct(12.5) → "12.5%", pct(40, 0) → "40%". The input is already a percentage (not a fraction). */
export function pct(n: Num, dp: number = 1): string {
  return `${n0(n).toFixed(dp)}%`;
}

/** Litres: litres(1234.5) → "1,234.50 L", litres(1234.5, 0) → "1,235 L"; `blank` is shown for null / undefined. */
export function litres(n: Num, dp: number = 2, blank?: string): string {
  if (blank !== undefined && n == null) return blank;
  return `${group(n0(n), dp, dp)} L`;
}

/** Short money for chart axes and tight tiles: "KES 1.2M", "KES 45K", "KES 950". */
export function compactMoney(n: Num, currency: string = 'KES'): string {
  const v = n0(n);
  const abs = Math.abs(v);
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  let body = String(Math.round(abs));
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (abs >= size || Math.round(abs) >= size) {
      const r = Math.round((abs / size) * 10) / 10;
      // 999,960 rounds to "1000K" — show it in the next unit up instead
      if (r >= 1000 && i > 0) { body = `${Math.round((abs / units[i - 1][0]) * 10) / 10}${units[i - 1][1]}`; }
      else body = `${r}${suffix}`;
      break;
    }
  }
  const prefix = v < 0 && body !== '0' ? '-' : '';
  return `${prefix}${currency || 'KES'} ${body}`;
}

// ── dates and times (browser local = Kenya) ──

type When = string | number | Date | null | undefined;

/** A Date, or null. A bare "YYYY-MM-DD" is that LOCAL day (not UTC midnight, which is 03:00 in Nairobi). */
function toDate(v: When): Date | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v
    : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`)
    : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "13 Oct 2026" — "—" when there is no date. */
export function dateShort(v: When, empty = '—'): string {
  const d = toDate(v);
  return d ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : empty;
}

/** "14:05" — 24 h, as the rest of the app. */
export function time(v: When, empty = '—'): string {
  const d = toDate(v);
  return d ? d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : empty;
}

/** "13 Oct 2026, 14:05". */
export function dateTime(v: When, empty = '—'): string {
  const d = toDate(v);
  return d ? d.toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) : empty;
}

/** "13 Oct, 14:05" — no year, for lists of recent things. */
export function dayTime(v: When, empty = '—'): string {
  const d = toDate(v);
  return d ? d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : empty;
}

/** How long since: "45m", "2h 10m" (no "ago" — for "open for …"). */
export function elapsed(v: When, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return '—';
  const diff = Math.max(0, now - d.getTime());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "just now", "5m ago", "2h 10m ago", "yesterday", "3d ago", then "13 Oct 2026". */
export function relative(v: When, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return '—';
  const mins = Math.floor((now - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  if (localDateStr(d) === localDateStr(new Date(now - 86_400_000))) return 'yesterday';
  const days = Math.floor(mins / 1440);
  if (days < 7) return `${Math.max(days, 2)}d ago`;
  return dateShort(d);
}
