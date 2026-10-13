/**
 * monthlyPack.ts — A455: a branch's month, laid out like the clients' own workbooks.
 *
 * Owner, 2026-10-12, sending two branches' own spreadsheets (a monthly daily report, the daily expense book,
 * each branch's monthly expense file): "I want to be able to generate such reports from the system"; "email
 * and downloadable"; "manager can record". Their sheets were typed by hand — amounts changed when copied between them,
 * items went missing, the "System" column was left at 0 and the M-Pesa book counted the month's total as a day. Here every
 * figure comes from what the tills and the web recorded:
 *
 *   Summary      one row per day: sales by payment method, total, what the confirmed shifts expected and what the managers
 *                counted, the variance, the cashiers, remarks (confirm reasons; shifts not confirmed yet)
 *   Expenses     the daily book (each day's items and total) and the month by expense type and by how they were paid
 *   <Method> book one per payment method with money on it ("Cash Usage", "M-Pesa Usage"): opening balance, sales in, other
 *                income, expenses, pay-outs, drawings, bank deposits, charges, running balance
 *
 * Pure: the route and the monthly email gather the rows (routes/reports-monthly.ts); this only adds up and lays out.
 */
import type ExcelJS from 'exceljs';
import { methodLabel } from './paymentCatalogue';

export type MethodMap = Record<string, number>;
export type MovementKind = 'opening' | 'other_income' | 'drawing' | 'bank_deposit' | 'charges';
export const MOVEMENT_KINDS: readonly MovementKind[] = ['opening', 'other_income', 'drawing', 'bank_deposit', 'charges'];
export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  opening: 'Opening balance', other_income: 'Other income', drawing: 'Personal (drawing)',
  bank_deposit: 'Bank deposit', charges: 'Charges',
};

export interface PackInput {
  businessName: string;
  branchName: string;
  currency: string;
  month: string;                                   // YYYY-MM
  days: string[];                                  // every business date of the month, in order
  orders: { day: string; payments: { method: string; amount: number; status: string }[] }[];   // completed orders
  shifts: {
    day: string; cashier: string; closed: boolean;
    expected: MethodMap | null; confirmed: MethodMap | null; reasons: Record<string, string> | null;
  }[];
  expenses: { day: string; type: string | null; description: string; amount: number; method: string; by: string | null }[];
  floats: { day: string; type: 'float_in' | 'float_out'; amount: number; reason: string | null }[];
  movements: { day: string; method: string; kind: MovementKind; amount: number; note: string | null; by: string | null }[];
}

