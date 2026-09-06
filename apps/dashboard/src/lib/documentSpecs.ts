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
