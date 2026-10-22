/**
 * barcode.ts — A571: barcodes ZapTill can print, and in-store codes for products that have none.
 *
 * Owner, 2026-10-22: "we do not have barcode generation mechanism, what does it entail can we add it?"
 *
 * Pure (no DOM, no Node): the cloud assigns in-store codes with it, the web and the till draw and print labels with it.
 * Copies (scripts/check-shared-sync.mjs keeps them identical): apps/server/src/lib, apps/dashboard/src/lib,
 * apps/desktop/src/shared (the till's screens), apps/desktop/src/main (the till's raw label printing).
 *
 * ── SYMBOLOGIES ──────────────────────────────────────────────────────────────────────────────────────────────────────
 *   EAN-13   13 digits, the last a GS1 mod-10 check digit (12 given: the check digit is added).
 *   UPC-A    12 digits — an EAN-13 whose first digit is 0, shown as 12 (11 given: the check digit is added).
 *   Code 128 anything else in printable ASCII (letters, odd lengths, a manufacturer's internal code); subsets B and C
 *            chosen automatically (C packs digit pairs, so a long number stays short).
 * A scanned or typed code is never refused for its format: what cannot be drawn as EAN/UPC is drawn as Code 128, and
 * what Code 128 cannot carry (a character outside ASCII 32–126) has no barcode on the label (encodeBarcode → null).
 *
 * ── IN-STORE CODES (GS1 restricted circulation) ─────────────────────────────────────────────────────────────────────
 * GS1 keeps EAN-13 prefixes 20–29 for numbers a business uses inside its own shops; no manufacturer's product ever
 * carries one. ZapTill uses ONLY prefix "20" for the codes it assigns:  20 + a 10-digit item number + the check digit,
 * e.g. 2000000000015, 2000000000022 … unique per business (the database's unique index on (business_id, barcode)).
 * Prefixes 21–29 are left alone: weighing scales print price- or weight-embedded codes there (2 + PLU + price/weight +
 * check), and a generated item code must never be read as one.
 */

export type Symbology = 'EAN13' | 'UPCA' | 'CODE128';

/** A Code 128 run in one subset: B carries the characters themselves, C the digit pairs. */
export interface Code128Segment { set: 'B' | 'C'; text: string }

export interface EncodedBarcode {
  symbology: Symbology;
  /** What the printer is given: EAN-13 13 digits, UPC-A 12, Code 128 the text. */
  data: string;
  /** The human-readable line under the bars. */
  text: string;
  /** One character per module, left to right: '1' a bar, '0' a space. Quiet zones NOT included. */
  modules: string;
  /** The light margin each side needs, in modules (EAN-13 11 left and 7 right, UPC-A 9 and 9, Code 128 10 and 10). */
  quietLeft: number;
  quietRight: number;
  /** Code 128 only: the symbol values (start, data, check, stop) and the subset runs (ESC/POS and ZPL need them). */
  values?: number[];
  segments?: Code128Segment[];
}

// ── GS1 check digit ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The GS1 mod-10 check digit of a digit string WITHOUT its check digit (EAN-13: 12 digits, UPC-A: 11, EAN-8: 7). */
export function gs1CheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new Error('A check digit needs digits only');
  let sum = 0;
  // Weights 3,1,3,1… from the RIGHTMOST digit of the body.
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** True for an 8, 12, 13 or 14 digit GTIN whose last digit is its correct check digit. */
export function isValidGtin(code: string): boolean {
  const c = String(code ?? '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(c)) return false;
  return gs1CheckDigit(c.slice(0, -1)) === Number(c[c.length - 1]);
}

// ── EAN-13 / UPC-A ───────────────────────────────────────────────────────────────────────────────────────────────────

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_R = EAN_L.map((p) => p.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));
const EAN_G = EAN_R.map((p) => p.split('').reverse().join(''));
/** Which of the left six digits use the G code, by the first digit (L = odd parity, G = even). */
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGGL', 'LGLGLG', 'LGGLGL'];

