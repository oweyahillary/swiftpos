/**
 * statementFile.ts — reads an M-Pesa statement file in the browser for Reports › M-Pesa statement (owner, 2026-11-05).
 * The file never leaves the browser. Loaded on demand with the tab (SheetJS and pdf.js are large).
 *
 *   .xlsx / .xls  the M-PESA Org Portal's Excel export — its first sheet; date cells as the Kenyan clock they show;
 *   .csv          the same export as CSV — read as text, so a date such as 04/11/2026 is never guessed as April;
 *   .pdf          the M-PESA business app's statement — its text laid out in rows (pdfRows); a statement with a password
 *                 asks for it (StatementPasswordError).
 * The rows are read by @zaptill/core/mpesaStatement parseStatementRows either way.
 */
import { parseStatementRows, pdfRows, type PdfText, type StatementRead } from '@zaptill/core/mpesaStatement';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** The PDF needs its password (`wrong`: the one given did not open it). */
export class StatementPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'That password did not open the statement.' : 'This statement is protected with a password.');
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A date cell as the wall clock it shows (SheetJS gives it in the browser's own time zone). */
const wallClock = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

async function sheetRows(file: File): Promise<unknown[][]> {
  const XLSX: any = await import('xlsx');
  const csv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
  const wb = csv
    ? XLSX.read(await file.text(), { type: 'string', raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  return rows.map((r) => r.map((c) => (c instanceof Date ? wallClock(c) : c)));
}

async function pdfText(file: File, password?: string): Promise<PdfText[]> {
  const pdfjs: any = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  let doc: any;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password }).promise;
  } catch (e: any) {
    if (e?.name === 'PasswordException') throw new StatementPasswordError(e.code === pdfjs.PasswordResponses?.INCORRECT_PASSWORD);
    throw e;
  }
  const items: PdfText[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const it of content.items as any[]) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, page });
    }
  }
  await doc.destroy();
  return items;
}

/** The statement's lines from an uploaded file. */
export async function readStatementFile(file: File, password?: string): Promise<StatementRead> {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return parseStatementRows(pdfRows(await pdfText(file, password)));
  return parseStatementRows(await sheetRows(file));
}
