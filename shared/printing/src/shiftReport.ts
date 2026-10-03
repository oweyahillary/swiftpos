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
import type { MonoRaster } from './raster';
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
  /** 0.6.25 (owner: "add the logo in all documents"): the client's receipt logo, printed centred above the name — the same
   *  raster and the same switch as the receipt's. Absent = no logo, the report byte-identical to before. */
  logoRaster?: MonoRaster;
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
  /** A349: refunds on the shift's orders, sales kept, the taxes in them (refund-reduced), and tips. null/absent =
   *  not reported (an older caller) → no line. `ctl` is printed only when given (the business levies it). */
  refunds?: Cents | null;
  netSales?: Cents | null;
  vat?: Cents | null;
  ctl?: Cents | null;
  tips?: Cents | null;
  /** 0.6.27: delivery fees the customers paid on top of their bills (pass-through, in the payments, not sales). */
  deliveryFees?: Cents | null;
  /** 0.6.33: the riders' fees on FREE deliveries — the shop paid them (in "Paid to riders"), the customers did not. */
  freeDeliveries?: Cents | null;
  /** 0.6.33: one line per rider this shift — deliveries, the fees customers paid, and the free ones the shop paid. */
  riders?: { rider: string; deliveries: number; feesPaid: Cents; freeCount: number; freeFees: Cents }[] | null;
  voidCount: number;

  openingFloat: Cents;
  cashSales: Cents;
  floatIn: Cents;
  floatOut: Cents;
  /** 0.6.11: cash paid out as expenses, already taken off expectedCash. null/absent = not reported (older caller). */
  expenses?: Cents | null;
  /** 0.6.27: the delivery fees paid to riders in cash from the drawer (a part of the pay-outs, shown on its own line;
   *  `floatOut` is then the other pay-outs). null/absent = none. */
  riderPayouts?: Cents | null;
  /** 0.6.27: expenses paid by another method (M-Pesa…), NOT from the drawer — off that method's total. */
  otherExpenses?: { method: string; amount: Cents }[] | null;
  /** A342: the web POS's own shift on this till, counted in this drawer and closed with it. null/absent = none. */
  siblingCash?: Cents | null;
  /** 0.6.11: the expense lines behind it. */
  expenseLines?: { description: string; amount: Cents }[];
  /** 0.6.28: items taken back after they were sent to the kitchen — one line each ("2x Chicken — Wrong item · made ·
   *  approved Jane"), the total and the part already made (wasted). null/absent = none. */
  kitchenVoids?: { lines: { description: string; amount: Cents }[]; total: Cents; madeTotal: Cents } | null;
  /** A363: what of the shift is not on the cloud yet, in words (desktop lib/syncNotice zBackupNote). null/absent = all on it. */
  backupNote?: string | null;
  /** A365: the manager's confirmation, in lines ("CONFIRMED BY …", one per method; desktop lib/shiftConfirm). */
  confirmLines?: string[] | null;
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
  if (r.logoRaster) d.image(r.logoRaster, 'center');   // 0.6.25
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
      const label = METHOD_LABELS[m.method] ?? m.method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      d.line(pair(cols, `${label} (${m.orders})`, money(m.amount)));
    }
  }
  d.line(rule(cols));

  d.line(pair(cols, 'Orders', String(r.orderCount)));
  d.line(pair(cols, 'Gross sales', money(r.grossSales)));
  // A349: the shift's money in full — refunds, what was kept, the taxes in it (CTL where levied), tips.
  if (r.refunds != null && r.refunds > 0) {
    d.line(pair(cols, '- Refunds', money(r.refunds)));
    d.line(pair(cols, '= Net sales', money(r.netSales ?? r.grossSales - r.refunds)));
  }
  if (r.vat != null) d.line(pair(cols, 'incl. VAT', money(r.vat)));
  if (r.ctl != null) d.line(pair(cols, 'incl. CTL', money(r.ctl)));
  if (r.tips != null && r.tips > 0) d.line(pair(cols, 'Tips (in payments)', money(r.tips)));
  if (r.deliveryFees != null && r.deliveryFees > 0) d.line(pair(cols, 'Delivery fees (in payments)', money(r.deliveryFees)));
  if (r.freeDeliveries != null && r.freeDeliveries > 0) d.line(pair(cols, 'Free deliveries (shop paid)', money(r.freeDeliveries)));
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
  // 0.6.27: the riders' delivery fees, paid in cash from this drawer — why cash is lower and M-Pesa higher.
  if (r.riderPayouts != null && r.riderPayouts > 0) d.line(pair(cols, '- Paid to riders', money(r.riderPayouts)));
  // 0.6.11: expenses were always deducted from expected cash but never printed, so the column did not add up.
  if (r.expenses != null) d.line(pair(cols, '- Expenses', money(r.expenses)));
  if (r.siblingCash != null) d.line(pair(cols, '+ Web shift, this till', money(r.siblingCash)));
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

  // 0.6.33: the riders — who delivered how many, what the customers paid them in fees, what the shop paid (free ones).
  if (r.riders && r.riders.length) {
    d.line(rule(cols));
    d.line('RIDERS', { bold: true });
    for (const x of r.riders) {
      d.line(pair(cols, `${x.rider} (${x.deliveries})`, money(x.feesPaid + x.freeFees)));
      if (x.freeCount > 0) d.line(pair(cols, `  incl. ${x.freeCount} free (shop paid)`, money(x.freeFees)));
    }
  }

  // 0.6.27: expenses paid by M-Pesa etc. — not from the drawer; they come off that method's expected total.
  if (r.otherExpenses && r.otherExpenses.length) {
    d.line(rule(cols));
    d.line('EXPENSES NOT FROM THE DRAWER', { bold: true });
    for (const e of r.otherExpenses) {
      const label = METHOD_LABELS[e.method] ?? e.method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      d.line(pair(cols, `- ${label}`, money(e.amount)));
    }
  }

  if (r.expenseLines && r.expenseLines.length) {
    d.line(rule(cols));
    d.line(`EXPENSES (${r.expenseLines.length})`, { bold: true });
    for (const e of r.expenseLines) {
      const amt = money(e.amount);
      // Fits → one line. Otherwise the description wraps WHOLE (it is what the owner reads to know what the cash
      // was for) and the amount sits right-aligned beneath it.
      if (e.description.length + amt.length + 1 <= cols) d.line(pair(cols, e.description, amt));
      else { d.lines(wrap(e.description, cols)); d.line(' '.repeat(Math.max(0, cols - amt.length)) + amt); }
    }
  }

  // 0.6.28: what was sent to the kitchen and taken back — the owner reads these to see who cancels cooked food.
  if (r.kitchenVoids && r.kitchenVoids.lines.length) {
    d.line(rule(cols));
    d.line(`KITCHEN VOIDS (${r.kitchenVoids.lines.length})`, { bold: true });
    for (const e of r.kitchenVoids.lines) {
      const amt = money(e.amount);
      if (e.description.length + amt.length + 1 <= cols) d.line(pair(cols, e.description, amt));
      else { d.lines(wrap(e.description, cols)); d.line(' '.repeat(Math.max(0, cols - amt.length)) + amt); }
    }
    d.line(pair(cols, 'Total voided', money(r.kitchenVoids.total)), { bold: true });
    if (r.kitchenVoids.madeTotal > 0) d.line(pair(cols, 'Of which already made', money(r.kitchenVoids.madeTotal)));
  }

  // A363 (owner: "add the note on the zreport"): never close a day without seeing what is still only on this till.
  if (r.backupNote && r.backupNote.trim()) {
    d.line(rule(cols));
    d.lines(wrap(r.backupNote.trim(), cols), { bold: true });
  }

  // A365: who confirmed the shift and each method's recount — or that it still awaits a manager.
  if (r.confirmLines && r.confirmLines.length) {
    d.line(rule(cols));
    const [head, ...rest] = r.confirmLines;
    d.lines(wrap(head, cols), { bold: true });
    for (const l of rest) d.lines(wrap(l, cols));
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
