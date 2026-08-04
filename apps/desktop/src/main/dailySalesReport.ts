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

import { isNodeRole } from './deviceConfig';
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
  // Aggregator. Listed explicitly so it appears in its own right rather than
  // falling into the unlisted catch-all below — a Glovo day showing up under a
  // generic heading is how aggregator income stops being reconciled against what
  // Glovo actually settles.
  { label: 'Glovo', methods: ['glovo'] },
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


// ── Report scope ─────────────────────────────────────────────────────────────
// One report, two scopes, ONE query path. Two separate report functions is where
// this goes wrong: somebody prints the branch view on Monday and a till view on
// Tuesday, the numbers do not tie, and nobody can say whether that is a bug or a
// scoping difference. The same reasoning as taxSplit() in the parking design —
// two implementations of one figure drift, and the drift is silent.
//
// deviceId === null  → every terminal at this branch (only meaningful on a node,
//                      which is the only machine holding peers' rows)
// deviceId === '<id>' → that terminal alone
//
// COALESCE on both sides because rows written before device_id existed carry
// NULL, and on a till that has never been assigned one both sides are ''.
// dayService.getOpenDay() already uses exactly this shape.
function scopeClause(deviceId: string | null, col = 'device_id'): string {
  return deviceId === null ? '' : ` AND COALESCE(${col},'') = COALESCE(?,'')`;
}
function scopeArgs(deviceId: string | null): string[] {
  return deviceId === null ? [] : [deviceId];
}
function readTotals(from: string, to: string, deviceId: string | null): Totals {
  const db = getLocalDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS bills,
           COALESCE(SUM(total), 0)        AS gross,
           COALESCE(SUM(vat_amount), 0)   AS vat,
           COALESCE(SUM(ctl_amount), 0)   AS ctl
      FROM orders
     WHERE status = 'completed' AND created_at >= ? AND created_at <= ?
           ${scopeClause(deviceId)}
  `).get(from, to, ...scopeArgs(deviceId)) as { bills: number; gross: number; vat: number; ctl: number };

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
           ${scopeClause(deviceId)}
  `).get(from, to, ...scopeArgs(deviceId)) as { covers: number; bills: number };

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
function dineInNet(from: string, to: string, deviceId: string | null): number {
  const db = getLocalDb();
  const r = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS gross,
           COALESCE(SUM(vat_amount), 0) AS vat,
           COALESCE(SUM(ctl_amount), 0) AS ctl
      FROM orders
     WHERE status = 'completed' AND order_type = 'dine_in'
       AND created_at >= ? AND created_at <= ?
           ${scopeClause(deviceId)}
  `).get(from, to, ...scopeArgs(deviceId)) as { gross: number; vat: number; ctl: number };
  return Number(r.gross) - Number(r.vat) - Number(r.ctl);
}

function readByMode(from: string, to: string, deviceId: string | null): Map<string, number> {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT p.method AS method, COALESCE(SUM(p.amount), 0) AS amt
      FROM payments p
      JOIN orders o ON o.id = p.order_id
     WHERE o.status = 'completed' AND o.created_at >= ? AND o.created_at <= ?
           ${scopeClause(deviceId, 'o.device_id')}
     GROUP BY p.method
  `).all(from, to, ...scopeArgs(deviceId)) as { method: string; amt: number }[];
  return new Map(rows.map(r => [String(r.method), Number(r.amt)]));
}

function readHourly(from: string, to: string, deviceId: string | null) {
  const db = getLocalDb();
  return db.prepare(`
    SELECT strftime('%H', created_at, 'localtime') AS hour,
           COUNT(*) AS bills,
           COALESCE(SUM(total), 0) AS gross,
           COALESCE(SUM(vat_amount), 0) AS vat,
           COALESCE(SUM(ctl_amount), 0) AS ctl
      FROM orders
     WHERE status = 'completed' AND created_at >= ? AND created_at <= ?
           ${scopeClause(deviceId)}
     GROUP BY hour ORDER BY hour
  `).all(from, to, ...scopeArgs(deviceId)) as { hour: string; bills: number; gross: number; vat: number; ctl: number }[];
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
  /**
   * Which terminals the report covers.
   *
   *   'own'    — this terminal only. All a plain till can produce, because it
   *              holds nobody else's rows.
   *   'branch' — every terminal, with a per-till breakdown. Only meaningful on a
   *              node, which is the only machine that has ingested peers' rows.
   *
   * Defaults to 'branch' on a node and 'own' elsewhere. Not offered as a user
   * toggle on a plain till: it genuinely cannot produce a branch figure, and a
   * greyed-out option teaches people the feature is broken.
   */
  scope?: 'own' | 'branch';
}

/** A terminal's contribution to the branch total. */
export interface TerminalLine {
  deviceId: string | null;
  terminalCode: string | null;
  gross: number;
  bills: number;
  /** Last order seen from this terminal, so staleness can be stated. */
  lastSeen: string | null;
}

