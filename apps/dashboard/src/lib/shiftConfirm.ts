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
/** The methods every POS offers (till PaymentModal, web PaymentModal) besides cash. Custom tenders come on top. */
export const BUILT_IN_METHODS = ['mpesa', 'card', 'glovo'];

export function methodsToDeclare(active: MethodOption[], taken: { method: string }[]): string[] {
  const set = new Set<string>(BUILT_IN_METHODS);
  for (const o of active) { const c = String(o.code ?? '').trim().toLowerCase(); if (c && c !== 'cash') set.add(c); }
  for (const t of taken) { const c = String(t.method ?? '').trim().toLowerCase(); if (c && c !== 'cash') set.add(c); }
  return [...set].sort((a, b) => a.localeCompare(b));
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
