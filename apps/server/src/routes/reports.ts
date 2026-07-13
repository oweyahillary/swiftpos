import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import type { ReportOrderRow, DbShift, DbFloatTransaction } from '../lib/dbTypes';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);   // reports are a web-portal surface — block desktop tokens

/**
 * chunkIn — safe replacement for Supabase .in() with large arrays.
 *
 * Supabase/PostgREST encodes .in() as a URL query param. At ~2,000 IDs
 * the URL exceeds the 8KB limit and the request silently fails with a 400
 * or returns no results. This splits the array into batches, queries each,
 * and merges the results.
 *
 * Usage:
 *   const rows = await chunkIn(supabase, 'payments', 'order_id', orderIds,
 *     q => q.select('amount, method').eq('status', 'completed')
 *   );
 */
export async function chunkIn<T>(
  table: string,
  column: string,
  ids: string[],
  refine: (q: ReturnType<typeof supabase.from>) => ReturnType<typeof supabase.from>,
  chunkSize = 500,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const q = supabase.from(table).select('*');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (refine(q) as any).in(column, chunk);
    if (error) throw new Error(`chunkIn(${table}.${column}): ${error.message}`);
    if (data) results.push(...data);
  }
  return results;
}

// East Africa Time. Filter dates are the business's local calendar day; we
// convert to the UTC instants stored in created_at so a day-filter captures the
// whole local day (the old code mixed UTC and server-local parsing, so orders
// near midnight — and, with a UTC host, whole days — were dropped from reports).
// TODO: make this per-business when multi-timezone support is added.
const BIZ_TZ_OFFSET = '+03:00';

function getDateRange(from?: string, to?: string) {
  const todayLocal = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const fromDay = from || todayLocal;
  const toDay   = to   || todayLocal;
  const start = new Date(`${fromDay}T00:00:00.000${BIZ_TZ_OFFSET}`);
  const end   = new Date(`${toDay}T23:59:59.999${BIZ_TZ_OFFSET}`);
  return { start: start.toISOString(), end: end.toISOString() };
}

// GET /api/reports/sales
// Owner: all branches or filtered by ?branch_id=
// Staff: locked to their branch via branchScope
router.get('/sales', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, status, subtotal, vat_amount,
      discount_amount, total, created_at, branch_id, payment_method,
      branches ( name ),
      payments ( method, amount, status )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true });

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data: orders, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const o = orders ?? [];
  const totalRevenue  = o.reduce((s, x) => s + Number(x.total), 0);
  const totalOrders   = o.length;
  const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;
  const totalDiscount = o.reduce((s, x) => s + Number(x.discount_amount ?? 0), 0);
  const totalVat      = o.reduce((s, x) => s + Number(x.vat_amount ?? 0), 0);

  // Payment method breakdown
  const methodTotals: Record<string, number> = {};
  o.forEach(order => {
    let paid = 0;
    (order.payments ?? []).forEach((p: { method: string; amount: string; status: string }) => {
      if (p.status === 'completed') {
        methodTotals[p.method] = (methodTotals[p.method] ?? 0) + Number(p.amount);
        paid += Number(p.amount);
      }
    });
    // Completed orders with no (or short) payments rows would make the method
    // breakdown fall short of gross. Attribute the remainder to the order's own
    // payment_method (or 'unaccounted') so payment methods reconcile to gross sales.
    const remainder = Number(order.total) - paid;
    if (remainder > 0.005) {
      const m = (order as { payment_method?: string }).payment_method || 'unaccounted';
      methodTotals[m] = (methodTotals[m] ?? 0) + remainder;
    }
  });

  // Daily revenue series
  const dailyMap: Record<string, number> = {};
  o.forEach(order => {
    const day = order.created_at.slice(0, 10);
    dailyMap[day] = (dailyMap[day] ?? 0) + Number(order.total);
  });
  const dailySeries = Object.entries(dailyMap).map(([date, revenue]) => ({ date, revenue }));

  // Per-branch breakdown (for owner cross-branch view)
  const branchMap: Record<string, { name: string; revenue: number; orders: number }> = {};
  o.forEach(order => {
    const bid = order.branch_id;
    const bname = (order as { branches?: { name: string } | null }).branches?.name ?? bid;
    if (!branchMap[bid]) branchMap[bid] = { name: bname, revenue: 0, orders: 0 };
    branchMap[bid].revenue += Number(order.total);
    branchMap[bid].orders++;
  });
  const branchBreakdown = Object.entries(branchMap).map(([id, v]) => ({ branch_id: id, ...v }));

  res.json({
    summary: { totalRevenue, totalOrders, avgOrderValue, totalDiscount, totalVat },
    paymentMethods: methodTotals,
    dailySeries,
    branchBreakdown,
    orders: o,
  });
});

// GET /api/reports/products
router.get('/products', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let ordersQuery = supabase
    .from('orders')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) ordersQuery = ordersQuery.eq('branch_id', scopedBranch);
  const { data: orders } = await ordersQuery;
  const orderIds = (orders ?? []).map(o => o.id);

  if (!orderIds.length) { res.json({ products: [] }); return; }

  const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('product_id, product_name, category_name, quantity, subtotal'),
    );
  // chunkIn throws on error — no separate error check needed

  const productMap: Record<string, { name: string; category: string; qty: number; revenue: number }> = {};
  (items ?? []).forEach(item => {
    const key = item.product_id ?? item.product_name;
    if (!productMap[key]) {
      productMap[key] = { name: item.product_name, category: item.category_name ?? '', qty: 0, revenue: 0 };
    }
    productMap[key].qty     += Number(item.quantity);
    productMap[key].revenue += Number(item.subtotal);
  });

  const products = Object.entries(productMap)
    .map(([id, v]) => ({ product_id: id, ...v }))
    .sort((a, b) => b.revenue - a.revenue);

  res.json({ products });
});

// GET /api/reports/staff
router.get('/staff', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select('id, total, cashier_id, branch_id, branches ( name )')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data: orders, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Collect unique user IDs then fetch names in one query
  const userIds = [...new Set((orders ?? []).map(o => o.cashier_id).filter(Boolean))];
  const userMap: Record<string, string> = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('users')
      .select('id, name')
      .in('id', userIds);
    (users ?? [] as Array<{ id: string; name: string }>).forEach(u => { userMap[u.id] = u.name; });
  }

  const staffMap: Record<string, { name: string; branch: string; orders: number; revenue: number }> = {};
  (orders ?? [] as ReportOrderRow[]).forEach((o) => {
    const key    = o.cashier_id ?? 'unknown';
    const name   = userMap[o.cashier_id] ?? 'Unknown';
    const branch = (o as { branches?: { name: string } | null }).branches?.name ?? '';
    if (!staffMap[key]) staffMap[key] = { name, branch, orders: 0, revenue: 0 };
    staffMap[key].orders++;
    staffMap[key].revenue += Number(o.total);
  });

  const staff = Object.entries(staffMap)
    .map(([id, v]) => ({ cashier_id: id, ...v }))
    .sort((a, b) => b.revenue - a.revenue);

  res.json({ staff });
});

