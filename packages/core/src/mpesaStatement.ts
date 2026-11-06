/**
 * mpesaStatement.ts — the M-Pesa statement check (owner, 2026-11-05: Excel/CSV and PDF, "both").
 *
 * A business uploads its M-Pesa statement — the M-PESA Org Portal's Excel/CSV export, or the PDF statement from the
 * M-PESA business app — and sees it against the sales its POS recorded as M-Pesa. The file is read in the browser and
 * never leaves it; the cloud gives only the sales (GET /api/payments/mpesa-statement/sales).
 *
 *   parseStatementRows  a sheet's or a CSV's rows → the statement's lines (the header row is found by its titles, so the
 *                       portal's account details above the table do not matter);
 *   pdfRows             a PDF's text pieces (pdf.js) → the same rows: one row per transaction, a wrapped cell joined;
 *   matchStatement      the lines against the sales:
 *     matched        the line's receipt code is on a sale, for the same amount;
 *     amountDiffers  the code is on a sale, for a different amount;
 *     likely         a sale whose code is missing or unknown, and money in for the same amount within 15 minutes;
 *     statementOnly  money in that no sale carries (a sale not rung, or money that was not a sale);
 *     posOnly        a sale recorded as M-Pesa with no money on the statement (no code, an unknown code, or a code
 *                    another sale already used).
 *
 * Pure: no I/O, no clock. Times on a statement are Kenyan (EAT, UTC+3) and are returned as UTC ISO strings.
 */

export const LIKELY_WINDOW_MINUTES = 15;
const EAT_OFFSET_MS = 3 * 3600_000;
const CODE = /^[A-Z0-9]{8,20}$/;

export interface StatementLine {
  code: string;
  /** UTC ISO; '' when the statement's time could not be read. */
  at: string;
  details: string;
  party: string;
  status: string;
  paidIn: number;
  withdrawn: number;
}

export interface StatementRead {
  lines: StatementLine[];
  /** Rows under the header that were not a transaction (totals, blank or unreadable rows). */
  skipped: number;
  /** The statement's first and last Kenyan day (YYYY-MM-DD), from its lines; null when it has none. */
  from: string | null;
  to: string | null;
}

/** A sale's M-Pesa payment, as the cloud gives it. */
export interface MpesaSale {
  order_number: string;
  reference: string | null;
  amount: number;
  /** UTC ISO. */
  at: string;
  cashier?: string | null;
  branch?: string | null;
}

export type PosOnlyReason = 'no_code' | 'unknown_code' | 'code_used_twice';

export interface StatementCheck {
  matched: Array<{ line: StatementLine; sale: MpesaSale }>;
  amountDiffers: Array<{ line: StatementLine; sale: MpesaSale }>;
  likely: Array<{ line: StatementLine; sale: MpesaSale }>;
  statementOnly: StatementLine[];
  posOnly: Array<{ sale: MpesaSale; reason: PosOnlyReason }>;
  totals: { statementIn: number; posMpesa: number; matched: number; statementOnly: number; posOnly: number };
}

// ── Reading the table ──────────────────────────────────────────────────────────────────────────────────────────────

type Column = 'code' | 'at' | 'details' | 'party' | 'status' | 'paidIn' | 'withdrawn';

/** The titles a column goes by (letters only, lower case), best first. */
const TITLES: Record<Column, string[]> = {
  code:      ['receiptno', 'receiptnumber', 'receipt', 'transactionid', 'transid'],
  at:        ['completiontime', 'completedtime', 'transactiontime', 'datetime', 'date'],
  details:   ['details', 'description', 'narration'],
  party:     ['otherpartyinfo', 'otherparty'],
  status:    ['transactionstatus', 'status'],
  paidIn:    ['paidin', 'moneyin', 'credit'],
  withdrawn: ['withdrawn', 'withdrawal', 'paidout', 'moneyout', 'debit'],
};

const letters = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
const cellText = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

function headerOf(row: unknown[]): Partial<Record<Column, number>> | null {
  const names = row.map(letters);
  const found: Partial<Record<Column, number>> = {};
  for (const col of Object.keys(TITLES) as Column[]) {
    for (const title of TITLES[col]) {
      const i = names.findIndex((n, k) => n === title && !Object.values(found).includes(k));
      if (i >= 0) { found[col] = i; break; }
    }
  }
  return found.code !== undefined && found.paidIn !== undefined && found.at !== undefined ? found : null;
}

