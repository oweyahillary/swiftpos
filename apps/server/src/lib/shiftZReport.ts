/**
 * shiftZReport — A433 (owner, 2026-10-10: "under sales report it should cover all tills when logged in as the manager").
 *
 * A manager on till B opens till A's shift under Sales › Shift report. Till B does not hold that shift, so the cloud builds
 * its Z-report in the till's own shape (desktop ZReport, main/shiftService.ts) — the same screen and the same paper.
 * Figures as the cloud already counts them: completed orders, refund-adjusted (lib/orderTax.ts, applied by the route);
 * payments counted as the drawer counts them (completed, and refunds as their negative rows — computeExpectedCash);
 * expected cash as the close stored it (open: computed now). Pure and self-contained so the test runs it as it is.
 */

export interface ZOrder {
  /** A442: who rang it up (null on a row that recorded no one). */
  cashier_id?: string | null;
  gross: number; refunded: number; net: number; vat: number; ctl: number; tip: number;
  payments: Array<{ method: string; amount: number; status: string | null }>;
}

export interface ZShift {
  id: string; status: string; opened_at: string; closed_at: string | null; cashier_id: string | null;
  opening_float: number; closing_float: number | null; expected_cash: number | null; cash_variance: number | null;
  notes: string | null; confirmed_at: string | null; confirm_self?: boolean | null;
}

export interface ZLine { method: string; declared: number | null; expected: number | null; confirmed: number | null;
  variance: number | null; mismatch: boolean; reason?: string }

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
/** As the drawer counts: completed payments and the refunds' negative rows (computeExpectedCash, expectedByMethod). */
const inDrawer = (p: { status: string | null }) => !p.status || p.status === 'completed' || p.status === 'refunded';

/**
 * A442 (owner, 2026-10-11: "if two cashiers sell using the same shift we don't get the correct metrics … add each
 * cashier's section on the report"). Who sold what on one drawer — the till's rule (main/shiftService.ts computeZReport):
 * each person's orders, sales kept after refunds (the shift's netSales), and money by method counted as the drawer counts
 * (the shift's byMethod), so each column adds up to the shift's own figure. A row with no cashier: "Not recorded".
 */
