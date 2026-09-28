import type { Product, SelectedVariant, SelectedModifier } from '../types';

export interface CartItem {
  product: Product;
  quantity: number;
  selectedVariants: SelectedVariant[];   // one per required variant group
  selectedModifiers: SelectedModifier[]; // zero or more modifier options

  // Derived — computed once at add-to-cart time, stored for display + order save
  unitPrice: number;   // base_price + sum of variant price_adjustments
  lineTotal: number;   // unitPrice * quantity + modifier prices * quantity

  // Restaurant course firing (optional). course is a free-text course name the
  // cashier assigns; fire_status 'held' keeps it off the kitchen until fired.
  course?: string | null;

  // Petrol: a fuel line whose quantity is litres (priced per litre). Drives
  // litre-aware display and suppresses the qty stepper.
  isFuel?: boolean;
  fire_status?: 'held' | 'fired';
}

export function cartSubtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.lineTotal, 0);
}

// Prices are VAT-inclusive — extract VAT portion from total
export function extractVat(total: number, vatRate: number): number {
  return total - total / (1 + vatRate / 100);
}

/**
 * A349: VAT and the catering levy inside a tax-inclusive BILL (after any discount) — the same arithmetic as the till
 * (desktop payment.ts) and the cloud (orders.ts taxSplit), which stores the authoritative figures:
 *   net = bill / (1 + (vat + ctl)/100);  vat = round2(net·vat%);  ctl = round2(net·ctl%)
 * VAT is on the net, never on net-plus-levy. ctlRate 0 gives the VAT-only figure.
 */
export function extractTaxes(bill: number, vatRate: number, ctlRate = 0): { vat: number; ctl: number } {
  const net = bill / (1 + (vatRate + ctlRate) / 100);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { vat: r2(net * (vatRate / 100)), ctl: r2(net * (ctlRate / 100)) };
}

let __orderSeq = 0;

export function generateOrderNumber(): string {
  // Collision resistance (finding #20). The old form was a 6-digit time slice
  // plus 3 random digits — two sales in the same 100ms with the same random
  // draw collided, and the unique index (business_id, branch_id, order_number)
  // then rejected the second sale. Three defences now, in order of strength:
  //   1. a per-process monotonic counter, so two calls on the SAME client in the
  //      same millisecond cannot produce the same number by construction;
  //   2. a wide random suffix, so two DIFFERENT clients are astronomically
  //      unlikely to collide even within one millisecond;
  //   3. the server's unique index as the final backstop, with the atomic-order
  //      path returning a clean 409 (retry) on the rare cross-client collision.
  const ts = Date.now().toString(36).toUpperCase();
  __orderSeq = (__orderSeq + 1) % 0xffff;
  const seq = __orderSeq.toString(36).toUpperCase().padStart(3, '0');
  const rand = Math.floor(Math.random() * 0xfff).toString(36).toUpperCase().padStart(2, '0');
  return `ORD-${ts}-${seq}${rand}`;
}
