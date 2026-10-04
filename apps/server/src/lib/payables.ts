/**
 * payables.ts — A395: what the business owes its suppliers (pure; routes/payables.ts does the database work).
 *
 * Owner, 2026-10-04: supplier bills and payables, with returns to supplier ("Yes proceed").
 *
 *   A bill        — the supplier's invoice (open, or void). Paid = the payments made against it.
 *   A payment     — against one bill, or "on account" (no bill). Never more than the bill still owes.
 *   A return      — goods sent back; its credit lowers what is owed.
 *   Balance       = open bills − payments − return credits. Above 0: the business owes the supplier; below 0: the
 *                   supplier owes the business (paid ahead, or returns not yet set off).
 *   Ageing        — what each open bill still owes, by days past its due date (a bill with no due date is due on its
 *                   bill date).
 */

export const PAYMENT_METHODS = ['cash', 'mpesa', 'bank', 'cheque', 'other'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** A money amount typed by a person: > 0, at most 2 decimals' worth (rounded), commas allowed. null = not an amount. */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = round2(Number(s));
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return null;
  return n;
}

export function cleanMethod(value: unknown): PaymentMethod | null {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s-]/g, '');
  const m = s === 'm-pesa' || s === 'mpesa' ? 'mpesa' : s;
  return (PAYMENT_METHODS as readonly string[]).includes(m) ? (m as PaymentMethod) : null;
}

/** "YYYY-MM-DD" or null. */
export function cleanDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface BillLike { id: string; amount: number | string; status: string; bill_date: string; due_date: string | null }
export interface PaymentLike { bill_id: string | null; amount: number | string; voided_at?: string | null }
export interface ReturnLike { credit_amount: number | string }

export type BillState = 'void' | 'paid' | 'part_paid' | 'overdue' | 'open';

export interface BillView { paid: number; due: number; state: BillState; daysOverdue: number }

/** What a bill has had paid against it, what it still owes, and where it stands today. */
export function billView(bill: BillLike, payments: PaymentLike[], today: string): BillView {
  const paid = round2(payments.filter((p) => p.bill_id === bill.id && !p.voided_at).reduce((s, p) => s + Number(p.amount), 0));
  if (bill.status === 'void') return { paid, due: 0, state: 'void', daysOverdue: 0 };
  const due = round2(Math.max(0, Number(bill.amount) - paid));
  const dueOn = bill.due_date || bill.bill_date;
  const late = Math.max(0, daysBetween(dueOn, today));
  if (due === 0) return { paid, due, state: 'paid', daysOverdue: 0 };
  if (late > 0) return { paid, due, state: 'overdue', daysOverdue: late };
  return { paid, due, state: paid > 0 ? 'part_paid' : 'open', daysOverdue: 0 };
}

/** May this payment be recorded against this bill? It may not be more than the bill still owes, nor against a void bill. */
export function paymentProblem(bill: BillLike | null, payments: PaymentLike[], amount: number, today: string): string | null {
  if (!bill) return null;                                          // on account — any amount
  if (bill.status === 'void') return 'That bill was voided.';
  const v = billView(bill, payments, today);
  if (v.due <= 0) return 'That bill is already paid.';
  if (amount > v.due + 0.004) return `That is more than the bill still owes (${v.due.toFixed(2)}). Pay the rest on account.`;
  return null;
}

export interface Ageing { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number }

export interface SupplierPosition {
  billed: number;           // open bills
  paid: number;             // payments not voided (against bills and on account)
  credits: number;          // returns
  balance: number;          // billed − paid − credits
  overdue: number;          // owed on bills past their due date
  dueSoon: number;          // owed on bills due within the next 7 days (not yet overdue)
  ageing: Ageing;
  openBills: number;
}

