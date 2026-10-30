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
import { zBackupNote } from './syncNotice';
import { confirmationPrintLines } from '@zaptill/core/shiftConfirm';
import { kitchenVoidText } from '@zaptill/core/kitchenLines';
import { readPrinterSettings } from '../hooks/usePrinterSettings';   // A454

/** Money crosses into shared/printing as integer cents, never as a float. */
const toCents = (v: number | null | undefined) => Math.round((Number(v) || 0) * 100);

/**
 * A454: `cashierCopy` — the cashier's own slip at a blind close: what they declared per method, no sales, expected or
 * variance (shared/printing renderCashierCopy). The report then carries no figures the cashier may not see anyway.
 */
export async function printShiftReport(
  report: ZReport,
  opts: { cashierCopy?: { declared: Record<string, number> } } = {},
): Promise<{ ok: boolean; error?: string }> {
  const { shift, byMethod, totals, businessName, currency } = report;
  // A454: the till's receipt printer is the Z-report's printer. With no thermal Till station bound here, the main
  // process prints it to the Windows receipt printer chosen in Settings › Printers (else the Windows default) — the
  // same printer the customer receipt uses — instead of refusing.
  const ps = readPrinterSettings();
  const cashierCopy = opts.cashierCopy ? {
    declared: Object.entries(opts.cashierCopy.declared)
      .sort(([a], [b]) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)))
      .map(([method, v]) => ({ method, amount: toCents(v) })),
  } : null;

  return window.swiftpos.escpos.printShiftReport({
    cashierCopy,
    fallbackPrinter: ps.receiptPrinterName ?? '',
    fallbackPaperWidthMm: ps.paperWidth === 58 ? 58 : 80,
    businessName,
    currencyCode: currency ?? 'KES',

    // A442: more than one person sold on this drawer — the shift is the one who opened it; who sold what follows.
    cashierName: (report.byCashier?.length ?? 0) > 1 ? `${shift.cashier_name} (opened)` : shift.cashier_name,
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
    byCashier: (report.byCashier ?? []).map(c => ({
      name: c.name, orders: c.orders, sales: toCents(c.sales),
      byMethod: c.byMethod.map(m => ({ method: m.method, amount: toCents(m.amount) })),
    })),
    orderCount: totals.orderCount,
    grossSales: toCents(totals.grossSales),
    // A349: refunds / net / taxes / tips (absent on an older report → no line).
    refunds:    totals.refunds == null ? null : toCents(totals.refunds),
    netSales:   totals.netSales == null ? null : toCents(totals.netSales),
    vat:        totals.vat == null ? null : toCents(totals.vat),
    ctl:        totals.ctlLevied ? toCents(totals.ctl ?? 0) : null,
    tips:       totals.tips == null ? null : toCents(totals.tips),
    deliveryFees: totals.deliveryFees ? toCents(totals.deliveryFees) : null,   // 0.6.27
    freeDeliveries: totals.freeDeliveries ? toCents(totals.freeDeliveries) : null,   // 0.6.33
    riders: (totals.riders ?? []).map((x) => ({ ...x, feesPaid: toCents(x.feesPaid), freeFees: toCents(x.freeFees) })),   // 0.6.33
    voidCount:  totals.voidCount,

    openingFloat: toCents(shift.opening_float),
    cashSales:    toCents(totals.cashSales),
    // 0.6.27: the riders' pay-outs (and a void's pay-in back) on their own line; the other movements as before.
    floatIn:      toCents(totals.floatIn - (totals.riderReturned ?? 0)),
    floatOut:     toCents(totals.floatOut - (totals.riderPayouts ?? 0)),
    riderPayouts: totals.riderPayouts ? toCents(totals.riderPayouts - (totals.riderReturned ?? 0)) : null,
    otherExpenses: Object.entries(totals.expensesByMethod ?? {}).map(([method, v]) => ({ method, amount: toCents(v) })),
    // 0.6.11: the expenses already taken off expected cash, and their lines — so the paper adds up.
    expenses:     totals.expenses == null ? null : toCents(totals.expenses),
    // 0.6.27 (request 9): the expense TYPE first ("Transport — boda · M-Pesa"), not only the description.
    expenseLines: (report.expenseLines ?? []).map(e => ({ description: e.label ?? e.description, amount: toCents(e.amount) })),
    // 0.6.37 (A388): the cash-outs and who approved each ("Gas refill · approved Mary").
    payoutLines: (report.payoutLines ?? []).map(p => ({ description: p.label, amount: toCents(p.amount) })),
    // A363: what of the shift is not on the cloud yet — the same words as the on-screen report.
    backupNote: zBackupNote(report.notBackedUp),
    // 0.6.28: kitchen voids — what was sent and taken back, why, and who approved.
    kitchenVoids: (report.kitchenVoids?.lines.length ?? 0) > 0 ? {
      lines: report.kitchenVoids!.lines.map(v => ({ description: kitchenVoidText(v), amount: toCents(v.amount) })),
      total: toCents(report.kitchenVoids!.summary.value),
      madeTotal: toCents(report.kitchenVoids!.summary.cookedValue),
    } : null,
    // A365: the manager's confirmation (or "AWAITING MANAGER CHECK") — the same lines as the on-screen report.
    confirmLines: confirmationPrintLines(report.confirmation, (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    // A342: the web's own shift on this till, counted in this drawer (absent → no line).
    siblingCash:  (totals.foreign?.siblings?.count ?? 0) > 0 ? toCents(totals.foreign!.siblings!.expected) : null,
    // The shift's own figure, not the totals block: once a shift is closed the
    // stored expected_cash is what was reconciled against, and recomputing it
    // here could quietly disagree with the number the cashier signed off.
    expectedCash: toCents(shift.expected_cash ?? totals.expectedCash),

    countedCash: shift.closing_float == null ? null : toCents(shift.closing_float),
    variance:    shift.cash_variance == null ? null : toCents(shift.cash_variance),
    notes:       shift.notes,
  }) as Promise<{ ok: boolean; error?: string }>;
}
