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
export interface ReceiptUnitAttribute { group: string; option: string; count: number; priceDelta: number }
export interface ReceiptOrderUnit { name: string; quantity: number; portions: number; priceDelta: number; chosen: boolean; stationIds: []; attributes: ReceiptUnitAttribute[] }
export interface ReceiptOrderLine { name: string; quantity: number; unitPrice: number; lineTotal: number; units: ReceiptOrderUnit[]; stationIds: []; note?: string; measureUnit?: string }
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
  /** A349: discount off the lines (cents); the lines sum to total + discount. */
  discount?: number;
  /** A349: tip on top of the bill (cents); printed after the total, PAY = total + tip. */
  tip?: number;
  /** 0.6.27: delivery fee on top of the bill (cents); printed with the tip, PAY includes it. */
  deliveryFee?: number;
  /** 0.6.33: a free delivery — "Delivery: FREE", the fee not in PAY. */
  deliveryFree?: boolean;
  kotCount: number;
  /** A367: the note on the whole order. */
  note?: string;
  /** A607: the buyer's KRA PIN for this sale ("Buyer PIN: …"). */
  buyerPin?: string;
}
export interface ReceiptBusinessConfig {
  name: string;
  branchName?: string;    // A255: printed under the business name
  header?: string;        // A255: owner receipt_header (address/tagline), one line per line
  footerCredit?: string;  // A255: "Powered by ZapTill"
  logoRaster?: import('./escposRenderer').MonoRaster;  // A313: client logo, receipts only (A310)
  currencyCode: string;   // shared/printing renders the PAY line as `<currencyCode> <total>`
  kraPin?: string;
  telephone?: string;
  thankYouMessage?: string;
  /** A450: how a customer pays by M-Pesa — printed under the payments ("Buy Goods: 123456"). */
  tillLabel?: string;
  tillNumber?: string;
  vatRate: number;   // required by shared/printing's tax line
  ctlRate: number;   // required by shared/printing's tax line
  /** A530/A538: the admin portal's receipt switches (pos/init posFeatures); all false = the standard (classic layout at
   *  ~3.75 mm, small logo, 1-line feed). */
  receiptClassic?: { spacing: boolean; fullLogo: boolean; compactLayout: boolean; extraFeed: boolean };
  /** A551: the admin portal's 'kitchen_font_b' — kitchen tickets in Font B (A543); false = Font A (the standard). */
  kitchenFontB?: boolean;
  /** A580: false = a business with no kitchen (a shop, a petrol station, a car park, other) — no "Kots" line on its receipt. */
  kitchenTickets?: boolean;
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
  /** The BILL: after the discount, WITHOUT the tip. */
  total: number;
  /** A349: the discount taken off the cart lines. */
  discount?: number;
  /** A445: the offers inside `discount`, by name (each printed; the rest prints as "Discount:"). */
  offers?: Array<{ name: string; amount: number }>;
  /** A349: the tip on top of the bill. */
  tip?: number;
  /** 0.6.27: the delivery fee on top of the bill. */
  deliveryFee?: number;
  /** 0.6.33: a free delivery (the shop pays the rider). */
  deliveryFree?: boolean;
  change: number;
  payments: { method: string; amount: number }[];
  tableNumber?: string;
  comboItems?: Record<string, ComboComponent[]>;   // A248: combo_id -> components
  /** A367: the note on the whole order. */
  orderNote?: string | null;
  /** A607: the buyer's KRA PIN for this sale. */
  buyerPin?: string | null;
}): ReceiptOrder {
  return {
    billNumber:  a.orderNumber,
    orderType:   ORDER_TYPES[a.orderType] ?? 'counter',
    cashierName: a.cashierName || 'Cashier',
    soldAt:      new Date().toISOString(),
    tableNumber: a.tableNumber,
    lines: a.cart.map(c => {
      // Sub-items: combo components (from comboItems) first, then modifiers. Each becomes a named unit so kitchen/dispatch
      // tickets list what is in the item; the receipt shows them too. priceDelta stays 0 (names only) — the line's
      // lineTotal already carries the full price, so totals reconcile exactly. Components carry is_kitchen/category_id for
      // later routing (A248).
      // A551 (owner, 2026-10-21: "why not write `Chicken burger - Spicy` we avoid 2 lines of the same item"): the variants
      // as shared/printing's toUnits (routing.ts) gives them on the till — the options as the first component's
      // attributes, or, for a product without components, one unit of the product itself carrying them, which the renderer
      // prints on the item's own row ("Chicken Burger - Spicy"). Was one "Group: Option" unit per variant.
      const name = c.product?.name ?? 'Item';
      const combo = a.comboItems?.[c.product?.id ?? ''] ?? [];
      const units: ReceiptOrderUnit[] = combo.map(k => ({
        name: k.name, quantity: k.quantity, portions: 1, priceDelta: 0, chosen: false,
        stationIds: [] as [], attributes: [],
      }));
      const attrs: ReceiptUnitAttribute[] = (c.selectedVariants ?? []).filter(v => v.optionName)
        .map(v => ({ group: v.groupName ?? '', option: v.optionName, count: 1, priceDelta: 0 }));
      if (attrs.length && units.length) { units[0].attributes = attrs; units[0].chosen = true; }
      else if (attrs.length) units.push({ name, quantity: 1, portions: 1, priceDelta: 0, chosen: true, stationIds: [] as [], attributes: attrs });
      for (const m of c.selectedModifiers ?? []) {
        units.push({ name: m.optionName, quantity: 1, portions: 1, priceDelta: 0, chosen: false, stationIds: [] as [], attributes: [] });
      }
      return {
        name,
        quantity:  c.quantity,
        ...(c.measureUnit ? { measureUnit: c.measureUnit } : {}),   // A577: "0.452 kg @ 650/kg"
        unitPrice: toCents(c.unitPrice),
        lineTotal: toCents(c.lineTotal),
        units,
        stationIds: [] as [],
        note:      c.notes || undefined,   // A367
      };
    }),
    payments:    a.payments.map(p => ({ label: p.method, amount: toCents(p.amount) })),
    changeGiven: toCents(a.change),
    total:       toCents(a.total),
    discount:    toCents(a.discount ?? 0),
    ...(a.offers?.length ? { offers: a.offers.map((o) => ({ name: o.name, amount: toCents(o.amount) })) } : {}),   // A445
    tip:         toCents(a.tip ?? 0),
    deliveryFee: toCents(a.deliveryFee ?? 0),   // 0.6.27
    deliveryFree: a.deliveryFree === true,      // 0.6.33
    kotCount:    0,
    note:        a.orderNote || undefined,   // A367
    ...(a.buyerPin && /^[AP][0-9]{9}[A-Z]$/.test(a.buyerPin) ? { buyerPin: a.buyerPin } : {}),   // A607
  };
}

