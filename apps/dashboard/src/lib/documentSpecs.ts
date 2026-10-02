/**
 * documentSpecs — the single home for the PO / GRN / stock-transfer document specs.
 *
 * These specs were duplicated across PurchaseOrdersPage, StockTransfersPage,
 * ManagerReceivingTab and ManagerHistoryTab (A225–A231). Each caller still owns
 * the record→input mapping (their records differ), but the spec shape — columns,
 * totals, accent, signatures, money formatting — lives here once so it can't drift.
 * Behaviour is intentionally identical to the previous inline builders.
 */
import type { PrintDocSpec } from './printDocument';
import { DOC_ACCENT } from './printDocument';

type Biz = { name: string; address?: string | null; phone?: string | null; tax_pin?: string | null; logo_url?: string | null };
type Meta = { label: string; value: string };

export const docMoney = (currency: string, n: number): string =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

// ── Purchase order ────────────────────────────────────────────────────────────
export interface PoDocInput {
  poNumber: string; orderDate?: string; expectedDate?: string | null; status: string;
  supplier?: string | null; business: Biz; currency: string;
  lines: { name: string; unit?: string | null; ordered: number; unitCost: number }[];
  note?: string | null;
}
export function purchaseOrderDocSpec(i: PoDocInput): PrintDocSpec {
  let total = 0;
  const rows = i.lines.map(l => {
    const line = l.ordered * l.unitCost; total += line;
    return [`${l.name}${l.unit ? ` (${l.unit})` : ''}`, String(l.ordered), docMoney(i.currency, l.unitCost), docMoney(i.currency, line)];
  });
  return {
    docType: 'PURCHASE ORDER', number: i.poNumber, dateLabel: i.orderDate,
    accent: i.status === 'cancelled' ? DOC_ACCENT.cancelled : DOC_ACCENT.po, statusLabel: i.status,
    business: i.business,
    meta: [{ label: 'Supplier', value: i.supplier ?? '—' }, ...(i.expectedDate ? [{ label: 'Expected', value: i.expectedDate }] : [])],
    columns: [{ label: 'Ingredient' }, { label: 'Ordered', align: 'right' }, { label: 'Unit Cost', align: 'right' }, { label: 'Line Total', align: 'right' }],
    rows, totals: [{ label: 'Total', value: docMoney(i.currency, total) }],
    note: i.note ?? undefined, signatures: ['Prepared by', 'Approved by'],
  };
}

// ── Goods received note ─────────────────────────────────────────────────────
export interface GrnDocInput {
  grnNumber: string; date?: string; poNumber?: string | null; supplier?: string | null;
  business: Biz; currency: string;
  lines: { name: string; unit?: string | null; received: number; unitCost: number }[];
  note?: string | null;
  // Some callers show a different 2nd meta (e.g. History has the branch, not supplier).
  secondMeta?: Meta;
}
export function grnDocSpec(i: GrnDocInput): PrintDocSpec {
  let total = 0;
  const rows = i.lines.map(l => {
    const line = l.received * l.unitCost; total += line;
    return [`${l.name}${l.unit ? ` (${l.unit})` : ''}`, String(l.received), docMoney(i.currency, l.unitCost), docMoney(i.currency, line)];
  });
  return {
    docType: 'GOODS RECEIVED NOTE', number: i.grnNumber, dateLabel: i.date,
    accent: DOC_ACCENT.grn, statusLabel: 'Received', business: i.business,
    meta: [{ label: 'Against PO', value: i.poNumber ?? '—' }, i.secondMeta ?? { label: 'Supplier', value: i.supplier ?? '—' }],
    columns: [{ label: 'Ingredient' }, { label: 'Received', align: 'right' }, { label: 'Unit Cost', align: 'right' }, { label: 'Line Total', align: 'right' }],
    rows, totals: [{ label: 'Total received value', value: docMoney(i.currency, total) }],
    note: i.note ?? undefined, signatures: ['Received by', 'Checked by'],
  };
}

// ── Stock transfer (despatch note / received note) ───────────────────────────
export interface TransferDocInput {
  number: string; date?: string; from: string; to: string; status: string; received: boolean;
  business: Biz;
  lines: { name: string; sent: number; received?: number | null }[];
  note?: string | null;
}
export function transferDocSpec(i: TransferDocInput): PrintDocSpec {
  return {
    docType: i.received ? 'TRANSFER RECEIVED NOTE' : 'STOCK TRANSFER NOTE',
    number: i.number, dateLabel: i.date,
    accent: i.received ? DOC_ACCENT.received : (i.status === 'cancelled' ? DOC_ACCENT.cancelled : DOC_ACCENT.despatch),
    statusLabel: i.status, business: i.business,
    meta: [{ label: 'From', value: i.from }, { label: 'To', value: i.to }],
    columns: i.received
      ? [{ label: 'Product' }, { label: 'Sent', align: 'right' }, { label: 'Received', align: 'right' }, { label: 'Variance', align: 'right' }]
      : [{ label: 'Product' }, { label: 'Quantity sent', align: 'right' }],
    rows: i.lines.map(l => {
      const sent = Number(l.sent) || 0;
      if (!i.received) return [l.name, String(sent)];
      const rec = l.received == null ? sent : Number(l.received);
      const v = rec - sent;
      return [l.name, String(sent), String(rec), v === 0 ? '—' : String(v)];
    }),
    note: i.note ?? undefined, signatures: i.received ? ['Received by', 'Checked by'] : ['Despatched by', 'Received by'],
  };
}

