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
import { columnsFor, center, rule, pair, pairOrStack, hangingWrap, indentedWrap, itemRow, subRow, wrap, wrapAuthored, itemColumns, sanitize,
  nameWithVariant } from './layout';
import { fitMonoRaster, RECEIPT_LOGO_MAX_WIDTH, RECEIPT_LOGO_PRINT_MAX_HEIGHT } from './raster';

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

/** A530: "05/08/26 19:42" — the compact receipt's date, when the full stamp does not fit beside the cashier (58 mm). */
function compactStamp(d: Date): string {
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * A538: the receipt's standard line spacing — ESC 3 30, 30 dots (~3.76 mm at 203 dpi) for a 24-dot Font A glyph, where
 * ESC 2 gives ~34 (1/6", ~4.23 mm). A530 had 26 (~3.25 mm); on a real printer the owner (2026-10-21) found it "congested
 * everywhere" and chose "line spacing in the middle, about 3.75 mm". 'receipt_classic_spacing' still gives ESC 2.
 */
export const RECEIPT_LINE_SPACING_DOTS = 30;
/** A530: lines fed before the cut (GS V 66 0 already carries the last line to the blade) — kept by A538. */
export const COMPACT_CUT_FEED = 1;
/** A540: the thin gap between the order's info lines on the standard receipt — 10 dots, about 1.25 mm at 203 dpi. */
export const INFO_GAP_DOTS = 10;
/**
 * A543: a Font B kitchen line every 24 dots (ESC 3 24, ~3.0 mm). Font B's glyph is 17 dots tall, so ESC 2 (1/6", ~34
 * dots) would leave the same line height as Font A and save paper only where a line no longer wraps — almost nowhere
 * on a kitchen ticket. 24 leaves 7 dots (~0.9 mm) between lines: more air, for its glyph, than the receipt's standard
 * 30 gives Font A's 24 (6 dots), which the owner found right ("line spacing in the middle"). Double-height dish names
 * (34 dots) keep ESC 2, as on the receipt (escpos.ts). A551: Font B is the opt-in now ('kitchen_font_b'); the standard
 * kitchen ticket is Font A at ESC 2, like the dispatch ticket.
 */
export const KITCHEN_FONT_B_LINE_SPACING_DOTS = 24;
/**
 * A551 (owner, 2026-10-21, on paper: "reduce the spacing between item in the kitchen printer; spacing between content is
 * okay but items i feel its too big"): kitchen and dispatch tickets put a thin gap between one item and the next — ESC J
 * 10, about 1.25 mm (the receipt's A540 info gap) — instead of a blank line (ESC 2, 34 dots, ~4.2 mm). An item's own rows
 * (its name, components, attributes, notes), the header and the footer are spaced as before.
 */
export const ITEM_GAP_DOTS = 10;
/** A551 (owner: "spacing at the end of packaging and kitchen receipt"): kitchen and dispatch tickets feed 1 line before
 *  the cut, as the receipt does (A530/A538) — GS V 66 0 carries the last line to the blade. A tear-off printer (no cut)
 *  still feeds the station's feedBeforeCut (3). */
export const PRODUCTION_CUT_FEED = 1;

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

/**
 * A551 (owner, 2026-10-21: "on items with variants assume chicken burger instead of writing `Chicken burger` then
 * `  Chicken burger spicy` why not write `Chicken burger - Spicy` we avoid 2 lines of the same item"): the unit that only
 * carries a line's variant — the one toUnits (routing.ts) makes for a product sold with a variant and no components: the
 * product's own name, one of it, one portion, no price of its own, the variant options as its attributes. Its options go
 * on the line's own row ("Chicken Burger - Spicy", nameWithVariant) and the unit prints no row of its own. Any other unit
 * (a combo's component, a modifier, a split "1 spicy, 2 normal") prints as before.
 */
function variantUnit(line: OrderLine): OrderUnit | undefined {
  const key = (s: string) => sanitize(s).trim().toLowerCase();
  const name = key(line.name);
  if (!name) return undefined;
  return line.units.find(u => u.attributes.length > 0 && u.quantity === 1 && u.portions <= 1 && u.priceDelta === 0
    && key(u.name) === name);
}

/** A551: the line's printed name — with its variant when a unit carries one (variantUnit) — and that unit. */
function lineHeading(line: OrderLine): { name: string; folded?: OrderUnit } {
  const folded = variantUnit(line);
  if (!folded) return { name: line.name };
  return { name: nameWithVariant(line.name, folded.attributes.map(a => a.option)), folded };
}

/**
 * A556 (owner, on paper after A551: "YOU DID NOT DO THIS ON THE RECEIPT WE STILL HAVE TWO LINES OF THE SAME"): on the
 * CUSTOMER RECEIPT every variant choice goes on the item's own row, whatever carries it. A551's variantUnit only caught
 * the unit made for a plain product; a combo hangs its variant on the first component ("5PC Chicken Combo" then
 * "  5PC Chicken  Normal") and a described product on the first part of its description ("  Crispy fillet  Spicy") —
 * both still printed two rows. Here any unit of one, a single portion, whose choices cost nothing gives its choices to the
 * heading; the unit itself then prints no row unless it carries a price of its own (that row stays, without the choice).
 * Split portions ("1 spicy, 2 normal": portions > 1) and priced choices print as before. Kitchen and dispatch tickets
 * keep lineHeading: the cook still sees which piece of a combo the choice is for.
 */
function receiptHeading(line: OrderLine): { name: string; hidden: Set<OrderUnit>; moved: Set<OrderUnit> } {
  const options: string[] = [];
  const hidden = new Set<OrderUnit>();
  const moved = new Set<OrderUnit>();
  for (const u of line.units) {
    if (!u.attributes.length || u.quantity !== 1 || u.portions > 1 || u.attributes.some(a => a.priceDelta !== 0)) continue;
    options.push(...u.attributes.filter(a => a.count > 0).map(a => a.option));
    if (u.priceDelta === 0) hidden.add(u); else moved.add(u);
  }
  return { name: options.length ? nameWithVariant(line.name, options) : line.name, hidden, moved };
}

/** A367: a typed note as printed rows — the cashier's line breaks kept, blank lines dropped. */
function noteRows(note: string | undefined): string[] {
  return (note ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** ─── Production tickets: kitchen, dispatch, and anything shaped like them ─── */
function renderProduction(ctx: PrintContext): Document {
  const { order, station } = ctx;
  // A543 made the KITCHEN ticket Font B (64 / 42 columns, at KITCHEN_FONT_B_LINE_SPACING_DOTS). A551 (owner, 2026-10-21,
  // on paper: "kitchen receipt use the same font as the despatcher"): Font A again, the dispatch ticket's font, size and
  // columns — Font B only for a client with 'kitchen_font_b' (admin portal). Dispatch (packing) is Font A either way.
  const fontB = station.kind === 'kitchen' && ctx.business.kitchenFontB === true;
  const cols = columnsFor(station.paperWidthMm, fontB ? 'B' : 'A');
  const d = new DocBuilder(cols);
  if (fontB) d.fontB().lineSpacing(KITCHEN_FONT_B_LINE_SPACING_DOTS);
  d.cutFeed(PRODUCTION_CUT_FEED);   // A551: 1 line before the cut, not the station's 3

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
  // A367: the order's note, bold, before any dish — the cook reads it first.
  for (const ln of noteRows(order.note)) d.lines(indentedWrap(cols, `NOTE: ${ln}`, 0), { bold: true });
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

    // A551: a thin gap between two items (ITEM_GAP_DOTS), not a blank line.
    if (printedLines > 0) d.gap(ITEM_GAP_DOTS);
    printedLines++;
    const { name, folded } = lineHeading(line);   // A551: "Chicken Burger - Spicy" on one row

    // The hanging indent keeps a wrapped dish name under itself rather than
    // under the quantity, which on 58mm is the difference between a readable
    // ticket and a puzzle.
    // A551: an emphasized heading is 'tall' — GS ! 0x01, double HEIGHT only, its glyphs one column wide — so it has the
    // whole line. It used to be wrapped at half the line as if it were double width, which split "1   CHICKEN BURGER -
    // SPICY" (26 characters) over two rows on 80 mm and wasted the right half of every long dish name.
    const qtyPrefix = `${line.quantity}   `;
    const headingWidth = cols;
    d.lines(
      hangingWrap(`${qtyPrefix}${name.toUpperCase()}`, headingWidth, qtyPrefix.length),
      { size: station.emphasizeParent ? 'tall' : 'normal', bold: true },
    );

    // A flat product with attributes but no units carries them directly.
    if (line.units.length === 0) {
      unitRows++;
      // A367: its note too — this `continue` used to skip the note block below, so a plain dish lost its note.
      for (const ln of noteRows(line.note)) d.lines(indentedWrap(cols, `** ${ln}`, 6), { bold: true });
      continue;
    }

    for (const u of units) {
      unitRows++;
      if (u === folded) continue;   // A551: its variant is on the line's row
      const attrs = describeAttributes(u);
      const qty = u.quantity > 1 ? ` x${u.quantity}` : '';
      const inline =
        station.attributeStyle === 'inline-when-simple' && attrs
          ? ` (${attrs})`
          : '';
      // A547: indentedWrap keeps the 6 spaces on the first row of a component that wraps (subRow dropped them).
      d.lines(indentedWrap(cols, `${u.name}${qty}${inline}`, 6));
      if (attrs && !inline) {
        d.lines(indentedWrap(cols, attrs, 8));
      }
    }

    // A367: one row per line the cashier typed ("3 normal" / "2 spicy"), bold so it is not read as a component.
    for (const ln of noteRows(line.note)) d.lines(indentedWrap(cols, `** ${ln}`, 6), { bold: true });
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

  // A530 (owner, 2026-10-19: "I feel the receipt is too long wasting paper") made the receipt compact; A538 (owner,
  // 2026-10-21, on paper: "it feels congested everywhere — qty, subtotal, ctl, vat, roundoff — top arrangement totally
  // off") puts the classic (1.0.19) LAYOUT back as the standard at ~3.75 mm, keeping A530's small logo and 1-line feed.
  // The admin portal sets per client (shared/posFeatures.ts): receipt_compact_layout (A530's compact lines, opt-in),
  // receipt_classic_spacing, receipt_full_logo, receipt_extra_feed. Spacing + full logo + extra feed on and compact off
  // = the 1.0.19 receipt byte for byte (receipt-compact.test).
  const classic = business.receiptClassic ?? {};
  const full = classic.compactLayout !== true;     // A538: every rule and line, as before — unless the client opted in
  if (classic.spacing !== true) d.lineSpacing(RECEIPT_LINE_SPACING_DOTS);
  if (classic.extraFeed !== true) d.cutFeed(COMPACT_CUT_FEED);
  /** A rule the compact layout drops (the classic layout prints it). The five it keeps are plain d.line(rule(cols)). */
  const minorRule = () => { if (full) d.line(rule(cols)); };
  // A540 (owner, 2026-10-21, on paper: "add a small space between bill no, cashier, date, kot"): on the standard layout
  // the order's info lines (Bill No., Delivery Boy, Table, Cashier, Date, RePrint, Voided, Kots) are a thin gap apart —
  // INFO_GAP_DOTS, about 1.25 mm, not a blank line. The first of them has none above it (the rule is there).
  let infoLines = 0;
  const info = (text: string) => {
    if (full && infoLines++ > 0) d.gap(INFO_GAP_DOTS);
    d.line(text);
  };

  if (ctx.voided) {
    d.line('VOID', { align: 'center', size: 'large', bold: true });
    d.line(rule(cols));
  }
  if (ctx.reprint) {
    d.line('Duplicate Print', { align: 'center', size: 'tall', bold: true });
    d.line(rule(cols));
  }
  if (ctx.proforma) {
    d.line('BILL - NOT A RECEIPT', { align: 'center', size: 'tall', bold: true });
    d.line(rule(cols));
  }

  // A310: client logo above the name, receipts only. Nothing else in this
  // document moves — with logoRaster absent the byte stream is unchanged.
  // A530: a logo is stored up to 288 dots tall (36 mm) and prints at most 120 (15 mm) unless the client keeps the full size.
  if (business.logoRaster) {
    d.image(classic.fullLogo === true ? business.logoRaster
      : fitMonoRaster(business.logoRaster, RECEIPT_LOGO_MAX_WIDTH, RECEIPT_LOGO_PRINT_MAX_HEIGHT), 'center');
  }

  d.line(center(cols, business.name), { bold: true });
  if (business.branchName) d.line(center(cols, business.branchName));
  // Owner's custom header (address, phone, tagline…), one line per line, centred
  // — matching the on-screen ReceiptView. Blank lines dropped so a stray return
  // doesn't waste paper. This was shown on screen but never printed (register).
  if (business.header) {
    for (const ln of business.header.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      d.line(center(cols, ln));
    }
  }
  if (business.kraPin) d.line(center(cols, `PIN: ${business.kraPin}`));
  if (business.telephone) d.line(center(cols, `Tel: ${business.telephone}`));
  d.line(rule(cols));

  if (full) {
    d.line(`Type: ${TYPE_TITLE[order.orderType]}`);
    d.line(rule(cols));
    if (!ctx.proforma) info(`Bill No.: ${order.billNumber}`);   // a proforma bill carries no fiscal number
  } else if (ctx.proforma) {
    d.line(`Type: ${TYPE_TITLE[order.orderType]}`);
  } else {
    // A530: the order type and the bill number share a line — "Type: " dropped where both do not fit with it (58 mm:
    // "Takeaway      Bill No.: T1--5718"), stacked only when even that does not fit (a very long bill number).
    const bill = `Bill No.: ${order.billNumber}`;
    const labelled = `Type: ${TYPE_TITLE[order.orderType]}`;
    const type = labelled.length + 1 + sanitize(bill).length <= cols ? labelled : TYPE_TITLE[order.orderType];
    d.lines(pairOrStack(cols, type, bill));
  }
  if (order.orderType === 'delivery') info(`Delivery Boy: ${order.deliveryPerson ?? ''}`);
  if (order.orderType === 'dine_in' && order.tableNumber) info(`Table: ${order.tableNumber}`);
  if (full) {
    info(`Cashier: ${order.cashierName}`);
    info(`Date: ${fullStamp(order.soldAt)}`);
  } else {
    // A530: the cashier and the time share a line — the full stamp where it fits (80 mm), "05/08/26 19:42" where it
    // does not (58 mm), stacked under the name only when even that does not fit beside a long name.
    const who = `Cashier: ${order.cashierName}`;
    const stamp = sanitize(who).length + 1 + 19 <= cols ? fullStamp(order.soldAt) : compactStamp(order.soldAt);
    d.lines(pairOrStack(cols, who, stamp));
  }
  if (ctx.reprint) info(`RePrint T.: ${fullStamp(ctx.reprint.at)}`);
  if (ctx.voided) {
    const voided = `Voided: ${fullStamp(ctx.voided.at)} by ${ctx.voided.by}`;
    // A530: wrapped on the compact layout — on 58 mm it ran past the paper and the printer broke it where it liked.
    if (full) info(voided); else d.lines(wrap(voided, cols));
  }
  // A530: how many kitchen tickets the order made is the kitchen's business, not the customer's.
  if (full) info(`Kots: ${order.kotCount}`);
  for (const ln of noteRows(order.note)) d.lines(subRow(cols, `Note: ${ln}`, undefined, 0));   // A367
  minorRule();

  d.line('Item'.padEnd(c.name) + 'Qty'.padStart(c.qty) + 'Amt'.padStart(c.amt));
  d.line(rule(cols));

  const tax = splitTax(
    order.lines.map(l => l.lineTotal),
    order.total,
    business.vatRate,
    business.ctlRate,
    order.discount ?? 0,
  );
  const tip = Math.max(0, order.tip ?? 0);
  // 0.6.27; 0.6.33: on a free delivery the customer pays no fee (the shop pays the rider) — not printed, not in PAY.
  const deliveryFee = order.deliveryFree ? 0 : Math.max(0, order.deliveryFee ?? 0);

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

    const { name, hidden, moved } = receiptHeading(line);   // A551/A556: "Chicken Burger - Spicy" on the item's own row
    d.lines(itemRow(cols, name, String(line.quantity), formatCents(baseNet)));

    const units = visibleUnits(line, ctx).filter(u => !hidden.has(u)).map(u => (moved.has(u) ? { ...u, attributes: [] } : u));
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

    for (const ln of noteRows(line.note)) d.lines(subRow(cols, `** ${ln}`, undefined, 2));   // A367

    lastHadSubLines = d.length > before;
  });

  d.line(rule(cols));
  d.line(pair(cols, 'Total Qty:', String(totalQty)));
  // A349: the discount, net of tax like every figure above it; SubTotal is what is left, and the taxes below are on it.
  // A445: offers by name (net of tax, as the discount), then whatever of the discount was the cashier's own.
  let manualNet = tax.discount;
  if (tax.discount > 0 && order.offers?.length) {
    for (const o of order.offers) {
      const net = Math.min(manualNet, netOf(o.amount, business.vatRate, business.ctlRate));
      if (net <= 0) continue;
      manualNet -= net;
      d.line(pair(cols, `${o.name.slice(0, Math.max(8, cols - 14))}:`, `-${formatCents(net)}`));
    }
  }
  if (manualNet > 0) d.line(pair(cols, 'Discount:', `-${formatCents(manualNet)}`));
  d.line(pair(cols, 'SubTotal:', formatCents(tax.subtotal)));
  minorRule();
  // A349: the levy only where it is levied — a business without CTL no longer prints "CTL (0%) 0.00".
  if (business.ctlRate > 0 || tax.ctl !== 0) d.line(pair(cols, `CTL (${rate(business.ctlRate)}%)`, formatCents(tax.ctl)));
  d.line(pair(cols, `VAT (${rate(business.vatRate)}%)`, formatCents(tax.vat)));
  minorRule();
  // A530: "Round Off: 0.00" says nothing — printed only when the cent is really there. A540 (owner, 2026-10-21: "if round
  // off is 0.00 hide it"): on the standard receipt too.
  if (tax.roundOff !== 0) d.line(pair(cols, 'Round Off:', formatCents(tax.roundOff)));
  // A530: with no tip and no delivery fee the Total IS what PAY says — the tall PAY line alone carries it. With either,
  // Total (the bill, what the taxes are on), then the extras, then PAY (what the customer hands over).
  if (full || tip > 0 || deliveryFee > 0) d.line(pair(cols, 'Total:', formatCents(tax.total)), { bold: true });
  // A349: a tip is not a sale and carries no tax — shown after the total, and the customer pays both.
  if (tip > 0) d.line(pair(cols, 'Tip:', formatCents(tip)));
  // 0.6.27: the delivery fee — like the tip, on top of the bill and outside its taxes.
  if (deliveryFee > 0) d.line(pair(cols, 'Delivery fee:', formatCents(deliveryFee)));
  else if (order.deliveryFree && order.orderType === 'delivery') d.line(pair(cols, 'Delivery:', 'FREE'));
  d.line(rule(cols));

  d.line(`PAY: ${business.currencyCode} ${formatCents(tax.total + tip + deliveryFee)}`, { size: 'tall', bold: true });
  minorRule();

  // A498 (owner, 2026-10-15, a printed receipt: "the payment method is printing on the wrong place … check where payment
  // detail is printed and where buy good is printed"): ONE block — the number customers pay to, straight above the
  // payments, inside the block, before its rule. A530: no heading on the compact receipt — the payment lines straight
  // under PAY say what they are. A539 put the number in a "Payment Details: Buy Goods - 892984" heading, then a rule.
  // A551 (owner, 2026-10-21, on paper: "we just write `PAY BILL/BUY GOODS:` newline `123445` and we center it and increase
  // the font size and thickness, We remove the wordings payment details"): the standard receipt prints the label alone
  // ("BUY GOODS:" / "PAYBILL:"), then the number, each centred, double size and bold; a Paybill's account under them in
  // normal size ("Account: WEST1", A492's ", Account " split); then the rule and the payments as before. No number, no
  // heading (and no rule of its own — the one under PAY is there). Double width halves the line (24 on 80 mm, 16 on 58 mm):
  // when the label or the number does not fit in it, both print double height only. The compact opt-in keeps A530's block.
  if (full && business.tillNumber?.trim()) {
    const label = `${sanitize(business.tillLabel ?? '').trim().toUpperCase() || 'BUY GOODS'}:`;
    const raw = sanitize(business.tillNumber).trim();
    const cut = raw.indexOf(', Account ');
    const number = cut > 0 ? raw.slice(0, cut).trim() : raw;
    const account = cut > 0 ? raw.slice(cut + ', Account '.length).trim() : '';
    // A557 (owner, on paper: "reduce the font size of paybil abit"): double HEIGHT only (GS ! 0x01) — the glyphs keep the
    // normal width, a step down from A551's double size. ESC/POS has no sizes in between; bold and centred as before.
    for (const t of [label, number]) d.lines(wrap(t, cols), { align: 'center', size: 'tall', bold: true });
    if (account) d.lines(wrap(`Account: ${account}`, cols), { align: 'center' });
    d.line(rule(cols));
  }
  for (const leg of order.payments) {
    d.line(pair(cols, leg.label.toUpperCase(), formatCents(leg.amount)));
  }
  if (order.changeGiven > 0) {
    d.line(pair(cols, 'CHANGE', formatCents(order.changeGiven)));
  }
  if (!full && business.tillNumber) {
    const payLine = `${business.tillLabel ?? 'Buy Goods'}: ${business.tillNumber}`;
    // A Paybill's account ("4098201, Account WEST1", A492) goes on its own line when the line is wider than the paper.
    const cut = payLine.indexOf(', Account ');
    if (payLine.length > cols && cut > 0) { d.line(payLine.slice(0, cut)); d.line(payLine.slice(cut + 2)); }
    else d.line(payLine);
  }
  d.line(rule(cols));

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
  // A530: on the compact receipt the owner's box runs straight into the closing block (one rule above both, not two).
  if (full && (business.thankYouMessage || business.deliveryMessage)) d.line(rule(cols));

  // Closing block — fixed, always printed, EXCEPT its thank-you line when the
  // owner already wrote it (A315). The owner's box is printed verbatim above,
  // so if any authored line of it — or of the delivery box, which prints in the
  // same block — IS the closing line (case and surrounding whitespace aside),
  // printing it again gives the customer the same sentence twice. Seen on paper
  // on the XP-80, 2026-09-22; the web POS hits it on every receipt from a
  // business with no receipt_footer, because its per-device footerMessage
  // defaults to exactly this phrase. Whole-line equality, never "starts with":
  // a longer owner sentence that merely begins with these words is a different
  // line, and suppressing on it would leave no thank-you at all. The TAX line
  // and the credit below are never suppressed — they are not the owner's to
  // replace.
  const closing = business.closingMessage ?? 'Thank you for your business!';
  if (!ownerAlreadySays(closing, business.thankYouMessage, business.deliveryMessage)) {
    d.lines(wrap(closing, cols).map(l => center(cols, l)));
  }

  // Only when tax actually applies. A zero-rated business printing "TAX RECEIPT
  // UPON REQUEST" is claiming something untrue on a document a customer keeps.
  if (business.vatRate > 0) {
    d.line(center(cols, 'TAX RECEIPT UPON REQUEST'));
  }

  if (business.footerCredit) d.line(center(cols, business.footerCredit));

  return d.build();
}

/** A315: does any authored line of the owner's boxes equal `line`? Compared as
 *  printed (sanitize maps smart quotes etc. to the code page), trimmed, and
 *  case-insensitive. Private: the test drives renderTicket and reads the paper. */
function ownerAlreadySays(line: string, ...boxes: (string | undefined)[]): boolean {
  const norm = (s: string) => sanitize(s).trim().toLowerCase();
  const want = norm(line);
  if (!want) return false;
  return boxes.some(box => !!box && box.split(/\r?\n/).some(l => norm(l) === want));
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