export function supplierPosition(bills: BillLike[], payments: PaymentLike[], returns: ReturnLike[], today: string): SupplierPosition {
  const live = payments.filter((p) => !p.voided_at);
  const open = bills.filter((b) => b.status !== 'void');
  const billed = round2(open.reduce((s, b) => s + Number(b.amount), 0));
  const paid = round2(live.reduce((s, p) => s + Number(p.amount), 0));
  const credits = round2(returns.reduce((s, r) => s + Number(r.credit_amount), 0));
  const ageing: Ageing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  let overdue = 0, dueSoon = 0, openBills = 0;
  for (const b of open) {
    const v = billView(b, live, today);
    if (v.due <= 0) continue;
    openBills++;
    const d = v.daysOverdue;
    if (d === 0) ageing.current += v.due; else if (d <= 30) ageing.d1_30 += v.due; else if (d <= 60) ageing.d31_60 += v.due;
    else if (d <= 90) ageing.d61_90 += v.due; else ageing.d90plus += v.due;
    if (d > 0) overdue += v.due;
    else if (daysBetween(today, b.due_date || b.bill_date) <= 7) dueSoon += v.due;
  }
  for (const k of Object.keys(ageing) as Array<keyof Ageing>) ageing[k] = round2(ageing[k]);
  return { billed, paid, credits, balance: round2(billed - paid - credits), overdue: round2(overdue), dueSoon: round2(dueSoon), ageing, openBills };
}

export interface StatementEntry {
  date: string; kind: 'bill' | 'payment' | 'return'; ref: string; detail: string;
  debit: number;            // adds to what is owed (a bill)
  credit: number;           // takes off (a payment, a return)
  balance: number;          // running
  id: string;
}

/** The supplier statement: every bill, payment and return in date order with a running balance. Void lines left out. */
export function statement(
  bills: Array<BillLike & { ref: string; invoice_number?: string | null; created_at?: string }>,
  payments: Array<PaymentLike & { id: string; paid_on: string; method: string; reference?: string | null; created_at?: string }>,
  returns: Array<ReturnLike & { id: string; ref: string; return_date: string; created_at?: string }>,
): StatementEntry[] {
  type Row = Omit<StatementEntry, 'balance'> & { at: string };
  const rows: Row[] = [];
  const billRef = new Map(bills.map((b) => [b.id, b.ref]));
  for (const b of bills) {
    if (b.status === 'void') continue;
    rows.push({ id: b.id, date: b.bill_date, at: b.created_at ?? '', kind: 'bill', ref: b.ref,
      detail: b.invoice_number ? `Invoice ${b.invoice_number}` : 'Bill', debit: round2(Number(b.amount)), credit: 0 });
  }
  for (const p of payments) {
    if (p.voided_at) continue;
    rows.push({ id: p.id, date: p.paid_on, at: p.created_at ?? '', kind: 'payment',
      ref: p.reference || p.method.toUpperCase(),
      detail: `Payment — ${p.method}${p.bill_id ? ` for ${billRef.get(p.bill_id) ?? 'a bill'}` : ' (on account)'}`,
      debit: 0, credit: round2(Number(p.amount)) });
  }
  for (const r of returns) {
    rows.push({ id: r.id, date: r.return_date, at: r.created_at ?? '', kind: 'return', ref: r.ref, detail: 'Goods returned',
      debit: 0, credit: round2(Number(r.credit_amount)) });
  }
  const order = { bill: 0, return: 1, payment: 2 } as const;
  rows.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.at.localeCompare(b.at));
  let bal = 0;
  return rows.map(({ at: _at, ...r }) => { bal = round2(bal + r.debit - r.credit); return { ...r, balance: bal }; });
}

/** A delivery's value: what was received × its unit cost (a line with no cost counts 0). */
export function grnValue(items: Array<{ quantity_received: number | string; unit_cost: number | string | null }>): number {
  return round2(items.reduce((s, i) => s + Number(i.quantity_received || 0) * Number(i.unit_cost ?? 0), 0));
}

/** BILL-0001, RTN-0001 … per business. */
export function payablesRef(prefix: 'BILL' | 'RTN', previousCount: number): string {
  return `${prefix}-${String(Math.max(0, Math.floor(previousCount)) + 1).padStart(4, '0')}`;
}