/**
 * Terminals that have reported, with their totals.
 *
 * A branch report is only as complete as the peers that have reached this node,
 * and a stale one looks exactly like a correct one. So the breakdown carries
 * `lastSeen` per terminal and the report states it, rather than printing a
 * confident branch total that silently omits a till nobody has heard from since
 * lunchtime.
 */
function readByTerminal(from: string, to: string): TerminalLine[] {
  const db = getLocalDb();
  // branch-wide: this IS the per-terminal breakdown — grouping by device is the
  // entire purpose, so scoping it to one device would return one row.
  const rows = db.prepare(`
    SELECT device_id                      AS deviceId,
           COALESCE(SUM(total), 0)        AS gross,
           COUNT(*)                       AS bills,
           MAX(created_at)                AS lastSeen
      -- branch-wide: grouping BY device is the entire purpose of this query;
      -- scoping it to one terminal would return a single row.
      FROM orders
     WHERE status = 'completed' AND created_at >= ? AND created_at <= ?
     GROUP BY device_id
     ORDER BY device_id
  `).all(from, to) as any[];

  return rows.map(r => ({
    deviceId:     r.deviceId ?? null,
    terminalCode: null,          // filled by the caller, which holds device_config
    gross:        Number(r.gross),
    bills:        Number(r.bills),
    lastSeen:     r.lastSeen ?? null,
  }));
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

    // A plain till has only its own rows, so 'branch' would be a lie there.
    const isNode = isNodeRole(cfg?.device_role);
    const wantBranch = (req.scope ?? (isNode ? 'branch' : 'own')) === 'branch';
    const deviceId: string | null = wantBranch ? null : (cfg?.device_id ?? null);

    const t = readTotals(range.from, range.to, deviceId);
    const byMode = readByMode(range.from, range.to, deviceId);
    const hourly = readHourly(range.from, range.to, deviceId);
    const byTerminal = wantBranch ? readByTerminal(range.from, range.to) : [];

    // The per-till figures must sum to the branch total. If they do not, say so
    // on the report rather than printing a total that does not foot — a report
    // that silently fails to add up is worse than one that admits it cannot.
    const terminalSum = byTerminal.reduce((a, x) => a + x.gross, 0);
    const footsOk = !wantBranch || Math.abs(terminalSum - t.grossSales) < 0.01;

    // Every report states its scope. 'Daily Sales Report' with no scope line, at
    // a branch where one till aggregates, is how somebody reconciles the wrong
    // figure and does not find out for a month.
    const terminalScope = wantBranch
      ? `All terminals${byTerminal.length ? ` — ${byTerminal.length} reporting` : ''}`
      : `Terminal ${cfg?.terminal_code ?? 'unknown'}`;
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
    // WHICH TERMINALS. Distinct from scope.scopeLabel below, which describes
    // where the DATA came from (this till / synced from the cloud). Both matter
    // and neither substitutes for the other: a report can be branch-wide and
    // stale, or single-till and current.
    put([`Terminals: ${terminalScope}`], { bold: true });
    put([`Daily_Sales_Report_Detail(${range.label})`]);
    put([`Generated On: ${new Date().toLocaleString('en-KE')}`]);
    // Provenance, in the file. Not decoration — see the note at the top.
    put([`Covers: ${scope.scopeLabel}`]);
    blank();

    // ── Per-terminal breakdown ───────────────────────────────────────────────
    // Branch total first, tills beneath it as evidence. One document, not two:
    // separate branch and till reports are how somebody ends up with numbers
    // that do not tie and no way to tell whether that is a bug or a scope
    // difference.
    if (wantBranch && byTerminal.length) {
      section('By Terminal');
      put(['Terminal', 'Bills', 'Gross', 'Last order'], { bold: true });
      for (const line of byTerminal) {
        put([
          line.terminalCode ?? line.deviceId ?? 'Unattributed',
          line.bills,
          line.gross,
          line.lastSeen ? new Date(line.lastSeen).toLocaleString('en-KE') : '—',
        ]);
      }
      put(['TOTAL', byTerminal.reduce((a, x) => a + x.bills, 0), terminalSum, ''], { bold: true });

      if (!footsOk) {
        // Do not print a total that does not foot without saying so.
        put([`DISCREPANCY: terminal figures sum to ${terminalSum.toFixed(2)} against a branch total of ${t.grossSales.toFixed(2)}. Do not rely on this report until it is explained.`], { bold: true });
      }

      // A branch report is only as complete as the peers that have reached this
      // node. A stale one looks identical to a correct one, so name it.
      const stale = byTerminal.filter(x =>
        x.lastSeen && (Date.now() - new Date(x.lastSeen).getTime()) > 2 * 60 * 60 * 1000);
      for (const x of stale) {
        put([`${x.terminalCode ?? x.deviceId}: nothing since ${new Date(x.lastSeen!).toLocaleString('en-KE')} — figures may be incomplete.`]);
      }
      blank();
    }

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
    const dineIn = dineInNet(range.from, range.to, deviceId);
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
