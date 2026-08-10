/**
 * render — an order becomes a Document for one station.
 *
 * ── ONE RENDERER, NOT THREE ──────────────────────────────────────────────────
 * Kitchen, dispatch and customer receipt are not three document types. They are
 * one document under three sets of flags. The previous code had three separate
 * builders (printReceipt, printKOT, printDispatcher) and they drifted, the same
 * way the two order endpoints on the server drifted — a fix landed in one and
 * not the others. Anything that reads as a difference between the three tickets
 * is a field on StationConfig, so a client with a bar, a grill and a cold pass
 * configures five stations and nothing here changes.
 *
 * The one place `kind` is consulted is the skeleton: a receipt carries a
 * business header and a tax footer; a production ticket carries a station
 * banner and a count. Everything inside those skeletons is flag-driven.
 *
 * ── NOTHING IS RESOLVED AT PRINT TIME ────────────────────────────────────────
 * Product names, prices, station routing and attributes all arrive on the
 * order, snapshotted at sale. A reprint of a six-month-old order reproduces the
 * paper that came out then, not what today's menu would produce.
 */

import type { PrintContext, OrderLine, OrderUnit, OrderType } from './types';
import { DocBuilder, type Document } from './document';
import { splitTax, netOf, formatCents } from './money';
import { columnsFor, center, rule, pair, pairOrStack, hangingWrap, itemRow, subRow, wrap, wrapAuthored, itemColumns } from './layout';

const TYPE_CAPS: Record<OrderType, string> = {
  takeaway: 'TAKEAWAY',
  dine_in: 'DINE IN',
  delivery: 'DELIVERY',
  counter: 'COUNTER',
};

const TYPE_TITLE: Record<OrderType, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine In',
  delivery: 'Delivery',
  counter: 'Counter',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const p2 = (n: number) => String(n).padStart(2, '0');

