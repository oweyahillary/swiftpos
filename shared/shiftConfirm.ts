/**
 * shiftConfirm.ts — A365 (desktop 0.6.22): the cashier declares every payment method at End Shift; a manager
 * confirms every shift with a blind recount, now or later; Close Day waits for them.
 *
 * Owner, 2026-09-29: "the managers should confirm shift before closing the day … They can confirm anytime but
 * recommended the moment the cashier closes … it should block … They should recount incase the cashier submitted less
 * than the amount … on all payment method not just mpesa"; a manager's own shift is "allowed, flagged".
 *
 * Pure — the till's screens (ShiftPanel, ConfirmShiftModal, DayCloseTab, ZReportView) and the web POS's ShiftModal
 * use it; the tests run it. ONE file: shared/shiftConfirm.ts, copied byte-for-byte to the till and the web
 * (scripts/check-shared-sync.mjs).
 */

export interface MethodOption { code: string; name: string }

const NAMES: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', glovo: 'Glovo', credit: 'Credit' };

/** "M-Pesa", "Card", or the business's own name for a method, or the code with a capital. */
export function methodName(code: string, options: MethodOption[] = []): string {
  const c = String(code ?? '').trim().toLowerCase();
  const own = options.find((o) => String(o.code).toLowerCase() === c)?.name;
  if (own) return own;
  return NAMES[c] ?? (c ? c[0].toUpperCase() + c.slice(1) : '');
}

/**
 * The methods a cashier declares besides cash: every active method of the business, plus any this shift actually
 * took (a method switched off mid-shift still has money to account for). Cash is the drawer count, asked separately.
 */
/**
 * The methods a cashier declares besides cash: only those this shift actually recorded money on. Owner, 0.6.22: "if the
 * method of payment is 0 let it not appear" — a method with nothing recorded is not asked (it counts as 0). Cash is the
 * drawer count, asked separately.
 */
