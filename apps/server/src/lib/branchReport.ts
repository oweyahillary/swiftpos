/**
 * branchReport — A431 / A432 (owner, 2026-10-09: "the manager should view sales across all tills no matter the till they
 * have logged into … and add a shift report in the overview").
 *
 * The till's Overview read only the till's own database, and every shift query on the till is that till's alone, so a
 * manager on till B never saw till A. The cloud holds every till's sales and shifts; GET /api/shifts/branch-report hands a
 * manager on ANY till (through the branch server on a till behind one, A410) the branch's figures in the shape the till's
 * Overview already draws, plus every shift.
 *
 * Pure: the route fetches and refund-adjusts the rows (lib/orderTax.ts — the one place for that), this shapes them.
 * Self-contained on purpose (no imports) so the test runs it as it is.
 */

export interface BranchOrder {
  id: string;
  created_at: string;
  device_id: string | null;
  shift_id: string | null;
  /** A440: who rang the sale up (the person signed in, not the shift's owner); null on an old row. */
  cashier_id?: string | null;
  /** From orderTax: before refunds, handed back, kept (gross − refunded), VAT and levy reduced by the refunded share. */
  gross: number; refunded: number; net: number; vat: number; ctl: number;
  discount: number; tip: number;
  payments: Array<{ method: string; amount: number; status: string | null }>;
}