/** "Wed 05 Aug 19:42" — production tickets, where the day matters more than the year. */
function shortStamp(d: Date): string {
  return `${DAYS[d.getDay()]} ${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "2026-08-05 19:42:11" — receipts, which are a record. */
function fullStamp(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 16 -> "16", 2 -> "2", 16.5 -> "16.5". Never "16.00%" on a receipt. */
function rate(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * "all spicy" / "1 spicy, 2 normal" / "spicy".
 *
 * A single option covering every portion reads as "all X" when there is more
 * than one portion, and bare "X" when there is only one — "all spicy" on a
 * single burger is noise. A split lists every part, because the cook needs the
 * counts and the customer needs the record if they are charged for it.
 */
function describeAttributes(unit: OrderUnit): string {
  if (!unit.attributes.length) return '';
  const total = unit.attributes.reduce((a, x) => a + x.count, 0);
  if (unit.attributes.length === 1) {
    const only = unit.attributes[0];
    const whole = only.count >= unit.portions && unit.portions > 1;
    return whole ? `all ${only.option}` : only.option;
  }
  return unit.attributes
    .filter(a => a.count > 0)
    .map(a => (total === unit.portions ? `${a.count} ${a.option}` : `${a.count} x ${a.option}`))
    .join(', ');
}

function visibleUnits(line: OrderLine, ctx: PrintContext): OrderUnit[] {
  const { station } = ctx;
  if (station.includeUnits === 'none') return [];
  let units = line.units;
  if (station.includeUnits === 'routed') {
    units = units.filter(u => u.stationIds.includes(station.id));
  }
  if (!station.showUnchangedUnits) {
    units = units.filter(u => u.chosen || u.priceDelta !== 0 || u.attributes.length > 0);
  }
  return units;
}

/** ─── Production tickets: kitchen, dispatch, and anything shaped like them ─── */
function renderProduction(ctx: PrintContext): Document {
  const { order, station } = ctx;
  const cols = columnsFor(station.paperWidthMm);
  const d = new DocBuilder(cols);

  if (ctx.voided) {
    d.line('VOID', { align: 'center', size: 'large', bold: true });
    d.line(rule(cols));
  }

  d.line(`* * ${station.name.toUpperCase()} * *`, { align: 'center', size: 'tall', bold: true });
  d.blank();

  d.lines(pairOrStack(cols, `Order  ${order.billNumber}`, TYPE_CAPS[order.orderType]));
  d.lines(pairOrStack(cols, shortStamp(order.soldAt), `Cashier  ${order.cashierName}`));
  if (order.orderType === 'dine_in' && order.tableNumber) {
    d.line(`Table  ${order.tableNumber}`);
  }
  if (order.orderType === 'delivery' && order.deliveryPerson) {
    d.line(`Rider  ${order.deliveryPerson}`);
  }
  if (ctx.reprint) {
    d.line(`REPRINT  ${fullStamp(ctx.reprint.at)}  (#${ctx.reprint.count})`);
  }
  d.line(rule(cols));

  let unitRows = 0;
  let printedLines = 0;

  for (const line of order.lines) {
    const units = visibleUnits(line, ctx);

    // A line contributing nothing to this station is omitted entirely rather
    // than printed as an empty heading. A fryer should not read drink orders.
    //
    // A line with units earns its place through them. A FLAT line has no units,
    // so it routes on its own account — which is the only way a bottled soda
    // stays off the kitchen ticket and still reaches the packer.
    if (station.includeUnits !== 'none') {
      const earns = line.units.length > 0
        ? units.length > 0
        : station.includeUnits === 'all' || line.stationIds.includes(station.id);
      if (!earns) continue;
    }

    if (printedLines > 0) d.blank();
    printedLines++;

    // Double-width glyphs cost two columns each, so an emphasized heading has
    // half the room. The hanging indent keeps a wrapped dish name under itself
    // rather than under the quantity, which on 58mm is the difference between
    // a readable ticket and a puzzle.
    const qtyPrefix = `${line.quantity}   `;
    const headingWidth = station.emphasizeParent ? Math.floor(cols / 2) : cols;
    d.lines(
      hangingWrap(`${qtyPrefix}${line.name.toUpperCase()}`, headingWidth, qtyPrefix.length),
      { size: station.emphasizeParent ? 'tall' : 'normal', bold: true },
    );

    // A flat product with attributes but no units carries them directly.
    if (line.units.length === 0) {
      unitRows++;
      continue;
    }

    for (const u of units) {
      unitRows++;
      const attrs = describeAttributes(u);
      const qty = u.quantity > 1 ? ` x${u.quantity}` : '';
      const inline =
        station.attributeStyle === 'inline-when-simple' && attrs
          ? ` (${attrs})`
          : '';
      d.lines(subRow(cols, `${u.name}${qty}${inline}`, undefined, 6));
      if (attrs && !inline) {
        d.lines(subRow(cols, attrs, undefined, 8));
      }
    }

    if (line.note) {
      d.lines(subRow(cols, `** ${line.note}`, undefined, 6));
    }
  }

  d.line(rule(cols));

  if (station.showFooterCount) {
    const label =
      station.kind === 'kitchen'
        ? `${unitRows} items to cook`
        : `${printedLines} bags`;
    d.line(center(cols, label));
  }

  return d.build();
}

/** ─── Customer receipt ──────────────────────────────────────────────────────
 * Tax-exclusive presentation of tax-inclusive pricing: net line amounts, net
 * subtotal, levy and VAT added beneath, and a Round Off line carrying the cent
 * that the division loses. See money.ts for why that line has to exist.
 */
