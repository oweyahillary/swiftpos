/**
 * shopPos.ts — what changes when the web POS screens run inside the ZapTill Android app's Shop POS (Till stage 1,
 * docs/ANDROID-APP-DESIGN.md §11). In the browser nothing here is set, and every screen behaves exactly as before.
 *
 * The Shop POS is a POS of its own (A415: it joined with an enrolment code and has its own device id), not a browser
 * covering a desktop POS (A273). So, when the Android app registers itself here at start:
 *   - terminal    this POS — its drawer is its own: shifts and sales key to its device id, there is no "which POS are you
 *                 selling on?" (lib/posTerminal.ts), and a cashier signing in sells into its running shift, as on the
 *                 desktop;
 *   - printBytes  ESC/POS bytes straight to a network printer (the Android app's TCP plugin), where the browser hands them
 *                 to the print bridge on the PC (lib/localPrintServer.ts);
 *   - printOrder  the whole ticket to the branch server, which prints it with ITS stations, printers and spool (owner,
 *                 2026-11-05: "so that printing can be easier"); null when the tablet joined no branch server or cannot
 *                 reach it, and the screens then print directly.
 * One seam, set once; the web POS screens are not copied (owner, 2026-11-04: one POS design).
 */
import { setOwnTerminal, type CoveredTerminal } from './posTerminal';
import { setDirectPrinter } from './localPrintServer';

/** The kinds the branch server prints (apps/desktop nodePrintRelay.ts takes the same). */
export type ServerPrintJob = 'receipt' | 'kitchen' | 'proforma' | 'void';

/** What the branch server answered: how many stations printed, and words for what did not. */
export interface ServerPrintAnswer { printed: number; failed: number; configured: number; problem: string | null }

export interface ShopPosHost {
  terminal: CoveredTerminal;
  printBytes: (target: string, bytes: Uint8Array) => Promise<void>;
  /** null = no branch server to print through (none joined, or not reachable): print directly. */
  printOrder: (job: ServerPrintJob, order: Record<string, unknown>) => Promise<ServerPrintAnswer | null>;
}

let host: ShopPosHost | null = null;

/**
 * The Android app, once, before the POS screens open. Never called in a browser. posTerminal and localPrintServer are
 * told their part here (they keep no imports: the tests load them as they are).
 */
export function setShopPosHost(h: ShopPosHost | null): void {
  host = h;
  setOwnTerminal(h?.terminal ?? null);
  setDirectPrinter(h ? h.printBytes : null);
}

/** The Shop POS this page runs in, or null in a browser. */
export function shopPosHost(): ShopPosHost | null { return host; }

/** One web POS cart line, as the branch server's printer takes it (apps/desktop escposBridge CartLine — the same names). */
interface CartLineLike {
  product?: { id?: string; name?: string; category_id?: string | null; description?: string | null } | null;
  quantity: number; unitPrice: number; lineTotal: number;
  measureUnit?: string | null; notes?: string | null; course?: string | null;
  selectedVariants?: unknown; selectedModifiers?: unknown;
}

/**
 * The order as the branch server's queueThermal takes it (apps/desktop ipc/shared.ts) — built from what the web POS
 * screens print with. Pure, so tests/android-till-stage1.test.mjs runs it.
 */
export function serverPrintOrder(a: {
  orderNumber: string; orderType: string; cashierName: string; total: number;
  cart: CartLineLike[]; comboItems?: Record<string, unknown[]>;
  discount?: number; tip?: number; change?: number; deliveryFee?: number; deliveryFree?: boolean;
  payments?: { method: string; amount: number }[]; offers?: { name: string; amount: number }[];
  tableNumber?: string; orderNote?: string | null; buyerPin?: string;
  voided?: { by?: string; reason?: string };
}): Record<string, unknown> {
  return {
    order_number: a.orderNumber,
    order_type: a.orderType,
    cashier_name: a.cashierName,
    table_number: a.tableNumber ?? null,
    notes: a.orderNote ?? null,
    items: a.cart.map((l) => ({
      product: { id: l.product?.id ?? '', name: l.product?.name ?? 'Item', category_id: l.product?.category_id ?? null,
                 description: l.product?.description ?? null },
      quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
      measureUnit: l.measureUnit ?? null, notes: l.notes ?? null, course: l.course ?? null,
      selectedVariants: l.selectedVariants ?? [], selectedModifiers: l.selectedModifiers ?? [],
      ...(a.comboItems?.[l.product?.id ?? ''] ? { comboComponents: a.comboItems[l.product?.id ?? ''] } : {}),
    })),
    payments: a.payments ?? [],
    change_given: a.change ?? 0,
    total: a.total,
    discount_amount: a.discount ?? 0,
    ...(a.offers?.length ? { offers: a.offers } : {}),
    tip_amount: a.tip ?? 0,
    delivery_fee: a.deliveryFee ?? 0,
    delivery_free: a.deliveryFree === true,
    ...(a.buyerPin ? { buyer_kra_pin: a.buyerPin } : {}),
    ...(a.voided ? { kitchen_void: { by: a.voided.by ?? '', reason: a.voided.reason ?? '' } } : {}),
  };
}

/**
 * The branch-server jobs one web POS print makes: Print bill (proforma), a kitchen VOID, or the kitchen fire and/or the
 * receipt, in the desktop's order (kitchen first). Pure.
 */
export function serverJobsOf(a: { kinds?: string[]; proforma?: boolean; voided?: unknown }): ServerPrintJob[] {
  if (a.proforma) return ['proforma'];
  if (a.voided) return ['void'];
  const kinds = a.kinds ?? ['receipt', 'kitchen', 'dispatch'];
  const jobs: ServerPrintJob[] = [];
  if (kinds.some((k) => k !== 'receipt')) jobs.push('kitchen');
  if (kinds.includes('receipt')) jobs.push('receipt');
  return jobs;
}