/** EAN-13 from 12 digits (the check digit is added) or 13 (the check digit must be right). */
export function encodeEan13(code: string): EncodedBarcode {
  const c = String(code ?? '').trim();
  if (!/^\d{12,13}$/.test(c)) throw new Error('EAN-13 needs 12 or 13 digits');
  const full = c.length === 12 ? c + gs1CheckDigit(c) : c;
  if (c.length === 13 && !isValidGtin(full)) throw new Error(`${c} has a wrong check digit (should end in ${gs1CheckDigit(c.slice(0, 12))})`);
  const parity = EAN_PARITY[Number(full[0])];
  let m = '101';
  for (let i = 1; i <= 6; i++) m += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(full[i])];
  m += '01010';
  for (let i = 7; i <= 12; i++) m += EAN_R[Number(full[i])];
  m += '101';
  return { symbology: 'EAN13', data: full, text: full, modules: m, quietLeft: 11, quietRight: 7 };
}

/** UPC-A from 11 digits (the check digit is added) or 12: the bars of the EAN-13 "0" + the code, shown as 12 digits. */
export function encodeUpcA(code: string): EncodedBarcode {
  const c = String(code ?? '').trim();
  if (!/^\d{11,12}$/.test(c)) throw new Error('UPC-A needs 11 or 12 digits');
  const ean = encodeEan13('0' + c);
  return { ...ean, symbology: 'UPCA', data: ean.data.slice(1), text: ean.data.slice(1), quietLeft: 9, quietRight: 9 };
}

// ── Code 128 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bar/space widths of each symbol value 0–106 (ISO/IEC 15417 table 1); 106 is the stop (with its final bar). */
export const CODE128_WIDTHS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const C128 = { CODE_C: 99, CODE_B: 100, START_B: 104, START_C: 105, STOP: 106 } as const;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const digitRun = (s: string, i: number): number => { let n = 0; while (isDigit(s[i + n])) n++; return n; };

/** True when Code 128 (subsets B/C) can carry the text: printable ASCII 32–126, 1–80 characters. */
export function code128Can(text: string): boolean {
  return typeof text === 'string' && text.length > 0 && text.length <= 80 && /^[\x20-\x7e]+$/.test(text);
}

/** The subset runs, ISO/IEC 15417 Annex E style: C for 4+ leading digits (or exactly 2), for 6+ digits inside the text
 *  and 4+ at its end; an odd run gives its FIRST digit to B (mid-text) or its LAST to B (at the start). */
export function code128Segments(text: string): Code128Segment[] {
  if (!code128Can(text)) throw new Error('Code 128 here carries printable ASCII only (1–80 characters)');
  const segs: Code128Segment[] = [];
  const push = (set: 'B' | 'C', s: string) => {
    if (!s) return;
    const last = segs[segs.length - 1];
    if (last && last.set === set) last.text += s; else segs.push({ set, text: s });
  };
  let i = 0;
  const lead = digitRun(text, 0);
  if (lead === text.length && lead === 2) { push('C', text); return segs; }
  if (lead >= 4) {
    const even = lead - (lead % 2);
    push('C', text.slice(0, even));
    i = even;
  }
  while (i < text.length) {
    const run = digitRun(text, i);
    const atEnd = i + run === text.length;
    if (run >= 6 || (atEnd && run >= 4)) {
      if (run % 2 === 1) { push('B', text[i]); i++; }
      const even = run - (run % 2);
      push('C', text.slice(i, i + even));
      i += even;
      continue;
    }
    push('B', text[i]);
    i++;
  }
  return segs;
}

