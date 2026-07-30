/**
 * dailySalesReport.ts — the Daily Sales Report, as an .xlsx.
 *
 * Modelled on the report the staff already read (Ushirika/POSIST export), section
 * for section and in the same order, because familiarity is the whole point: a
 * manager who has read that layout every day for a year should not have to learn a
 * new one to check the same numbers.
 *
 * ── THE ARITHMETIC ALREADY MATCHED ──────────────────────────────────────────
 * Verified against a real export before writing any of this:
 *
 *     net 26,259.36 + CTL 525.24 + VAT 4,201.49 = 30,986.09 gross
 *     round-off  -0.09
 *     cash 9,334 + other 21,652 = 30,986 collection total
 *
 * That is exactly how ReceiptView presents a sale — line amounts NET of tax with
 * CTL and VAT added back beneath — so no change to the data model was needed. The
 * report is a different arrangement of figures SwiftPOS already computes, which is
 * why it can be trusted.
 *
 * ── VALUES, NOT FORMULAS ────────────────────────────────────────────────────
 * Section totals are written as literal numbers, matching the source report. This
 * is a snapshot of a closed period, not a model anyone edits: a SUM() here would
 * recalculate against rows a reader had filtered or deleted and quietly disagree
 * with the till.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * A till holds only its OWN orders; only the aggregation node holds the branch's.
 * The header states which, in the file itself, because a spreadsheet gets emailed
 * and filed and by then nobody can tell which machine produced it.
 *
 * ── TWO COLUMNS DELIBERATELY NOT COPIED ─────────────────────────────────────
 * Covers / APC   `orders.covers` exists in Postgres but not in the till's SQLite,
 *                so it cannot be filled. The source report reads Covers (0) and
 *                APC (0.00) anyway — the incumbent is not capturing it either.
 *                Shown as "not tracked" rather than a fake 0.
 * Time Slot      SwiftPOS has no meal-session concept, and the source prints NA
 *                down the whole column. Replaced with a real hourly breakdown,
 *                which is what a manager would want that column for.
 */

import ExcelJS from 'exceljs';
import { dialog, BrowserWindow } from 'electron';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { resolveRange, getReportScope, type RangePreset } from './managerReports';

const FONT = 'Arial';
const MONEY = '#,##0.00;(#,##0.00);-';

/** Two decimals, applied where a value is WRITTEN, not merely displayed.
 *  numFmt formats; it does not round. Left raw, 15253.449999999999 survives into
 *  any sum a reader builds on top of the sheet. */
const money2 = (n: number) => Number(n.toFixed(2));
const INT = '#,##0;(#,##0);-';

/** Payment methods in the source report's order, mapped to SwiftPOS methods. */
const MODE_ROWS: { label: string; methods: string[] }[] = [
  { label: 'Cash', methods: ['cash'] },
  { label: 'M-Pesa', methods: ['mpesa'] },
  { label: 'Card', methods: ['card'] },
  { label: 'On Account', methods: ['credit'] },
];

interface Totals {
  netSales: number;
  grossSales: number;
  vat: number;
  ctl: number;
  bills: number;
  roundOff: number;
  /** Diners across dine-in bills. Null when nothing in range recorded any. */
  covers: number | null;
  /** Dine-in bills only — the denominator APC is actually about. */
  dineInBills: number;
}

function readTotals(from: string, to: string): Totals {
  const db = getLocalDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS bills,
           COALESCE(SUM(total), 0)        AS gross,
           COALESCE(SUM(vat_amount), 0)   AS vat,
           COALESCE(SUM(ctl_amount), 0)   AS ctl
      FROM orders
     WHERE status = 'completed' AND created_at >= ? AND created_at <= ?
  `).get(from, to) as { bills: number; gross: number; vat: number; ctl: number };

  const gross = Number(r.gross);
  const vat = Number(r.vat);
  const ctl = Number(r.ctl);

  // Covers count only for DINE-IN. Every other row defaults to 1, so summing all
  // of them would silently count each takeaway bag as a diner and drag APC toward
  // the average bill — a number that looks like APC and is not.
  const cv = db.prepare(`
    SELECT COALESCE(SUM(covers), 0) AS covers, COUNT(*) AS bills
      FROM orders
     WHERE status = 'completed' AND order_type = 'dine_in'
       AND created_at >= ? AND created_at <= ?
  `).get(from, to) as { covers: number; bills: number };

  // Round-off is the difference between the exact gross and what was actually
  // charged to the nearest whole unit — the same figure the receipt prints, and
  // the reason a day's printed lines always foot to the amount taken.
  const roundOff = Math.round(gross) - gross;

  return {
    netSales: gross - vat - ctl,
    grossSales: gross,
    vat,
    ctl,
    bills: Number(r.bills),
    roundOff: Number(roundOff.toFixed(2)),
    covers: Number(cv.bills) > 0 ? Number(cv.covers) : null,
    dineInBills: Number(cv.bills),
  };
}

/** Net-of-tax sales on DINE-IN bills only — the numerator for APC. */
function dineInNet(from: string, to: string): number {
  const db = getLocalDb();
  const r = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS gross,
           COALESCE(SUM(vat_amount), 0) AS vat,
           COALESCE(SUM(ctl_amount), 0) AS ctl
      FROM orders
     WHERE status = 'completed' AND order_type = 'dine_in'
       AND created_at >= ? AND created_at <= ?
  `).get(from, to) as { gross: number; vat: number; ctl: number };
  return Number(r.gross) - Number(r.vat) - Number(r.ctl);
}

