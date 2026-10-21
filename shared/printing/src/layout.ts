/**
 * layout — fixed-width text composition for thermal paper.
 *
 * Every function here takes the column count explicitly rather than reading a
 * global. 58mm and 80mm rolls differ by 16 columns, and the commonest way to
 * produce a receipt with a wrapped, ragged Amt column is to lay it out for one
 * width and print it on the other.
 *
 * COLUMN COUNTS are for the printer's Font A (12x24 dots) unless Font B is asked
 * for. Font A is what receipts, dispatch and the Z-report use: it reads across a
 * counter. A543 (owner, 2026-10-21: "change the font of the kitchen printer,
 * packing is okay" — chose "the printer's smaller Font B so long orders fit on
 * less paper") put KITCHEN tickets in Font B (9x17 dots). A551 (owner, on paper:
 * "kitchen receipt use the same font as the despatcher"): Font A again; Font B
 * only with the client's 'kitchen_font_b' switch.
 */

export type PrinterFont = 'A' | 'B';

/** Characters a line: Font A 12 dots wide → 48 on 80 mm (576 dots), 32 on 58 mm (384); A543: Font B 9 dots wide →
 *  64 on 80 mm, 42 on 58 mm (384 / 9 = 42.7, rounded down). */
export function columnsFor(paperWidthMm: 58 | 80, font: PrinterFont = 'A'): number {
  if (font === 'B') return paperWidthMm === 80 ? 64 : 42;
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
 *  than under the quantity that opened the line.
 *
 *  The first `indent` characters of `text` are its prefix (a kitchen ticket's "2   "). A547: the prefix is kept as
 *  written and only the rest is wrapped, in `width - indent` — before, the whole text went through wrap(), which
 *  split on runs of spaces and joined with one, so a wrapped dish name lost the three spaces after its quantity
 *  ("2 CHICKEN ..."), and a continuation row could run `indent` past the paper. A line that fits is unchanged. */
export function hangingWrap(text: string, width: number, indent: number): string[] {
  const prefix = sanitize(text.slice(0, indent));
  const rest = text.slice(indent);
  const segs = wrap(rest, Math.max(1, width - indent));
  return segs.map((s, i) => (i === 0 ? prefix : ' '.repeat(indent)) + s);
}

/** A547: an indented row on a production ticket (a component, its attributes, a note) — every row of it, the first
 *  included, `indent` spaces in, the text wrapped in `cols - indent` so no row runs past the paper. subRow (the
 *  receipt's) wraps the already-indented text, which drops the indent on the first row of a line that wraps and can
 *  push a continuation past the margin; the receipt's committed bytes keep subRow as it is. */
export function indentedWrap(cols: number, text: string, indent: number): string[] {
  const pad = ' '.repeat(indent);
  return wrap(text, Math.max(1, cols - indent)).map(l => pad + l);
}

/**
 * A551: a variant option without a leading repeat of the product's name — "Chicken Burger Spicy" on "Chicken Burger" is
 * "Spicy" (case aside, the separators after the name dropped: spaces, "-", ":", ",", "/", "|"). Only a whole-word repeat:
 * "Chicken Burgers" is not "Chicken Burger" + "s". An option that does not start with the name ("Large") is kept as it is.
 */
export function variantLabel(product: string, option: string): string {
  const p = sanitize(product).trim();
  const v = sanitize(option).trim();
  const head = v.slice(0, p.length);
  if (p && head.toLowerCase() === p.toLowerCase() && !/[A-Za-z0-9]/.test(v.charAt(p.length))) {
    return v.slice(p.length).replace(/^[\s\-:,/|]+/, '').trim();
  }
  return v;
}

/**
 * A551 (owner, 2026-10-21: "why not write `Chicken burger - Spicy` we avoid 2 lines of the same item"): the product's
 * name and its variant on one line — "Chicken Burger - Spicy", "Chicken Burger - Large"; two variant groups
 * "Chicken Burger - Large, Spicy". An option that only repeats the name adds nothing ("Chicken Burger"). The caller wraps
 * it as any other name (the kitchen ticket's hanging wrap keeps the quantity column, A547).
 */
export function nameWithVariant(product: string, options: string[]): string {
  const name = sanitize(product).trim();
  const seen = new Set<string>();
  const parts = options.map(o => variantLabel(name, o)).filter(o => {
    const k = o.toLowerCase();
    if (!o || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return parts.length ? `${name} - ${parts.join(', ')}` : name;
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
