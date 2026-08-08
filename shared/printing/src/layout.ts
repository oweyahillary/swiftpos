/**
 * layout — fixed-width text composition for thermal paper.
 *
 * Every function here takes the column count explicitly rather than reading a
 * global. 58mm and 80mm rolls differ by 16 columns, and the commonest way to
 * produce a receipt with a wrapped, ragged Amt column is to lay it out for one
 * width and print it on the other.
 *
 * COLUMN COUNTS are for the printer's Font A, which is what this package uses
 * throughout. Font B is narrower and fits more, but it is noticeably harder to
 * read across a counter and under a heat lamp, and legibility matters more on
 * these documents than saving paper.
 */

export function columnsFor(paperWidthMm: 58 | 80): number {
  return paperWidthMm === 80 ? 48 : 32;
}

/** Strips anything the printer's code page cannot render, rather than letting it
 *  arrive as a garbage glyph. Curly quotes and dashes come in from menu names
 *  pasted out of Word more often than anyone expects. */
export function sanitize(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '');
}

export function center(cols: number, text: string): string {
  const t = sanitize(text).slice(0, cols);
  const pad = Math.max(0, Math.floor((cols - t.length) / 2));
  return ' '.repeat(pad) + t;
}

export function rule(cols: number, ch = '-'): string {
  return ch.repeat(cols);
}

/** Label on the left, value hard against the right margin. */
export function pair(cols: number, left: string, right: string): string {
  const l = sanitize(left);
  const r = sanitize(right);
  const gap = cols - l.length - r.length;
  if (gap < 1) {
    // Value wins the collision. A truncated label is readable; a wrapped
    // amount column is not.
    const keep = Math.max(0, cols - r.length - 1);
    return l.slice(0, keep) + ' ' + r;
  }
  return l + ' '.repeat(gap) + r;
}

/**
 * Like `pair`, but when the two sides cannot share a line it stacks them
 * instead of truncating. On 58mm paper "Wed 05 Aug 19:42" and a long cashier
 * name do not fit together, and `pair` would clip the timestamp — the one field
 * on a production ticket that settles arguments about when an order came in.
 * Two lines of paper is the cheaper loss.
 */
export function pairOrStack(cols: number, left: string, right: string): string[] {
  const l = sanitize(left);
  const r = sanitize(right);
  if (l.length + r.length + 1 <= cols) return [pair(cols, l, r)];
  return [l.slice(0, cols), ' '.repeat(Math.max(0, cols - r.length)) + r.slice(0, cols)];
}

/** Wrap with a hanging indent, so continuation lines sit under the text rather
 *  than under the quantity that opened the line. */
export function hangingWrap(text: string, width: number, indent: number): string[] {
  const segs = wrap(text, width);
  return segs.map((s, i) => (i === 0 ? s : ' '.repeat(indent) + s));
}

export interface ItemColumns {
  name: number;
  qty: number;
  amt: number;
}

/** Name / Qty / Amt widths. Amt is sized for "999,999.00" plus a space. */
export function itemColumns(cols: number): ItemColumns {
  const amt = cols >= 48 ? 12 : 10;
  const qty = cols >= 48 ? 5 : 4;
  return { name: cols - amt - qty, qty, amt };
}

/** One item row: wrapped name, right-aligned qty, right-aligned amount.
 *  Returns one line per wrapped name segment; qty and amt sit on the first. */
export function itemRow(
  cols: number,
  name: string,
  qty: string,
  amt: string,
): string[] {
  const c = itemColumns(cols);
  const segments = wrap(sanitize(name), c.name - 1);
  return segments.map((seg, i) => {
    const namePart = seg.padEnd(c.name, ' ');
    if (i > 0) return namePart.trimEnd();
    return namePart + qty.padStart(c.qty, ' ') + amt.padStart(c.amt, ' ');
  });
}

/** A sub-line beneath an item: indented text, optional right-aligned amount. */
export function subRow(cols: number, text: string, amt?: string, indent = 2): string[] {
  const body = ' '.repeat(indent) + sanitize(text);
  if (!amt) return wrap(body, cols).map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l.trimStart()));
  const amtW = itemColumns(cols).amt;
  const avail = cols - amtW;
  if (body.length <= avail) return [body.padEnd(avail, ' ') + amt.padStart(amtW, ' ')];
  // Name too long to share the line with its price: give the price its own row,
  // still right-aligned, so the column never breaks.
  const wrapped = wrap(body, cols);
  return [...wrapped, ''.padEnd(avail, ' ') + amt.padStart(amtW, ' ')];
}

/**
 * Wrap text that a HUMAN laid out, keeping the line breaks they typed.
 *
 * wrap() splits on /\s+/, so a newline is just another space to it. That is
 * right for a product name and wrong for anything an owner composed: a receipt
 * footer typed as
 *
 *     Thank you for your business!
 *     TAX RECEIPT UPON REQUEST
 *
 * came out as one run-on line, because the break between them was eaten before
 * anything could honour it. The author's breaks are meaning, not whitespace.
 *
 * Each authored line is still wrapped to the paper, so a long one folds rather
 * than being cut off.
 */
export function wrapAuthored(text: string, width: number): string[] {
  return text
    .split(/\r?\n/)
    .flatMap(line => (line.trim() ? wrap(line.trim(), width) : ['']));
}

export function wrap(text: string, width: number): string[] {
  const t = sanitize(text);
  if (width <= 0) return [t];
  if (t.length <= width) return [t];
  const out: string[] = [];
  let line = '';
  for (const word of t.split(/\s+/)) {
    if (!line.length) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line.length) out.push(line);
  return out;
}
