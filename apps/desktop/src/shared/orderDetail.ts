/**
 * orderDetail.ts — A444: what is inside a past order — its items (with sizes, extras and notes), payments and money — in
 * one shape, whether it is read from a till's own database or from the cloud (GET /api/orders/:id).
 *
 * Owner, 2026-10-11: "the manager should be able to view items inside an order", with reprint and void / refund from
 * the same place, "on both online and desktop app". No screen showed an order's items: History and the Orders pages
 * listed only the bill. Pure; ONE file, copied to the till (shared + main) and the dashboard (check-shared-sync).
 */

export interface DetailLine {
  name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string | null;
  /** "Size: Large", "+ Cheese" — what was chosen on the line, in order. */
  options: string[];
  variants: Array<{ group: string; option: string; price: number }>;
  modifiers: Array<{ group: string; name: string; price: number }>;
}

export interface DetailPayment { method: string; amount: number; reference: string | null; status: string }

export interface OrderDetail {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  order_type: string;
  cashier_name: string | null;
  customer_name: string | null;
  table_number: string | null;
  delivery_person: string | null;
  notes: string | null;
  subtotal: number;
  vat_amount: number;
  ctl_amount: number;
  discount_amount: number;
  /** A445: the offers inside discount_amount, by name (the rest of it was the cashier's own discount). */
  offers: Array<{ name: string; amount: number }>;
  tip_amount: number;
  delivery_fee: number;
  delivery_free: boolean;
  total: number;
  refunded_amount: number;
  refund_reason: string | null;
  void_reason: string | null;
  voided_by_name: string | null;
  items: DetailLine[];
  payments: DetailPayment[];
  /** Where it was read: this till's own records, or the cloud. */
  source: 'till' | 'cloud';
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v));

/** One line's choices, as the receipt words them. */
export function lineOptions(variants: DetailLine['variants'], modifiers: DetailLine['modifiers']): string[] {
  return [
    ...variants.map((v) => `${v.group}: ${v.option}`),
    ...modifiers.map((m) => `+ ${m.name}`),
  ];
}

function line(raw: any, variants: any[], modifiers: any[]): DetailLine {
  const vs = variants.map((v) => ({ group: String(v.variant_group_name ?? ''), option: String(v.variant_option_name ?? ''), price: n(v.price_adjustment) }));
  const ms = modifiers.map((m) => ({ group: String(m.modifier_group_name ?? ''), name: String(m.modifier_option_name ?? ''), price: n(m.price) }));
  return {
    name: String(raw.product_name ?? raw.name ?? 'Item'),
    quantity: n(raw.quantity),
    unit_price: n(raw.unit_price),
    subtotal: n(raw.subtotal ?? n(raw.unit_price) * n(raw.quantity)),
    notes: s(raw.notes),
    options: lineOptions(vs, ms),
    variants: vs,
    modifiers: ms,
  };
}

/** orders.offers — a JSON list (the till keeps it as text, the cloud as jsonb). */
function offersOf(raw: unknown): Array<{ name: string; amount: number }> {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return (Array.isArray(v) ? v : []).map((x: any) => ({ name: String(x?.name ?? 'Offer'), amount: n(x?.amount) })).filter((x) => x.amount > 0);
}

function base(o: any, source: OrderDetail['source']): Omit<OrderDetail, 'items' | 'payments'> {
  return {
    id: String(o.id),
    order_number: String(o.order_number ?? ''),
    created_at: String(o.created_at ?? ''),
    status: String(o.status ?? 'completed'),
    order_type: String(o.order_type ?? 'retail'),
    cashier_name: s(o.cashier_name),
    customer_name: s(o.customer_name),
    table_number: s(o.table_number),
    delivery_person: s(o.delivery_person),
    notes: s(o.notes),
    subtotal: n(o.subtotal),
    vat_amount: n(o.vat_amount),
    ctl_amount: n(o.ctl_amount),
    discount_amount: n(o.discount_amount),
    offers: offersOf(o.offers),
    tip_amount: n(o.tip_amount),
    delivery_fee: n(o.delivery_fee),
    delivery_free: o.delivery_free === true || o.delivery_free === 1,
    total: n(o.total),
    refunded_amount: n(o.refunded_amount),
    refund_reason: s(o.refund_reason),
    void_reason: s(o.void_reason),
    voided_by_name: s(o.voided_by_name),
    source,
  };
}

const payment = (p: any): DetailPayment => ({
  method: String(p.method ?? ''), amount: n(p.amount), reference: s(p.reference), status: String(p.status ?? 'completed'),
});

/** The cloud's GET /api/orders/:id (order_items with order_item_variants / order_item_modifiers, payments). */
export function detailFromCloud(o: any): OrderDetail {
  const items = (Array.isArray(o?.order_items) ? o.order_items : []).map((i: any) =>
    line(i, Array.isArray(i.order_item_variants) ? i.order_item_variants : [], Array.isArray(i.order_item_modifiers) ? i.order_item_modifiers : []));
  return { ...base(o ?? {}, 'cloud'), items, payments: (Array.isArray(o?.payments) ? o.payments : []).map(payment) };
}

/** A till's own rows: the order, its items, their variants and modifiers (by order_item_id), its payments. */
export function detailFromLocal(order: any, items: any[], variants: any[], modifiers: any[], payments: any[]): OrderDetail {
  const by = (rows: any[], id: string) => rows.filter((r) => r.order_item_id === id);
  return {
    ...base(order, 'till'),
    items: items.map((i) => line(i, by(variants, i.id), by(modifiers, i.id))),
    payments: payments.map(payment),
  };
}

/**
 * The till's receipt payload (the shape queueThermal prints) rebuilt from a detail — for a reprint of a sale this till
 * holds no stored receipt for (another till's, or one older than the stored 200). Marked a duplicate by the caller.
 */
export function receiptPayloadFromDetail(d: OrderDetail): Record<string, unknown> {
  return {
    order_number: d.order_number,
    order_type: d.order_type,
    table_number: d.table_number ?? undefined,
    delivery_person: d.delivery_person ?? undefined,
    notes: d.notes,
    cashier_name: d.cashier_name ?? undefined,
    items: d.items.map((l) => ({
      product: { id: '', name: l.name },
      quantity: l.quantity,
      unitPrice: l.unit_price,
      lineTotal: l.subtotal,
      notes: l.notes,
      selectedVariants: l.variants.map((v) => ({ groupName: v.group, optionName: v.option })),
      selectedModifiers: l.modifiers.map((m) => ({ name: m.name, price: m.price })),
    })),
    payments: d.payments.filter((p) => p.amount > 0).map((p) => ({ method: p.method, amount: p.amount })),
    total: d.total,
    discount_amount: d.discount_amount,
    ...(d.offers.length ? { offers: d.offers } : {}),
    tip_amount: d.tip_amount,
    delivery_fee: d.delivery_fee,
    delivery_free: d.delivery_free,
  };
}
