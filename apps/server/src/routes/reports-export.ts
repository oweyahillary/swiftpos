/**
 * reports-export.ts — PDF and Excel Report Export Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds export endpoints to the existing reports router.
 *
 * Routes:
 *   GET /api/reports/export/sales?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/products?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/shifts?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/expenses?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/pnl?format=xlsx|csv&from=&to=
 *
 * INSTALL DEPENDENCY:
 *   pnpm --filter server add exceljs
 *
 * INTEGRATION:
 *   In routes/index.ts, add:
 *     import reportsExportRoutes from './reports-export';
 *     router.use('/reports/export', reportsExportRoutes);
 *   (Must be registered BEFORE the existing /reports catch-all)
 */

import { Router }    from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }  from '../lib/supabase';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { branchScope } from '../middleware/rbac';
import ExcelJS       from 'exceljs';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);   // export is a web-portal surface — block desktop tokens

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDateRange(from?: string, to?: string) {
  const now = new Date();
  const start = from
    ? new Date(from)
    : new Date(now.getFullYear(), now.getMonth(), 1); // default: this month
  const end = to
    ? new Date(to + 'T23:59:59')
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtMoney(n: number): string {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Apply SwiftPOS header style to a worksheet row */
function styleHeader(row: ExcelJS.Row, bgColor = '1E3A5F') {
  row.height = 22;
  row.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgColor } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border    = { bottom: { style: 'thin', color: { argb: 'FF334155' } } };
  });
}

/** Set column widths automatically */
function autoWidth(worksheet: ExcelJS.Worksheet, minWidth = 12) {
  worksheet.columns.forEach(col => {
    let max = minWidth;
    col.eachCell?.({ includeEmpty: false }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 50);
  });
}

