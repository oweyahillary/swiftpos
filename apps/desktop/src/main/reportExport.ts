/**
 * reportExport.ts — CSV export for the desktop manager reports.
 *
 * WHY CSV AND NOT XLSX
 *   The server already builds real Excel files with exceljs, but that path is
 *   online-only, and the manager who needs a report at closing time is standing at
 *   a till that may have no internet. CSV needs no dependency, opens in Excel, and
 *   works offline — which is the whole point.
 *
 * WHY EVERY EXPORT CARRIES A SCOPE HEADER
 *   A till holds only its OWN orders; only the aggregation node holds the branch's.
 *   A spreadsheet with no provenance gets emailed, filed and quoted, and by then
 *   nobody can tell whether it was one till or three. So each file states the
 *   terminal, what it covers, the range, and how far back local data goes. A
 *   partial report is fine. A silently partial one is not.
 */

import { dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRange, getReportScope, getSalesSummary, getTopProducts, getRecentOrders,
  type RangePreset,
} from './managerReports';

export type ReportKind = 'sales' | 'orders' | 'products';

/**
 * RFC-4180 escaping.
 *
 * Non-negotiable here because the data is user-entered: product names contain
 * commas, notes contain quotes and newlines. Naive joining silently shifts every
 * later column on the affected row, so the file still opens and still looks
 * plausible while the numbers sit under the wrong headings.
 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: unknown[]) => cells.map(cell).join(',');

/** Excel needs a BOM to read UTF-8; without it Kenyan names with accents mangle. */
const BOM = '\uFEFF';

function scopeHeader(rangeLabel: string): string[] {
  const scope = getReportScope();
  return [
    row(['SwiftPOS report']),
    row(['Range', rangeLabel]),
    row(['Terminal', scope.terminalCode ?? 'unknown']),
    row(['Covers', scope.scopeLabel]),
    row(['Local data from', scope.earliestOrder ?? 'no orders recorded']),
    row(['Generated', new Date().toLocaleString('en-KE')]),
    '',
  ];
}

function buildSales(rangeLabel: string, range: ReturnType<typeof resolveRange>): string {
  const d = getSalesSummary(range);
  const lines = [
    ...scopeHeader(rangeLabel),
    row(['Metric', 'Value']),
    row(['Total revenue', d.summary.totalRevenue.toFixed(2)]),
    row(['Orders', d.summary.totalOrders]),
    row(['Average order', d.summary.avgOrderValue.toFixed(2)]),
    row(['VAT', d.summary.totalVat.toFixed(2)]),
    row(['Discounts', d.summary.totalDiscount.toFixed(2)]),
    '',
    row(['Payment method', 'Amount']),
    ...Object.entries(d.paymentMethods).map(([m, a]) => row([m, Number(a).toFixed(2)])),
    '',
    row(['Hour', 'Orders', 'Revenue']),
    ...d.hourly.map(h => row([`${String(h.hour).padStart(2, '0')}:00`, h.orders, h.revenue.toFixed(2)])),
  ];
  return BOM + lines.join('\r\n');
}

function buildOrders(rangeLabel: string, range: ReturnType<typeof resolveRange>): string {
  // limit 0 = no LIMIT. An export must be the whole range, not the first 30 —
  // a truncated spreadsheet that looks complete is the worst possible artefact.
  const orders = getRecentOrders(0, range) as any[];
  const lines = [
    ...scopeHeader(rangeLabel),
    row(['Order number', 'Date', 'Type', 'Status', 'Cashier', 'Terminal',
         'Subtotal ex-tax', 'CTL', 'VAT', 'Discount', 'Tip', 'Total', 'Payment methods']),
    ...orders.map(o => row([
      o.order_number,
      o.created_at,
      o.order_type,
      o.status,
      o.cashier_name ?? '',
      o.device_id ?? '',
      Number(o.total ?? 0) - Number(o.vat_amount ?? 0) - Number(o.ctl_amount ?? 0),
      Number(o.ctl_amount ?? 0).toFixed(2),
      Number(o.vat_amount ?? 0).toFixed(2),
      Number(o.discount_amount ?? 0).toFixed(2),
      Number(o.tip_amount ?? 0).toFixed(2),
      Number(o.total ?? 0).toFixed(2),
      // Semicolons, not commas: a comma here would need quoting and is easy to
      // misread as a column break when someone scans the file by eye.
      (o.payments ?? []).map((p: any) => `${p.method} ${Number(p.amount).toFixed(2)}`).join('; '),
    ])),
    '',
    row(['Orders in range', orders.length]),
    row(['Total', orders.reduce((s, o) => s + Number(o.total ?? 0), 0).toFixed(2)]),
  ];
  return BOM + lines.join('\r\n');
}

function buildProducts(rangeLabel: string, range: ReturnType<typeof resolveRange>): string {
  const items = getTopProducts(1000, range) as any[];
  const lines = [
    ...scopeHeader(rangeLabel),
    row(['Product', 'Quantity', 'Revenue']),
    ...items.map(i => row([
      i.name ?? i.product_name ?? '',
      i.quantity ?? i.qty ?? 0,
      Number(i.revenue ?? 0).toFixed(2),
    ])),
  ];
  return BOM + lines.join('\r\n');
}

export interface ExportRequest {
  kind: ReportKind;
  preset?: RangePreset;
  from?: string;
  to?: string;
}

export async function exportReportCsv(
  req: ExportRequest,
): Promise<{ ok: boolean; path?: string; error?: string; rows?: number }> {
  try {
    const range = resolveRange(req.preset ?? 'today', req.from, req.to);
    const scope = getReportScope();

    const body =
      req.kind === 'orders' ? buildOrders(range.label, range)
      : req.kind === 'products' ? buildProducts(range.label, range)
      : buildSales(range.label, range);

    // Filename carries the terminal and the range, so two files from two tills
    // cannot be confused once they are both sitting in a Downloads folder.
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '');
    const suggested =
      `swiftpos-${req.kind}-${safe(scope.terminalCode ?? 'till')}-${safe(range.label)}.csv`;

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save report',
      defaultPath: suggested,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    // Cancelling is a normal outcome, not a failure. Reporting it as an error
    // would train the manager to ignore the error banner.
    if (result.canceled || !result.filePath) return { ok: false };

    const target = result.filePath.endsWith('.csv') ? result.filePath : `${result.filePath}.csv`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');

    const rows = body.split('\r\n').length;
    return { ok: true, path: target, rows };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not write the file' };
  }
}
