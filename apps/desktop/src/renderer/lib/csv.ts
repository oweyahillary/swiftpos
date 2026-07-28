/**
 * csv — a small, correct CSV reader for the menu import.
 *
 * Hand-rolled rather than pulling in a parser dependency at this stage, but NOT
 * naively: this menu's descriptions are things like
 *
 *     Chicken breast, lettuce, tomato, cheddar cheese, sauce
 *
 * so splitting on commas would shred half the catalogue. This handles the parts
 * of RFC 4180 that actually occur in spreadsheet exports — quoted fields,
 * embedded commas, doubled quotes as an escape, and newlines inside quotes.
 *
 * Deliberately NOT handled: alternative delimiters, and multi-sheet workbooks.
 * Excel and Sheets both export comma-separated UTF-8 by default, and telling
 * someone to "Save As CSV" is cheaper than shipping a spreadsheet engine.
 */

export type CsvRow = Record<string, string>;

/** Splits raw CSV text into rows of cells. Returns [] for empty input. */
export function parseCsv(text: string): string[][] {
  // Excel on Windows writes a UTF-8 BOM, which would otherwise become part of
  // the first header name and break every column lookup.
  const src = text.replace(/^\uFEFF/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }  // "" → literal "
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }                                // CRLF → LF
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }

  // Trailing field/row unless the file ended on a clean newline.
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

/**
 * Parses to objects keyed by header. Headers are lower-cased and trimmed so
 * "Name", "name" and " NAME " all resolve — people export from all sorts of
 * places and a case mismatch is a miserable thing to debug from a shop floor.
 */
export function parseCsvRows(text: string): { headers: string[]; rows: CsvRow[] } {
  const raw = parseCsv(text);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map(h => h.trim().toLowerCase());
  const rows = raw.slice(1).map(cells => {
    const obj: CsvRow = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

/** Truthy spreadsheet values. Blank means false. */
export function csvBool(v: string | undefined): boolean {
  return ['yes', 'y', 'true', '1', 'kitchen'].includes((v ?? '').trim().toLowerCase());
}
