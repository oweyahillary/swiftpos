/**
 * expenseMethod.ts — 0.6.27: how an expense was paid, and how it shows on the Z-report (a prospect's requests 5 and 9).
 *
 * Owner, 2026-09-30: "When recording expenses add mode of payment so that its deducted correctly because some expenses
 * are paid using mpesa or cash" · "when recording expenses at the moment it capturing description on the zreport not
 * type of expense".
 *
 * Only a CASH expense leaves the drawer (expected cash). An expense paid by another method (M-Pesa, card…) comes off
 * that method's expected total instead — the M-Pesa statement shows the money going out. An expense recorded before
 * this (no method) was cash, as every expense was.
 *
 * ONE file: shared/expenseMethod.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

/**
 * A payment method code as stored on an expense — the payment codes' own format (^[a-z0-9_]{1,40}$, migration 89/111):
 * trimmed, lower-case, anything else becomes '_'. Empty → 'cash'.
 */
export function cleanExpenseMethod(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'cash';
}

/** Does this expense come out of the cash drawer? */
export function isDrawerExpense(method: unknown): boolean {
  return cleanExpenseMethod(method) === 'cash';
}

/**
 * Non-cash expenses per method ({ mpesa: 1200 }), rounded to cents — what comes off each method's expected total.
 * Cash is not in the map (it is already in expected cash).
 */
export function nonCashExpenses(rows: Array<{ amount: unknown; payment_method?: unknown }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const m = cleanExpenseMethod(r.payment_method);
    if (m === 'cash') continue;
    out[m] = Math.round(((out[m] ?? 0) + (Number(r.amount) || 0)) * 100) / 100;
  }
  return out;
}

/**
 * The Z-report line for an expense: the TYPE first ("Transport"), then what it was for when that adds anything, then
 * how it was paid when not cash — "Transport — boda to market · M-Pesa". No type → the description alone.
 */
export function expenseLabel(typeName: string | null | undefined, description: string | null | undefined,
                             method?: string | null, methodName?: string | null): string {
  const type = String(typeName ?? '').trim();
  const desc = String(description ?? '').trim();
  const base = type
    ? (desc && desc.toLowerCase() !== type.toLowerCase() ? `${type} — ${desc}` : type)
    : (desc || 'Expense');
  const m = cleanExpenseMethod(method);
  return m === 'cash' ? base : `${base} · ${methodName || KNOWN_METHODS[m] || m}`;
}

const KNOWN_METHODS: Record<string, string> = { mpesa: 'M-Pesa', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque' };
