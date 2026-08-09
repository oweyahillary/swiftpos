/**
 * printShiftReport — send the shift report / Z-report to the thermal printer.
 *
 * Replaces two different HTML routes that did the same job badly:
 *
 *   ManagerPage  printReceipt(ref.innerHTML, …)  — offscreen-window print, whose
 *                page height was measured at 800px while printing at 302px, so
 *                the report stopped mid-way and lost the cash reconciliation.
 *
 *   ShiftPanel   window.open(…).print()          — the browser's own dialog. It
 *                prompts, it spools through the driver, and it rasterises. On a
 *                thermal roll that is slow and it wraps unpredictably.
 *
 * Both are now one call into the same renderer every other ticket uses, so the
 * column arithmetic comes from the print head's dot count rather than a browser
 * guess, and 58mm is laid out by the same code as 80mm.
 */
import type { ZReport } from './posApi';

/** Money crosses into shared/printing as integer cents, never as a float. */
const toCents = (v: number | null | undefined) => Math.round((Number(v) || 0) * 100);

export async function printShiftReport(
  report: ZReport,
): Promise<{ ok: boolean; error?: string }> {
  const { shift, byMethod, totals, businessName, currency } = report;

  return window.swiftpos.escpos.printShiftReport({
    businessName,
    currencyCode: currency ?? 'KES',

    cashierName: shift.cashier_name,
    // Eight characters is what the owner is asked to quote when something needs
    // looking up. A full uuid on paper is unreadable and nobody copies it.
    shiftRef:    shift.id.slice(0, 8),
    openedAt:    shift.opened_at,
    closedAt:    shift.closed_at,
    status:      shift.status,

    byMethod: byMethod.map(m => ({
      method: m.method,
      orders: m.orders,
      amount: toCents(m.amount),
    })),
    orderCount: totals.orderCount,
    grossSales: toCents(totals.grossSales),
    voidCount:  totals.voidCount,

    openingFloat: toCents(shift.opening_float),
    cashSales:    toCents(totals.cashSales),
    floatIn:      toCents(totals.floatIn),
    floatOut:     toCents(totals.floatOut),
    // The shift's own figure, not the totals block: once a shift is closed the
    // stored expected_cash is what was reconciled against, and recomputing it
    // here could quietly disagree with the number the cashier signed off.
    expectedCash: toCents(shift.expected_cash ?? totals.expectedCash),

    countedCash: shift.closing_float == null ? null : toCents(shift.closing_float),
    variance:    shift.cash_variance == null ? null : toCents(shift.cash_variance),
    notes:       shift.notes,
  }) as Promise<{ ok: boolean; error?: string }>;
}
