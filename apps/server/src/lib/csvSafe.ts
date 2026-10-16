/**
 * csvSafe.ts — A494: a CSV cell that a spreadsheet will not run as a formula.
 *
 * A product name, a void reason or an expense description typed as `=HYPERLINK(...)` or `@SUM(...)` is run by Excel /
 * Sheets when the owner opens the export (CSV / formula injection). A text cell that starts with = + - @ tab or CR is
 * prefixed with ' (OWASP). A plain number — "-1,250.00", "-3", "12.5%" — cannot be a formula and is left as it is, so
 * a negative amount still reads as a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?[\d,]*\.?\d+%?$/;

/** The text of a cell, neutralised. */
export function neutralise(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'number') return s;
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

/** One quoted CSV cell: neutralised, double quotes doubled. */
export function csvCell(v: unknown): string {
  return `"${neutralise(v).replace(/"/g, '""')}"`;
}
