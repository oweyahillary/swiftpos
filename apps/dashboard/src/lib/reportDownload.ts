/**
 * reportDownload.ts — Download Excel on each Reports tab (A467).
 *
 * Owner, 2026-10-13: "can we download individual report — some I might want daily, some monthly, some weekly".
 * Every data tab hands over the data it ALREADY loaded (no new API call, no figure changed) as sheets: one per
 * table/section, the tab's column headings as the header row, numbers as numbers, money rounded to 2 dp. A first
 * "About" sheet names the business, the branch (or All branches), the report, the period and when it was made.
 *
 * Built from the DATA, never the DOM — a phone's "View more" rows (A464) are not in it, so nothing doubles.
 *
 * The shaping (shapeReport, buildWorkbook, reportFileName) is pure and has no imports, so a test can run it under
 * plain node. Only downloadReport touches the browser, and it loads `xlsx` with a dynamic import so the library stays
 * out of the main bundle until someone presses the button.
 */

export interface ReportColumn {
  key: string;
  label: string;
  /** Money: rounded to 2 dp and shown with a #,##0.00 format. */
  money?: boolean;
  /** Any other number rounded to this many decimals (litres, hours, percentages). */
  dp?: number;
}
/** Rows are plain objects read by column key (an interface type such as a typed API row is fine). */
export interface ReportSheet { name: string; columns: ReportColumn[]; rows: readonly object[] }
export interface ReportDownloadInput {
  /** The report's name as the tab shows it, e.g. "Item Mix". */
  report: string;
  /** The selected branch's name; empty / null = All branches. */
  branchName?: string | null;
  from: string;
  to: string;
  businessName?: string | null;
  sheets: ReportSheet[];
}
export interface ShapedSheet { name: string; aoa: unknown[][]; moneyCols: number[] }
export interface ShapedReport { fileName: string; sheets: ShapedSheet[] }

/** "Voids & Exceptions" → "voids-exceptions". */
export function slugify(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** zaptill-<report>-<branch or all>-<from>_to_<to>.xlsx — a single day is just the date. */
export function reportFileName(input: Pick<ReportDownloadInput, 'report' | 'branchName' | 'from' | 'to'>): string {
  const report = slugify(input.report) || 'report';
  const branch = slugify(input.branchName) || 'all';
  const period = input.from === input.to ? input.from : `${input.from}_to_${input.to}`;
  return `zaptill-${report}-${branch}-${period}.xlsx`;
}

/** Excel sheet names: ≤ 31 chars, none of : \ / ? * [ ], not blank, not History, unique (case-insensitive). */
export function safeSheetName(name: string, used: Set<string>): string {
  let base = String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');
  if (!base || base.toLowerCase() === 'history') base = base ? `${base} sheet` : 'Sheet';
  base = base.slice(0, 31).trim();
  let out = base, n = 2;
  while (used.has(out.toLowerCase())) {
    const tag = ` (${n++})`;
    out = base.slice(0, 31 - tag.length).trim() + tag;
  }
  used.add(out.toLowerCase());
  return out;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** One cell: blank for nothing, numbers stay numbers (numeric strings from Postgres numerics become numbers), money to 2 dp. */
export function cellValue(v: unknown, col: Pick<ReportColumn, 'money' | 'dp'> = {}): unknown {
  const dp = col.money ? 2 : col.dp;
  if (v == null) return null;   // a blank cell, not an empty string
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return dp != null ? round(v, dp) : v;
  }
  if (typeof v === 'string' && dp != null && NUMERIC.test(v.trim())) return round(Number(v), dp);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function pad(n: number) { return String(n).padStart(2, '0'); }

/** A timestamp as the local (EAT) day and time: 2026-10-13 18:05. Blank for nothing / an unreadable value. */
export function localStamp(v: string | number | Date | null | undefined): string {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The whole workbook as plain arrays: About first, then each sheet with its header row. Pure. */
export function shapeReport(input: ReportDownloadInput, generatedAt: Date = new Date()): ShapedReport {
  const used = new Set<string>();
  const about: ShapedSheet = {
    name: safeSheetName('About', used),
    moneyCols: [],
    aoa: [
      ['Field', 'Value'],
      ['Business', input.businessName || ''],
      ['Branch', input.branchName || 'All branches'],
      ['Report', input.report],
      ['Period from', input.from],
      ['Period to', input.to],
      ['Generated at', localStamp(generatedAt)],
    ],
  };
  const sheets = input.sheets.map((s): ShapedSheet => ({
    name: safeSheetName(s.name, used),
    moneyCols: s.columns.map((c, i) => (c.money ? i : -1)).filter((i) => i >= 0),
    aoa: [s.columns.map((c) => c.label), ...s.rows.map((r) => s.columns.map((c) => cellValue((r as Record<string, unknown>)[c.key], c)))],
  }));
  return { fileName: reportFileName(input), sheets: [about, ...sheets] };
}

/** True when no sheet has a row — the button is disabled. */
export function reportIsEmpty(sheets: ReportSheet[]): boolean {
  return sheets.every((s) => s.rows.length === 0);
}

/** Build the workbook with the given xlsx module (passed in, so this stays pure and testable). */
export function buildWorkbook(XLSX: any, shaped: ShapedReport): any {
  const wb = XLSX.utils.book_new();
  for (const s of shaped.sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    // Money cells keep their number and show two decimals.
    for (let r = 1; r < s.aoa.length; r++) {
      for (const c of s.moneyCols) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') cell.z = '#,##0.00';
      }
    }
    const width = s.aoa[0]?.length ?? 0;
    ws['!cols'] = Array.from({ length: width }, (_, c) => ({
      wch: Math.min(48, Math.max(8, ...s.aoa.map((row) => String(row[c] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return wb;
}

/** The browser half: load xlsx on demand, build, save. */
export async function downloadReport(input: ReportDownloadInput): Promise<void> {
  const mod: any = await import('xlsx');
  const XLSX = mod?.utils ? mod : mod.default;
  const shaped = shapeReport(input, new Date());
  XLSX.writeFile(buildWorkbook(XLSX, shaped), shaped.fileName);
}
