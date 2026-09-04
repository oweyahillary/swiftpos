/**
 * buildReceiptOrder — map a completed web sale to the EXACT Order shape that
 * shared/printing renders (the desktop's receipt format). This is a PURE data
 * mapper: it produces JSON only (no rendering, no Buffer), so it runs safely in
 * the browser. The print-server then renders this Order with shared/printing's
 * renderTicket/toEscPos — the same code the desktop till uses — so the printed
 * receipt is byte-identical to desktop (A209, option B: server renders).
 *
 * The types below mirror shared/printing's Order/BusinessConfig JSON shape
 * deliberately (not imported) so the web build stays decoupled from the package.
 * Money is integer CENTS, exactly as shared/printing expects.
 */
import type { CartItem } from './cart';
import type { Business } from '../types';

export type ReceiptOrderType = 'takeaway' | 'dine_in' | 'delivery' | 'counter';
export interface ReceiptOrderLine { name: string; quantity: number; unitPrice: number; lineTotal: number; units: []; stationIds: []; note?: string }
export interface ReceiptPaymentLeg { label: string; amount: number }
export interface ReceiptOrder {
  billNumber: string;
  orderType: ReceiptOrderType;
  cashierName: string;
  soldAt: string;              // ISO; the print-server revives it to a Date
  tableNumber?: string;
  lines: ReceiptOrderLine[];
  payments: ReceiptPaymentLeg[];
  changeGiven: number;
  total: number;
  kotCount: number;
}
export interface ReceiptBusinessConfig {
  name: string;
  branchName?: string;
  kraPin?: string;
  telephone?: string;
  thankYouMessage?: string;
  vatRate: number;   // required by shared/printing's tax line
  ctlRate: number;   // required by shared/printing's tax line
}

const toCents = (n: number) => Math.round((Number(n) || 0) * 100);

const ORDER_TYPES: Record<string, ReceiptOrderType> = {
  takeaway: 'takeaway', dine_in: 'dine_in', delivery: 'delivery', counter: 'counter', retail: 'counter',
};

export function buildReceiptOrder(a: {
  orderNumber: string;
  orderType: string;
  cashierName: string;
  cart: CartItem[];
  total: number;
  change: number;
  payments: { method: string; amount: number }[];
  tableNumber?: string;
}): ReceiptOrder {
  return {
    billNumber:  a.orderNumber,
    orderType:   ORDER_TYPES[a.orderType] ?? 'counter',
    cashierName: a.cashierName || 'Cashier',
    soldAt:      new Date().toISOString(),
    tableNumber: a.tableNumber,
    lines: a.cart.map(c => ({
      name:      c.product?.name ?? 'Item',
      quantity:  c.quantity,
      unitPrice: toCents(c.unitPrice),
      lineTotal: toCents(c.lineTotal),
      units:     [] as [],
      stationIds: [] as [],
      note: c.selectedModifiers?.length
        ? c.selectedModifiers.map(m => (m as any).name).filter(Boolean).join(', ')
        : undefined,
    })),
    payments:    a.payments.map(p => ({ label: p.method, amount: toCents(p.amount) })),
    changeGiven: toCents(a.change),
    total:       toCents(a.total),
    kotCount:    0,
  };
}

export function buildReceiptBusinessConfig(b: Business, footerMessage?: string, ctlRate = 0): ReceiptBusinessConfig {
  return {
    name:            b.name,
    kraPin:          b.tax_pin ?? undefined,
    telephone:       b.phone ?? undefined,
    thankYouMessage: footerMessage || undefined,
    // Rates must match what the business actually charges so the tax line equals
    // the desktop's. vat_rate comes from the business; CTL defaults to 0 unless
    // the business levies it (pass ctlRate through when it does).
    vatRate:         typeof b.vat_rate === 'number' ? b.vat_rate : 16,
    ctlRate:         ctlRate,
  };
}
