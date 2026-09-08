/**
 * printShiftReport — print a shift's Z-report / reconciliation using the SAME
 * shared renderer the desktop uses (renderShiftReport). Fetches the shift detail
 * (GET /api/shifts/:id, which carries the payment breakdown + cash reconciliation),
 * maps it into ShiftReportData, and sends the bytes to the branch receipt printer
 * via the bridge (till only). Not a redesign — the desktop's report on web. (A262)
 */
import { renderShiftReportEscPos } from './escposRenderer';
import { getQZStatus, printBytesToServer } from './localPrintServer';
import { api } from './api';
import type { BranchPrinter } from './printKOT';

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);

export async function printShiftReport(shiftId: string): Promise<{ ok: boolean; message: string }> {
  if (getQZStatus() !== 'connected') {
    return { ok: false, message: 'Print server not connected on this device — open the till to print.' };
  }

  let shift: any;
  try { shift = await api.get<any>(`/api/shifts/${shiftId}`); }
  catch (e: any) { return { ok: false, message: e?.message ?? 'Could not load the shift.' }; }

  const [business, printers] = await Promise.all([
    api.get<any>('/api/business').catch(() => ({ name: 'SwiftPOS', currency: 'KES' })),
    api.get<BranchPrinter[]>(`/api/printers?branch_id=${shift.branch_id}`).catch(() => [] as BranchPrinter[]),
  ]);

  const receipt = (printers ?? []).find(p => p.enabled && !!p.printer_name && (p.is_default_receipt || p.type === 'receipt'));
  if (!receipt) return { ok: false, message: 'No receipt printer is configured for this branch.' };

  const data = {
    businessName: business?.name ?? 'SwiftPOS',
    branchName:   shift.branch_name ?? undefined,
    currencyCode: business?.currency ?? 'KES',

    cashierName:  shift.cashier_name ?? 'Unknown',
    shiftRef:     String(shift.id).slice(0, 8),
    openedAt:     new Date(shift.opened_at),
    closedAt:     shift.closed_at ? new Date(shift.closed_at) : null,
    status:       shift.status,

    byMethod:     (shift.by_method ?? []).map((m: any) => ({ method: m.method, orders: m.orders, amount: cents(m.amount) })),
    orderCount:   shift.order_count ?? 0,
    grossSales:   cents(shift.total_revenue),
    voidCount:    0,

    openingFloat: cents(shift.opening_float),
    cashSales:    cents(shift.cash_sales),
    floatIn:      cents(shift.float_in),
    floatOut:     cents(shift.float_out),
    // Stored expected_cash once closed; the live computed figure while open.
    expectedCash: cents(shift.expected_cash ?? shift.expected_cash_computed ?? 0),

    countedCash:  shift.closing_float == null ? null : cents(shift.closing_float),
    variance:     shift.cash_variance == null ? null : cents(shift.cash_variance),
    notes:        shift.notes ?? null,
    printedAt:    new Date(),
    footerCredit: 'Powered by SwiftPOS',
  };

  try {
    const bytes = renderShiftReportEscPos(data as any, receipt.paper_width);
    await printBytesToServer(`printer:${receipt.printer_name}`, bytes);
    return { ok: true, message: `Shift report sent to ${receipt.printer_name}.` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Shift report print failed.' };
  }
}
