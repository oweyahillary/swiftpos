/**
 * customerDisplayFeed.ts — A606: the cashier's POS → the customer screen. Loaded on first use (import() from POSPage), so
 * the POS's main chunk carries none of it. It maps the sale to the few fields the customer sees and sends them through
 * main, which CLEANS them (customerScreen.ts sanitiseDisplayState) before the customer screen gets anything. Unchanged
 * states are not sent.
 */
import { posApi } from './posApi';
import type { CartItem } from './cart';
import type { PaymentResult } from '../components/PaymentModal';

let last = '';
let timer: ReturnType<typeof setTimeout> | null = null;

export function sendDisplay(s: Record<string, unknown>): void {
  const j = JSON.stringify(s);
  if (j === last) return;
  last = j;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; posApi.customerDisplay?.update(s)?.catch?.(() => {}); }, 40);
}

/** The cart's lines as the customer sees them: the name, the options the receipt prints, quantity, prices, the offer. */
export const displayLines = (cart: CartItem[], byLine: Record<string, number>) => cart.map((i, n) => ({
  name: i.product?.name, qty: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal,
  unit: i.isFuel ? 'L' : (i.measureUnit ?? null), discount: byLine[i.lineId ?? String(n)] ?? 0,
  detail: [...(i.selectedVariants ?? []), ...(i.selectedModifiers ?? [])].map((o) => o.optionName).join(', '),
}));

/** What the payment screen hands over (PaymentModal onDisplay): the discount, the amount due and its legs. */
export interface PayDraft {
  discount: number; amountDue: number;
  legs: Array<{ method: string; tendered: string }>;
  view: Array<{ method: string; resolvedTendered: number; change: number }>;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** The payment as the customer sees it: the cash actually handed over (a cash leg with an amount typed), the change, and
 *  the method of the leg being paid (the last one). */
export function payFigures(d: PayDraft): { discount: number; amountDue: number; paid: number; change: number; method: string | null } {
  const cash = d.view.filter((l, i) => l.method === 'cash' && (d.legs[i]?.tendered ?? '').trim() !== '');
  return { discount: d.discount, amountDue: d.amountDue, method: d.view[d.view.length - 1]?.method ?? null,
    paid: r2(cash.reduce((a, l) => a + l.resolvedTendered, 0)), change: r2(cash.reduce((a, l) => a + l.change, 0)) };
}

export interface SaleView {
  paid?: PaymentResult | null;
  paying: boolean;
  cart: CartItem[];
  pay: PayDraft | null;
  mode: string; currency: string; table: string | null;
  byLine: Record<string, number>; subtotal: number; toPay: number; offerOff: number;
}

/** The POS's sale → the display state: a paid sale "Thank you", the payment screen "payment", items "sale", else idle. */
export function displayState(v: SaleView): Record<string, unknown> {
  const p = v.paid ?? undefined;
  const stage = p ? 'thanks' : v.paying ? 'payment' : v.cart.length ? 'sale' : 'idle';
  if (stage === 'idle') return { stage, mode: v.mode, currency: v.currency };
  const cash = p ? p.legs.filter((l) => l.method === 'cash') : [];
  const pay = v.pay ? payFigures(v.pay) : null;
  return {
    stage, mode: v.mode, currency: v.currency, table: v.table,
    lines: p ? [] : displayLines(v.cart, v.byLine), subtotal: p ? p.total + p.discountAmount : v.subtotal,
    discount: p ? p.discountAmount : pay?.discount ?? v.offerOff, total: p ? p.total : v.toPay,
    amountDue: p ? p.amountDue : pay?.amountDue ?? v.toPay,
    paid: p ? cash.reduce((a, l) => a + l.amount_tendered, 0) : pay?.paid ?? 0,
    change: p ? cash.reduce((a, l) => a + l.change_given, 0) : pay?.change ?? 0,
    method: p ? p.legs[p.legs.length - 1]?.method ?? null : pay?.method ?? null,
  };
}

export function feedCustomerDisplay(v: SaleView | null): void {
  sendDisplay(v ? displayState(v) : { stage: 'idle' });
}