/**
 * A551: the item's name with its variants on one line — "Chicken Burger - Spicy" — as shared/printing's nameWithVariant
 * prints it on the thermal receipt (layout.ts; written out here so this file stays a pure mapper — the web receipt test
 * pins the two to the same answer). An option that starts with the product's name loses that repeat ("Chicken Burger
 * Spicy" -> "Spicy"); one that does not ("Large") is kept; an option that only repeats the name adds nothing.
 */
export function nameWithVariants(product: string, options: string[]): string {
  const name = product.trim();
  const strip = (o: string) => {
    const v = o.trim();
    if (name && v.slice(0, name.length).toLowerCase() === name.toLowerCase() && !/[A-Za-z0-9]/.test(v.charAt(name.length))) {
      return v.slice(name.length).replace(/^[\s\-:,/|]+/, '').trim();
    }
    return v;
  };
  const seen = new Set<string>();
  const parts = options.map(strip).filter(o => !!o && !seen.has(o.toLowerCase()) && !!seen.add(o.toLowerCase()));
  return parts.length ? `${name} - ${parts.join(', ')}` : name;
}

/** A530: the receipt_* switches as shared/printing takes them — posFeatures.ts receiptClassicFrom, written out here so
 *  this file stays a pure mapper with no runtime import (the web receipt test runs it type-stripped on plain node).
 *  tests/receipt-compact-a530.test.mjs pins the two to the same answer. Only a real `true` changes a part.
 *  A538: receipt_compact_layout opts in to A530's compact lines; the retired receipt_classic_layout is not read. */