// ── Shift report (A365, 0.6.23) ───────────────────────────────────────────────
// Owner: the printed shift report "should not be the page screenshot but a report". One A4 document per shift — the
// business header, the shift's facts, the per-method table, totals, the notes, and Cashier / Manager signatures — and
// one for the list. The figures come from shared/shiftConfirm.ts (shiftReportLines), the same rules as the screen.
export interface ShiftDocLine {
  method: string; cashier: number | null; manager: number | null; recorded: number | null; variance: number | null; mismatch: boolean;
}
export interface ShiftDocInput {
  business: Biz; currency: string;
  cashier: string; till: string; opened: string; closed: string; openingFloat: number;
  status: string;            // "Confirmed by Mary" …
  confirmedAt?: string | null; self?: boolean; confirmed: boolean; running: boolean;
  lines: ShiftDocLine[]; methodName: (m: string) => string;
  notes?: string | null; printedAt?: string;
}
export function shiftDocSpec(i: ShiftDocInput): PrintDocSpec {
  const m = (n: number | null) => (n === null ? '—' : docMoney(i.currency, n));
  const signed = (n: number | null) => (n === null ? '—' : Math.round(n * 100) === 0 ? '0.00' : `${n > 0 ? '+' : '−'}${docMoney(i.currency, Math.abs(n))}`);
  const sum = (k: 'cashier' | 'manager' | 'recorded' | 'variance') =>
    i.lines.every((l) => l[k] === null) ? null : i.lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  const totalVar = sum('variance');
  const short = totalVar !== null && Math.round(totalVar * 100) < 0;
  const noteParts = [
    i.running ? 'This shift is still running — the table shows only what has been recorded so far.' : null,
    !i.running ? `Variance = ${i.confirmed ? "the manager's count" : "the cashier's figure (not yet confirmed by a manager)"} − what the till recorded. Cash "till recorded" is the expected cash in the drawer (opening float + cash sales + pay-ins − pay-outs − expenses).` : null,
    i.lines.some((l) => l.mismatch) ? `Where marked *, the manager's count differs from what the cashier said.` : null,
    i.self ? 'Self-confirmed: the manager who confirmed this shift also worked it.' : null,
    i.notes ? `Shift notes: ${i.notes}` : null,
  ].filter(Boolean);
  return {
    docType: 'SHIFT REPORT',
    number: `${i.cashier} · ${i.till}`,
    dateLabel: i.opened,
    business: i.business,
    statusLabel: i.status,
    accent: short ? DOC_ACCENT.cancelled : i.confirmed ? DOC_ACCENT.received : DOC_ACCENT.despatch,
    meta: [
      { label: 'Cashier', value: i.cashier },
      { label: 'Till', value: i.till },
      { label: 'Opened', value: i.opened },
      { label: 'Closed', value: i.closed },
      { label: 'Opening float', value: docMoney(i.currency, i.openingFloat) },
      { label: 'Status', value: i.status + (i.confirmedAt ? ` · ${i.confirmedAt}` : '') },
    ],
    columns: [
      { label: 'Method' }, { label: 'Cashier said', align: 'right' }, { label: 'Manager counted', align: 'right' },
      { label: 'Till recorded', align: 'right' }, { label: 'Variance', align: 'right' },
    ],
    rows: i.lines.map((l) => [
      `${i.methodName(l.method)}${l.mismatch ? ' *' : ''}`, m(l.cashier), i.confirmed ? m(l.manager) : '—', m(l.recorded), signed(l.variance),
    ]),
    totals: i.running ? [] : [
      { label: i.confirmed ? 'Total counted (manager)' : 'Total declared (cashier)', value: m(i.confirmed ? sum('manager') : sum('cashier')) },
      { label: 'Total recorded', value: m(sum('recorded')) },
      { label: short ? 'Total SHORT' : 'Total variance', value: signed(totalVar) },
    ],
    note: noteParts.join('\n'),
    signatures: ['Cashier', 'Manager'],
  };
}

export interface ShiftListDocInput {
  business: Biz; from: string; to: string; filterLabel: string;
  rows: { cashier: string; till: string; opened: string; closed: string; status: string; difference: string }[];
  awaiting: number; problems: number;
}
export function shiftListDocSpec(i: ShiftListDocInput): PrintDocSpec {
  return {
    docType: 'SHIFT REPORTS',
    number: `${i.from} – ${i.to}`,
    business: i.business,
    statusLabel: i.filterLabel,
    accent: i.problems > 0 ? DOC_ACCENT.despatch : DOC_ACCENT.received,
    meta: [{ label: 'Period', value: `${i.from} – ${i.to}` }, { label: 'Showing', value: i.filterLabel }],
    columns: [{ label: 'Cashier' }, { label: 'Till' }, { label: 'Opened' }, { label: 'Closed' }, { label: 'Status' }, { label: 'Difference', align: 'right' }],
    rows: i.rows.map((r) => [r.cashier, r.till, r.opened, r.closed, r.status, r.difference || '—']),
    totals: [
      { label: 'Shifts', value: String(i.rows.length) },
      { label: 'Awaiting a manager', value: String(i.awaiting) },
      { label: 'Need a look', value: String(i.problems) },
    ],
    signatures: ['Prepared by', 'Reviewed by'],
  };
}