export function shiftByCashier(orders: Array<Pick<ZOrder, 'cashier_id' | 'net' | 'payments'>>, names: Map<string, string>) {
  const by = new Map<string, { cashier_id: string | null; name: string; orders: number; sales: number; methods: Map<string, number> }>();
  for (const o of orders) {
    const id = o.cashier_id ?? null;
    const key = id ?? '';
    const row = by.get(key) ?? { cashier_id: id, name: id ? (names.get(id) ?? 'Unknown staff') : 'Not recorded', orders: 0, sales: 0, methods: new Map<string, number>() };
    by.set(key, row);
    row.orders += 1; row.sales += o.net;
    for (const p of o.payments) {
      if (!inDrawer(p)) continue;
      const m = String(p.method || 'other').toLowerCase();
      row.methods.set(m, (row.methods.get(m) ?? 0) + (Number(p.amount) || 0));
    }
  }
  return [...by.values()].map((c) => ({
    cashier_id: c.cashier_id, name: c.name, orders: c.orders, sales: r2(c.sales),
    byMethod: [...c.methods].map(([method, amount]) => ({ method, amount: r2(amount) }))
      .filter((m) => Math.round(m.amount * 100) !== 0).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
}

export function buildShiftZReport(input: {
  shift: ZShift;
  cashierName: string;
  orders: ZOrder[];
  /** A442: the names of the people who rang this shift's sales up. */
  people?: Map<string, string>;
  voidCount: number;
  floatTxns: Array<{ type: string; amount: number }>;
  /** Expenses on the shift; a cash one comes out of the drawer, another off its own method. */
  expenses: Array<{ description: string | null; amount: number; created_at: string; payment_method: string | null; paid_by_name: string | null }>;
  /** Expected cash now — for an open shift (a closed one carries what the close stored). */
  expectedNow: number | null;
  ctlLevied: boolean;
  /** A365: the cashier's declaration, what was recorded per method, the manager's recount, the reasons — and who. */
  confirmation: { declared: Record<string, number> | null; lines: ZLine[]; methods: string[]; confirmedByName: string | null } | null;
}) {
  const { shift, orders, floatTxns, expenses } = input;
  const byMethod = new Map<string, { amount: number; orders: number }>();
  let gross = 0, refunds = 0, net = 0, vat = 0, ctl = 0, tips = 0, cashSales = 0;
  for (const o of orders) {
    gross += o.gross; refunds += o.refunded; net += o.net; vat += o.vat; ctl += o.ctl; tips += o.tip;
    const seen = new Set<string>();
    for (const p of o.payments) {
      if (!inDrawer(p)) continue;
      const m = String(p.method || 'other').toLowerCase();
      const v = byMethod.get(m) ?? { amount: 0, orders: 0 };
      v.amount += Number(p.amount) || 0;
      if (!seen.has(m) && p.status !== 'refunded') { v.orders += 1; seen.add(m); }
      byMethod.set(m, v);
      if (m === 'cash') cashSales += Number(p.amount) || 0;
    }
  }
  const floatIn = floatTxns.filter(f => f.type === 'float_in').reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const floatOut = floatTxns.filter(f => f.type === 'float_out').reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const cashExp = expenses.filter(e => (e.payment_method ?? 'cash') === 'cash').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const otherExp: Record<string, number> = {};
  for (const e of expenses) {
    const m = String(e.payment_method ?? 'cash').toLowerCase();
    if (m !== 'cash') otherExp[m] = r2((otherExp[m] ?? 0) + (Number(e.amount) || 0));
  }
  const expectedCash = shift.status === 'open'
    ? (input.expectedNow ?? r2(shift.opening_float + cashSales + floatIn - floatOut - cashExp))
    : (shift.expected_cash ?? r2(shift.opening_float + cashSales + floatIn - floatOut - cashExp));

  const c = input.confirmation;
  return {
    shift: {
      id: shift.id, opened_at: shift.opened_at, closed_at: shift.closed_at, status: shift.status,
      cashier_id: shift.cashier_id, cashier_name: input.cashierName, opening_float: r2(shift.opening_float),
      closing_float: shift.closing_float == null ? null : r2(shift.closing_float),
      expected_cash: r2(expectedCash),
      cash_variance: shift.cash_variance == null ? null : r2(shift.cash_variance),
      notes: shift.notes,
    },
    byMethod: [...byMethod].map(([method, v]) => ({ method, amount: r2(v.amount), orders: v.orders }))
      .sort((a, b) => b.amount - a.amount),
    byCashier: shiftByCashier(orders, input.people ?? new Map()),   // A442
    totals: {
      orderCount: orders.length,
      grossSales: r2(gross), refunds: r2(refunds), netSales: r2(net),
      vat: r2(vat), ctl: r2(ctl), ctlLevied: input.ctlLevied || ctl > 0, tips: r2(tips),
      voidCount: input.voidCount,
      cashSales: r2(cashSales), floatIn: r2(floatIn), floatOut: r2(floatOut),
      expectedCash: r2(expectedCash),
      expenses: r2(cashExp),
      expensesByMethod: otherExp,
    },
    expenseLines: expenses.map(e => ({
      description: e.description ?? '', amount: r2(e.amount), created_at: e.created_at, paid_by_name: e.paid_by_name,
      payment_method: String(e.payment_method ?? 'cash'),
    })),
    confirmation: !c ? null : shift.confirmed_at
      ? { status: 'confirmed' as const, confirmed_by_name: c.confirmedByName, confirmed_at: shift.confirmed_at,
          self: !!shift.confirm_self, lines: c.lines }
      : { status: 'awaiting' as const, methods: c.methods, lines: c.lines },
  };
}