function renderReceipt(ctx: PrintContext): Document {
  const { order, business, station } = ctx;
  const cols = columnsFor(station.paperWidthMm);
  const c = itemColumns(cols);
  const d = new DocBuilder(cols);

  if (ctx.voided) {
    d.line('VOID', { align: 'center', size: 'large', bold: true });
    d.line(rule(cols));
  }
  if (ctx.reprint) {
    d.line('Duplicate Print', { align: 'center', size: 'tall', bold: true });
    d.line(rule(cols));
  }

  d.line(center(cols, business.name), { bold: true });
  if (business.branchName) d.line(center(cols, business.branchName));
  if (business.kraPin) d.line(center(cols, `PIN: ${business.kraPin}`));
  if (business.telephone) d.line(center(cols, `Tel: ${business.telephone}`));
  d.line(rule(cols));

  d.line(`Type: ${TYPE_TITLE[order.orderType]}`);
  d.line(rule(cols));

  d.line(`Bill No.: ${order.billNumber}`);
  if (order.orderType === 'delivery') d.line(`Delivery Boy: ${order.deliveryPerson ?? ''}`);
  if (order.orderType === 'dine_in' && order.tableNumber) d.line(`Table: ${order.tableNumber}`);
  d.line(`Cashier: ${order.cashierName}`);
  d.line(`Date: ${fullStamp(order.soldAt)}`);
  if (ctx.reprint) d.line(`RePrint T.: ${fullStamp(ctx.reprint.at)}`);
  if (ctx.voided) d.line(`Voided: ${fullStamp(ctx.voided.at)} by ${ctx.voided.by}`);
  d.line(`Kots: ${order.kotCount}`);
  d.line(rule(cols));

  d.line('Item'.padEnd(c.name) + 'Qty'.padStart(c.qty) + 'Amt'.padStart(c.amt));
  d.line(rule(cols));

  const tax = splitTax(
    order.lines.map(l => l.lineTotal),
    order.total,
    business.vatRate,
    business.ctlRate,
  );

  let totalQty = 0;

  let lastHadSubLines = false;

  order.lines.forEach((line, i) => {
    totalQty += line.quantity;

    // A blank line only where the previous item carried detail beneath it.
    // Between two bare lines it is wasted paper; after a block of options it is
    // what stops the next item's name reading as another option.
    if (lastHadSubLines) d.blank();

    // The Amt column carries the net of the BASE price. Each chosen upgrade
    // gets its own net delta beneath, so the sub-lines add to the line's net.
    const deltas = line.units.reduce((a, u) => a + u.priceDelta * u.quantity, 0);
    const baseNet = tax.lineNets[i] - netOf(deltas * line.quantity, business.vatRate, business.ctlRate);

    d.lines(itemRow(cols, line.name, String(line.quantity), formatCents(baseNet)));

    const units = visibleUnits(line, ctx);
    const before = d.length;

    // Chosen units that cost nothing and carry no choice detail are collapsed
    // onto one wrapped line — four sauces should not be four rows of paper.
    const plain: string[] = [];
    for (const u of units) {
      const attrs = describeAttributes(u);
      const delta = u.priceDelta * u.quantity;
      if (!attrs && delta === 0) { plain.push(u.name); continue; }

      if (attrs) {
        d.lines(subRow(cols, `${u.name}  ${attrs}`, undefined, 2));
      }
      if (delta !== 0 && station.showOptionPrices) {
        const net = netOf(delta * line.quantity, business.vatRate, business.ctlRate);
        d.lines(subRow(cols, u.name, formatCents(net), 2));
      } else if (delta !== 0) {
        d.lines(subRow(cols, u.name, undefined, 2));
      }
    }
    if (plain.length) d.lines(subRow(cols, plain.join(', '), undefined, 2));

    if (line.note) d.lines(subRow(cols, `** ${line.note}`, undefined, 2));

    lastHadSubLines = d.length > before;
  });

  d.line(rule(cols));
  d.line(pair(cols, 'Total Qty:', String(totalQty)));
  d.line(pair(cols, 'SubTotal:', formatCents(tax.subtotal)));
  d.line(rule(cols));
  d.line(pair(cols, `CTL (${rate(business.ctlRate)}%)`, formatCents(tax.ctl)));
  d.line(pair(cols, `VAT (${rate(business.vatRate)}%)`, formatCents(tax.vat)));
  d.line(rule(cols));
  d.line(pair(cols, 'Round Off:', formatCents(tax.roundOff)));
  d.line(pair(cols, 'Total:', formatCents(tax.total)), { bold: true });
  d.line(rule(cols));

  d.line(`PAY: ${business.currencyCode} ${formatCents(tax.total)}`, { size: 'tall', bold: true });
  d.line(rule(cols));

  d.line('Payment Detail:', { bold: true });
  d.line(rule(cols));
  for (const leg of order.payments) {
    d.line(pair(cols, leg.label.toUpperCase(), formatCents(leg.amount)));
  }
  if (order.changeGiven > 0) {
    d.line(pair(cols, 'CHANGE', formatCents(order.changeGiven)));
  }
  d.line(rule(cols));

  if (business.tillNumber) {
    d.line(`${business.tillLabel ?? 'Buy Goods'}: ${business.tillNumber}`);
    d.line(rule(cols));
  }

  // ── The footer stack ───────────────────────────────────────────────────────
  // Owner-approved arrangement, 04 Aug 2026, in this order:
  //
  //     the owner's footer box, verbatim line for line   (paybill, delivery no.)
  //     a rule — only when that box has content, so there is no orphan separator
  //     the CLOSING BLOCK: thank-you · TAX RECEIPT · Powered by SwiftPOS
  //
  // The box is the owner's; the closing block is not editable from it.
  //
  // ── WHY THE CLOSING BLOCK IS HERE AND NOT ONLY IN THE HTML RECEIPT ─────────
  // It used to live at ReceiptView.tsx:266-269, and 0.5.27 removed the HTML
  // SALE path (register D8). Two behaviours went with it and nobody noticed,
  // because the thermal renderer had never had them:
  //
  //   * the DEFAULT thank-you when the owner's box is blank. Without it an
  //     empty receipt_footer printed no thank-you AND no rule, so the receipt
  //     ended on the payment line and then "Powered by SwiftPOS" with nothing
  //     between them.
  //   * "TAX RECEIPT UPON REQUEST" whenever VAT applies. The string did not
  //     exist anywhere in this package — only in the deleted HTML component and
  //     in wrapAuthored's docstring, which uses it as its example.
  //
  // Reported from the field on 0.5.27: both lines missing above the credit.
  //
  // The VAT line is deliberately NOT taken from receipt_footer. Making a line
  // with legal meaning depend on somebody remembering to type it is how it goes
  // missing — and on this build a manager cannot type it anyway, because the
  // Receipt tab is shown on isManagerRole while the write demands
  // settings.manage and refuses (register A45).
  //
  // wrapAuthored, not wrap: the owner's box is composed text and the line
  // breaks they typed are meaning, not whitespace (P-15).
  if (business.thankYouMessage) {
    d.lines(wrapAuthored(business.thankYouMessage, cols).map(l => center(cols, l)));
  }
  if (business.deliveryMessage) {
    d.lines(wrapAuthored(business.deliveryMessage, cols).map(l => center(cols, l)));
  }
  if (business.thankYouMessage || business.deliveryMessage) d.line(rule(cols));

  // Closing block — fixed, always printed.
  d.lines(wrap(business.closingMessage ?? 'Thank you for your business!', cols)
    .map(l => center(cols, l)));

  // Only when tax actually applies. A zero-rated business printing "TAX RECEIPT
  // UPON REQUEST" is claiming something untrue on a document a customer keeps.
  if (business.vatRate > 0) {
    d.line(center(cols, 'TAX RECEIPT UPON REQUEST'));
  }

  if (business.footerCredit) d.line(center(cols, business.footerCredit));

  return d.build();
}