// GET /api/reports/inventory
// Derives sold qty from order_items, restocked/adjustments from stock_adjustments
router.get('/inventory', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // ── 1. Units sold: from order_items in completed orders ──
  let ordersQuery = supabase
    .from('orders')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) ordersQuery = ordersQuery.eq('branch_id', scopedBranch);
  const { data: completedOrders } = await ordersQuery;
  const orderIds = (completedOrders ?? []).map(o => o.id);

  const soldMap: Record<string, { name: string; qty: number; revenue: number }> = {};
  if (orderIds.length) {
    const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('product_id, product_name, quantity, subtotal'),
    );
    (items ?? []).forEach(item => {
      const key = item.product_id ?? item.product_name;
      if (!soldMap[key]) soldMap[key] = { name: item.product_name, qty: 0, revenue: 0 };
      soldMap[key].qty     += Number(item.quantity);
      soldMap[key].revenue += Number(item.subtotal);
    });
  }

  // ── 2. Adjustments: from stock_adjustments table ──────────
  let adjQuery = supabase
    .from('stock_adjustments')
    .select(`
      id, product_id, adjustment_type, quantity, reason, notes, created_at,
      products!inner ( name, business_id )
    `)
    .eq('business_id', req.businessId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false });

  if (scopedBranch) adjQuery = adjQuery.eq('branch_id', scopedBranch);
  const { data: adjustments, error: adjErr } = await adjQuery;
  if (adjErr) { res.status(500).json({ error: adjErr.message }); return; }

  const adjMap: Record<string, { name: string; restocked: number; written_off: number }> = {};
  (adjustments ?? [] as Array<{ product_id: string; quantity: string; type: string; created_at: string }>).forEach((a) => {
    const key  = a.product_id;
    const name = a.products?.name ?? 'Unknown';
    if (!adjMap[key]) adjMap[key] = { name, restocked: 0, written_off: 0 };
    if (a.adjustment_type === 'add')    adjMap[key].restocked   += Number(a.quantity);
    if (a.adjustment_type === 'remove') adjMap[key].written_off += Number(a.quantity);
  });

  // ── 3. Merge into unified summary ─────────────────────────
  const allKeys = new Set([...Object.keys(soldMap), ...Object.keys(adjMap)]);
  const summary = [...allKeys].map(key => ({
    product_id: key,
    name:        soldMap[key]?.name ?? adjMap[key]?.name ?? 'Unknown',
    sold:        soldMap[key]?.qty ?? 0,
    revenue:     soldMap[key]?.revenue ?? 0,
    restocked:   adjMap[key]?.restocked ?? 0,
    written_off: adjMap[key]?.written_off ?? 0,
  })).sort((a, b) => b.sold - a.sold);

  res.json({
    summary,
    adjustments: adjustments ?? [],
  });
});

