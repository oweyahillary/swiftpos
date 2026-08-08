/**
 * shiftReport.ts — the shift report / Z-report as ESC/POS.
 *
 * WHY IT MOVED HERE
 * This was the last document still printed as HTML. That path measures the page
 * by laying the markup out in an offscreen window, and the window's width was
 * never set to the paper — so the height it computed was for an 800px column
 * while the printer got a 302px one. The report ran off the end of the page and
 * stopped mid-way through, taking the whole cash reconciliation with it. The
 * half of the report anybody counting a drawer actually needs.
 *
 * Rendering it the same way as every other ticket removes that class of bug
 * entirely: columns are computed from the print head's dot count, not measured
 * from a browser guess, and the same code lays out 58mm and 80mm.
 *
 * WHAT IT DELIBERATELY KEEPS
 * The layout is a faithful port of ZReportView, because that is what the owner
 * already reads at the end of a shift and recognises at a glance. Same section
 * order, same labels, same wording. Changing it while also changing the
 * mechanism would make a mis-print impossible to attribute.
 */
import { DocBuilder, type Document } from './document';
import { columnsFor, center, rule, pair, wrap } from './layout';
import { formatCents } from './money';
import type { Cents } from './types';

export interface ShiftReportMethodLine {
  /** 'cash', 'mpesa', 'card', 'credit', 'glovo' … */
  method: string;
  orders: number;
  amount: Cents;
}

export interface ShiftReportData {
  businessName: string;
  branchName?: string;
  currencyCode: string;

  cashierName: string;
  /** Short reference the owner can quote. The full uuid is unreadable on paper. */
  shiftRef: string;
  openedAt: Date;
  closedAt?: Date | null;
  /** 'open' | 'closed' | 'closed_unreconciled' */
  status: string;

  byMethod: ShiftReportMethodLine[];
  orderCount: number;
  grossSales: Cents;
  voidCount: number;

  openingFloat: Cents;
  cashSales: Cents;
  floatIn: Cents;
  floatOut: Cents;
  expectedCash: Cents;

  /** Present once the drawer has been counted. */
  countedCash?: Cents | null;
  /** Positive = over, negative = short. */
  variance?: Cents | null;

  notes?: string | null;
  printedAt: Date;
  footerCredit?: string;
}

const METHOD_LABELS: Record<string, string> = {
  mpesa: 'M-PESA',
  glovo: 'GLOVO',
};

function stamp(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon}, ${hh}:${mm}`;
}

export function renderShiftReport(r: ShiftReportData, paperWidthMm: 58 | 80): Document {
  const cols = columnsFor(paperWidthMm);
  const d = new DocBuilder(cols);
  const money = (c: Cents | null | undefined) => `${r.currencyCode} ${formatCents(c ?? 0)}`;

  const isClosed = r.status === 'closed' || r.status === 'closed_unreconciled';

  // ── Heading ───────────────────────────────────────────────────────────────
  d.line(center(cols, r.businessName.toUpperCase()), { size: 'tall', bold: true });
  d.line(center(cols, isClosed ? 'Z-REPORT (SHIFT CLOSE)' : 'SHIFT REPORT (LIVE)'), { bold: true });
  if (r.branchName) d.line(center(cols, r.branchName));
  d.line(center(cols, `Printed ${stamp(r.printedAt)}`));
  d.line(rule(cols));

  // ── Who and when ──────────────────────────────────────────────────────────
  d.line(pair(cols, 'Cashier', r.cashierName));
  d.line(pair(cols, 'Shift', r.shiftRef));
  d.line(pair(cols, 'Opened', stamp(r.openedAt)));
  d.line(pair(cols, 'Closed', r.closedAt ? stamp(r.closedAt) : '—'));
  d.line(pair(cols, 'Status', r.status.toUpperCase()));
  d.line(rule(cols));

  // ── Sales by method ───────────────────────────────────────────────────────
  d.line('SALES BY METHOD', { bold: true });
  if (r.byMethod.length === 0) {
    d.line('No sales this shift');
  } else {
    for (const m of r.byMethod) {
      const label = METHOD_LABELS[m.method] ?? m.method.toUpperCase();
      d.line(pair(cols, `${label} (${m.orders})`, money(m.amount)));
    }
  }
  d.line(rule(cols));

  d.line(pair(cols, 'Orders', String(r.orderCount)));
  d.line(pair(cols, 'Gross sales', money(r.grossSales)));
  d.line(pair(cols, 'Voids', String(r.voidCount)));
  d.line(rule(cols));

  // ── Cash reconciliation ───────────────────────────────────────────────────
  // The reason the report exists. It is the section the old HTML path lost, so
  // it is the one worth being certain about.
  d.line('CASH RECONCILIATION', { bold: true });
  d.line(pair(cols, 'Opening float', money(r.openingFloat)));
  d.line(pair(cols, '+ Cash sales', money(r.cashSales)));
  d.line(pair(cols, '+ Float in', money(r.floatIn)));
  d.line(pair(cols, '- Float out', money(r.floatOut)));
  d.line(pair(cols, '= Expected cash', money(r.expectedCash)), { bold: true });

  if (isClosed) {
    d.line(pair(cols, 'Counted cash', money(r.countedCash)));
    if (r.variance != null) {
      // Named, not just signed. A cashier reading "-450.00" at 1am should not
      // have to work out which direction the drawer is wrong in.
      const label = r.variance === 0 ? 'Variance'
        : r.variance > 0 ? 'Variance (over)'
        : 'Variance (short)';
      d.line(pair(cols, label, money(r.variance)), { size: 'tall', bold: true });
    }
  }

  if (isClosed && r.notes && r.notes.trim()) {
    d.line(rule(cols));
    d.line('NOTES', { bold: true });
    // Authored text: the line breaks the cashier typed are meaning, not
    // whitespace. Same reasoning as the receipt footer.
    for (const line of r.notes.split(/\r?\n/)) {
      if (!line.trim()) { d.blank(); continue; }
      d.lines(wrap(line.trim(), cols));
    }
  }

  d.line(rule(cols));
  d.line(center(cols, r.footerCredit ?? 'Powered by SwiftPOS'));

  return d.build();
}
