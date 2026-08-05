/**
 * reports-daily.ts — the three reports a restaurant actually reads
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET /api/reports/export/daily?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/hourly?format=xlsx|csv&from=&to=
 *   GET /api/reports/export/audit?format=xlsx|csv&from=&to=
 *
 * Separate file from reports-export.ts to keep that one readable; same router
 * prefix, same middleware, same helpers.
 *
 * WHY THESE THREE
 *
 * The existing exports (sales, products, shifts, expenses, pnl) are flat tables
 * — one row per order, one row per product. Useful for a spreadsheet, wrong for
 * the question an owner asks at close, which is "did today work, and does the
 * cash add up".
 *
 *   daily   Reconciliation. Net, tax, gross, tender breakdown, bill count. Laid
 *           out to mirror the report the client already reads from their old
 *           system, because a familiar shape is read and an unfamiliar one is
 *           filed.
 *   hourly  Staffing. Where the peaks are. For a fast-food counter this is the
 *           report that changes a rota.
 *   audit   Control. Every void, refund and discount with who and why. The
 *           discount and void paths are the two most common ways a till loses
 *           money, and neither was visible anywhere before this.
 *
 * Deliberately NOT built: labour and food-cost reports. Both need data this
 * system does not hold, and a report built on absent data is worse than no
 * report — it gets believed.
 */

import { sendError }  from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }   from '../lib/supabase';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { branchScope, requirePermission } from '../middleware/rbac';
import ExcelJS        from 'exceljs';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);
router.use(requirePermission('reports.financial'));

// ── Helpers (mirrors reports-export.ts) ──────────────────────────────────────

function getDateRange(from?: string, to?: string) {
  const now = new Date();
  const start = from ? new Date(from + 'T00:00:00')
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = to ? new Date(to + 'T23:59:59')
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

const money = (n: number) =>
  Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const round2 = (n: number) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

function styleHeader(row: ExcelJS.Row, bg = '1E3A5F') {
  row.height = 20;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } };
    cell.alignment = { vertical: 'middle' };
  });
}

function styleTitle(row: ExcelJS.Row) {
  row.font = { bold: true, size: 12, color: { argb: 'FF1E3A5F' } };
}

