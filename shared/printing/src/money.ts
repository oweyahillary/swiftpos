/**
 * money — tax splitting and rounding for the receipt footer.
 *
 * ── WHY THE RECEIPT SHOWS A NET SUBTOTAL ─────────────────────────────────────
 * Menu prices are tax-INCLUSIVE: 890 is what the customer hands over. But the
 * receipt the owner is used to reading, and that his accountant reconciles,
 * prints the NET subtotal and adds VAT and the catering levy beneath it. So the
 * document is tax-exclusive even though the pricing is not, and every printed
 * amount is derived by dividing the gross by (1 + vat + ctl).
 *
 * ── WHY THERE IS A ROUND OFF LINE ────────────────────────────────────────────
 * That division is inexact. 435.00 / 1.18 is 368.6440678..., and once subtotal,
 * levy and VAT are each rounded to two decimals they sum to 434.99, not 435.00.
 * The Round Off line carries the missing cent. It is not a fudge — it is the
 * only honest way to print a tax-exclusive breakdown of a tax-inclusive price,
 * and without it a customer can find a one-shilling discrepancy on the paper.
 *
 * ── WHY MICROS ───────────────────────────────────────────────────────────────
 * Rounding each line to cents and then summing gives a different answer from
 * summing exactly and rounding once. The incumbent does the latter: its two
 * lines print 2754.24 and 1177.97, which add to 3932.21, but its subtotal reads
 * 3932.20. Matching that is not pedantry — a subtotal that disagrees with the
 * lines above it by a cent is exactly the kind of thing that gets a receipt
 * waved at a cashier.
 *
 * So net is carried as an INTEGER number of micro-cents (cents x 1e6) right up
 * to the moment it is printed. Integer addition is exact, so the sum of the
 * line nets is bit-identical to the net of the sum. There is no float anywhere
 * in this file.
 *
 * Safe to about 9e9 cents (90 million KES) on one order before Number loses
 * integer precision. Asserted below rather than left to chance.
 */

import type { Cents } from './types';

const MICROS = 1_000_000;
const MAX_SAFE_CENTS = 9_000_000_000;

/** Cents x 1e6. Integer. Never printed directly. */
type Micros = number;

function grossToNetMicros(gross: Cents, vatRate: number, ctlRate: number): Micros {
  // Rates arrive as percentages (16, 2) and are used in basis points so the
  // divisor is integer arithmetic rather than 1 + 0.16 + 0.02, which is not
  // representable in binary floating point.
  const rateBps = Math.round((vatRate + ctlRate) * 100);
  return Math.round((gross * MICROS * 10_000) / (10_000 + rateBps));
}

function microsToCents(m: Micros): Cents {
  return Math.round(m / MICROS);
}

export interface TaxBreakdown {
  /** Net of every line, summed exactly then rounded once. */
  subtotal: Cents;
  ctl: Cents;
  vat: Cents;
  /** total - (subtotal + ctl + vat). Usually 0 or +/- 1 cent. */
  roundOff: Cents;
  /** The gross the customer actually pays. Never derived, always passed in. */
  total: Cents;
  /** Net per line, in the order the lines were given. For the Amt column. */
  lineNets: Cents[];
}

/**
 * `lineGrosses` must sum to `total`. It is asserted rather than trusted,
 * because a receipt whose lines do not add up to its total is worse than no
 * receipt at all — it is evidence in an argument the operator will lose.
 */
export function splitTax(
  lineGrosses: Cents[],
  total: Cents,
  vatRate: number,
  ctlRate: number,
): TaxBreakdown {
  if (!Number.isInteger(total)) {
    throw new Error(`total must be integer cents, got ${total}`);
  }
  if (Math.abs(total) > MAX_SAFE_CENTS) {
    throw new Error(`total ${total} exceeds the safe integer range for micro-cent arithmetic`);
  }
  const summed = lineGrosses.reduce((a, b) => a + b, 0);
  if (summed !== total) {
    throw new Error(`line grosses sum to ${summed} but order total is ${total}`);
  }

  const netMicrosPerLine = lineGrosses.map(g => grossToNetMicros(g, vatRate, ctlRate));
  const netMicrosTotal = netMicrosPerLine.reduce((a, b) => a + b, 0);

  const subtotal = microsToCents(netMicrosTotal);
  const ctl = microsToCents(Math.round((netMicrosTotal * Math.round(ctlRate * 100)) / 10_000));
  const vat = microsToCents(Math.round((netMicrosTotal * Math.round(vatRate * 100)) / 10_000));

  return {
    subtotal,
    ctl,
    vat,
    roundOff: total - (subtotal + ctl + vat),
    total,
    lineNets: netMicrosPerLine.map(microsToCents),
  };
}

/** Net of a single gross amount, for the option delta sub-lines. */
export function netOf(gross: Cents, vatRate: number, ctlRate: number): Cents {
  return microsToCents(grossToNetMicros(gross, vatRate, ctlRate));
}

/** 89000 -> "890.00", -50 -> "-0.50", 330000 -> "3,300.00" */
export function formatCents(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = whole.toLocaleString('en-US');
  return `${neg ? '-' : ''}${grouped}.${String(frac).padStart(2, '0')}`;
}