export interface BranchShift {
  id: string;
  device_id: string | null;
  terminal_code: string | null;
  cashier_id: string | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  closing_float: number | null;
  expected_cash: number | null;
  cash_variance: number | null;
  close_method?: string | null;
  declared_methods: unknown;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export interface TillName { device_id: string; terminal_code: string | null; device_label: string | null }

export type ShiftState = 'open' | 'awaiting' | 'confirmed' | 'closed';

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
/** A payment the drawer and the method split count — the same rule as GET /api/shifts/:id and /api/reports/sales. */
const counts = (p: { status: string | null }) => !p.status || p.status === 'completed';

/** Where a shift stands — the web's Shift reports words (A365). */
export function shiftState(s: Pick<BranchShift, 'status' | 'declared_methods' | 'confirmed_at'>): ShiftState {
  if (s.status === 'open') return 'open';
  if (s.confirmed_at) return 'confirmed';
  if (s.declared_methods != null) return 'awaiting';
  return 'closed';
}

/** The till's name as people know it: its code, else its label, else "Web Till" (a web POS drawer has no device). */
export function tillLabel(deviceId: string | null, terminalCode: string | null, names: Map<string, TillName>): string {
  const d = deviceId ? names.get(deviceId) : undefined;
  return d?.terminal_code || terminalCode || d?.device_label || (deviceId ? 'Till' : 'Web Till');
}

/** The hour of the day where the branch is (minutes east of UTC; Kenya 180) — the till's Overview draws local hours. */
export function localHour(iso: string, tzOffsetMin: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return new Date(t + tzOffsetMin * 60_000).getUTCHours();
}

export function buildBranchReport(input: {
  /** Every completed order at the branch in the range (the Overview's figures). */
  orders: BranchOrder[];
  /** The shifts to list. */
  shifts: BranchShift[];
  /** Completed orders of those shifts, whenever rung (a shift opened before the range still shows all its sales). */
  shiftOrders: BranchOrder[];
  names: Map<string, TillName>;
  people: Map<string, string>;
  /** Expected cash now, for open shifts (closed ones carry what the close stored). */
  expectedOpen: Map<string, number>;
  tzOffsetMin: number;
}) {
  const { orders, shifts, shiftOrders, names, people, expectedOpen, tzOffsetMin } = input;

  // ── The Overview's figures, for the whole branch ──
  let gross = 0, refunded = 0, net = 0, vat = 0, ctl = 0, discount = 0, tips = 0;
  const methods: Record<string, number> = {};
  const hours = new Map<number, { revenue: number; orders: number }>();
  const tills = new Map<string, { device_id: string | null; label: string; orders: number; revenue: number }>();
  for (const o of orders) {
    gross += o.gross; refunded += o.refunded; net += o.net; vat += o.vat; ctl += o.ctl; discount += o.discount; tips += o.tip;
    for (const p of o.payments) if (counts(p)) methods[p.method] = (methods[p.method] ?? 0) + (Number(p.amount) || 0);
    const h = localHour(o.created_at, tzOffsetMin);
    const hv = hours.get(h) ?? { revenue: 0, orders: 0 };
    hv.revenue += o.net; hv.orders += 1; hours.set(h, hv);
    const key = o.device_id ?? '';
    const tv = tills.get(key) ?? { device_id: o.device_id, label: tillLabel(o.device_id, null, names), orders: 0, revenue: 0 };
    tv.orders += 1; tv.revenue += o.net; tills.set(key, tv);
  }

  // ── Every shift, with its own sales ──
  const byShift = new Map<string, BranchOrder[]>();
  for (const o of shiftOrders) if (o.shift_id) {
    const list = byShift.get(o.shift_id) ?? []; list.push(o); byShift.set(o.shift_id, list);
  }
  const shiftRows = shifts.map((s) => {
    const mine = byShift.get(s.id) ?? [];
    const by: Record<string, number> = {};
    for (const o of mine) for (const p of o.payments) if (counts(p)) by[p.method] = (by[p.method] ?? 0) + (Number(p.amount) || 0);
    const state = shiftState(s);
    const expected = state === 'open' ? (expectedOpen.has(s.id) ? expectedOpen.get(s.id)! : null) : s.expected_cash;
    return {
      id: s.id,
      device_id: s.device_id,
      till: tillLabel(s.device_id, s.terminal_code, names),
      cashier: (s.cashier_id && people.get(s.cashier_id)) || 'Unknown',
      opened_at: s.opened_at,
      closed_at: s.closed_at,
      state,
      force_closed: s.close_method === 'forced',
      confirmed_by: s.confirmed_by ? (people.get(s.confirmed_by) ?? null) : null,
      opening_float: r2(s.opening_float),
      orders: mine.length,
      sales: r2(mine.reduce((t, o) => t + o.net, 0)),
      by_method: Object.entries(by).map(([method, amount]) => ({ method, amount: r2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      expected_cash: expected == null ? null : r2(expected),
      counted_cash: state === 'open' || s.closing_float == null ? null : r2(s.closing_float),
      variance: state === 'open' || s.cash_variance == null ? null : r2(s.cash_variance),
    };
  }).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || b.opened_at.localeCompare(a.opened_at));

  // ── A440: staff performance — each person's sales in the range, by who rang them up (an old row with no cashier:
  // the shift's owner), and their money by payment method (each sale's kept total shared over its payments). ──
  const shiftOwner = new Map(shifts.map((s) => [s.id, s.cashier_id]));
  const staff = new Map<string, { id: string; name: string; orders: number; revenue: number; methods: Record<string, number> }>();
  for (const o of orders) {
    const id = o.cashier_id || (o.shift_id ? shiftOwner.get(o.shift_id) : null) || '';
    const row = staff.get(id) ?? { id, name: (id && people.get(id)) || 'Unknown', orders: 0, revenue: 0, methods: {} };
    staff.set(id, row);
    row.orders += 1; row.revenue += o.net;
    const parts = o.payments.filter((p) => counts(p) && Number(p.amount) > 0);
    const paid = parts.reduce((t, p) => t + Number(p.amount), 0);
    if (!parts.length || paid <= 0) { row.methods.unpaid = (row.methods.unpaid ?? 0) + o.net; continue; }
    for (const p of parts) row.methods[p.method] = (row.methods[p.method] ?? 0) + o.net * (Number(p.amount) / paid);
  }
  const byStaff = [...staff.values()].map((s) => ({
    id: s.id, name: s.name, orders: s.orders, revenue: r2(s.revenue), avg: s.orders ? r2(s.revenue / s.orders) : 0,
    by_method: Object.entries(s.methods).map(([method, amount]) => ({ method, amount: r2(amount) }))
      .filter((m) => m.amount !== 0).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

  const count = orders.length;
  return {
    summary: {
      totalRevenue: r2(net),
      totalOrders: count,
      avgOrderValue: count > 0 ? r2(net / count) : 0,
      totalVat: r2(vat),
      totalCtl: r2(ctl),
      totalRefunded: r2(refunded),
      grossBeforeRefunds: r2(gross),
      totalDiscount: r2(discount),
      totalTips: r2(tips),
    },
    paymentMethods: Object.fromEntries(Object.entries(methods).map(([m, a]) => [m, r2(a)])),
    hourly: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, revenue: r2(v.revenue), orders: v.orders })),
    byTill: [...tills.values()].map((t) => ({ ...t, revenue: r2(t.revenue) })).sort((a, b) => b.revenue - a.revenue),
    shifts: shiftRows,
    byStaff,
  };
}