function autoWidth(ws: ExcelJS.Worksheet, min = 12) {
  ws.columns.forEach(col => {
    let max = min;
    col.eachCell?.({ includeEmpty: false }, c => {
      const len = String(c.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 52);
  });
}

async function sendExcel(res: any, wb: ExcelJS.Workbook, filename: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

function sendCsv(res: any, rows: (string | number)[][], filename: string) {
  const lines = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
}

async function businessName(businessId: string): Promise<string> {
  const { data } = await supabase.from('businesses').select('name').eq('id', businessId).maybeSingle();
  return data?.name ?? 'SwiftPOS';
}

/** Orders in range, completed only, with their payments and items. */
async function fetchOrders(businessId: string, branchId: string | null, start: string, end: string) {
  let q = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, status, created_at,
      subtotal, vat_amount, ctl_amount, discount_amount, tip_amount, total,
      refunded_at, refunded_amount, refund_reason, void_reason, cashier_id,
      payments ( method, amount, status ),
      order_items ( product_name, category_name, quantity, subtotal )
    `)
    .eq('business_id', businessId)
    .gte('created_at', start)
    .lte('created_at', end);

  if (branchId) q = q.eq('branch_id', branchId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// ── GET /daily ───────────────────────────────────────────────────────────────
//
// Deliberately mirrors the layout of the client's previous system: a summary
// line, a grand-total block, tender breakdown, then tax breakdown. They already
// know how to read it, and a report that gets read is worth more than a better
// one that does not.
router.get('/daily', async (req: any, res) => {
  try {
    const { from, to, format = 'xlsx' } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    // branchScope() is a HELPER that returns the branch to filter by (or null
    // for an owner viewing all branches). It was previously passed as router
    // middleware — but it never calls next(), so every request to this endpoint
    // hung forever. Resolving it here, the way reports-export.ts does, both
    // unblocks the route AND applies the correct branch: req.branchId alone was
    // undefined for owners, so an owner's selected branch was silently ignored.
    const scopedBranch = branchScope(req);
    const orders = await fetchOrders(req.businessId, scopedBranch, start, end);

    const completed = orders.filter((o: any) => o.status === 'completed');
    const voided    = orders.filter((o: any) => o.status === 'voided');
    const refunded  = completed.filter((o: any) => o.refunded_at);

    let net = 0, vat = 0, ctl = 0, discount = 0, gross = 0, tips = 0;
    for (const o of completed) {
      net      += Number(o.subtotal) || 0;
      vat      += Number(o.vat_amount) || 0;
      ctl      += Number(o.ctl_amount) || 0;
      discount += Number(o.discount_amount) || 0;
      tips     += Number(o.tip_amount) || 0;
      gross    += Number(o.total) || 0;
    }

    // Tender breakdown INCLUDES refund rows, which are negative. Netting them
    // is the point: the drawer holds what came in minus what went back out.
    const byMethod: Record<string, number> = {};
    for (const o of completed) {
      for (const p of (o.payments ?? []) as any[]) {
        if (p.status !== 'completed' && p.status !== 'refunded') continue;
        byMethod[p.method] = (byMethod[p.method] ?? 0) + (Number(p.amount) || 0);
      }
    }

    const byType: Record<string, { count: number; net: number; gross: number }> = {};
    for (const o of completed) {
      const k = o.order_type ?? 'retail';
      byType[k] ??= { count: 0, net: 0, gross: 0 };
      byType[k].count++;
      byType[k].net   += Number(o.subtotal) || 0;
      byType[k].gross += Number(o.total) || 0;
    }

    const bills = completed.length;
    const apc   = bills ? gross / bills : 0;   // average per cover/bill
    const label = `${(from as string) ?? start.slice(0, 10)}_${(to as string) ?? end.slice(0, 10)}`;
    const name  = await businessName(req.businessId);

    const blocks: (string | number)[][] = [
      [name], ['Daily Sales Report'],
      [`Period: ${start.slice(0, 10)} to ${end.slice(0, 10)}`],
      [`Generated: ${new Date().toLocaleString('en-KE')}`],
      [],
      ['Sale Type', 'Bills', 'Net Amount', 'Gross Amount'],
      ...Object.entries(byType).map(([k, v]) => [k, v.count, money(v.net), money(v.gross)]),
      ['Total Sales', bills, money(net), money(gross)],
      [],
      ['Grand Total'],
      ['Total Net Sale', money(net)],
      ['Discounts', money(discount)],
      ['Tips', money(tips)],
      ['Total Gross', money(gross)],
      ['Total Bills', bills],
      ['Average Per Bill', money(apc)],
      ['Voided Bills', voided.length],
      ['Refunded Bills', refunded.length],
      ['Refunded Value', money(refunded.reduce((s: number, o: any) => s + (Number(o.refunded_amount) || 0), 0))],
      [],
      ['Collection Breakup'],
      ['Mode', 'Amount'],
      ...Object.entries(byMethod).map(([m, a]) => [m, money(a)]),
      ['Total', money(Object.values(byMethod).reduce((s, a) => s + a, 0))],
      [],
      ['Tax Breakup'],
      ['Tax Name', 'Amount'],
      ['CTL', money(ctl)],
      ['VAT', money(vat)],
      ['Tax Total', money(ctl + vat)],
    ];

    if (format === 'csv') { sendCsv(res, blocks, `daily_sales_${label}.csv`); return; }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SwiftPOS';
    const ws = wb.addWorksheet('Daily Sales');
    blocks.forEach(b => ws.addRow(b));

    styleTitle(ws.getRow(1));
    styleTitle(ws.getRow(2));
    [6, 10, 21, 22, 27, 28].forEach(n => {
      const r = ws.getRow(n);
      if (r && r.getCell(1).value) styleHeader(r);
    });
    autoWidth(ws);
    await sendExcel(res, wb, `daily_sales_${label}.xlsx`);
  } catch (err) {
    sendError(res, err, { message: 'Failed to build the daily sales report' });
  }
});

// ── GET /hourly ──────────────────────────────────────────────────────────────
//
// Where the peaks are. For a counter operation this is the report that changes
// a rota, and it is the one thing the old system's daily report did not answer.
router.get('/hourly', async (req: any, res) => {
  try {
    const { from, to, format = 'xlsx' } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    // See /daily above — branchScope is a helper, not middleware.
    const scopedBranch = branchScope(req);
    const orders = (await fetchOrders(req.businessId, scopedBranch, start, end))
      .filter((o: any) => o.status === 'completed');

    const hours: Array<{ bills: number; gross: number; items: number }> =
      Array.from({ length: 24 }, () => ({ bills: 0, gross: 0, items: 0 }));

    for (const o of orders) {
      // Nairobi is UTC+3 with no daylight saving, so a fixed offset is correct
      // here and avoids a timezone dependency for one number.
      const h = new Date(new Date(o.created_at).getTime() + 3 * 3600_000).getUTCHours();
      hours[h].bills++;
      hours[h].gross += Number(o.total) || 0;
      hours[h].items += (o.order_items ?? []).reduce((s: number, i: any) => s + (Number(i.quantity) || 0), 0);
    }

    const busiest = hours.reduce((best, h, i) => (h.gross > hours[best].gross ? i : best), 0);
    const label   = `${(from as string) ?? start.slice(0, 10)}_${(to as string) ?? end.slice(0, 10)}`;
    const name    = await businessName(req.businessId);
    const total   = hours.reduce((s, h) => s + h.gross, 0);

    const rows: (string | number)[][] = [
      [name], ['Sales by Hour'],
      [`Period: ${start.slice(0, 10)} to ${end.slice(0, 10)}`],
      [`Busiest hour: ${String(busiest).padStart(2, '0')}:00`],
      [],
      ['Hour', 'Bills', 'Items', 'Gross', '% of day'],
      ...hours.map((h, i) => [
        `${String(i).padStart(2, '0')}:00`,
        h.bills, h.items, money(h.gross),
        total ? `${((h.gross / total) * 100).toFixed(1)}%` : '0.0%',
      ]),
      ['Total', hours.reduce((s, h) => s + h.bills, 0), hours.reduce((s, h) => s + h.items, 0), money(total), '100.0%'],
    ];

    if (format === 'csv') { sendCsv(res, rows, `hourly_sales_${label}.csv`); return; }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SwiftPOS';
    const ws = wb.addWorksheet('By Hour');
    rows.forEach(r => ws.addRow(r));
    styleTitle(ws.getRow(1)); styleTitle(ws.getRow(2)); styleHeader(ws.getRow(6));
    // Shade the busiest hour — the whole point of the report is spotting it.
    ws.getRow(7 + busiest).eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    });
    autoWidth(ws);
    await sendExcel(res, wb, `hourly_sales_${label}.xlsx`);
  } catch (err) {
    sendError(res, err, { message: 'Failed to build the hourly report' });
  }
});

// ── GET /audit ───────────────────────────────────────────────────────────────
//
// Every void, refund and discount, with who and why.
//
// These are the two most common ways a till loses money and neither was visible
// anywhere. A discount is not suspicious; a pattern of discounts on one PIN at
// one hour is. The report exists so that pattern can be seen without anyone
// having to go looking for it.
router.get('/audit', async (req: any, res) => {
  try {
    const { from, to, format = 'xlsx' } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    // See /daily above — branchScope is a helper, not middleware.
    const scopedBranch = branchScope(req);
    const orders = await fetchOrders(req.businessId, scopedBranch, start, end);

    const staffIds = [...new Set(orders.map((o: any) => o.cashier_id).filter(Boolean))];
    const { data: staff } = staffIds.length
      ? await supabase.from('users').select('id, name').in('id', staffIds)
      : { data: [] as any[] };
    const nameOf = (id: string) => (staff ?? []).find((s: any) => s.id === id)?.name ?? '—';

    const events: (string | number)[][] = [];
    for (const o of orders) {
      const when = new Date(o.created_at).toLocaleString('en-KE');
      if (o.status === 'voided') {
        events.push(['Void', o.order_number, when, nameOf(o.cashier_id), money(o.total), o.void_reason ?? '—']);
      }
      if (o.refunded_at) {
        events.push(['Refund', o.order_number, new Date(o.refunded_at).toLocaleString('en-KE'),
          nameOf(o.cashier_id), money(o.refunded_amount), o.refund_reason ?? '—']);
      }
      if (Number(o.discount_amount) > 0 && o.status === 'completed') {
        const pct = Number(o.subtotal) ? (Number(o.discount_amount) / Number(o.subtotal)) * 100 : 0;
        events.push(['Discount', o.order_number, when, nameOf(o.cashier_id),
          money(o.discount_amount), `${pct.toFixed(1)}% of ${money(o.subtotal)}`]);
      }
    }
    events.sort((a, b) => String(a[2]).localeCompare(String(b[2])));

    // Per-cashier totals. One line each, so an outlier is obvious without
    // reading three hundred events.
    const perStaff: Record<string, { voids: number; refunds: number; discounts: number; value: number }> = {};
    for (const e of events) {
      const who = String(e[3]);
      perStaff[who] ??= { voids: 0, refunds: 0, discounts: 0, value: 0 };
      if (e[0] === 'Void')     perStaff[who].voids++;
      if (e[0] === 'Refund')   perStaff[who].refunds++;
      if (e[0] === 'Discount') perStaff[who].discounts++;
      perStaff[who].value += Number(String(e[4]).replace(/,/g, '')) || 0;
    }

    const label = `${(from as string) ?? start.slice(0, 10)}_${(to as string) ?? end.slice(0, 10)}`;
    const name  = await businessName(req.businessId);

    const head: (string | number)[][] = [
      [name], ['Voids, Refunds and Discounts'],
      [`Period: ${start.slice(0, 10)} to ${end.slice(0, 10)}`],
      [`${events.length} events`],
      [],
      ['By staff member'],
      ['Staff', 'Voids', 'Refunds', 'Discounts', 'Total value'],
      ...Object.entries(perStaff).map(([w, v]) => [w, v.voids, v.refunds, v.discounts, money(v.value)]),
      [],
      ['All events'],
      ['Type', 'Bill', 'When', 'Staff', 'Amount', 'Reason'],
      ...events,
    ];

    if (format === 'csv') { sendCsv(res, head, `audit_${label}.csv`); return; }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SwiftPOS';
    const ws = wb.addWorksheet('Audit');
    head.forEach(r => ws.addRow(r));
    styleTitle(ws.getRow(1)); styleTitle(ws.getRow(2));
    styleHeader(ws.getRow(7));
    styleHeader(ws.getRow(7 + Object.keys(perStaff).length + 3));
    autoWidth(ws);
    await sendExcel(res, wb, `audit_${label}.xlsx`);
  } catch (err) {
    sendError(res, err, { message: 'Failed to build the audit report' });
  }
});

export default router;