export interface SummaryRow {
  day: string;
  byMethod: MethodMap;
  total: number;
  /** Over the day's CONFIRMED shifts only (null: none confirmed). */
  expected: number | null;
  counted: number | null;
  variance: number | null;
  cashiers: string[];
  remarks: string[];
}
export interface MoneyBookRow {
  day: string; sales: number; otherIn: number; expenses: number; paidOut: number;
  drawings: number; deposits: number; charges: number; balance: number;
}
export interface MoneyBook {
  method: string; label: string; opening: number; rows: MoneyBookRow[];
  totals: Omit<MoneyBookRow, 'day' | 'balance'>; closing: number;
}
export interface Pack {
  title: string;
  methods: string[];
  summary: { rows: SummaryRow[]; byMethod: MethodMap; total: number; expected: number; counted: number; variance: number };
  expenses: {
    days: { day: string; lines: PackInput['expenses']; total: number }[];
    byType: { type: string; amount: number }[];
    byMethod: { method: string; amount: number }[];
    total: number;
  };
  books: MoneyBook[];
  movements: PackInput['movements'];
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const add = (m: MethodMap, k: string, v: number) => { m[k] = r2((m[k] ?? 0) + (Number(v) || 0)); };
const sumMap = (m: MethodMap | null | undefined) => r2(Object.values(m ?? {}).reduce((a, v) => a + (Number(v) || 0), 0));

/** Cash first, then M-Pesa, then the rest by name. */
export function methodOrder(a: string, b: string): number {
  const rank = (m: string) => (m === 'cash' ? 0 : m === 'mpesa' ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Every date of a month, YYYY-MM-DD. */
export function monthDays(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return [];
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, '0')}`);
}

/** The month before a date (YYYY-MM) — what the email on the 1st sends. */
export function previousMonth(isoDate: string): string {
  const [y, mo] = isoDate.slice(0, 7).split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

export function buildPack(input: PackInput): Pack {
  const days = input.days;
  const inMonth = new Set(days);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const byDay = new Map<string, SummaryRow>(days.map((d) => [d, {
    day: d, byMethod: {}, total: 0, expected: null, counted: null, variance: null, cashiers: [], remarks: [],
  }]));
  const methodSet = new Set<string>();
  for (const o of input.orders) {
    const row = byDay.get(o.day);
    if (!row) continue;
    for (const p of o.payments) {
      // Refund rows are negative: the day keeps what came in less what went back (as the daily export).
      if (p.status !== 'completed' && p.status !== 'refunded') continue;
      add(row.byMethod, p.method, p.amount);
      methodSet.add(p.method);
    }
  }
  for (const s of input.shifts) {
    const row = byDay.get(s.day);
    if (!row) continue;
    if (s.cashier && !row.cashiers.includes(s.cashier)) row.cashiers.push(s.cashier);
    if (s.confirmed) {
      row.expected = r2((row.expected ?? 0) + sumMap(s.expected));
      row.counted = r2((row.counted ?? 0) + sumMap(s.confirmed));
      for (const [m, why] of Object.entries(s.reasons ?? {})) {
        if (why && String(why).trim()) row.remarks.push(`${s.cashier}, ${methodLabel(m)}: ${String(why).trim()}`);
      }
    }
  }
  for (const row of byDay.values()) {
    row.total = sumMap(row.byMethod);
    if (row.counted !== null) row.variance = r2(row.counted - (row.expected ?? 0));
    const open = input.shifts.filter((s) => s.day === row.day && !s.closed).length;
    const waiting = input.shifts.filter((s) => s.day === row.day && s.closed && !s.confirmed).length;
    if (open) row.remarks.unshift(`${open} shift${open === 1 ? '' : 's'} still open`);
    if (waiting) row.remarks.unshift(`${waiting} shift${waiting === 1 ? '' : 's'} not confirmed`);
  }
  const rows = days.map((d) => byDay.get(d)!);
  const totalByMethod: MethodMap = {};
  for (const r of rows) for (const [m, v] of Object.entries(r.byMethod)) add(totalByMethod, m, v);

  // ── Expenses ────────────────────────────────────────────────────────────────
  const exps = input.expenses.filter((e) => inMonth.has(e.day));
  const expDays = days.map((d) => {
    const lines = exps.filter((e) => e.day === d);
    return { day: d, lines, total: r2(lines.reduce((a, e) => a + e.amount, 0)) };
  }).filter((d) => d.lines.length > 0);
  const byType: MethodMap = {};
  const expByMethod: MethodMap = {};
  for (const e of exps) { add(byType, e.type?.trim() || 'Uncategorised', e.amount); add(expByMethod, e.method || 'cash', e.amount); }

  // ── Money books ─────────────────────────────────────────────────────────────
  const movs = input.movements.filter((m) => inMonth.has(m.day));
  for (const m of [...Object.keys(expByMethod), ...movs.map((x) => x.method)]) methodSet.add(m);
  const methods = [...methodSet].sort(methodOrder);
  const bookMethods = [...new Set(['cash', 'mpesa', ...methods])].sort(methodOrder);
  const floats = input.floats.filter((f) => inMonth.has(f.day));
  const books: MoneyBook[] = bookMethods.map((method) => {
    const opening = r2(movs.filter((m) => m.method === method && m.kind === 'opening').reduce((a, m) => a + m.amount, 0));
    let balance = opening;
    const t = { sales: 0, otherIn: 0, expenses: 0, paidOut: 0, drawings: 0, deposits: 0, charges: 0 };
    const bookRows = days.map((d) => {
      const mv = (k: MovementKind) => r2(movs.filter((m) => m.day === d && m.method === method && m.kind === k).reduce((a, m) => a + m.amount, 0));
      const isCash = method === 'cash';
      const row: MoneyBookRow = {
        day: d,
        sales: r2(byDay.get(d)!.byMethod[method] ?? 0),
        // Money into the drawer that is not a sale (a pay-in) counts for cash; other income for every method.
        otherIn: r2(mv('other_income') + (isCash ? floats.filter((f) => f.day === d && f.type === 'float_in').reduce((a, f) => a + f.amount, 0) : 0)),
        expenses: r2(exps.filter((e) => e.day === d && (e.method || 'cash') === method).reduce((a, e) => a + e.amount, 0)),
        paidOut: isCash ? r2(floats.filter((f) => f.day === d && f.type === 'float_out').reduce((a, f) => a + f.amount, 0)) : 0,
        drawings: mv('drawing'),
        deposits: mv('bank_deposit'),
        charges: mv('charges'),
        balance: 0,
      };
      balance = r2(balance + row.sales + row.otherIn - row.expenses - row.paidOut - row.drawings - row.deposits - row.charges);
      row.balance = balance;
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] = r2(t[k] + row[k]);
      return row;
    });
    return { method, label: methodLabel(method), opening, rows: bookRows, totals: t, closing: balance };
  }).filter((b) => b.method === 'cash' || b.method === 'mpesa' || b.opening !== 0
    || Object.values(b.totals).some((v) => v !== 0));

  const total = sumMap(totalByMethod);
  const expected = r2(rows.reduce((a, r) => a + (r.expected ?? 0), 0));
  const counted = r2(rows.reduce((a, r) => a + (r.counted ?? 0), 0));
  return {
    title: `${input.businessName} — ${input.branchName} — ${input.month}`,
    methods,
    summary: { rows, byMethod: totalByMethod, total, expected, counted, variance: r2(counted - expected) },
    expenses: {
      days: expDays,
      byType: Object.entries(byType).map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount),
      byMethod: Object.entries(expByMethod).map(([method, amount]) => ({ method, amount })).sort((a, b) => methodOrder(a.method, b.method)),
      total: r2(exps.reduce((a, e) => a + e.amount, 0)),
    },
    books,
    movements: movs,
  };
}

// ── The workbook ──────────────────────────────────────────────────────────────

const MONEY = '#,##0.00';

function header(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }; });
}
function title(ws: ExcelJS.Worksheet, text: string, sub: string): void {
  ws.addRow([text]).font = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
  ws.addRow([sub]).font = { italic: true, color: { argb: 'FF555555' } };
  ws.addRow([]);
}
function money(row: ExcelJS.Row, from: number): void {
  row.eachCell((c, n) => { if (n >= from && typeof c.value === 'number') c.numFmt = MONEY; });
}
function widths(ws: ExcelJS.Worksheet, w: number[]): void { w.forEach((x, i) => { ws.getColumn(i + 1).width = x; }); }
const dateCell = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };

/** The pack as one workbook: Summary, Expenses, Expenses by type, one book per method, Movements. */
export function writePackWorkbook(wb: ExcelJS.Workbook, p: Pack, currency: string): void {
  const sub = `Generated by ZapTill from the tills' records · ${currency}`;

  // Summary — the client's "Summary" sheet
  const s = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 4 }] });
  title(s, `Daily sales — ${p.title}`, sub);
  header(s.addRow(['Date', ...p.methods.map(methodLabel), 'Total', 'Expected (confirmed shifts)', 'Counted', 'Variance', 'Cashiers', 'Remarks']));
  for (const r of p.summary.rows) {
    const row = s.addRow([dateCell(r.day), ...p.methods.map((m) => r.byMethod[m] ?? 0), r.total,
      r.expected, r.counted, r.variance, r.cashiers.join(', '), r.remarks.join('; ')]);
    row.getCell(1).numFmt = 'dd-mmm-yyyy';
    money(row, 2);
    const v = row.getCell(p.methods.length + 5);
    if (typeof r.variance === 'number' && Math.abs(r.variance) >= 0.005) v.font = { color: { argb: r.variance < 0 ? 'FFC0392B' : 'FFB9770E' }, bold: true };
  }
  const tot = s.addRow(['Total', ...p.methods.map((m) => p.summary.byMethod[m] ?? 0), p.summary.total,
    p.summary.expected, p.summary.counted, p.summary.variance]);
  tot.font = { bold: true }; money(tot, 2);
  widths(s, [13, ...p.methods.map(() => 13), 14, 14, 13, 12, 26, 60]);

  // Expenses — the daily book (OCTOBER_EXPENSES: one block per day)
  const e = wb.addWorksheet('Expenses');
  title(e, `Expenses — ${p.title}`, sub);
  header(e.addRow(['Date', 'Type', 'Item', 'Paid with', 'Recorded by', 'Amount']));
  for (const d of p.expenses.days) {
    for (const l of d.lines) {
      const row = e.addRow([dateCell(d.day), l.type ?? 'Uncategorised', l.description, methodLabel(l.method), l.by ?? '', l.amount]);
      row.getCell(1).numFmt = 'dd-mmm-yyyy'; money(row, 6);
    }
    const st = e.addRow(['', '', `Total ${d.day}`, '', '', d.total]);
    st.font = { bold: true }; money(st, 6);
  }
  const et = e.addRow(['', '', 'Month total', '', '', p.expenses.total]);
  et.font = { bold: true, size: 12 }; money(et, 6);
  widths(e, [13, 22, 34, 12, 18, 13]);

  // Expenses by type and by method
  const t = wb.addWorksheet('Expenses by type');
  title(t, `Expenses by type — ${p.title}`, sub);
  header(t.addRow(['Type', 'Amount', 'Share']));
  for (const x of p.expenses.byType) {
    const row = t.addRow([x.type, x.amount, p.expenses.total ? x.amount / p.expenses.total : 0]);
    money(row, 2); row.getCell(3).numFmt = '0.0%';
  }
  const tt = t.addRow(['Total', p.expenses.total]); tt.font = { bold: true }; money(tt, 2);
  t.addRow([]);
  header(t.addRow(['Paid with', 'Amount']));
  for (const x of p.expenses.byMethod) money(t.addRow([methodLabel(x.method), x.amount]), 2);
  widths(t, [26, 14, 10]);

  // One book per method — the client's "Cash Usage" / "Mpesa Usage"
  for (const b of p.books) {
    const w = wb.addWorksheet(`${b.label} Usage`.slice(0, 31));
    title(w, `${b.label} book — ${p.title}`, sub);
    header(w.addRow(['Date', 'Sales in', 'Other income', 'Expenses', b.method === 'cash' ? 'Paid out' : '—', 'Personal', 'Bank deposit', 'Charges', 'Running balance']));
    const o = w.addRow(['Opening balance', null, null, null, null, null, null, null, b.opening]); o.font = { italic: true }; money(o, 2);
    for (const r of b.rows) {
      const row = w.addRow([dateCell(r.day), r.sales, r.otherIn, r.expenses, r.paidOut, r.drawings, r.deposits, r.charges, r.balance]);
      row.getCell(1).numFmt = 'dd-mmm-yyyy'; money(row, 2);
    }
    const bt = w.addRow(['Total', b.totals.sales, b.totals.otherIn, b.totals.expenses, b.totals.paidOut, b.totals.drawings, b.totals.deposits, b.totals.charges, b.closing]);
    bt.font = { bold: true }; money(bt, 2);
    widths(w, [16, 13, 13, 13, 12, 12, 13, 12, 16]);
  }

  // Movements — what the managers recorded for the books
  const m = wb.addWorksheet('Movements');
  title(m, `Money movements — ${p.title}`, sub);
  header(m.addRow(['Date', 'Book', 'Movement', 'Amount', 'Note', 'Recorded by']));
  for (const x of p.movements) {
    const row = m.addRow([dateCell(x.day), methodLabel(x.method), MOVEMENT_LABELS[x.kind], x.amount, x.note ?? '', x.by ?? '']);
    row.getCell(1).numFmt = 'dd-mmm-yyyy'; money(row, 4);
  }
  if (p.movements.length === 0) m.addRow(['None recorded this month.']);
  widths(m, [13, 12, 20, 13, 40, 18]);
}