// GET /api/reports/eod  — End-of-day Z-report for a specific cashier session
// Query: ?branch_id=&from=&to=&cashier_id= (all optional)
router.get('/eod', async (req, res) => {
  const { from, to, cashier_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, table_number, status,
      subtotal, vat_amount, discount_amount, total, created_at,
      cashier_id, payment_method,
      branch_id, branches ( name ),
      payments ( method, amount, status )
    `)
    .eq('business_id', req.businessId)
    .in('status', ['completed', 'voided'])
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true });

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);
  if (cashier_id) query = query.eq('cashier_id', cashier_id as string);

  const { data: orders, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const o = orders ?? [];
  const completed = o.filter(x => x.status === 'completed');
  const voided    = o.filter(x => x.status === 'voided');

  const totalRevenue  = completed.reduce((s, x) => s + Number(x.total), 0);
  const totalDiscount = completed.reduce((s, x) => s + Number(x.discount_amount ?? 0), 0);
  const totalVat      = completed.reduce((s, x) => s + Number(x.vat_amount ?? 0), 0);

  const methodTotals: Record<string, number> = {};
  completed.forEach(order => {
    let paid = 0;
    (order.payments ?? []).forEach((p: { method: string; amount: string; status: string }) => {
      if (p.status === 'completed') {
        methodTotals[p.method] = (methodTotals[p.method] ?? 0) + Number(p.amount);
        paid += Number(p.amount);
      }
    });
    const remainder = Number(order.total) - paid;
    if (remainder > 0.005) {
      const m = (order as { payment_method?: string }).payment_method || 'unaccounted';
      methodTotals[m] = (methodTotals[m] ?? 0) + remainder;
    }
  });

  // Top products
  const orderIds = completed.map(x => x.id);
  let topProducts: { name: string; qty: number; revenue: number }[] = [];
  if (orderIds.length) {
    const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('product_name, quantity, subtotal'),
    );
    const pm = new Map<string, { qty: number; revenue: number }>();
    (items ?? []).forEach(i => {
      const ex = pm.get(i.product_name) ?? { qty: 0, revenue: 0 };
      pm.set(i.product_name, { qty: ex.qty + Number(i.quantity), revenue: ex.revenue + Number(i.subtotal) });
    });
    topProducts = [...pm.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  }

  const branchName = completed[0] ? (completed[0] as { branches?: { name: string } | null }).branches?.name ?? '' : '';

  // Fetch cashier name separately (avoid broken FK join inference)
  let cashierName = 'Unknown';
  const firstCashierId = completed[0]?.cashier_id;
  if (firstCashierId) {
    const { data: cashierUser } = await supabase
      .from('users')
      .select('name')
      .eq('id', firstCashierId)
      .single();
    if (cashierUser?.name) cashierName = cashierUser.name;
  }

  // Fetch expenses for this period + branch (for EOD profit view)
  let expensesQuery = supabase
    .from('expenses')
    .select('amount, expense_categories ( name )')
    .eq('business_id', req.businessId)
    .gte('expense_date', start.slice(0, 10))
    .lte('expense_date', end.slice(0, 10));

  if (scopedBranch) expensesQuery = expensesQuery.eq('branch_id', scopedBranch);

  const { data: expenseRows } = await expensesQuery;
  const byCat: Record<string, number> = {};
  let totalExpenses = 0;
  (expenseRows ?? [] as Array<{ expense_category_id: string | null; amount: string; expense_categories?: { name: string } | null }>).forEach(e => {
    const cat = e.expense_categories?.name ?? 'Uncategorised';
    byCat[cat] = (byCat[cat] ?? 0) + Number(e.amount);
    totalExpenses += Number(e.amount);
  });
  const expenseBreakdown = Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  // ── Shifts in this period (for Z-report cash reconciliation) ──────────────
  // expected_cash = opening_float + cash sales + float_in − float_out.
  // Closed shifts use the value stored at close; open shifts are computed live.
  let shiftsQ = supabase
    .from('shifts')
    .select('id, status, opening_float, closing_float, expected_cash, cash_variance, opened_at')
    .eq('business_id', req.businessId)
    .gte('opened_at', start)
    .lte('opened_at', end)
    .order('opened_at', { ascending: false });
  if (scopedBranch) shiftsQ = shiftsQ.eq('branch_id', scopedBranch);
  const { data: shiftRows } = await shiftsQ;

  const shiftIds = (shiftRows ?? []).map(s => s.id);
  const cashByShift: Record<string, number> = {};
  const floatByShift: Record<string, { in: number; out: number }> = {};
  if (shiftIds.length) {
    const { data: cashPays } = await supabase
      .from('payments')
      .select('amount, orders!inner(shift_id)')
      .eq('method', 'cash')
      .eq('status', 'completed')
      .in('orders.shift_id', shiftIds);
    (cashPays ?? [] as Array<{ amount: string; orders?: { shift_id: string | null } | null }>).forEach(p => {
      const sid = p.orders?.shift_id;
      if (sid) cashByShift[sid] = (cashByShift[sid] ?? 0) + Number(p.amount);
    });
    const { data: floats } = await supabase
      .from('float_transactions')
      .select('shift_id, type, amount')
      .in('shift_id', shiftIds);
    (floats ?? [] as Array<{ shift_id: string; type: string; amount: string }>).forEach(f => {
      if (!floatByShift[f.shift_id]) floatByShift[f.shift_id] = { in: 0, out: 0 };
      if (f.type === 'float_in')  floatByShift[f.shift_id].in  += Number(f.amount);
      if (f.type === 'float_out') floatByShift[f.shift_id].out += Number(f.amount);
    });
  }

  const shifts = (shiftRows ?? []).map(s => {
    const cashSales = cashByShift[s.id] ?? 0;
    const float_in  = floatByShift[s.id]?.in  ?? 0;
    const float_out = floatByShift[s.id]?.out ?? 0;
    const liveExpected = Number(s.opening_float) + cashSales + float_in - float_out;
    const expected_cash = (s.status === 'closed' && s.expected_cash != null)
      ? Number(s.expected_cash)
      : liveExpected;
    return {
      id: s.id,
      status: s.status,
      opening_float: Number(s.opening_float),
      cash_sales: cashSales,
      float_in,
      float_out,
      closing_float: s.closing_float != null ? Number(s.closing_float) : null,
      expected_cash,
      cash_variance: s.cash_variance != null ? Number(s.cash_variance) : null,
    };
  });

  const netRevenue = totalRevenue - totalVat; // VAT is a liability, not income

  res.json({
    period: { from: start, to: end },
    branchName,
    cashierName,
    summary: {
      totalRevenue,
      netRevenue,
      totalOrders: completed.length,
      totalDiscount,
      totalVat,
      voidedCount: voided.length,
      totalExpenses,
      netProfit: netRevenue - totalExpenses,
    },
    paymentMethods: methodTotals,
    topProducts,
    expenses: { total: totalExpenses, breakdown: expenseBreakdown },
    shifts,
    orders: o,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/shifts
// Returns shift history with per-shift order totals, variance, and float txns.
// Owner: all branches or filtered; Staff: locked to their branch via branchScope.
// Query: from, to, branch_id, status ('open'|'closed'), cashier_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/shifts', async (req, res) => {
  const { from, to, status, cashier_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .gte('opened_at', start)
    .lte('opened_at', end)
    .order('opened_at', { ascending: false });

  if (scopedBranch)            query = query.eq('branch_id', scopedBranch);
  if (req.query.branch_id)     query = query.eq('branch_id', req.query.branch_id as string);
  if (status)                  query = query.eq('status', status as string);
  if (cashier_id)              query = query.eq('cashier_id', cashier_id as string);

  const { data: shifts, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!shifts?.length) {
    res.json({ shifts: [], summary: { totalShifts: 0, closedShifts: 0, openShifts: 0, totalVariance: 0, totalOpeningFloat: 0, avgVariance: 0 } });
    return;
  }

  // ── Enrich with cashier names ─────────────────────────────────────────────
  const cashierIds = [...new Set(shifts.map(s => s.cashier_id))];
  const { data: users } = await supabase
    .from('users')
    .select('id, name')
    .in('id', cashierIds);
  const nameMap: Record<string, string> = {};
  (users ?? []).forEach(u => { nameMap[u.id] = u.name; });

  // ── Enrich with branch names ──────────────────────────────────────────────
  const branchIds = [...new Set(shifts.map(s => s.branch_id))];
  const { data: branches } = await supabase
    .from('branches')
    .select('id, name')
    .in('id', branchIds);
  const branchMap: Record<string, string> = {};
  (branches ?? []).forEach(b => { branchMap[b.id] = b.name; });

  // ── Enrich with order totals per shift ────────────────────────────────────
  const shiftIds = shifts.map(s => s.id);
  const { data: orders } = await supabase
    .from('orders')
    .select('shift_id, total, payment_method')
    .in('shift_id', shiftIds)
    .eq('status', 'completed');

  const orderMap: Record<string, { count: number; revenue: number }> = {};
  (orders ?? []).forEach(o => {
    if (!o.shift_id) return;
    if (!orderMap[o.shift_id]) orderMap[o.shift_id] = { count: 0, revenue: 0 };
    orderMap[o.shift_id].count++;
    orderMap[o.shift_id].revenue += Number(o.total);
  });

  // ── Enrich with float transactions per shift ──────────────────────────────
  const { data: floatTxns } = await supabase
    .from('float_transactions')
    .select('shift_id, type, amount')
    .in('shift_id', shiftIds);

  const floatMap: Record<string, { float_in: number; float_out: number }> = {};
  (floatTxns ?? []).forEach(f => {
    if (!floatMap[f.shift_id]) floatMap[f.shift_id] = { float_in: 0, float_out: 0 };
    floatMap[f.shift_id][f.type as 'float_in' | 'float_out'] += Number(f.amount);
  });

  // ── Assemble enriched rows ────────────────────────────────────────────────
  const enriched = shifts.map(s => ({
    ...s,
    cashier_name: nameMap[s.cashier_id] ?? 'Unknown',
    branch_name:  branchMap[s.branch_id] ?? '—',
    order_count:  orderMap[s.id]?.count   ?? 0,
    order_revenue: orderMap[s.id]?.revenue ?? 0,
    float_in:     floatMap[s.id]?.float_in  ?? 0,
    float_out:    floatMap[s.id]?.float_out ?? 0,
  }));

  // ── Summary ───────────────────────────────────────────────────────────────
  const closed   = enriched.filter(s => s.status === 'closed');
  const open     = enriched.filter(s => s.status === 'open');
  const totalVariance = closed.reduce((sum, s) => sum + Number(s.cash_variance ?? 0), 0);

  res.json({
    shifts: enriched,
    summary: {
      totalShifts:      enriched.length,
      closedShifts:     closed.length,
      openShifts:       open.length,
      totalVariance,
      avgVariance:      closed.length ? totalVariance / closed.length : 0,
      totalOpeningFloat: enriched.reduce((s, sh) => s + Number(sh.opening_float), 0),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/master
// Posist-style "Master Data" / Daily Sales Report (DSR).
// Returns: sale summary, channel split, payment split, cost summary,
//          category × super-category breakdown, expenses.
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/master', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // Catering levy (CTL) only applies to hospitality establishments — not to
  // retail/minimart/petrol/parking. Gate it on the business type.
  const { data: bizRow } = await supabase
    .from('businesses').select('type').eq('id', req.businessId).single();
  const ctlApplies = ['restaurant', 'cafe'].includes((bizRow?.type ?? '') as string);

  // ── 1. Fetch orders (completed + voided) ─────────────────────────────────
  let ordersQ = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, aggregator_name, status,
      subtotal, vat_amount, discount_amount, total,
      created_at, branch_id, cashier_id, payment_method,
      branches ( name ),
      payments ( method, amount, status )
    `)
    .eq('business_id', req.businessId)
    .in('status', ['completed', 'voided'])
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: allOrders, error: oErr } = await ordersQ;
  if (oErr) { res.status(500).json({ error: oErr.message }); return; }

  const completed = (allOrders ?? []).filter(o => o.status === 'completed');
  const voided    = (allOrders ?? []).filter(o => o.status === 'voided');

  // ── 2. Sale summary ───────────────────────────────────────────────────────
  // Bases are post-discount and VAT-inclusive: total = subtotal − discount,
  // and vat_amount is the VAT embedded in total. Use `total` consistently so
  // the figures reconcile (sum(subtotal) is pre-discount and must not be the base).
  const grossInclVat  = completed.reduce((s, o) => s + Number(o.total), 0);
  const totalVat      = completed.reduce((s, o) => s + Number(o.vat_amount ?? 0), 0);
  const totalDiscount = completed.reduce((s, o) => s + Number(o.discount_amount ?? 0), 0);
  // CTL (Catering Levy) = 2% of net-of-VAT sales — hospitality only.
  const CTL_RATE     = 0.02;
  const netBeforeTax = grossInclVat - totalVat;
  const totalCtl     = ctlApplies ? netBeforeTax * CTL_RATE : 0;
  const totalSale    = grossInclVat;
  const netSales     = netBeforeTax - totalCtl;

  // ── 3. Channel split ──────────────────────────────────────────────────────
  const channels: Record<string, number> = {
    counter: 0, takeaway: 0, delivery: 0, aggregator: 0, other: 0,
  };
  const channelMap: Record<string, string> = {
    retail: 'counter', dine_in: 'counter',
    takeaway: 'takeaway',
    delivery: 'delivery',
    aggregator: 'aggregator',
  };
  for (const o of completed) {
    const ch = channelMap[o.order_type] ?? 'other';
    channels[ch] = (channels[ch] ?? 0) + Number(o.total);
  }

  // ── 4. Payment method split ───────────────────────────────────────────────
  const payments: Record<string, number> = {};
  for (const o of completed) {
    let paid = 0;
    for (const p of (o.payments ?? []) as Array<{ status: string; method: string; amount: string }>) {
      if (p.status === 'completed') {
        payments[p.method] = (payments[p.method] ?? 0) + Number(p.amount);
        paid += Number(p.amount);
      }
    }
    // Attribute any un-recorded remainder to the order's own payment_method so the
    // payment split reconciles to gross sales (see QA #8).
    const remainder = Number(o.total) - paid;
    if (remainder > 0.005) {
      const m = (o as { payment_method?: string }).payment_method || 'unaccounted';
      payments[m] = (payments[m] ?? 0) + remainder;
    }
  }

  // ── 5. Category breakdown ─────────────────────────────────────────────────
  const orderIds = completed.map(o => o.id);
  let categoryBreakdown: Array<{ category_name: string | null; subtotal: string }> = [];
  if (orderIds.length) {
    const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('category_name, quantity, subtotal, product_id'),
    );

    // Enrich with super_category from categories table
    const catNames = [...new Set((items ?? []).map(i => i.category_name).filter(Boolean))];
    const { data: catRows } = await supabase
      .from('categories')
      .select('name, super_category')
      .eq('business_id', req.businessId)
      .in('name', catNames);
    const superMap: Record<string, string> = {};
    (catRows ?? [] as Array<{ name: string; super_category?: string | null }>).forEach(c => { superMap[c.name] = c.super_category ?? c.name.toUpperCase(); });

    const catMap: Record<string, { category: string; superCategory: string; qty: number; netSales: number }> = {};
    for (const item of items ?? []) {
      const cat = item.category_name ?? 'Uncategorised';
      if (!catMap[cat]) catMap[cat] = { category: cat, superCategory: superMap[cat] ?? cat.toUpperCase(), qty: 0, netSales: 0 };
      catMap[cat].qty      += Number(item.quantity);
      catMap[cat].netSales += Number(item.subtotal);
    }
    categoryBreakdown = Object.values(catMap).sort((a, b) => b.netSales - a.netSales);
  }

  // ── 6. Expenses ───────────────────────────────────────────────────────────
  let expQ = supabase
    .from('expenses')
    .select('amount, expense_categories ( name )')
    .eq('business_id', req.businessId)
    .gte('expense_date', start.slice(0, 10))
    .lte('expense_date', end.slice(0, 10));
  if (scopedBranch) expQ = expQ.eq('branch_id', scopedBranch);
  const { data: expRows } = await expQ;
  const totalExpenses = (expRows ?? []).reduce((s, e) => s + Number(e.amount), 0);
  const expByCategory: Record<string, number> = {};
  (expRows ?? [] as Array<{ expense_categories?: { name: string } | null; amount: string }>).forEach(e => {
    const cat = e.expense_categories?.name ?? 'Uncategorised';
    expByCategory[cat] = (expByCategory[cat] ?? 0) + Number(e.amount);
  });

  // ── 7. Branch name ────────────────────────────────────────────────────────
  const branchName = (completed[0] as { branches?: { name: string } | null } | undefined)?.branches?.name ?? (allOrders?.[0] as { branches?: { name: string } | null } | undefined)?.branches?.name ?? '';

  const totalRevenue = completed.reduce((s, o) => s + Number(o.total), 0);

  res.json({
    period:     { from: start, to: end },
    branchName,
    summary: {
      totalSale,
      totalVat,
      totalCtl,
      totalDiscount,
      netSales,
      totalRevenue,
      totalOrders:  completed.length,
      voidedCount:  voided.length,
      voidedValue:  voided.reduce((s, o) => s + Number(o.total), 0),
      avgOrderValue: completed.length ? totalRevenue / completed.length : 0,
      totalExpenses,
      netProfit:    netSales - totalExpenses,
    },
    channels: Object.entries(channels).map(([channel, amount]) => ({
      channel,
      amount,
      pct: totalRevenue > 0 ? (amount / totalRevenue) * 100 : 0,
    })),
    payments: Object.entries(payments).map(([method, amount]) => ({ method, amount })),
    categoryBreakdown,
    expenses: {
      total: totalExpenses,
      breakdown: Object.entries(expByCategory).map(([category, amount]) => ({ category, amount })),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/hourly
// Hourly + day-of-week breakdown for peak-hour analysis.
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/hourly', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select('id, total, created_at, order_type')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);
  const { data: orders, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Aggregate by hour (0-23)
  const hourMap: Record<number, { revenue: number; orders: number }> = {};
  for (let h = 0; h < 24; h++) hourMap[h] = { revenue: 0, orders: 0 };

  // Aggregate by day of week (0=Sun … 6=Sat)
  const dowMap: Record<number, { revenue: number; orders: number }> = {};
  for (let d = 0; d < 7; d++) dowMap[d] = { revenue: 0, orders: 0 };

  // Daily series for sparkline
  const dailyMap: Record<string, { revenue: number; orders: number }> = {};

  for (const o of orders ?? []) {
    const dt  = new Date(o.created_at);
    const h   = dt.getHours();
    const dow = dt.getDay();
    const day = o.created_at.slice(0, 10);

    hourMap[h].revenue += Number(o.total);
    hourMap[h].orders  += 1;
    dowMap[dow].revenue += Number(o.total);
    dowMap[dow].orders  += 1;
    if (!dailyMap[day]) dailyMap[day] = { revenue: 0, orders: 0 };
    dailyMap[day].revenue += Number(o.total);
    dailyMap[day].orders  += 1;
  }

  const hourly = Object.entries(hourMap).map(([h, v]) => ({
    hour: Number(h),
    label: `${h.padStart(2, '0')}:00`,
    ...v,
    avgOrderValue: v.orders > 0 ? v.revenue / v.orders : 0,
  }));

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayOfWeek = Object.entries(dowMap).map(([d, v]) => ({
    day: DOW_LABELS[Number(d)],
    dayIndex: Number(d),
    ...v,
  }));

  // Peak hour
  const peakHour = hourly.reduce((best, h) => h.revenue > best.revenue ? h : best, hourly[0]);

  res.json({
    period: { from: start, to: end },
    hourly,
    dayOfWeek,
    dailySeries: Object.entries(dailyMap).map(([date, v]) => ({ date, ...v })),
    peakHour: peakHour?.hour ?? null,
    peakRevenue: peakHour?.revenue ?? 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/voids
// All voided orders with cashier attribution, reason, and per-staff summary.
// Query: from, to, branch_id, cashier_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/voids', async (req, res) => {
  const { from, to, cashier_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, total, discount_amount,
      void_reason, cashier_id, voided_at, authorized_by, created_at, branch_id,
      branches ( name ),
      order_items ( product_name, quantity, subtotal )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'voided')
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false });

  if (scopedBranch)  query = query.eq('branch_id', scopedBranch);
  if (cashier_id)    query = query.eq('cashier_id', cashier_id as string);

  const { data: voids, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Enrich cashier + authorizer (supervisor) names in one lookup.
  const userIds = [...new Set(
    (voids ?? []).flatMap(o => [o.cashier_id, (o as any).authorized_by]).filter(Boolean)
  )];
  const nameMap: Record<string, string> = {};
  if (userIds.length) {
    const users = await chunkIn<any>('users', 'id', userIds, q => q.select('id, name'));
    (users ?? [] as Array<{ id: string; name: string }>).forEach(u => { nameMap[u.id] = u.name; });
  }

  const enriched = (voids ?? []).map(o => ({
    ...o,
    cashier_name:       nameMap[o.cashier_id] ?? 'Unknown',
    authorized_by_name: (o as any).authorized_by ? (nameMap[(o as any).authorized_by] ?? 'Unknown') : null,
    branch_name:        (o as { branches?: { name: string } | null }).branches?.name ?? '—',
  }));

  // Per-cashier summary
  const staffMap: Record<string, { name: string; count: number; value: number }> = {};
  for (const o of enriched) {
    const key = o.cashier_id ?? 'unknown';
    if (!staffMap[key]) staffMap[key] = { name: o.cashier_name, count: 0, value: 0 };
    staffMap[key].count++;
    staffMap[key].value += Number(o.total);
  }
  const byStaff = Object.entries(staffMap)
    .map(([cashier_id, v]) => ({ cashier_id, ...v }))
    .sort((a, b) => b.value - a.value);

  res.json({
    period:    { from: start, to: end },
    voids:     enriched,
    summary: {
      totalVoids: enriched.length,
      totalValue: enriched.reduce((s, o) => s + Number(o.total), 0),
      byStaff,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/tax
// Kenya tax report — VAT 16% + CTL 2% per period, with category and branch split.
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tax', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // CTL (Catering Levy) is hospitality-only; gate it on business type.
  const { data: bizRow } = await supabase
    .from('businesses').select('type').eq('id', req.businessId).single();
  const ctlApplies = ['restaurant', 'cafe'].includes((bizRow?.type ?? '') as string);
  const CTL_RATE = ctlApplies ? 0.02 : 0;

  let query = supabase
    .from('orders')
    .select(`
      id, subtotal, vat_amount, total, branch_id,
      branches ( name ),
      order_items ( category_name, subtotal )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);
  const { data: orders, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Authoritative figures are per-order and post-discount:
  //   gross (VAT-incl) = total ; VAT = vat_amount (what was actually charged).
  // Everything else is derived from these so the report reconciles end to end
  // (and ties to what eTIMS transmitted).
  const grossSales   = (orders ?? []).reduce((s, o) => s + Number(o.total), 0);
  const vatTotal     = (orders ?? []).reduce((s, o) => s + Number(o.vat_amount ?? 0), 0);
  const netBeforeTax = grossSales - vatTotal;
  const ctlTotal     = netBeforeTax * CTL_RATE;
  const netSales     = netBeforeTax - ctlTotal;

  // By category — allocate each order's actual total & vat_amount across its
  // items in proportion to item subtotal, so category totals SUM BACK to the
  // order-level figures above (no second, divergent VAT calculation).
  const catTaxMap: Record<string, { category: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }> = {};
  for (const o of orders ?? []) {
    const items = (o.order_items ?? []) as Array<{ category_name: string | null; subtotal: string }>;
    const itemsTotal = items.reduce((s, it) => s + Number(it.subtotal), 0);
    const oTotal = Number(o.total);
    const oVat   = Number(o.vat_amount ?? 0);
    for (const item of items) {
      const cat    = item.category_name ?? 'Uncategorised';
      const weight = itemsTotal > 0 ? Number(item.subtotal) / itemsTotal : 0;
      const gross  = oTotal * weight;
      const vat    = oVat * weight;
      const net    = gross - vat;
      const ctl    = net * CTL_RATE;
      if (!catTaxMap[cat]) catTaxMap[cat] = { category: cat, grossSales: 0, vatAmount: 0, ctlAmount: 0, netSales: 0 };
      catTaxMap[cat].grossSales += gross;
      catTaxMap[cat].vatAmount  += vat;
      catTaxMap[cat].ctlAmount  += ctl;
      catTaxMap[cat].netSales   += net - ctl;
    }
  }

  // By branch — same post-discount basis.
  const branchTaxMap: Record<string, { branchName: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }> = {};
  for (const o of orders ?? []) {
    const bid   = o.branch_id;
    const bname = (o as { branches?: { name: string } | null }).branches?.name ?? bid;
    if (!branchTaxMap[bid]) branchTaxMap[bid] = { branchName: bname, grossSales: 0, vatAmount: 0, ctlAmount: 0, netSales: 0 };
    const oGross = Number(o.total);
    const oVat   = Number(o.vat_amount ?? 0);
    const oNet   = oGross - oVat;
    const oCtl   = oNet * CTL_RATE;
    branchTaxMap[bid].grossSales += oGross;
    branchTaxMap[bid].vatAmount  += oVat;
    branchTaxMap[bid].ctlAmount  += oCtl;
    branchTaxMap[bid].netSales   += oNet - oCtl;
  }

  res.json({
    period:    { from: start, to: end },
    rates:     { vatRate: 16, ctlRate: CTL_RATE * 100 },
    summary: {
      grossSales,
      vatTotal,
      ctlTotal,
      netSales,
      totalOrders: (orders ?? []).length,
    },
    byCategory: Object.values(catTaxMap).sort((a, b) => b.grossSales - a.grossSales),
    byBranch:   Object.values(branchTaxMap).sort((a, b) => b.grossSales - a.grossSales),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/products  (enhanced — adds % contribution + cost/margin)
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/products-v2', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let ordersQ = supabase
    .from('orders')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);
  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: completedOrders } = await ordersQ;
  const orderIds = (completedOrders ?? []).map(o => o.id);

  if (!orderIds.length) { res.json({ products: [], totalRevenue: 0 }); return; }

  const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('product_id, product_name, category_name, quantity, subtotal'),
    );
  // chunkIn throws on error — no separate error check needed.

  const productMap: Record<string, { name: string; category: string; qty: number; revenue: number }> = {};
  for (const item of items ?? []) {
    const key = item.product_id ?? item.product_name;
    if (!productMap[key]) productMap[key] = { name: item.product_name, category: item.category_name ?? '', qty: 0, revenue: 0 };
    productMap[key].qty     += Number(item.quantity);
    productMap[key].revenue += Number(item.subtotal);
  }

  const totalRevenue = Object.values(productMap).reduce((s, p) => s + p.revenue, 0);

  // Enrich with cost price from products table
  const productIds = Object.keys(productMap).filter(k => k.length === 36); // uuid check
  const { data: productMeta } = await supabase
    .from('products')
    .select('id, cost_price')
    .in('id', productIds);
  const costMap: Record<string, number> = {};
  (productMeta ?? [] as Array<{ id: string; cost_price?: string | null }>).forEach(p => { if (p.cost_price) costMap[p.id] = Number(p.cost_price); });

  const products = Object.entries(productMap)
    .map(([id, v]) => {
      const costPrice  = costMap[id] ?? null;
      const totalCost  = costPrice != null ? costPrice * v.qty : null;
      const grossMargin = totalCost != null ? ((v.revenue - totalCost) / v.revenue) * 100 : null;
      return {
        product_id: id,
        ...v,
        contribution_pct: totalRevenue > 0 ? (v.revenue / totalRevenue) * 100 : 0,
        cost_price:  costPrice,
        total_cost:  totalCost,
        gross_margin_pct: grossMargin,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  res.json({ products, totalRevenue });
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/food-cost
// Ideal vs actual ingredient consumption + food cost % per product.
//
// Ideal consumption  = sum(recipe.qty_per_serving × qty_sold) per ingredient
// Actual consumption = sum of ingredient_stock_movements with type='sale'
// Variance           = actual - ideal  (positive = over-consumed)
//
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/food-cost', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // ── 1. Sales in period (completed orders) ─────────────────────────────────
  let ordersQ = supabase
    .from('orders')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end);
  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: orders } = await ordersQ;
  const orderIds = (orders ?? []).map(o => o.id);

  if (!orderIds.length) {
    return res.json({ period: { from: start, to: end }, summary: { totalIdealCost: 0, totalActualCost: 0, foodCostPct: 0, totalRevenue: 0 }, products: [], ingredients: [] });
  }

  // ── 2. Order items with quantities sold ───────────────────────────────────
  const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('product_id, product_name, quantity, subtotal'),
    );

  // Aggregate qty + revenue per product
  const productSales: Record<string, { name: string; qtySold: number; revenue: number }> = {};
  for (const item of items ?? []) {
    const pid = item.product_id ?? item.product_name;
    if (!productSales[pid]) productSales[pid] = { name: item.product_name, qtySold: 0, revenue: 0 };
    productSales[pid].qtySold  += Number(item.quantity);
    productSales[pid].revenue  += Number(item.subtotal);
  }
  const totalRevenue = Object.values(productSales).reduce((s, p) => s + p.revenue, 0);

  // ── 3. Recipes with ingredient costs ─────────────────────────────────────
  const productIds = Object.keys(productSales).filter(k => k.length === 36);
  const { data: recipes } = await supabase
    .from('recipes')
    .select('product_id, ingredient_id, quantity_per_serving, ingredients(id, name, unit, unit_cost)')
    .eq('business_id', req.businessId)
    .in('product_id', productIds);

  // ── 4. Compute ideal consumption per ingredient ───────────────────────────
  const idealMap: Record<string, { name: string; unit: string; unitCost: number | null; idealQty: number; idealCost: number }> = {};

  for (const recipe of recipes ?? []) {
    const ing  = (recipe as { ingredients?: { name: string } | null }).ingredients;
    const sale = productSales[recipe.product_id];
    if (!sale || !ing) continue;

    const qty  = Number(recipe.quantity_per_serving) * sale.qtySold;
    const cost = ing.unit_cost ? qty * Number(ing.unit_cost) : null;

    if (!idealMap[recipe.ingredient_id]) {
      idealMap[recipe.ingredient_id] = {
        name: ing.name, unit: ing.unit,
        unitCost: ing.unit_cost ? Number(ing.unit_cost) : null,
        idealQty: 0, idealCost: 0,
      };
    }
    idealMap[recipe.ingredient_id].idealQty  += qty;
    idealMap[recipe.ingredient_id].idealCost += cost ?? 0;
  }

  // ── 5. Actual consumption from stock movements in period ──────────────────
  const ingIds = Object.keys(idealMap);
  const actualMap: Record<string, number> = {};

  if (ingIds.length) {
    const { data: movements } = await supabase
      .from('ingredient_stock_movements')
      .select('ingredient_id, quantity_change')
      .eq('business_id', req.businessId)
      .eq('movement_type', 'sale')
      .in('ingredient_id', ingIds)
      .gte('created_at', start)
      .lte('created_at', end);

    for (const mv of movements ?? []) {
      const id = mv.ingredient_id;
      actualMap[id] = (actualMap[id] ?? 0) + Math.abs(Number(mv.quantity_change));
    }
  }

  // ── 6. Per-ingredient variance ────────────────────────────────────────────
  const ingredients = Object.entries(idealMap).map(([id, v]) => {
    const actualQty  = actualMap[id] ?? 0;
    const actualCost = v.unitCost ? actualQty * v.unitCost : null;
    const variance   = actualQty - v.idealQty;
    return {
      ingredient_id: id,
      name:          v.name,
      unit:          v.unit,
      unit_cost:     v.unitCost,
      idealQty:      Math.round(v.idealQty * 1000) / 1000,
      actualQty:     Math.round(actualQty * 1000) / 1000,
      variance:      Math.round(variance * 1000) / 1000,
      variancePct:   v.idealQty > 0 ? Math.round((variance / v.idealQty) * 10000) / 100 : 0,
      idealCost:     Math.round(v.idealCost * 100) / 100,
      actualCost:    actualCost !== null ? Math.round(actualCost * 100) / 100 : null,
    };
  }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  // ── 7. Per-product cost breakdown ─────────────────────────────────────────
  const productCostMap: Record<string, { name: string; qtySold: number; revenue: number; idealCost: number; hasCost: boolean }> = {};

  for (const recipe of recipes ?? []) {
    const ing  = (recipe as { ingredients?: { name: string } | null }).ingredients;
    const sale = productSales[recipe.product_id];
    if (!sale || !ing) continue;

    if (!productCostMap[recipe.product_id]) {
      productCostMap[recipe.product_id] = {
        name: sale.name, qtySold: sale.qtySold,
        revenue: sale.revenue, idealCost: 0, hasCost: false,
      };
    }
    if (ing.unit_cost) {
      const lineCost = Number(recipe.quantity_per_serving) * sale.qtySold * Number(ing.unit_cost);
      productCostMap[recipe.product_id].idealCost += lineCost;
      productCostMap[recipe.product_id].hasCost    = true;
    }
  }

  const products = Object.entries(productCostMap)
    .filter(([, v]) => v.hasCost)
    .map(([id, v]) => ({
      product_id: id,
      name:       v.name,
      qtySold:    v.qtySold,
      revenue:    Math.round(v.revenue * 100) / 100,
      idealCost:  Math.round(v.idealCost * 100) / 100,
      grossMargin: v.revenue > 0 ? Math.round(((v.revenue - v.idealCost) / v.revenue) * 10000) / 100 : 0,
      costPct:    v.revenue > 0 ? Math.round((v.idealCost / v.revenue) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.idealCost - a.idealCost);

  const totalIdealCost  = ingredients.reduce((s, i) => s + i.idealCost, 0);
  const totalActualCost = ingredients.reduce((s, i) => s + (i.actualCost ?? 0), 0);
  const hasActual       = ingredients.some(i => i.actualCost !== null);

  res.json({
    period: { from: start, to: end },
    summary: {
      totalRevenue:    Math.round(totalRevenue * 100) / 100,
      totalIdealCost:  Math.round(totalIdealCost * 100) / 100,
      totalActualCost: hasActual ? Math.round(totalActualCost * 100) / 100 : null,
      foodCostPct:     totalRevenue > 0 ? Math.round((totalIdealCost / totalRevenue) * 10000) / 100 : 0,
      variance:        hasActual ? Math.round((totalActualCost - totalIdealCost) * 100) / 100 : null,
    },
    products,
    ingredients,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/aggregator
// Revenue by aggregator platform with commission deduction.
// Commission % stored in business_settings as aggregator_commission_<platform>
// Query: from, to, branch_id

// ─────────────────────────────────────────────────────────────────────────────
router.get('/aggregator', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // 1. Fetch aggregator orders
  let ordersQ = supabase
    .from('orders')
    .select('id, order_type, aggregator_name, total, subtotal, vat_amount, created_at, branch_id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .eq('order_type', 'aggregator')
    .gte('created_at', start)
    .lte('created_at', end);

  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: orders, error } = await ordersQ;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // 2. Fetch commission settings
  const { data: settings } = await supabase
    .from('business_settings')
    .select('key, value')
    .eq('business_id', req.businessId)
    .like('key', 'aggregator_commission_%');

  const commissions: Record<string, number> = {};
  (settings ?? [] as Array<{ key: string; value: string }>).forEach(s => {
    const platform = s.key.replace('aggregator_commission_', '');
    commissions[platform] = parseFloat(s.value) || 0;
  });

  // 3. Group by platform
  const platformMap: Record<string, {
    platform: string; orders: number; grossRevenue: number;
    commissionPct: number; commissionAmount: number; netRevenue: number;
  }> = {};

  for (const o of orders ?? []) {
    const platform = (o.aggregator_name ?? 'unknown').toLowerCase();
    if (!platformMap[platform]) {
      const commPct = commissions[platform] ?? 0;
      platformMap[platform] = {
        platform,
        orders: 0,
        grossRevenue: 0,
        commissionPct: commPct,
        commissionAmount: 0,
        netRevenue: 0,
      };
    }
    const gross = Number(o.total);
    const comm  = gross * (platformMap[platform].commissionPct / 100);
    platformMap[platform].orders++;
    platformMap[platform].grossRevenue  += gross;
    platformMap[platform].commissionAmount += comm;
    platformMap[platform].netRevenue    += gross - comm;
  }

  const platforms = Object.values(platformMap).sort((a, b) => b.grossRevenue - a.grossRevenue);
  const totalGross  = platforms.reduce((s, p) => s + p.grossRevenue, 0);
  const totalComm   = platforms.reduce((s, p) => s + p.commissionAmount, 0);
  const totalNet    = platforms.reduce((s, p) => s + p.netRevenue, 0);
  const totalOrders = platforms.reduce((s, p) => s + p.orders, 0);

  res.json({
    period: { from: start, to: end },
    summary: { totalGross, totalComm, totalNet, totalOrders },
    platforms,
    commissions, // so frontend can show/edit them
  });
});



// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/splh
// Sales Per Labour Hour — the core QSR labour efficiency metric.
// Also returns labour cost % per shift using hourly_rate on users.
//
// Query: from, to, branch_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/splh', async (req, res) => {
  const { from, to } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // 1. Fetch closed shifts in period
  let shiftsQ = supabase
    .from('shifts')
    .select('id, cashier_id, branch_id, opened_at, closed_at, status, branches(name)')
    .eq('business_id', req.businessId)
    .eq('status', 'closed')
    .gte('opened_at', start)
    .lte('opened_at', end);

  if (scopedBranch) shiftsQ = shiftsQ.eq('branch_id', scopedBranch);
  const { data: shifts, error: sErr } = await shiftsQ;
  if (sErr) { res.status(500).json({ error: sErr.message }); return; }
  if (!shifts?.length) {
    return res.json({ period: { from: start, to: end }, summary: { totalRevenue: 0, totalHours: 0, splh: 0, labourCostPct: null }, shifts: [], staff: [] });
  }

  // 2. Revenue per shift from orders
  const shiftIds = shifts.map(s => s.id);
  const { data: orders } = await supabase
    .from('orders')
    .select('shift_id, total')
    .in('shift_id', shiftIds)
    .eq('status', 'completed');

  const revenueByShift: Record<string, number> = {};
  for (const o of orders ?? []) {
    revenueByShift[o.shift_id] = (revenueByShift[o.shift_id] ?? 0) + Number(o.total);
  }

  // 3. Fetch cashier hourly rates + names
  const cashierIds = [...new Set(shifts.map(s => s.cashier_id))];
  const { data: users } = await supabase
    .from('users')
    .select('id, name, hourly_rate')
    .in('id', cashierIds);

  const userMap: Record<string, { name: string; hourly_rate: number | null }> = {};
  (users ?? [] as Array<{ id: string; name: string; hourly_rate?: string | null }>).forEach(u => { userMap[u.id] = { name: u.name, hourly_rate: u.hourly_rate }; });

  // 4. Build per-shift metrics
  const shiftRows = shifts.map(s => {
    const revenue    = revenueByShift[s.id] ?? 0;
    const openedAt   = new Date(s.opened_at).getTime();
    const closedAt   = new Date(s.closed_at!).getTime();
    const hours      = Math.max(0, (closedAt - openedAt) / 3_600_000);
    const splh       = hours > 0 ? revenue / hours : 0;
    const rate       = userMap[s.cashier_id]?.hourly_rate ?? null;
    const labourCost = rate !== null ? rate * hours : null;
    const labourPct  = labourCost !== null && revenue > 0 ? (labourCost / revenue) * 100 : null;

    return {
      shift_id:     s.id,
      cashier_id:   s.cashier_id,
      cashier_name: userMap[s.cashier_id]?.name ?? 'Unknown',
      branch_name:  (s as { branches?: { name: string } | null }).branches?.name ?? '',
      opened_at:    s.opened_at,
      closed_at:    s.closed_at,
      hours:        Math.round(hours * 100) / 100,
      revenue:      Math.round(revenue * 100) / 100,
      splh:         Math.round(splh * 100) / 100,
      hourly_rate:  rate,
      labour_cost:  labourCost !== null ? Math.round(labourCost * 100) / 100 : null,
      labour_pct:   labourPct  !== null ? Math.round(labourPct  * 100) / 100 : null,
    };
  });

  // 5. Per-staff rollup
  const staffMap: Record<string, {
    cashier_id: string; name: string; shifts: number;
    totalHours: number; totalRevenue: number; totalLabour: number | null; hasRate: boolean;
  }> = {};

  for (const s of shiftRows) {
    if (!staffMap[s.cashier_id]) {
      staffMap[s.cashier_id] = {
        cashier_id: s.cashier_id, name: s.cashier_name,
        shifts: 0, totalHours: 0, totalRevenue: 0, totalLabour: 0, hasRate: false,
      };
    }
    staffMap[s.cashier_id].shifts++;
    staffMap[s.cashier_id].totalHours   += s.hours;
    staffMap[s.cashier_id].totalRevenue += s.revenue;
    if (s.labour_cost !== null) {
      staffMap[s.cashier_id].totalLabour = (staffMap[s.cashier_id].totalLabour ?? 0) + s.labour_cost;
      staffMap[s.cashier_id].hasRate = true;
    }
  }

  const staff = Object.values(staffMap).map(s => ({
    ...s,
    splh:       s.totalHours > 0 ? Math.round((s.totalRevenue / s.totalHours) * 100) / 100 : 0,
    labour_pct: s.hasRate && s.totalRevenue > 0
      ? Math.round(((s.totalLabour ?? 0) / s.totalRevenue) * 10000) / 100 : null,
  })).sort((a, b) => b.splh - a.splh);

  // 6. Summary
  const totalRevenue = shiftRows.reduce((s, r) => s + r.revenue, 0);
  const totalHours   = shiftRows.reduce((s, r) => s + r.hours, 0);
  const totalLabour  = shiftRows.reduce((s, r) => s + (r.labour_cost ?? 0), 0);
  const hasAnyRate   = shiftRows.some(r => r.labour_cost !== null);

  res.json({
    period: { from: start, to: end },
    summary: {
      totalRevenue:  Math.round(totalRevenue * 100) / 100,
      totalHours:    Math.round(totalHours   * 100) / 100,
      splh:          totalHours > 0 ? Math.round((totalRevenue / totalHours) * 100) / 100 : 0,
      totalLabour:   hasAnyRate ? Math.round(totalLabour * 100) / 100 : null,
      labourCostPct: hasAnyRate && totalRevenue > 0
        ? Math.round((totalLabour / totalRevenue) * 10000) / 100 : null,
    },
    shifts: shiftRows,
    staff,
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/fuel-sales
// Fuel-specific sales report:
//   - Total litres dispensed + revenue per grade
//   - Per-pump breakdown (litres + revenue + transaction count)
//   - Hourly dispensing pattern
//   - Average price per litre per grade
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fuel-sales', async (req, res) => {
  const { from, to, branch_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);

  let orderQuery = supabase
    .from('orders')
    .select('id, order_number, total, created_at, branch_id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .eq('order_type', 'fuel_sale')
    .gte('created_at', start)
    .lte('created_at', end);

  if (branch_id) orderQuery = orderQuery.eq('branch_id', branch_id as string);
  const { data: orders, error: oErr } = await orderQuery;
  if (oErr) { res.status(500).json({ error: oErr.message }); return; }

  const orderIds = (orders ?? []).map(o => o.id);

  // Get all order items for these fuel orders
  let itemData: Array<{ fuel_product_id: string | null; quantity: string; subtotal: string; order_id: string }> = [];
  if (orderIds.length) {
    const items = await chunkIn<any>(
      'order_items', 'order_id', orderIds,
      q => q.select('order_id, product_id, product_name, quantity, unit_price, subtotal'),
    );
    itemData = items ?? [];
  }

  // Aggregate by grade (product)
  const gradeMap: Record<string, {
    product_id: string; name: string;
    litres: number; revenue: number; transactions: number;
  }> = {};

  for (const item of itemData) {
    if (!gradeMap[item.product_id]) {
      gradeMap[item.product_id] = {
        product_id: item.product_id, name: item.product_name,
        litres: 0, revenue: 0, transactions: 0,
      };
    }
    gradeMap[item.product_id].litres       += Number(item.quantity);
    gradeMap[item.product_id].revenue      += Number(item.subtotal);
    gradeMap[item.product_id].transactions += 1;
  }

  const grades = Object.values(gradeMap).sort((a, b) => b.litres - a.litres);

  // Pump breakdown — join via orders.pump_id if available, else group by order
  const { data: pumps } = await supabase
    .from('pumps')
    .select('id, name, fuel_product_id')
    .eq('business_id', req.businessId);

  // Current tank levels per fuel_product — for opening/remaining calc
  const { data: tankRows } = await supabase
    .from('fuel_tanks')
    .select('fuel_product_id, current_level, capacity_litres')
    .eq('business_id', req.businessId);
  const tankByProduct: Record<string, { current_level: number; capacity_litres: number }> = {};
  (tankRows ?? [] as Array<{ fuel_product_id: string; capacity: number | string; current_level: number | string; products?: { name: string; base_price: string } | null }>).forEach(t => {
    tankByProduct[t.fuel_product_id] = { current_level: Number(t.current_level), capacity_litres: Number(t.capacity_litres) };
  });

  const pumpMap: Record<string, {
    pump_id: string; pump_name: string; fuel_product_id: string | null;
    litres: number; revenue: number; transactions: number;
    current_level: number | null; capacity_litres: number | null;
  }> = {};

  if (pumps) {
    for (const pump of pumps) {
      const pumpOrders = (orders ?? [] as Array<{ id: string; pump_id: string | null; total: string }>).filter(o => o.pump_id === pump.id);
      const pumpOrderIds = pumpOrders.map(o => o.id);
      const pumpItems = itemData.filter(i => pumpOrderIds.includes(i.order_id));
      const tank = pump.fuel_product_id ? tankByProduct[pump.fuel_product_id] : null;
      pumpMap[pump.id] = {
        pump_id:         pump.id,
        pump_name:       pump.name,
        fuel_product_id: pump.fuel_product_id ?? null,
        litres:          pumpItems.reduce((s, i) => s + Number(i.quantity), 0),
        revenue:         pumpItems.reduce((s, i) => s + Number(i.subtotal), 0),
        transactions:    pumpItems.length,
        current_level:   tank?.current_level ?? null,
        capacity_litres: tank?.capacity_litres ?? null,
      };
    }
  }

  // Hourly pattern
  const hourly: Record<number, { litres: number; revenue: number; count: number }> = {};
  for (const order of orders ?? []) {
    const h = new Date(order.created_at).getHours();
    if (!hourly[h]) hourly[h] = { litres: 0, revenue: 0, count: 0 };
    const orderItems = itemData.filter(i => i.order_id === order.id);
    hourly[h].litres  += orderItems.reduce((s, i) => s + Number(i.quantity), 0);
    hourly[h].revenue += Number(order.total);
    hourly[h].count   += 1;
  }

  const hourlySeries = Array.from({ length: 24 }, (_, h) => ({
    hour: h, ...((hourly[h]) ?? { litres: 0, revenue: 0, count: 0 }),
  }));

  res.json({
    summary: {
      totalLitres:      itemData.reduce((s, i) => s + Number(i.quantity), 0),
      totalRevenue:     (orders ?? []).reduce((s, o) => s + Number(o.total), 0),
      totalTransactions: (orders ?? []).length,
    },
    grades,
    pumps: Object.values(pumpMap).sort((a, b) => b.litres - a.litres),
    hourlySeries,
  });
});

// ── GET /api/reports/pump-monitor ────────────────────────────────────────────
// Real-time pump + tank status for the cockpit. Returns every pump with its
// linked tank's opening/sold/remaining for today, plus total revenue today.
router.get('/pump-monitor', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { start, end } = getDateRange(today, today);
  const { branch_id } = req.query;

  // All pumps for this business
  const { data: pumps } = await supabase
    .from('pumps')
    .select('id, name, status, fuel_product_id')
    .eq('business_id', req.businessId)
    .order('sort_order');

  // All tanks (current live levels)
  const { data: tanks } = await supabase
    .from('fuel_tanks')
    .select('id, name, fuel_product_id, capacity_litres, current_level, reorder_level, products(name, base_price)')
    .eq('business_id', req.businessId);

  const tankByProduct: Record<string, unknown> = {};
  (tanks ?? [] as Array<{ fuel_product_id: string; capacity: number | string; current_level: number | string; products?: { name: string } | null }>).forEach(t => { tankByProduct[t.fuel_product_id] = t; });

  // Today's fuel sales (litres + revenue per product)
  let ordQ = supabase
    .from('orders')
    .select('id, total')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .eq('order_type', 'fuel_sale')
    .gte('created_at', start)
    .lte('created_at', end);
  if (branch_id) ordQ = ordQ.eq('branch_id', branch_id as string);
  const { data: todayOrders } = await ordQ;

  const soldByProduct: Record<string, { litres: number; revenue: number; transactions: number }> = {};
  if ((todayOrders ?? []).length) {
    const { data: items } = await supabase
      .from('order_items')
      .select('product_id, quantity, subtotal')
      .in('order_id', (todayOrders ?? [] as Array<{ id: string; total: string; pump_id?: string | null }>).map(o => o.id));
    for (const i of items ?? []) {
      if (!i.product_id) continue;
      if (!soldByProduct[i.product_id]) soldByProduct[i.product_id] = { litres: 0, revenue: 0, transactions: 0 };
      soldByProduct[i.product_id].litres       += Number(i.quantity);
      soldByProduct[i.product_id].revenue      += Number(i.subtotal);
      soldByProduct[i.product_id].transactions += 1;
    }
  }

  const monitor = (pumps ?? [] as Array<{ id: string; name: string; fuel_product_id: string | null; status: string; sort_order: number }>).map(pump => {
    const pid   = pump.fuel_product_id;
    const tank  = pid ? tankByProduct[pid] : null;
    const sold  = pid ? (soldByProduct[pid] ?? { litres: 0, revenue: 0, transactions: 0 }) : null;
    const current = tank ? Number(tank.current_level) : null;
    const capacity = tank ? Number(tank.capacity_litres) : null;
    const soldLitres = sold?.litres ?? 0;
    // Opening stock for today = current + sold (since current has already been deducted)
    const opening = current !== null ? current + soldLitres : null;
    return {
      pump_id:         pump.id,
      pump_name:       pump.name,
      pump_status:     pump.status,
      fuel_product_id: pid ?? null,
      product_name:    tank?.products?.name ?? null,
      price_per_litre: tank?.products?.base_price ? Number(tank.products.base_price) : null,
      capacity_litres: capacity,
      opening_litres:  opening,
      sold_litres:     soldLitres,
      remaining_litres: current,
      revenue_today:   sold?.revenue ?? 0,
      transactions_today: sold?.transactions ?? 0,
      is_low:          tank ? Number(tank.current_level) <= Number(tank.reorder_level) : false,
      reorder_level:   tank ? Number(tank.reorder_level) : null,
    };
  });

  const totals = {
    total_revenue_today:  (todayOrders ?? [] as Array<{ total: string }>).reduce((s, o) => s + Number(o.total), 0),
    total_litres_today:   Object.values(soldByProduct).reduce((s, v) => s + v.litres, 0),
    total_transactions:   (todayOrders ?? []).length,
    pumps_low:            monitor.filter(p => p.is_low).length,
  };

  res.json({ pumps: monitor, totals });
});


// Wet stock / tank inventory report:
//   - Current tank levels (all tanks)
//   - Deliveries in the period (from stock_movements)
//   - Theoretical consumption (from order_items)
//   - Actual dip readings are manual — flag variance if recorded
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wet-stock', async (req, res) => {
  const { from, to, branch_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);

  // Current tank levels — include null-branch (business-wide) tanks
  let tanksQuery = supabase
    .from('fuel_tanks')
    .select('id, name, fuel_product_id, capacity_litres, current_level, reorder_level, products(name, base_price)')
    .eq('business_id', req.businessId);
  if (branch_id && typeof branch_id === 'string' && /^[0-9a-fA-F-]{36}$/.test(branch_id)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tanksQuery = (tanksQuery as any).or(`branch_id.eq.${branch_id},branch_id.is.null`);
  }
  const { data: tanks } = await tanksQuery;

  // Deliveries in period (stock_movements with movement_type = restock, reference_type = delivery)
  let movQuery = supabase
    .from('stock_movements')
    .select('product_id, quantity_change, quantity_after, notes, created_at')
    .eq('business_id', req.businessId)
    .eq('movement_type', 'restock')
    .gte('created_at', start)
    .lte('created_at', end);
  const { data: movements } = await movQuery;

  // Group deliveries by product
  const deliveriesByProduct: Record<string, { litres: number; count: number }> = {};
  for (const m of movements ?? []) {
    if (!m.product_id) continue;
    if (!deliveriesByProduct[m.product_id]) deliveriesByProduct[m.product_id] = { litres: 0, count: 0 };
    deliveriesByProduct[m.product_id].litres += Number(m.quantity_change);
    deliveriesByProduct[m.product_id].count  += 1;
  }

  // Theoretical consumption from fuel sales orders
  let salesQuery = supabase
    .from('orders')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('status', 'completed')
    .eq('order_type', 'fuel_sale')
    .gte('created_at', start)
    .lte('created_at', end);
  if (branch_id) salesQuery = salesQuery.eq('branch_id', branch_id as string);
  const { data: fuelOrders } = await salesQuery;
  const fuelOrderIds = (fuelOrders ?? [] as Array<{ id: string }>).map(o => o.id);

  const consumedByProduct: Record<string, number> = {};
  if (fuelOrderIds.length) {
    const { data: items } = await supabase
      .from('order_items')
      .select('product_id, quantity')
      .in('order_id', fuelOrderIds);
    for (const i of items ?? []) {
      if (!i.product_id) continue;
      consumedByProduct[i.product_id] = (consumedByProduct[i.product_id] ?? 0) + Number(i.quantity);
    }
  }

  // Build per-tank report
  const tankReport = (tanks ?? [] as Array<{ id: string; name: string; capacity: number | string; current_level: number | string; fuel_product_id: string | null; products?: { name: string; base_price: string } | null }>).map(tank => {
    const pid = tank.fuel_product_id;
    const pct = tank.capacity_litres > 0
      ? Math.round((tank.current_level / tank.capacity_litres) * 100) : 0;
    return {
      id:              tank.id,
      name:            tank.name,
      product_name:    tank.products?.name ?? 'Unknown',
      price_per_litre: tank.products?.base_price ?? 0,
      capacity_litres: tank.capacity_litres,
      current_level:   tank.current_level,
      reorder_level:   tank.reorder_level,
      level_pct:       pct,
      is_low:          tank.current_level <= tank.reorder_level,
      delivered_litres: deliveriesByProduct[pid]?.litres ?? 0,
      delivery_count:   deliveriesByProduct[pid]?.count  ?? 0,
      consumed_litres:  consumedByProduct[pid] ?? 0,
    };
  });

  // Build product name map for delivery log
  const productNameMap: Record<string, string> = {};
  (tanks ?? [] as Array<{ fuel_product_id?: string | null; products?: { name: string } | null }>).forEach(t => {
    if (t.fuel_product_id && t.products?.name) productNameMap[t.fuel_product_id] = t.products.name;
  });

  // Delivery log entries with product name
  const deliveryLog = (movements ?? [] as Array<{ product_id: string; type: string; quantity: string; notes?: string | null; created_at: string; products?: { name: string } | null; users?: { name: string } | null }>).map(m => ({
    product_id:   m.product_id,
    product_name: productNameMap[m.product_id] ?? null,
    litres:       Number(m.quantity_change),
    level_after:  Number(m.quantity_after),
    notes:        m.notes,
    recorded_at:  m.created_at,
  }));

  res.json({ tanks: tankReport, deliveryLog });
});

export default router;