/** Code 128 of printable ASCII text, subsets B and C chosen automatically. */
export function encodeCode128(text: string): EncodedBarcode {
  const segments = code128Segments(text);
  const values: number[] = [];
  segments.forEach((seg, k) => {
    if (k === 0) values.push(seg.set === 'C' ? C128.START_C : C128.START_B);
    else values.push(seg.set === 'C' ? C128.CODE_C : C128.CODE_B);
    if (seg.set === 'C') for (let j = 0; j < seg.text.length; j += 2) values.push(Number(seg.text.slice(j, j + 2)));
    else for (const ch of seg.text) values.push(ch.charCodeAt(0) - 32);
  });
  let sum = values[0];
  for (let j = 1; j < values.length; j++) sum += values[j] * j;
  values.push(sum % 103, C128.STOP);
  let modules = '';
  for (const v of values) {
    const w = CODE128_WIDTHS[v];
    for (let j = 0; j < w.length; j++) modules += (j % 2 === 0 ? '1' : '0').repeat(Number(w[j]));
  }
  return { symbology: 'CODE128', data: text, text, modules, quietLeft: 10, quietRight: 10, values, segments };
}

// ── Choosing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The symbology a stored code prints in: a valid EAN-13 as EAN-13, a valid UPC-A as UPC-A, anything else Code 128. */
export function symbologyFor(code: string): Symbology | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  if (/^\d{13}$/.test(c) && isValidGtin(c)) return 'EAN13';
  if (/^\d{12}$/.test(c) && isValidGtin(c)) return 'UPCA';
  return code128Can(c) ? 'CODE128' : null;
}

/** The bars for a product's stored barcode, whatever its format — null when it cannot be drawn. */
export function encodeBarcode(code: string | null | undefined): EncodedBarcode | null {
  const c = String(code ?? '').trim();
  const s = symbologyFor(c);
  if (s === 'EAN13') return encodeEan13(c);
  if (s === 'UPCA') return encodeUpcA(c);
  if (s === 'CODE128') return encodeCode128(c);
  return null;
}

// ── In-store codes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The prefix of every code ZapTill assigns (GS1 restricted circulation; 21–29 stay free for scale codes). */
export const IN_STORE_PREFIX = '20';
/** The largest item number a 10-digit field holds. */
export const IN_STORE_MAX = 9_999_999_999;

/** The in-store EAN-13 for item number n (1 … 9 999 999 999): "20" + n in 10 digits + the check digit. */
export function inStoreEan13(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > IN_STORE_MAX) throw new Error('An in-store item number is 1 to 9 999 999 999');
  const body = IN_STORE_PREFIX + String(n).padStart(10, '0');
  return body + gs1CheckDigit(body);
}

/** The item number of a code ZapTill assigned (prefix 20, valid check digit), else null. */
export function inStoreNumber(code: string | null | undefined): number | null {
  const c = String(code ?? '').trim();
  if (!/^20\d{11}$/.test(c) || !isValidGtin(c)) return null;
  const n = Number(c.slice(2, 12));
  return n >= 1 ? n : null;
}

/** True for a code ZapTill assigned. */
export function isInStoreCode(code: string | null | undefined): boolean {
  return inStoreNumber(code) !== null;
}

/** The next `count` in-store codes after the highest one already used (`taken`: every barcode the business has). */
export function nextInStoreCodes(taken: Iterable<string | null | undefined>, count: number, after = 0): string[] {
  const used = new Set<string>();
  let top = Math.max(0, Math.floor(after));
  for (const t of taken) {
    const c = String(t ?? '').trim();
    if (!c) continue;
    used.add(c);
    const n = inStoreNumber(c);
    if (n !== null && n > top) top = n;
  }
  const out: string[] = [];
  let n = top;
  while (out.length < count) {
    n++;
    const code = inStoreEan13(n);
    if (!used.has(code)) out.push(code);
  }
  return out;
}

/** A product "has no barcode" when the field is empty or only spaces. */
export function lacksBarcode(code: string | null | undefined): boolean {
  return String(code ?? '').trim() === '';
}
