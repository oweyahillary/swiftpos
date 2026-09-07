/**
 * printBill — render a web order to the THREE full-order stations (Customer
 * Receipt, Master KOT, Dispatcher) using shared/printing's renderers, and send
 * each to its configured printer via the tiny bridge, SILENTLY (no dialog).
 *
 * This replaces the old printGuestCheck(), which built ad-hoc HTML and printed
 * through a hidden iframe → the browser print dialog. Format now matches the
 * desktop (shared/printing → SAMPLE-OUTPUT.txt): customer receipt with the full
 * money/PAY/footer block, and KITCHEN / DISPATCH tickets listing every item.
 *
 * One printout per ENABLED full-order printer, so "3 printouts" requires all
 * three configured on the Printers page; whatever is configured fires.
 */
import { renderReceiptEscPos, renderKitchenEscPos, renderDispatchEscPos } from './escposRenderer';
import { getQZStatus, printBytesToServer } from './localPrintServer';
import { buildReceiptOrder, buildReceiptBusinessConfig } from './buildReceiptOrder';
import type { BranchPrinter } from './printKOT';
import type { CartItem } from './cart';
import type { Business } from '../types';

const RENDERERS: Record<string, (o: any, b: any, w: 58 | 80) => Uint8Array> = {
  receipt:   renderReceiptEscPos,   // Customer Receipt
  kot:       renderKitchenEscPos,   // Master KOT
  expeditor: renderDispatchEscPos,  // Dispatcher
};

// Emit order: KITCHEN first (food starts before anything else), then the
// CUSTOMER receipt, then the DISPATCHER packing copy last (A247).
const STATION_ORDER: Record<string, number> = { kot: 0, receipt: 1, expeditor: 2 };

export interface PrintBillArgs {
  cart: CartItem[];
  branchPrinters: BranchPrinter[];
  business: Business;
  orderNumber: string;
  orderType: string;
  cashierName: string;
  total: number;
  change?: number;
  payments?: { method: string; amount: number }[];
  tableNumber?: string;
  ctlRate?: number;
  footerMessage?: string;
}

export interface PrintBillResult { printed: number; failed: number; configured: number }

export async function printBillToStations(a: PrintBillArgs): Promise<PrintBillResult> {
  const order = buildReceiptOrder({
    orderNumber: a.orderNumber,
    orderType:   a.orderType,
    cashierName: a.cashierName,
    cart:        a.cart,
    total:       a.total,
    change:      a.change ?? 0,
    payments:    a.payments ?? [],
    tableNumber: a.tableNumber,
  });
  const biz = buildReceiptBusinessConfig(a.business, a.footerMessage, a.ctlRate ?? 0);

  const stations = a.branchPrinters
    .filter(p => p.enabled && !!RENDERERS[p.type] && !!p.printer_name)
    .sort((x, y) => (STATION_ORDER[x.type] ?? 9) - (STATION_ORDER[y.type] ?? 9));
  let printed = 0, failed = 0;
  for (const p of stations) {
    try {
      if (getQZStatus() === 'connected') {
        const bytes = RENDERERS[p.type](order, biz, p.paper_width);
        await printBytesToServer(`printer:${p.printer_name}`, bytes);
        printed++;
      } else {
        failed++;   // bridge down — caller decides on a browser fallback
      }
    } catch (err: any) {
      console.error(`[printBill] ${p.type} → ${p.printer_name} failed:`, err?.message);
      failed++;
    }
  }
  return { printed, failed, configured: stations.length };
}