/** Respond with Excel workbook */
async function sendExcel(res: any, wb: ExcelJS.Workbook, filename: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

/** Respond with CSV */
function sendCsv(res: any, headers: string[], rows: (string | number)[][], filename: string) {
  const lines = [
    headers.join(','),
    ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')),
  ];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
}

// ── GET /api/reports/export/sales ─────────────────────────────────────────────

router.get('/sales', async (req, res) => {
  const { from, to, format = 'xlsx' } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select(`
      order_number, order_type, status, subtotal, vat_amount,
      discount_amount, total, created_at,
      branches(name),
      payments(method, amount, status, reference)
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
  const dateLabel = `${(from as string) ?? start.slice(0, 10)}_to_${(to as string) ?? end.slice(0, 10)}`;

  if (format === 'csv') {
    const headers = ['Order #', 'Date', 'Type', 'Subtotal', 'VAT', 'Discount', 'Total', 'Payment Method', 'Branch'];
    const rows = o.map(order => [
      order.order_number,
      fmtDate(order.created_at),
      order.order_type,
      fmtMoney(order.subtotal),
      fmtMoney(order.vat_amount ?? 0),
      fmtMoney(order.discount_amount ?? 0),
      fmtMoney(order.total),
      (order.payments ?? []).map((p: any) => p.method).join('+'),
      (order as any).branches?.name ?? '',
    ]);
    sendCsv(res, headers, rows, `swiftpos_sales_${dateLabel}.csv`);
    return;
  }

  // Excel
  const wb = new ExcelJS.Workbook();
  wb.creator   = 'SwiftPOS';
  wb.created   = new Date();

  // Sales sheet
  const ws = wb.addWorksheet('Sales', { views: [{ state: 'frozen', ySplit: 2 }] });

  // Title row
  ws.mergeCells('A1:I1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `Sales Report — ${fmtDate(start)} to ${fmtDate(end)}`;
  titleCell.font  = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 28;

  const headerRow = ws.addRow(['Order #', 'Date', 'Type', 'Branch', 'Subtotal', 'VAT', 'Discount', 'Total', 'Payment']);
  styleHeader(headerRow);

  o.forEach(order => {
    const row = ws.addRow([
      order.order_number,
      fmtDate(order.created_at),
      order.order_type,
      (order as any).branches?.name ?? '',
      Number(order.subtotal),
      Number(order.vat_amount ?? 0),
      Number(order.discount_amount ?? 0),
      Number(order.total),
      (order.payments ?? []).map((p: any) => p.method).join('+'),
    ]);
    // Money columns
    [5, 6, 7, 8].forEach(col => {
      row.getCell(col).numFmt = '#,##0.00';
    });
  });

  // Totals row
  const totalRow = ws.addRow([
    'TOTAL', '', '', '',
    o.reduce((s, x) => s + Number(x.subtotal), 0),
    o.reduce((s, x) => s + Number(x.vat_amount ?? 0), 0),
    o.reduce((s, x) => s + Number(x.discount_amount ?? 0), 0),
    o.reduce((s, x) => s + Number(x.total), 0),
    `${o.length} orders`,
  ]);
  totalRow.font = { bold: true };
  [5, 6, 7, 8].forEach(col => { totalRow.getCell(col).numFmt = '#,##0.00'; });

  // Summary sheet
  const ws2 = wb.addWorksheet('Summary');
  ws2.addRow(['Metric', 'Value']);
  styleHeader(ws2.getRow(1));
  const totalRevenue = o.reduce((s, x) => s + Number(x.total), 0);
  [
    ['Total orders',         o.length],
    ['Total revenue',        fmtMoney(totalRevenue)],
    ['Total VAT',            fmtMoney(o.reduce((s, x) => s + Number(x.vat_amount ?? 0), 0))],
    ['Total discounts',      fmtMoney(o.reduce((s, x) => s + Number(x.discount_amount ?? 0), 0))],
    ['Avg order value',      fmtMoney(o.length ? totalRevenue / o.length : 0)],
    ['Period start',         fmtDate(start)],
    ['Period end',           fmtDate(end)],
    ['Exported',             fmtDate(new Date().toISOString())],
  ].forEach(([k, v]) => ws2.addRow([k, v]));

  autoWidth(ws);
  autoWidth(ws2);

  await sendExcel(res, wb, `swiftpos_sales_${dateLabel}.xlsx`);
});

// ── GET /api/reports/export/products ─────────────────────────────────────────

router.get('/products', async (req, res) => {
  const { from, to, format = 'xlsx' } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let ordersQ = supabase.from('orders').select('id')
    .eq('business_id', req.businessId).eq('status', 'completed')
    .gte('created_at', start).lte('created_at', end);
  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: orders } = await ordersQ;
  const ids = (orders ?? []).map((o: any) => o.id);

  if (!ids.length) {
    res.status(200).json({ message: 'No orders in this period' });
    return;
  }

  const { data: items, error } = await supabase
    .from('order_items')
    .select('product_id, product_name, category_name, quantity, unit_price, subtotal')
    .in('order_id', ids);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const productMap: Record<string, { name: string; category: string; qty: number; revenue: number; orders: number }> = {};
  (items ?? []).forEach((item: any) => {
    const key = item.product_id ?? item.product_name;
    if (!productMap[key]) {
      productMap[key] = { name: item.product_name, category: item.category_name ?? '', qty: 0, revenue: 0, orders: 0 };
    }
    productMap[key].qty     += Number(item.quantity);
    productMap[key].revenue += Number(item.subtotal);
    productMap[key].orders++;
  });

  const rows = Object.values(productMap).sort((a, b) => b.revenue - a.revenue);
  const dateLabel = `${(from as string) ?? start.slice(0, 10)}_to_${(to as string) ?? end.slice(0, 10)}`;

  if (format === 'csv') {
    sendCsv(res,
      ['Product', 'Category', 'Qty Sold', 'Revenue', 'Orders'],
      rows.map(r => [r.name, r.category, r.qty, fmtMoney(r.revenue), r.orders]),
      `swiftpos_products_${dateLabel}.csv`,
    );
    return;
  }

  const wb  = new ExcelJS.Workbook();
  wb.creator = 'SwiftPOS';
  const ws  = wb.addWorksheet('Top Products', { views: [{ state: 'frozen', ySplit: 2 }] });

  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = `Product Sales — ${fmtDate(start)} to ${fmtDate(end)}`;
  ws.getCell('A1').font  = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
  ws.getRow(1).height = 28;

  const hr = ws.addRow(['Product', 'Category', 'Qty Sold', 'Revenue (KES)', 'Orders']);
  styleHeader(hr);

  rows.forEach((r, i) => {
    const row = ws.addRow([r.name, r.category, r.qty, r.revenue, r.orders]);
    if (i % 2 === 1) {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2030' } }; });
    }
    row.getCell(4).numFmt = '#,##0.00';
  });

  autoWidth(ws);
  await sendExcel(res, wb, `swiftpos_products_${dateLabel}.xlsx`);
});

// ── GET /api/reports/export/pnl ───────────────────────────────────────────────

router.get('/pnl', async (req, res) => {
  const { from, to, format = 'xlsx' } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  // Revenue
  let ordersQ = supabase.from('orders').select('total, subtotal, vat_amount')
    .eq('business_id', req.businessId).eq('status', 'completed')
    .gte('created_at', start).lte('created_at', end);
  if (scopedBranch) ordersQ = ordersQ.eq('branch_id', scopedBranch);
  const { data: orders } = await ordersQ;

  // COGS — join order_items → products(cost_price)
  let itemsQ = supabase.from('order_items')
    .select('quantity, unit_price, subtotal, products(cost_price)')
    .in('order_id', (orders ?? []).map((o: any) => o.id ?? '').filter(Boolean));
  const { data: items } = await itemsQ;

  // Expenses
  let expQ = supabase.from('expenses').select('amount, category, description')
    .eq('business_id', req.businessId)
    .gte('date', start.slice(0, 10)).lte('date', end.slice(0, 10));
  if (scopedBranch) expQ = expQ.eq('branch_id', scopedBranch);
  const { data: expenses } = await expQ;

  const totalRevenue = (orders ?? []).reduce((s: number, o: any) => s + Number(o.total), 0);
  const totalVat     = (orders ?? []).reduce((s: number, o: any) => s + Number(o.vat_amount ?? 0), 0);
  const revenueExVat = totalRevenue - totalVat;

  const cogs = (items ?? []).reduce((s: number, item: any) => {
    const cost = item.products?.cost_price;
    if (cost == null) return s;
    return s + Number(cost) * Number(item.quantity);
  }, 0);

  const grossProfit = revenueExVat - cogs;
  const totalExpenses = (expenses ?? []).reduce((s: number, e: any) => s + Number(e.amount), 0);
  const netProfit = grossProfit - totalExpenses;

  const dateLabel = `${(from as string) ?? start.slice(0, 10)}_to_${(to as string) ?? end.slice(0, 10)}`;

  if (format === 'csv') {
    sendCsv(res,
      ['Metric', 'KES'],
      [
        ['Revenue (incl. VAT)',  fmtMoney(totalRevenue)],
        ['VAT collected',        fmtMoney(totalVat)],
        ['Revenue (excl. VAT)', fmtMoney(revenueExVat)],
        ['COGS',                fmtMoney(cogs)],
        ['Gross profit',        fmtMoney(grossProfit)],
        ['Gross margin %',      cogs > 0 ? ((grossProfit / revenueExVat) * 100).toFixed(1) + '%' : '—'],
        ['Operating expenses',  fmtMoney(totalExpenses)],
        ['Net profit',          fmtMoney(netProfit)],
      ],
      `swiftpos_pnl_${dateLabel}.csv`,
    );
    return;
  }

  const wb  = new ExcelJS.Workbook();
  wb.creator = 'SwiftPOS';
  const ws  = wb.addWorksheet('P&L');

  ws.mergeCells('A1:B1');
  ws.getCell('A1').value = `Profit & Loss — ${fmtDate(start)} to ${fmtDate(end)}`;
  ws.getCell('A1').font  = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  ws.getRow(1).height = 32;

  const addSection = (label: string) => {
    const r = ws.addRow([label, '']);
    r.font = { bold: true, size: 11, color: { argb: 'FF64748B' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  };

  const addLine = (label: string, value: number, bold = false, color?: string) => {
    const r = ws.addRow([label, value]);
    r.getCell(2).numFmt = '#,##0.00';
    if (bold)  r.font  = { bold: true };
    if (color) r.getCell(2).font = { bold, color: { argb: 'FF' + color } };
  };

  addSection('REVENUE');
  addLine('Gross revenue (incl. VAT)', totalRevenue);
  addLine('Less: VAT collected', -totalVat);
  addLine('Net revenue', revenueExVat, true);
  ws.addRow(['', '']);

  addSection('COST OF GOODS SOLD');
  addLine('COGS', cogs);
  addLine('Gross profit', grossProfit, true, grossProfit >= 0 ? '22C55E' : 'EF4444');
  addLine('Gross margin', revenueExVat > 0 ? Number(((grossProfit / revenueExVat) * 100).toFixed(1)) : 0);
  ws.addRow(['', '']);

  addSection('OPERATING EXPENSES');
  const expByCategory: Record<string, number> = {};
  (expenses ?? []).forEach((e: any) => {
    expByCategory[e.category ?? 'Other'] = (expByCategory[e.category ?? 'Other'] ?? 0) + Number(e.amount);
  });
  Object.entries(expByCategory).forEach(([cat, amt]) => addLine(`  ${cat}`, amt));
  addLine('Total expenses', totalExpenses, true);
  ws.addRow(['', '']);

  addSection('NET PROFIT');
  addLine('Net profit / (loss)', netProfit, true, netProfit >= 0 ? '22C55E' : 'EF4444');

  autoWidth(ws, 20);
  ws.getColumn(1).width = 32;

  await sendExcel(res, wb, `swiftpos_pnl_${dateLabel}.xlsx`);
});

// ── GET /api/reports/export/shifts ────────────────────────────────────────────

router.get('/shifts', async (req, res) => {
  const { from, to, format = 'xlsx' } = req.query;
  const { start, end } = getDateRange(from as string, to as string);

  const { data: shifts, error } = await supabase
    .from('shifts')
    .select(`
      id, opened_at, closed_at, opening_float, closing_float, cash_variance,
      users(name),
      branches(name)
    `)
    .eq('business_id', req.businessId)
    .gte('opened_at', start)
    .lte('opened_at', end)
    .order('opened_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const s = shifts ?? [];
  const dateLabel = `${(from as string) ?? start.slice(0, 10)}_to_${(to as string) ?? end.slice(0, 10)}`;

  if (format === 'csv') {
    sendCsv(res,
      ['Cashier', 'Branch', 'Opened', 'Closed', 'Opening Float', 'Closing Float', 'Variance'],
      s.map((sh: any) => [
        sh.users?.name ?? '',
        sh.branches?.name ?? '',
        fmtDate(sh.opened_at),
        sh.closed_at ? fmtDate(sh.closed_at) : 'Open',
        fmtMoney(sh.opening_float ?? 0),
        fmtMoney(sh.closing_float ?? 0),
        fmtMoney(sh.cash_variance ?? 0),
      ]),
      `swiftpos_shifts_${dateLabel}.csv`,
    );
    return;
  }

  const wb  = new ExcelJS.Workbook();
  wb.creator = 'SwiftPOS';
  const ws  = wb.addWorksheet('Shifts');
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = `Shift Reconciliation — ${fmtDate(start)} to ${fmtDate(end)}`;
  ws.getCell('A1').font  = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
  ws.getRow(1).height = 28;

  const hr = ws.addRow(['Cashier', 'Branch', 'Opened', 'Closed', 'Opening Float', 'Closing Float', 'Cash Variance']);
  styleHeader(hr);

  s.forEach((sh: any) => {
    const row = ws.addRow([
      (sh.users as any)?.name ?? '',
      (sh.branches as any)?.name ?? '',
      fmtDate(sh.opened_at),
      sh.closed_at ? fmtDate(sh.closed_at) : 'Open',
      Number(sh.opening_float ?? 0),
      Number(sh.closing_float ?? 0),
      Number(sh.cash_variance ?? 0),
    ]);
    [5, 6, 7].forEach(c => { row.getCell(c).numFmt = '#,##0.00'; });
    const variance = Number(sh.cash_variance ?? 0);
    if (Math.abs(variance) > 1) {
      row.getCell(7).font = { color: { argb: variance < 0 ? 'FFEF4444' : 'FF22C55E' } };
    }
  });

  autoWidth(ws);
  await sendExcel(res, wb, `swiftpos_shifts_${dateLabel}.xlsx`);
});

export default router;