/** A money cell: 1,250.00 · KES 1,250 · (500.00) · -500 · 1250 (a number). NaN when it is not money. */
export function moneyOf(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = cellText(v);
  if (!t) return 0;
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/^[A-Za-z]+\s*/, ''));
  const digits = t.replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return NaN;
  const n = Math.round(Number(digits) * 100) / 100;
  return negative ? -n : n;
}

/** A statement time (Kenyan clock) → UTC ISO; '' when unreadable. yyyy-mm-dd or dd/mm/yyyy (Kenya), seconds optional;
 *  an Excel serial number too. */
export function statementTimeOf(v: unknown): string {
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const ms = Math.round((v - 25569) * 86_400_000);   // the serial's days since 1970, read as the Kenyan wall clock
    return new Date(ms - EAT_OFFSET_MS).toISOString();
  }
  const t = cellText(v);
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) { [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; }
  else {
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return '';
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (m[4] !== undefined) { h = Number(m[4]); mi = Number(m[5]); s = Number(m[6] ?? 0); }
  if (/\bpm\b/i.test(t) && h < 12) h += 12;
  if (/\bam\b/i.test(t) && h === 12) h = 0;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return '';
  return new Date(ms - EAT_OFFSET_MS).toISOString();
}

/** The Kenyan day (YYYY-MM-DD) of a UTC ISO time. */
export function kenyanDayOf(iso: string): string {
  return new Date(Date.parse(iso) + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** An M-Pesa receipt code: 8–20 capitals and digits, with at least one of each. */
export function isMpesaCode(v: string): boolean {
  return CODE.test(v) && /\d/.test(v) && /[A-Z]/.test(v);
}

/** A sheet's or a CSV's rows (each a list of cells) → the statement's lines. */
export function parseStatementRows(rows: unknown[][]): StatementRead {
  let header: Partial<Record<Column, number>> | null = null;
  const lines: StatementLine[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const asHeader = headerOf(row);
    if (asHeader) { header = asHeader; continue; }   // a PDF repeats it on every page
    if (!header) continue;
    const get = (c: Column) => (header![c] === undefined ? '' : row[header![c]!]);
    const code = cellText(get('code')).toUpperCase();
    if (!isMpesaCode(code)) { if (row.some((c) => cellText(c))) skipped++; continue; }
    const paid = moneyOf(get('paidIn'));
    const out = moneyOf(get('withdrawn'));
    if (Number.isNaN(paid) || Number.isNaN(out)) { skipped++; continue; }
    lines.push({
      code, at: statementTimeOf(get('at')), details: cellText(get('details')), party: cellText(get('party')),
      status: cellText(get('status')),
      // One amount column with a sign (some PDFs): a negative "paid in" is money out.
      paidIn: paid > 0 ? paid : 0,
      withdrawn: Math.abs(out) || (paid < 0 ? -paid : 0),
    });
  }
  const days = lines.filter((l) => l.at).map((l) => kenyanDayOf(l.at)).sort();
  return { lines, skipped, from: days[0] ?? null, to: days[days.length - 1] ?? null };
}

// ── A PDF's text → rows ────────────────────────────────────────────────────────────────────────────────────────────

/** A piece of text on a PDF page (pdf.js getTextContent: transform[4] = x, transform[5] = y — y grows up the page). */
export interface PdfText { str: string; x: number; y: number; width: number; page: number }

/** The same line on the page: pieces whose y differ by at most this. */
const SAME_LINE = 2.5;

function linesOf(items: PdfText[]): PdfText[][] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: PdfText[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last[0].page === it.page && Math.abs(last[0].y - it.y) <= SAME_LINE) last.push(it);
    else out.push([it]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

/** A header line's cells: pieces close together are one title ("Receipt" "No."). */
function headerCells(line: PdfText[]): Array<{ text: string; from: number; to: number }> {
  const cells: Array<{ text: string; from: number; to: number }> = [];
  for (const it of line) {
    const last = cells[cells.length - 1];
    if (last && it.x - last.to < 6) { last.text += ` ${it.str}`; last.to = it.x + it.width; }
    else cells.push({ text: it.str, from: it.x, to: it.x + it.width });
  }
  return cells;
}

/** Which column a piece of text is in: the one its span overlaps most, else the nearest. */
function columnOf(it: PdfText, cols: Array<{ from: number; to: number }>): number {
  let best = -1, bestOverlap = 0, nearest = 0, nearestGap = Infinity;
  cols.forEach((c, i) => {
    const overlap = Math.min(it.x + it.width, c.to) - Math.max(it.x, c.from);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
    const gap = Math.max(c.from - (it.x + it.width), it.x - c.to, 0);
    if (gap < nearestGap) { nearestGap = gap; nearest = i; }
  });
  return best >= 0 ? best : nearest;
}

/**
 * A PDF statement's text → rows for parseStatementRows: the header row, then one row per transaction. A line with no
 * receipt code under the code column continues the transaction above it (a long description, or a date and its time on
 * two lines), so its cells are joined to that row's.
 */
export function pdfRows(items: PdfText[]): string[][] {
  const rows: string[][] = [];
  let cols: Array<{ text: string; from: number; to: number }> | null = null;
  let codeCol = -1;
  let current: string[] | null = null;
  for (const line of linesOf(items)) {
    const cells = headerCells(line);
    if (headerOf(cells.map((c) => c.text))) {
      if (!cols) rows.push(cells.map((c) => c.text));
      cols = cells;
      codeCol = cells.findIndex((c) => TITLES.code.includes(letters(c.text)));
      current = null;
      continue;
    }
    if (!cols) continue;
    const row: string[] = cols.map(() => '');
    for (const it of line) {
      const i = columnOf(it, cols);
      row[i] = row[i] ? `${row[i]} ${it.str.trim()}` : it.str.trim();
    }
    if (isMpesaCode(row[codeCol]?.toUpperCase() ?? '')) {
      current = row;
      rows.push(row);
    } else if (current && !row[codeCol]) {
      row.forEach((v, i) => { if (v) current![i] = current![i] ? `${current![i]} ${v}` : v; });
    }
  }
  return rows;
}

// ── Matching ───────────────────────────────────────────────────────────────────────────────────────────────────────

const cents = (n: number) => Math.round(n * 100);
const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

/** The M-Pesa codes a sale's reference holds (a cashier may type more than the code). */
export function codesInReference(reference: string | null | undefined): string[] {
  return (String(reference ?? '').toUpperCase().match(/[A-Z0-9]{8,20}/g) ?? []).filter(isMpesaCode);
}

/** Money that reached the account: a completed line with something paid in. */
function isMoneyIn(l: StatementLine): boolean {
  return l.paidIn > 0 && (!l.status || /complet/i.test(l.status));
}

export function matchStatement(lines: StatementLine[], sales: MpesaSale[]): StatementCheck {
  const moneyIn = lines.filter(isMoneyIn);
  const byCode = new Map<string, StatementLine>();
  for (const l of moneyIn) if (!byCode.has(l.code)) byCode.set(l.code, l);
  const used = new Set<StatementLine>();
  const check: StatementCheck = { matched: [], amountDiffers: [], likely: [], statementOnly: [], posOnly: [],
    totals: { statementIn: 0, posMpesa: 0, matched: 0, statementOnly: 0, posOnly: 0 } };

  // 1. By the receipt code.
  const pending: Array<{ sale: MpesaSale; reason: PosOnlyReason }> = [];
  for (const sale of [...sales].sort((a, b) => a.at.localeCompare(b.at))) {
    const codes = codesInReference(sale.reference);
    const line = codes.map((c) => byCode.get(c)).find((l) => l && !used.has(l));
    if (line) {
      used.add(line);
      (cents(line.paidIn) === cents(sale.amount) ? check.matched : check.amountDiffers).push({ line, sale });
      continue;
    }
    const reason: PosOnlyReason = !codes.length ? 'no_code' : codes.some((c) => byCode.has(c)) ? 'code_used_twice' : 'unknown_code';
    pending.push({ sale, reason });
  }

  // 2. The rest, by amount and time: the nearest unclaimed money in for the same amount, within the window.
  const window = LIKELY_WINDOW_MINUTES * 60_000;
  for (const p of pending) {
    const at = Date.parse(p.sale.at);
    let best: StatementLine | null = null, bestGap = Infinity;
    for (const l of moneyIn) {
      if (used.has(l) || !l.at || cents(l.paidIn) !== cents(p.sale.amount)) continue;
      const gap = Math.abs(Date.parse(l.at) - at);
      if (gap <= window && gap < bestGap) { best = l; bestGap = gap; }
    }
    if (best && p.reason !== 'code_used_twice') { used.add(best); check.likely.push({ line: best, sale: p.sale }); }
    else check.posOnly.push(p);
  }

  check.statementOnly = moneyIn.filter((l) => !used.has(l));
  check.totals = {
    statementIn: sum(moneyIn.map((l) => l.paidIn)),
    posMpesa: sum(sales.map((s) => s.amount)),
    matched: sum(check.matched.map((m) => m.sale.amount)),
    statementOnly: sum(check.statementOnly.map((l) => l.paidIn)),
    posOnly: sum(check.posOnly.map((p) => p.sale.amount)),
  };
  return check;
}