function readByMode(from: string, to: string): Map<string, number> {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT p.method AS method, COALESCE(SUM(p.amount), 0) AS amt
      FROM payments p
      JOIN orders o ON o.id = p.order_id
     WHERE o.status = 'completed' AND o.created_at >= ? AND o.created_at <= ?
     GROUP BY p.method
  `).all(from, to) as { method: string; amt: number }[];
  return new Map(rows.map(r => [String(r.method), Number(r.amt)]));
}

function readHourly(from: string, to: string) {
  const db = getLocalDb();
  return db.prepare(`
    SELECT strftime('%H', created_at, 'localtime') AS hour,
           COUNT(*) AS bills,
           COALESCE(SUM(total), 0) AS gross,
           COALESCE(SUM(vat_amount), 0) AS vat,
           COALESCE(SUM(ctl_amount), 0) AS ctl
      FROM orders
     WHERE status = 'completed' AND created_at >= ? AND created_at <= ?
     GROUP BY hour ORDER BY hour
  `).all(from, to) as { hour: string; bills: number; gross: number; vat: number; ctl: number }[];
}

function taxRates(): { vatRate: number; ctlRate: number } {
  const db = getLocalDb();
  const cfg = db.prepare(`SELECT vat_rate, ctl_rate FROM device_config WHERE id=1`).get() as
    { vat_rate: number | null; ctl_rate: number | null } | undefined;
  return { vatRate: Number(cfg?.vat_rate ?? 0), ctlRate: Number(cfg?.ctl_rate ?? 0) };
}

export interface DailyReportRequest {
  preset?: RangePreset;
  from?: string;
  to?: string;
}

export async function exportDailySalesReport(
  req: DailyReportRequest,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const range = resolveRange(req.preset ?? 'today', req.from, req.to);
    const scope = getReportScope();
    const db = getLocalDb();
    const session = db.prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as
      { business_name: string; currency: string } | undefined;
    const cfg = getDeviceConfig();

    const t = readTotals(range.from, range.to);
    const byMode = readByMode(range.from, range.to);
    const hourly = readHourly(range.from, range.to);
    const { vatRate, ctlRate } = taxRates();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SwiftPOS';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sheet1');
    ws.columns = [
      { width: 34 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 16 },
    ];

    let row = 1;
    const put = (values: unknown[], opts: { bold?: boolean; fmt?: string } = {}) => {
      const r = ws.getRow(row++);
      values.forEach((v, i) => {
        const c = r.getCell(i + 1);
        c.value = v as never;
        c.font = { name: FONT, size: 10, bold: !!opts.bold };
        if (typeof v === 'number' && opts.fmt) c.numFmt = opts.fmt;
      });
      return r;
    };
    const blank = () => { row++; };
    const section = (title: string) => {
      const r = put([title], { bold: true });
      r.getCell(1).font = { name: FONT, size: 11, bold: true };
    };

    // ── Header ───────────────────────────────────────────────────────────────
    put([session?.business_name ?? 'SwiftPOS'], { bold: true });
    put([cfg?.terminal_code ?? 'NA']);
    put([`Daily_Sales_Report_Detail(${range.label})`]);
    put([`Generated On: ${new Date().toLocaleString('en-KE')}`]);
    // Provenance, in the file. Not decoration — see the note at the top.
    put([`Covers: ${scope.scopeLabel}`]);
    blank();

    // ── Daily Sales Report ───────────────────────────────────────────────────
    section('Daily Sales Report');
    put(['Hour', 'Bills', 'Sale Type', 'Amount', 'Gross Amount'], { bold: true });
    for (const h of hourly) {
      const gross = Number(h.gross);
      put([`${h.hour}:00`, Number(h.bills), 'Sale',
           money2(gross - Number(h.vat) - Number(h.ctl)), money2(gross)], { fmt: MONEY });
    }
    // APC = net sales per DINER, not per bill. It is deliberately computed from
    // dine-in net sales only, because covers exist only there — dividing the whole
    // day's takings by dine-in heads would inflate it by every takeaway sale.
    const dineIn = dineInNet(range.from, range.to);
    const apc = t.covers && t.covers > 0 ? money2(dineIn / t.covers) : null;

    put([
      `Total Covers (${t.covers ?? 'not recorded'}) / Total Bills (${t.bills})`,
      apc === null ? 'Total APC (n/a)' : `Total APC (${apc.toFixed(2)})`,
      'Total Sales', money2(t.netSales), money2(t.grossSales),
    ], { bold: true, fmt: MONEY });
    blank();

    // ── Grand Total ──────────────────────────────────────────────────────────
    section('Grand Total');
    put(['Total Sale', money2(t.netSales)], { fmt: MONEY });
    put(['RoundOff', t.roundOff], { fmt: MONEY });
    put(['Total Gross', money2(t.grossSales)], { bold: true, fmt: MONEY });
    put(['Total Bills', t.bills], { fmt: INT });
    put(['Total Covers', t.covers ?? 'not recorded'], { fmt: INT });
    // Says WHY it is unavailable rather than printing 0.00. A zero APC reads as a
    // catastrophic trading day; "no covers recorded" reads as what it is.
    put(['Total APC', apc ?? (t.dineInBills === 0 ? 'no dine-in sales' : 'no covers recorded')],
        { fmt: MONEY });
    if (apc !== null) put(['Dine-in net (APC basis)', money2(dineIn)], { fmt: MONEY });
    blank();

    // ── Collection Breakup ───────────────────────────────────────────────────
    section('Collection Breakup');
    put(['Mode', 'Amount'], { bold: true });
    let collected = 0;
    for (const m of MODE_ROWS) {
      const amt = m.methods.reduce((s, k) => s + (byMode.get(k) ?? 0), 0);
      collected += amt;
      put([m.label, money2(amt)], { fmt: MONEY });
    }
    // Anything the till recorded under a method not in the list above. Printed
    // rather than dropped: a silently missing payment method is how a collection
    // total stops matching the gross and nobody can see why.
    const listed = new Set(MODE_ROWS.flatMap(m => m.methods));
    for (const [method, amt] of byMode) {
      if (!listed.has(method)) { collected += amt; put([method, money2(amt)], { fmt: MONEY }); }
    }
    put(['Total', money2(collected)], { bold: true, fmt: MONEY });
    // Collections are compared against the CHARGED total (gross + round-off), not
    // the exact gross.
    //
    // Customers pay whole shillings, so collections legitimately differ from the
    // exact gross by the round-off on every single report. Comparing against the
    // raw gross made this warning fire on a perfectly balanced day — verified
    // against the reference export, where collections are 30,986 and gross is
    // 30,986.09. A discrepancy warning that is always on is worse than none: it
    // trains the reader to skip the line that matters when a real hole appears.
    const charged = money2(t.grossSales + t.roundOff);
    const diff = money2(collected - charged);
    if (Math.abs(diff) >= 0.01) {
      put(['Unreconciled difference', diff], { bold: true, fmt: MONEY });
    }
    blank();

    // ── Tax Breakup ──────────────────────────────────────────────────────────
    section('Tax Breakup');
    put(['Tax Name', 'Rate', 'Amount'], { bold: true });
    if (ctlRate > 0 || t.ctl > 0) put([`CTL ${ctlRate}%`, ctlRate, money2(t.ctl)], { fmt: MONEY });
    if (vatRate > 0 || t.vat > 0) put([`VAT ${vatRate}%`, vatRate, money2(t.vat)], { fmt: MONEY });
    put(['Tax Total', '', money2(t.ctl + t.vat)], { bold: true, fmt: MONEY });
    blank();

    // ── Charge Breakup ───────────────────────────────────────────────────────
    // SwiftPOS has no service-charge concept. Kept so the section order matches
    // the report staff already read; the source prints 0.0 here too.
    section('Charge Breakup');
    put(['Charge Name', 'Charge Rate', 'Charge Amount'], { bold: true });
    put(['Charge Total', '', 0], { bold: true, fmt: MONEY });

    const safe = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '');
    const suggested =
      `Daily_Sales_Report_${safe(session?.business_name ?? 'SwiftPOS')}_${safe(range.label)}.xlsx`;

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save Daily Sales Report',
      defaultPath: suggested,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };

    const target = res.filePath.endsWith('.xlsx') ? res.filePath : `${res.filePath}.xlsx`;
    await wb.xlsx.writeFile(target);
    return { ok: true, path: target };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not write the report' };
  }
}