function receiptClassic(f: Partial<Record<string, unknown>> | null | undefined): NonNullable<ReceiptBusinessConfig['receiptClassic']> {
  return { spacing: f?.receipt_classic_spacing === true, fullLogo: f?.receipt_full_logo === true,
           compactLayout: f?.receipt_compact_layout === true, extraFeed: f?.receipt_extra_feed === true };
}

/** A580: a restaurant or café — or a type not known yet (shared/businessTerms.ts isFoodService, written out here). */
export function kitchenBusiness(type: string | null | undefined): boolean {
  const t = String(type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return t === '' || t === 'restaurant' || t === 'cafe';
}

export function buildReceiptBusinessConfig(
  b: Business,
  footerMessage?: string,
  ctlRate = 0,
  extra: { branchName?: string; header?: string; footerText?: string;
           /** A450: the business's (or branch's) Buy Goods / Paybill line; null or no number = none. */
           pay?: { label: string; number: string } | null;
           /** A313: already resolved by the caller (toggle ON + decodable raster) — the builder never decides. */
           logoRaster?: import('./escposRenderer').MonoRaster | null;
           /** A530: the client's POS switches (pos/init, or GET /api/flags) — the receipt_* ones pick receipt parts. */
           posFeatures?: Partial<Record<string, unknown>> | null } = {},
): ReceiptBusinessConfig {
  return {
    receiptClassic:  receiptClassic(extra.posFeatures),   // A530
    // A551 (owner, 2026-10-21: "kitchen receipt use the same font as the despatcher"): posFeatures.kitchenFontBFrom,
    // written out for the same reason as receiptClassic — only a real `true` puts the kitchen ticket in Font B.
    kitchenFontB:    extra.posFeatures?.kitchen_font_b === true,
    // A580 (owner, 2026-10-23): a shop's receipt has no "Kots: 0" — only a restaurant or café (or a type not known yet,
    // as businessTerms' isFoodService) prints the Kots line. Written out (no import) for the same reason as above.
    kitchenTickets:  kitchenBusiness(b.type),
    logoRaster:      extra.logoRaster ?? undefined,
    name:            b.name,
    branchName:      extra.branchName || undefined,
    header:          extra.header || undefined,          // A255: owner address/tagline block
    footerCredit:    'Powered by ZapTill',              // A255: closing credit line
    currencyCode:    b.currency || 'KES',
    kraPin:          b.tax_pin ?? undefined,
    telephone:       b.phone ?? undefined,
    // The shared renderer prints thankYouMessage as the owner's footer box
    // (paybill / delivery no.). Owner receipt_footer wins; the per-device printer
    // footerMessage is the fallback. (A255 — was mapped to an ignored footerText.)
    thankYouMessage: extra.footerText || footerMessage || undefined,
    tillLabel:       extra.pay?.number?.trim() ? (extra.pay.label?.trim() || 'Buy Goods') : undefined,   // A450
    tillNumber:      extra.pay?.number?.trim() || undefined,
    // Rates must match what the business actually charges so the tax line equals
    // the desktop's. vat_rate comes from the business; CTL defaults to 0 unless
    // the business levies it (pass ctlRate through when it does).
    vatRate:         typeof b.vat_rate === 'number' ? b.vat_rate : 16,
    // A349: the business's own levy whenever a caller passes none — every web print passed 0, so a CTL business's
    // receipt showed no CTL and split the VAT on the wrong net.
    ctlRate:         ctlRate || Number((b as any)?.ctl_rate ?? 0) || 0,
  };
}
