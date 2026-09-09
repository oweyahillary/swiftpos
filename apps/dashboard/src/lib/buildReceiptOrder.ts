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
import type { Business, ComboComponent } from '../types';

export type ReceiptOrderType = 'takeaway' | 'dine_in' | 'delivery' | 'counter';
export interface ReceiptOrderUnit { name: string; quantity: number; portions: number; priceDelta: number; chosen: boolean; stationIds: []; attributes: [] }
export interface ReceiptOrderLine { name: string; quantity: number; unitPrice: number; lineTotal: number; units: ReceiptOrderUnit[]; stationIds: []; note?: string }
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
  branchName?: string;    // A255: printed under the business name
  header?: string;        // A255: owner receipt_header (address/tagline), one line per line
  footerCredit?: string;  // A255: "Powered by SwiftPOS"
  currencyCode: string;   // shared/printing renders the PAY line as `<currencyCode> <total>`
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
  comboItems?: Record<string, ComboComponent[]>;   // A248: combo_id -> components
}): ReceiptOrder {
  return {
    billNumber:  a.orderNumber,
    orderType:   ORDER_TYPES[a.orderType] ?? 'counter',
    cashierName: a.cashierName || 'Cashier',
    soldAt:      new Date().toISOString(),
    tableNumber: a.tableNumber,
    lines: a.cart.map(c => {
      // Sub-items: combo components (from comboItems) first, then variants and
      // modifiers. Each becomes a named unit so kitchen/dispatch tickets list what
      // is in the item; the receipt shows them too. priceDelta stays 0 (names only)
      // — the line's lineTotal already carries the full price, so totals reconcile
      // exactly. Components carry is_kitchen/category_id for later routing (A248).
      const combo = a.comboItems?.[c.product?.id ?? ''] ?? [];
      const units = [
        ...combo.map(k => ({
          name: k.name, quantity: k.quantity, portions: 1, priceDelta: 0, chosen: false,
          stationIds: [] as [], attributes: [] as [],
        })),
        ...(c.selectedVariants ?? []).map(v => ({
          name: v.groupName ? `${v.groupName}: ${v.optionName}` : v.optionName,
          quantity: 1, portions: 1, priceDelta: 0, chosen: false, stationIds: [] as [], attributes: [] as [],
        })),
        ...(c.selectedModifiers ?? []).map(m => ({
          name: m.optionName, quantity: 1, portions: 1, priceDelta: 0, chosen: false, stationIds: [] as [], attributes: [] as [],
        })),
      ];
      return {
        name:      c.product?.name ?? 'Item',
        quantity:  c.quantity,
        unitPrice: toCents(c.unitPrice),
        lineTotal: toCents(c.lineTotal),
        units,
        stationIds: [] as [],
      };
    }),
    payments:    a.payments.map(p => ({ label: p.method, amount: toCents(p.amount) })),
    changeGiven: toCents(a.change),
    total:       toCents(a.total),
    kotCount:    0,
  };
}

export function buildReceiptBusinessConfig(
  b: Business,
  footerMessage?: string,
  ctlRate = 0,
  extra: { branchName?: string; header?: string; footerText?: string } = {},
): ReceiptBusinessConfig {
  return {
    name:            b.name,
    branchName:      extra.branchName || undefined,
    header:          extra.header || undefined,          // A255: owner address/tagline block
    footerCredit:    'Powered by SwiftPOS',              // A255: closing credit line
    currencyCode:    b.currency || 'KES',
    kraPin:          b.tax_pin ?? undefined,
    telephone:       b.phone ?? undefined,
    // The shared renderer prints thankYouMessage as the owner's footer box
    // (paybill / delivery no.). Owner receipt_footer wins; the per-device printer
    // footerMessage is the fallback. (A255 — was mapped to an ignored footerText.)
    thankYouMessage: extra.footerText || footerMessage || undefined,
    // Rates must match what the business actually charges so the tax line equals
    // the desktop's. vat_rate comes from the business; CTL defaults to 0 unless
    // the business levies it (pass ctlRate through when it does).
    vatRate:         typeof b.vat_rate === 'number' ? b.vat_rate : 16,
    ctlRate:         ctlRate,
  };
}
