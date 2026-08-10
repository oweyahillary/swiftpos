/**
 * types — the contract between the POS and the printer.
 *
 * Nothing here imports from the existing print code. The old path rendered HTML
 * and handed it to a browser or a shelled-out PowerShell command; this one
 * builds bytes. Sharing a type with the old path would drag the old shape along
 * with it, so this file starts from the order and nothing else.
 *
 * MONEY IS INTEGER CENTS, EVERYWHERE.
 * A `Cents` is a whole number of the smallest currency unit. 890.00 KES is
 * 89000. There is no float arithmetic on money anywhere in this package, and no
 * value crosses this boundary as a string. The one unavoidable exception is the
 * NET figure, which is a division and therefore inexact — see money.ts, which
 * documents exactly where that rounding happens and why the receipt carries a
 * Round Off line to absorb it.
 */

export type Cents = number;

/** ─── What the customer chose ──────────────────────────────────────────────
 * An attribute is a free or priced choice on a unit — Spice: Spicy. It carries
 * a count because a 3PC Chicken can be 1 spicy and 2 normal, so the counts
 * across one group sum to the unit's portion count.
 */
export interface UnitAttribute {
  group: string;
  option: string;
  /** How many portions of the unit carry this option. */
  count: number;
  priceDelta: Cents;
}

/**
 * A unit is one component of a sold line, resolved at sale time: a real
 * catalogue product with its own name, its own quantity, and its own routing.
 * A flat product sold on its own has no units at all.
 *
 * `stationIds` is FROZEN AT SALE TIME, not resolved at print time. A reprint of
 * a six-month-old order must produce the paper that came out then, not the
 * paper today's category routing would produce.
 */
export interface OrderUnit {
  productId: string;
  /** Snapshot. Never look this up live. */
  name: string;
  /** How many of this product. */
  quantity: number;
  /** How many individually-choosable portions one unit contains. 3PC Chicken = 3. */
  portions: number;
  /** 0 when included as standard; positive when the customer paid to change it. */
  priceDelta: Cents;
  /** True when the customer actively picked this, whether or not it cost anything. */
  chosen: boolean;
  attributes: UnitAttribute[];
  stationIds: string[];
}

export interface OrderLine {
  /** Snapshot of the sellable item's name. */
  name: string;
  quantity: number;
  /**
   * Where the LINE ITSELF routes, for a flat product that has no units — a
   * bottled soda routes to dispatch and must not reach the fryer. For a line
   * that does have units, routing is carried by the units and this is ignored:
   * a combo's parent name is a heading, not something anyone cooks.
   */
  stationIds: string[];
  /** Gross, tax-inclusive, for ONE of this line before any unit deltas. */
  unitPrice: Cents;
  /** Gross, tax-inclusive, for the whole line INCLUDING unit deltas. */
  lineTotal: Cents;
  units: OrderUnit[];
  /** Free-text kitchen note the cashier typed. */
  note?: string;
}

export type OrderType = 'takeaway' | 'dine_in' | 'delivery' | 'counter';

export interface PaymentLeg {
  /** Shown verbatim in the Payment Detail block. */
  label: string;
  amount: Cents;
}

export interface Order {
  billNumber: string;
  orderType: OrderType;
  cashierName: string;
  /** When the sale happened. NOT when it synced, and NOT when it printed. */
  soldAt: Date;
  tableNumber?: string;
  deliveryPerson?: string;
  lines: OrderLine[];
  payments: PaymentLeg[];
  changeGiven: Cents;
  /** Gross tax-inclusive total actually charged. The source of truth. */
  total: Cents;
  /** How many kitchen tickets this order produced, for the Kots line. */
  kotCount: number;
}

/** ─── Configuration ────────────────────────────────────────────────────────
 * Every field the operator can set. A field left undefined does not print — the
 * line disappears entirely rather than printing an empty label.
 */
export interface BusinessConfig {
  name: string;
  branchName?: string;
  kraPin?: string;
  telephone?: string;
  /** Label and value are separate so a Paybill client is not stuck saying "Buy Goods". */
  tillLabel?: string;
  tillNumber?: string;
  thankYouMessage?: string;
  deliveryMessage?: string;
  /**
   * The fixed closing line above the tax line and the credit. Defaults to
   * "Thank you for your business!" when absent — it is deliberately NOT the
   * owner's editable footer box (that is thankYouMessage), so a blank box never
   * produces a receipt that ends on the payment line.
   */
  closingMessage?: string;
  footerCredit?: string;
  currencyCode: string;
  /** As a percentage, e.g. 16 for 16%. */
  vatRate: number;
  ctlRate: number;
}

export type StationKind = 'kitchen' | 'dispatch' | 'receipt';

/**
 * How a station renders. These are FLAGS, not three hardcoded document types —
 * a client with a bar, a grill and a cold pass configures five stations off the
 * same struct and no code changes.
 */
export interface StationConfig {
  id: string;
  name: string;
  kind: StationKind;
  paperWidthMm: 58 | 80;

  /** 'routed' = units whose stationIds include this station.
   *  'all'    = every unit on the order, regardless of routing.
   *  'none'   = parent lines only; units are not listed. */
  includeUnits: 'routed' | 'all' | 'none';

  showPrices: boolean;
  /** Print units the customer did NOT change. Dispatch wants them; a receipt does not. */
  showUnchangedUnits: boolean;
  /** Per-unit price deltas beneath the parent line. */
  showOptionPrices: boolean;
  /** Double-height the sellable item's name. */
  emphasizeParent: boolean;
  /** Collapse identical units across different lines into one row. */
  aggregateUnits: boolean;
  /** The "5 items to cook" / "3 bags" line. */
  showFooterCount: boolean;

  /** 'inline-when-simple' puts a single whole-unit attribute on the item's own
   *  line and only breaks to a sub-line when the choice is split across
   *  portions. 'always-sublines' never does. */
  attributeStyle: 'inline-when-simple' | 'always-sublines';

  openCashDrawer: boolean;
  cutPaper: boolean;
  /** Blank lines fed before the cut so the tear-off clears the print head. */
  feedBeforeCut: number;
}

export interface PrintContext {
  order: Order;
  business: BusinessConfig;
  station: StationConfig;
  /** Set on any copy after the first. Drives the Duplicate Print banner. */
  reprint?: { at: Date; count: number };
  /** Set when the order was voided. Drives the VOID layout. */
  voided?: { at: Date; by: string; reason?: string };
}