/**
 * Would this station's ticket contain anything worth printing?
 *
 * A production ticket for an order with nothing routed to it renders as a
 * header, a rule, and "0 items to cook". That is not an empty ticket, it is a
 * WRONG one: a kitchen handed a slip saying zero has to stop, read it, work out
 * that it means nothing, and bin it — during service. An order of two sodas
 * should produce no kitchen ticket at all.
 *
 * Receipts are exempt. A receipt with no lines still carries the total, the
 * payment and the tax, and the customer is owed it.
 *
 * Mirrors the "earns its place" rule inside renderProduction exactly. If that
 * rule ever changes, this has to change with it — which is why they sit in the
 * same file, one directly above the other.
 */
export function hasPrintableContent(ctx: PrintContext): boolean {
  const { order, station } = ctx;
  if (station.kind === 'receipt') return true;
  if (station.includeUnits === 'none') return order.lines.length > 0;

  return order.lines.some(line => {
    const units = visibleUnits(line, ctx);
    return line.units.length > 0
      ? units.length > 0
      : station.includeUnits === 'all' || line.stationIds.includes(station.id);
  });
}

export function renderTicket(ctx: PrintContext): Document {
  return ctx.station.kind === 'receipt' ? renderReceipt(ctx) : renderProduction(ctx);
}