export function methodsToDeclare(taken: { method: string; amount: number }[]): string[] {
  const set = new Set<string>();
  for (const t of taken) {
    const c = String(t.method ?? '').trim().toLowerCase();
    if (c && c !== 'cash' && Math.round(Number(t.amount) * 100) !== 0) set.add(c);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * What a manager recounts: cash, every method the cashier declared money on, and every method the shift recorded money
 * on (even one the cashier put at 0 — that is the gap a recount exists to find). Never the amounts (the recount is blind).
 */
export function methodsToCount(declared: Record<string, number> | null | undefined, taken: { method: string; amount: number }[] = []): string[] {
  const set = new Set<string>();
  for (const [m, v] of Object.entries(declared ?? {})) if (m !== 'cash' && Math.round(Number(v) * 100) !== 0) set.add(m);
  for (const m of methodsToDeclare(taken)) set.add(m);
  return ['cash', ...[...set].sort((a, b) => a.localeCompare(b))];
}

/**
 * May the signed-in person confirm a shift without a PIN? A manager already signed in confirms as themselves (owner,
 * 0.6.22: "since its the manager who is logged in do they need to key in their password?"). The cloud's mayConfirm.
 */
export function maySignedInConfirm(s: { role?: string | null; permissions?: Record<string, boolean> | null } | null | undefined): boolean {
  if (!s) return false;
  const p = s.permissions ?? {};
  if (p['*'] === true || p['orders.void'] === true || p['shifts.manage'] === true || p['settings.manage'] === true) return true;
  return ['owner', 'admin', 'manager', 'supervisor', 'branch_manager'].includes(String(s.role ?? '').toLowerCase());
}

/** Typed amounts → a method map when EVERY listed method has a number ≥ 0; else the ones still missing. */
export function readAmounts(inputs: Record<string, string>, codes: string[]):
  { ok: true; map: Record<string, number> } | { ok: false; missing: string[] } {
  const map: Record<string, number> = {};
  const missing: string[] = [];
  for (const c of codes) {
    const raw = String(inputs[c] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0) missing.push(c);
    else map[c] = Math.round(n * 100) / 100;
  }
  return missing.length ? { ok: false, missing } : { ok: true, map };
}

/** "Confirmed by Mary 17:05" / "… (self-confirmed)" / "Awaiting manager check". */
export function confirmationLabel(c: { status: 'awaiting' | 'confirmed'; confirmed_by_name?: string | null; confirmed_at?: string; self?: boolean } | null | undefined): string | null {
  if (!c) return null;
  if (c.status === 'awaiting') return 'Awaiting manager check';
  const t = c.confirmed_at ? new Date(c.confirmed_at) : null;
  const hm = t && !isNaN(t.getTime()) ? ` ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  return `Confirmed by ${c.confirmed_by_name ?? 'a manager'}${hm}${c.self ? ' (self-confirmed)' : ''}`;
}

/** The printed Z-report's confirmation lines (paper has no colour, so the mismatch is spelled out). */
export function confirmationPrintLines(c: { status: 'awaiting' | 'confirmed'; confirmed_by_name?: string | null; confirmed_at?: string; self?: boolean;
  lines: { method: string; declared: number | null; expected: number | null; confirmed: number | null; variance: number | null; mismatch: boolean }[] } | null | undefined,
  fmt: (n: number) => string, options: MethodOption[] = []): string[] {
  if (!c) return [];
  const out = [confirmationLabel(c)!.toUpperCase()];
  for (const l of c.lines) {
    const name = methodName(l.method, options);
    if (c.status === 'awaiting') { out.push(`${name}: cashier ${fmt(l.declared ?? 0)}`); continue; }
    const v = l.variance ?? 0;
    out.push(`${name}: counted ${fmt(l.confirmed ?? 0)} / expected ${fmt(l.expected ?? 0)}` +
      (Math.round(v * 100) !== 0 ? ` (${v > 0 ? 'over' : 'short'} ${fmt(Math.abs(v))})` : ''));
    if (l.mismatch) out.push(`  cashier said ${fmt(l.declared ?? 0)}`);
  }
  return out;
}

// ── The owner's Shift Reports (dashboard, 0.6.23) ────────────────────────────────────────────────────────────────────
// Owner: "a table like cashier name, shift date, confirmed (if its still running or not), view — when they click view
// they get such a table". One row per shift; View opens the per-method table below.

export type ShiftReportStatus = 'running' | 'awaiting' | 'confirmed' | 'self' | 'force_closed' | 'not_required';

interface ReportShift {
  status: string;
  declared_methods?: Record<string, number> | null;
  expected_methods?: Record<string, number> | null;
  confirmed_methods?: Record<string, number> | null;
  confirmed_at?: string | null;
  confirm_self?: boolean | null;
  closing_float?: number | string | null;
  expected_cash?: number | string | null;
  cash_variance?: number | string | null;
}

/** Where a shift stands: still running, awaiting a manager, confirmed (or self-confirmed), force-closed, or closed before confirmation existed. */
export function shiftReportStatus(s: ReportShift): ShiftReportStatus {
  if (s.status === 'open') return 'running';
  if (s.status === 'closed_unreconciled') return 'force_closed';
  if (s.confirmed_at) return s.confirm_self ? 'self' : 'confirmed';
  if (s.declared_methods) return 'awaiting';
  return 'not_required';
}

export function shiftStatusLabel(st: ShiftReportStatus, confirmerName?: string | null): string {
  switch (st) {
    case 'running':      return 'Running';
    case 'awaiting':     return 'Awaiting manager check';
    case 'confirmed':    return `Confirmed by ${confirmerName ?? 'a manager'}`;
    case 'self':         return `Self-confirmed by ${confirmerName ?? 'a manager'}`;
    case 'force_closed': return 'Force-closed (not counted)';
    default:             return 'Closed (before confirmation)';
  }
}

export interface ReportLine {
  method: string;
  /** What the cashier said at End Shift (cash = the counted drawer). */
  cashier: number | null;
  /** The manager's blind recount (null until confirmed). */
  manager: number | null;
  /** What the system recorded (cash = expected cash in the drawer). */
  recorded: number | null;
  /** The official figure − recorded: the manager's once confirmed, else the cashier's. */
  variance: number | null;
  /** The manager's count differs from the cashier's. */
  mismatch: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The View table: one line per method (cash first). `byMethod` is what the cloud recorded per method on the shift
 * (GET /api/shifts/:id by_method) — used until a confirmation stores its own expected figures.
 */
export function shiftReportLines(s: ReportShift, byMethod: { method: string; amount: number }[] = []): ReportLine[] {
  const declared = s.declared_methods ?? (num(s.closing_float) !== null ? { cash: Number(s.closing_float) } : null);
  let recorded: Record<string, number> | null = s.expected_methods ?? null;
  if (!recorded) {
    recorded = {};
    for (const b of byMethod) {
      const m = String(b.method ?? '').trim().toLowerCase();
      if (m && m !== 'cash') recorded[m] = r2((recorded[m] ?? 0) + Number(b.amount));
    }
    const cash = num(s.expected_cash);
    if (cash !== null) recorded.cash = cash;
  }
  const confirmed = s.confirmed_methods ?? null;
  const codes = new Set<string>([...Object.keys(declared ?? {}), ...Object.keys(confirmed ?? {}),
    ...Object.entries(recorded ?? {}).filter(([, v]) => Math.round(v * 100) !== 0).map(([m]) => m)]);
  if (s.status !== 'open') codes.add('cash');
  return [...codes].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b))).map((m) => {
    const c = declared ? (declared[m] ?? 0) : null;
    const mg = confirmed ? (confirmed[m] ?? 0) : null;
    // Cash recorded is the expected cash in the drawer — unknown (null), never 0, when the cloud has not computed it.
    const rec = recorded ? (m in recorded ? recorded[m] : (m === 'cash' ? null : 0)) : null;
    const official = mg ?? c;
    return { method: m, cashier: c, manager: mg, recorded: rec,
      variance: official !== null && rec !== null ? r2(official - rec) : null,
      mismatch: c !== null && mg !== null && Math.round(c * 100) !== Math.round(mg * 100) };
  });
}

/**
 * The list's "Difference" column from the shift row alone: every method that is over or short once confirmed (the
 * manager's figures), else the cashier's cash variance. "Balanced" when nothing is off; "" while running.
 */
export function shiftDifference(s: ReportShift, fmt: (n: number) => string, options: MethodOption[] = []): string {
  const st = shiftReportStatus(s);
  if (st === 'running') return '';
  if (s.confirmed_methods && s.expected_methods) {
    const off = shiftReportLines(s).filter((l) => Math.round((l.variance ?? 0) * 100) !== 0);
    const mism = shiftReportLines(s).some((l) => l.mismatch);
    if (!off.length) return mism ? 'Balanced (cashier differed)' : 'Balanced';
    return off.map((l) => `${methodName(l.method, options)} ${(l.variance ?? 0) > 0 ? '+' : '−'}${fmt(Math.abs(l.variance ?? 0))}`).join(' · ');
  }
  const v = num(s.cash_variance);
  if (v === null) return st === 'force_closed' ? 'Not counted' : '';
  return Math.round(v * 100) === 0 ? 'Balanced' : `Cash ${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`;
}
