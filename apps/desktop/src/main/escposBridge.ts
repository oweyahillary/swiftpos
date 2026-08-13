/**
 * escposBridge.ts — turns a completed sale into a print job.
 *
 * WHY THIS FILE EXISTS
 * shared/printing renders a `Document` from its own `Order` model, which is
 * deliberately NOT the till's cart shape: it is in CENTS, it carries routing on
 * every line, and it knows nothing about SQLite. Something has to translate,
 * and that something belongs in main — the renderer must not be trusted with
 * money arithmetic it can round differently from the server.
 *
 * The ESC/POS subsystem has been complete since 7067f8d except for this: the
 * layouts, the byte encoder, the spool with its retry classification and the
 * setup screen were all built and tested, and `queueTickets()` was exported and
 * called from nowhere. Every receipt still went out through the old HTML path.
 * This is the wire.
 *
 * ── THE FEATURE FLAG ────────────────────────────────────────────────────────
 * Defaults OFF, per till.
 *
 * ESC/POS has never touched a printer. The layouts are verified against the
 * incumbent's receipts and the encoder is unit-tested, but "correct in a test"
 * and "correct on a Star TSP100 at a lunch rush" are different claims. A till
 * that prints nothing during service is worse than one that prints slowly, so
 * the old path stays default until a real service has gone through this one.
 *
 * Flip it per terminal from the Printers screen. Flipping back needs no
 * reinstall, which is the entire point: the first hardware test must not be
 * able to take the counter down.
 */
import { getLocalDb } from './localDb';
import { getDeviceConfig, saveDeviceConfig } from './deviceConfig';
import { queueTickets } from './print/printWorker';
import type { PrintContext, StationConfig, OrderLine, OrderUnit, UnitAttribute,
  PaymentLeg, OrderType } from '@swiftpos/printing';

/** Money crosses into shared/printing as integer cents, never as a float. */
const toCents = (v: unknown): number => Math.round((Number(v) || 0) * 100);

/**
 * Is thermal printing switched on for THIS terminal?
 *
 * Stored in device_config beside the other per-machine settings, because it is
 * a property of the hardware in front of the cashier, not of the business.
 * Till 1 can be proving ESC/POS while till 3 still runs the old path.
 */
export function escposEnabled(): boolean {
  try {
    const row = getLocalDb()
      .prepare(`SELECT escpos_enabled FROM device_config WHERE id = 1`)
      .get() as { escpos_enabled?: number } | undefined;
    return row?.escpos_enabled === 1;
  } catch {
    // Column absent on a till that has not migrated yet. No opinion means the
    // path that is known to work.
    return false;
  }
}

export function setEscposEnabled(on: boolean): void {
  getLocalDb()
    .prepare(`UPDATE device_config SET escpos_enabled = ?, updated_at = ? WHERE id = 1`)
    .run(on ? 1 : 0, new Date().toISOString());
}

/** Cart line as the renderer hands it over. */
interface CartLine {
  product: {
    id: string;
    name: string;
    /** Desktop products carry this. The web catalogue nests it under categories. */
    category_id?: string | null;
    categories?: { id?: string } | null;
    /** Free text. Read only when nothing better describes the item — see describeFromText. */
    description?: string | null;
  };
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  note?: string;
  selectedVariants?: Array<{ groupName?: string; optionName?: string }>;
  selectedModifiers?: Array<{ name?: string; price?: number }>;
  comboComponents?: Array<{
    name: string;
    quantity: number;
    is_kitchen?: boolean;
    /** The component's OWN category, so it can be routed like any other line. */
    category_id?: string | null;
  }>;
}

/**
 * The station ids that actually exist on this terminal, grouped by kind.
 *
 * ROUTING MUST USE REAL IDS. This is the bug that made a dispatch ticket look
 * like a kitchen ticket: the ids here were hardcoded to the strings 'kitchen'
 * and 'dispatch', while a configured station's id is a uuid from
 * print_stations. A kitchen station is `includeUnits: 'routed'` — it prints
 * only the units routed TO IT — so with ids that never matched, its filter
 * selected nothing and the ticket collapsed. Dispatch is `'all'` and ignores
 * routing entirely, which is why only one of the two looked wrong.
 *
 * Routing decisions are made by KIND ("is this cooked?", "does this go in the
 * bag?") and then mapped onto whatever ids this business actually has. That
 * works for a uuid, for the built-in fallback, and for a business with two
 * kitchen stations.
 */
interface StationIds { kitchen: string[]; dispatch: string[] }

function idsByKind(stations: StationConfig[]): StationIds {
  return {
    kitchen:  stations.filter(s => s.kind === 'kitchen').map(s => s.id),
    dispatch: stations.filter(s => s.kind === 'dispatch').map(s => s.id),
  };
}

/**
 * Which stations a line belongs to.
 *
 * Reads category_stations — the routing the business configured — and keeps
 * only ids that exist on this terminal, so a station deleted in the dashboard
 * cannot strand a line on a ticket nobody prints.
 *
 * Falls back to categories.is_kitchen when no routing is configured, which is
 * the same fallback ipcHandlers documents for stationRouting and for the same
 * reason: a till that upgrades before anyone sets up stations must keep
 * printing exactly as it did yesterday.
 */
function stationsForCategory(categoryId: string | null | undefined, ids: StationIds): string[] {
  const all = [...ids.kitchen, ...ids.dispatch];
  if (!categoryId) return ids.dispatch;

  const db = getLocalDb();
  const rows = db.prepare(
    `SELECT station_id FROM category_stations WHERE category_id = ?`
  ).all(categoryId) as Array<{ station_id: string }>;

  const configured = rows.map(r => r.station_id).filter(id => all.includes(id));
  if (configured.length) return configured;

  const cat = db.prepare(`SELECT is_kitchen FROM categories WHERE id = ?`)
    .get(categoryId) as { is_kitchen?: number } | undefined;
  return cat?.is_kitchen ? ids.kitchen : ids.dispatch;
}


/**
 * Last-resort composition, read out of the product's own description.
 *
 * WHY THIS EXISTS
 * A ticket should print the best information the menu happens to hold, and
 * different clients hold it in different places. Most restaurants type a menu
 * as flat products with a line of prose:
 *
 *     3PC Chicken Combo — "3pc chicken + cole slaw + popcorn + medium fries"
 *
 * Nobody has a reason to also enter that as structured components, so combo
 * expansion finds nothing and the kitchen gets a bare title. Requiring
 * composition data before a kitchen ticket is useful would mean every new
 * client is unusable on day one, and it would push every menu into one shape.
 *
 * So this is a CASCADE, not a replacement. Real components win when they exist,
 * because only they can route a drink to the packer and the chicken to the
 * fryer. This runs only when there is nothing better.
 *
 * WHAT IT REFUSES TO DO
 * Prose is not a component list. "Our famous crispy chicken, marinated for 24
 * hours and served with a smile" would become six meaningless lines on a ticket
 * a cook has to read at speed. The heuristics below are deliberately strict:
 * a real list has a separator, short parts, and no sentence punctuation. When
 * in doubt it returns nothing and the ticket prints the title alone, which is
 * honest.
 */
export function describeFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const raw = text.trim();
  if (!raw || raw.length > 200) return [];      // a paragraph is not a list

  // Separators people actually use, in the order they are usually meant.
  // Newlines and bullets first: someone who typed a list on separate lines
  // meant a list, whatever punctuation is inside each line.
  const SEPARATORS = [/\r?\n/, /\s*[•·]\s*/, /\s+\+\s+/, /\s*,\s*/, /\s*\/\s*/];

  for (const sep of SEPARATORS) {
    const parts = raw.split(sep).map(t => t.trim()).filter(Boolean);
    if (parts.length < 2) continue;             // no split means no list
    if (parts.length > 12) continue;            // a wall of text, not a meal

    // Every part has to look like an item, not a clause. A single long part
    // or one carrying sentence punctuation means this was prose that happened
    // to contain a comma.
    const looksLikeItems = parts.every(t =>
      t.length <= 40 && t.split(/\s+/).length <= 6 && !/[.;:!?]$/.test(t));
    if (!looksLikeItems) continue;

    return parts;
  }
  return [];
}

/**
 * Names the owner has said must never reach a kitchen ticket.
 *
 * WHY A LIST AND NOT A GUESS
 * The alternative was matching part names against keywords — "soda", "sauce",
 * "drink". That is inference, and inference here is wrong occasionally and
 * SILENTLY: the cook is the one who discovers that "Saucy Wings" got filtered
 * out, halfway through service. An owner naming their own exclusions is
 * explicit, needs no menu restructuring, and is right the first time.
 *
 * It is also the only thing that can filter the description fallback, where a
 * part is a piece of TEXT and not a product at all — nothing else in the system
 * can know that "1L soft drink" is a drink.
 *
 * Matched on whole words, case-insensitively, so "soda" catches "Soda 1.25L"
 * and "1L soda" without catching "Sodalite Special". A multi-word entry like
 * "cole slaw" is matched as a phrase.
 */
function parseTerms(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * The exclusion list this terminal's printer actually applies.
 *
 * "Local is final": a per-terminal override wins when one is set, and the synced
 * cloud baseline is used otherwise. The override is stored separately from the
 * baseline (device_config.kitchen_exclusions_override vs .kitchen_exclusions),
 * so the cloud default can keep updating underneath a local edit without ever
 * overwriting it. A NULL override — not merely an empty one — means "follow the
 * cloud"; an empty-but-present override means "this terminal excludes nothing,
 * and means it," which is a different, deliberate state.
 */
export function kitchenExclusions(): string[] {
  const cfg = getDeviceConfig() as any;
  if (cfg?.kitchen_exclusions_override != null) return parseTerms(cfg.kitchen_exclusions_override);
  return parseTerms(cfg?.kitchen_exclusions);
}

/** Effective list plus where it came from, for the setup screen. */
export function kitchenExclusionsState(): { terms: string[]; source: 'local' | 'cloud'; cloudTerms: string[] } {
  const cfg = getDeviceConfig() as any;
  const overridden = cfg?.kitchen_exclusions_override != null;
  const cloudTerms = parseTerms(cfg?.kitchen_exclusions);
  return {
    terms: overridden ? parseTerms(cfg.kitchen_exclusions_override) : cloudTerms,
    source: overridden ? 'local' : 'cloud',
    cloudTerms,
  };
}

/**
 * Set this terminal's local override — the "final" list. Available on any till,
 * cloud or local: a cloud-connected terminal can still override the business
 * default for its own printer. Stored as a JSON array (blanks dropped) so it is
 * byte-compatible with the cloud baseline and the reader above.
 */
export function setKitchenExclusions(terms: string[]): string[] {
  const cleaned = (Array.isArray(terms) ? terms : [])
    .map(t => String(t).trim())
    .filter(Boolean);
  saveDeviceConfig({ kitchen_exclusions_override: JSON.stringify(cleaned) });
  return cleaned;
}

/**
 * Drop the local override and follow the cloud baseline again. Writing NULL,
 * not an empty array, is the whole point: empty would mean "exclude nothing,
 * finally"; NULL means "I no longer have an opinion — defer to the dashboard."
 */
export function clearKitchenExclusionsOverride(): string[] {
  saveDeviceConfig({ kitchen_exclusions_override: null });
  return parseTerms((getDeviceConfig() as any)?.kitchen_exclusions);
}

export function isExcludedFromKitchen(name: string, exclusions: string[]): boolean {
  if (!name) return false;
  const hay = name.toLowerCase();
  return exclusions.some(term => {
    const t = term.trim().toLowerCase();
    if (!t) return false;
    // Whole-word / phrase match. Escaped, because an owner may reasonably type
    // "7-up" or "soda (500ml)" and a stray regex character must not throw.
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay);
  });
}

function toUnits(
  line: CartLine,
  ids: StationIds,
  /** Where the parent line is routed, so a synthesised unit follows it. */
  lineStationIds: string[],
): OrderUnit[] {
  const lineProductId = line.product.id;
  const lineName = line.product.name;
  const units: OrderUnit[] = [];

  // A combo's components are the things that get cooked and bagged; the parent
  // name is a heading. Routing therefore lives on the components.
  for (const c of line.comboComponents ?? []) {
    // A component routes on its OWN category, exactly like a top-level line.
    //
    // Using is_kitchen alone — which is what this did — means configured
    // station routing works for a plain product and silently falls back to a
    // boolean inside every combo, which on a fast-food menu is most of what
    // gets sold. ipcHandlers joins category_id into comboItems precisely so
    // this can be done properly; it just was not being read.
    //
    // is_kitchen remains the fallback for a component whose category has no
    // routing configured, and stationsForCategory already applies it.
    units.push({
      productId:  c.name,          // components arrive by name; id is not carried
      name:       c.name,
      quantity:   c.quantity,
      portions:   1,
      priceDelta: 0,
      chosen:     false,           // included as standard unless a variant says otherwise
      attributes: [],
      stationIds: c.category_id
        ? stationsForCategory(c.category_id, ids)
        : (c.is_kitchen ? ids.kitchen : ids.dispatch),
    });
  }

  // Variants describe the unit above them ("all spicy"), so they attach as
  // attributes rather than becoming units of their own — which is what makes
  // the kitchen ticket read "3PC Chicken / all spicy" and not two lines.
  // Nothing structured describes this item, so fall back to its own words.
  // Runs BEFORE variants so a described item still gets its choice attached to
  // the first part, exactly as a combo does.
  if (units.length === 0) {
    for (const part of describeFromText(line.product.description)) {
      units.push({
        productId:  part,
        name:       part,
        quantity:   1,
        portions:   1,
        priceDelta: 0,
        chosen:     false,
        // Every part follows the PARENT's routing. Text cannot tell us that a
        // soda goes to the packer and the chicken to the fryer — only real
        // components can, which is the reason to enter them and the reason
        // this stays a fallback.
        attributes: [],
        stationIds: lineStationIds,
      });
    }
  }

  const attrs: UnitAttribute[] = (line.selectedVariants ?? [])
    .filter(v => v.optionName)
    .map(v => ({
      group:      v.groupName ?? '',
      option:     v.optionName as string,
      count:      1,
      priceDelta: 0,
    }));
  if (attrs.length) {
    if (units.length) {
      // A combo: the choice describes the first component ("3PC Chicken / all
      // spicy"), which is what the verified sample shows.
      units[0].attributes = attrs;
      units[0].chosen = true;
    } else {
      // A PLAIN product with a variant — no components to hang the choice on.
      //
      // This branch did not exist, and the condition above required units to be
      // non-empty, so the whole selection was dropped. A ticket for "Chicken
      // Burger / Large / no onions" printed as the words CHICKEN BURGER and
      // nothing else: the cook could not tell what to make, and nothing
      // anywhere reported a problem.
      //
      // Synthesised as one unit named after the product, routed by the LINE's
      // own stations so it lands wherever the product itself is routed.
      units.push({
        productId:  lineProductId,
        name:       lineName,
        quantity:   1,
        portions:   1,
        priceDelta: 0,
        chosen:     true,
        attributes: attrs,
        stationIds: lineStationIds,
      });
    }
  }

  for (const m of line.selectedModifiers ?? []) {
    if (!m.name) continue;
    units.push({
      productId:  m.name,
      name:       m.name,
      quantity:   1,
      portions:   1,
      priceDelta: toCents(m.price ?? 0),
      chosen:     true,
      attributes: [],
      // A sauce or an extra is packed, not cooked.
      stationIds: ids.dispatch,
    });
  }

  return units;
}

export interface SaleForPrint {
  billNumber: string;
  orderType: string;
  cashierName: string;
  soldAt: Date;
  tableNumber?: string;
  deliveryPerson?: string;
  cart: CartLine[];
  payments: Array<{ method: string; amount: number }>;
  changeGiven: number;
  total: number;
  kotCount: number;
  /** Set on any copy after the first. Drives the Duplicate Print banner. */
  reprint?: { at: Date; count: number };
}

const ORDER_TYPES: Record<string, OrderType> = {
  dine_in: 'dine_in', takeaway: 'takeaway', delivery: 'delivery',
  retail: 'counter', counter: 'counter', fuel_sale: 'counter',
};

/**
 * Queue a completed sale to every station with a printer on this terminal.
 *
 * NEVER THROWS. It runs after the money is taken and the order is committed; a
 * printer problem must not turn a completed sale into an error on screen. The
 * spool owns retrying, and the queue view on the Printers screen owns telling
 * somebody it did not work.
 */
export function printSale(
  sale: SaleForPrint,
  business: PrintContext['business'],
  stations: StationConfig[],
  /**
   * Which kinds of ticket to queue NOW.
   *
   * Kitchen and dispatch tickets belong to the moment the order is SENT; the
   * receipt belongs to the moment it is PAID. Queuing all three at once meant a
   * restaurant's food only started cooking after the customer had settled the
   * bill — the entire point of a kitchen ticket is that it goes first.
   *
   * A counter sale has no send step, so it passes all three and everything
   * comes out together, which is correct there.
   */
  kinds: Array<'kitchen' | 'dispatch' | 'receipt'> = ['kitchen', 'dispatch', 'receipt'],
): { queued: number; skipped: string[] } {
  try {
    if (!escposEnabled()) return { queued: 0, skipped: [] };

    const targets = stations.filter(s => kinds.includes(s.kind));
    if (targets.length === 0) return { queued: 0, skipped: [] };

    // Routing is computed against ALL stations, not just the ones being printed
    // now: a line's stationIds must mean the same thing on the kitchen ticket
    // sent at order time and on any ticket produced later.
    const ids = idsByKind(stations);

    // Applied to EVERY source of units — real components, description parts and
    // synthesised variant units alike. Filtering only the text fallback would
    // mean a properly-configured menu still sent drinks to the kitchen, which is
    // the wrong way round.
    const excluded = kitchenExclusions();
    const stripKitchen = (u: OrderUnit): OrderUnit =>
      isExcludedFromKitchen(u.name, excluded)
        ? { ...u, stationIds: u.stationIds.filter(id => !ids.kitchen.includes(id)) }
        : u;

    const lines: OrderLine[] = sale.cart.map(l => ({
      name:       l.product.name,
      quantity:   l.quantity,
      stationIds: stationsForCategory(
        l.product.category_id ?? l.product.categories?.id, ids),
      unitPrice:  toCents(l.unitPrice),
      lineTotal:  toCents(l.lineTotal),
      units:      toUnits(l, ids, stationsForCategory(
        l.product.category_id ?? l.product.categories?.id, ids)).map(stripKitchen),
      note:       l.note,
    }));

    const payments: PaymentLeg[] = sale.payments.map(p => ({
      label:  p.method.toUpperCase(),
      amount: toCents(p.amount),
    }));

    const ctx: Omit<PrintContext, 'station'> = {
      business,
      reprint: sale.reprint,
      order: {
        billNumber:     sale.billNumber,
        orderType:      ORDER_TYPES[sale.orderType] ?? 'counter',
        cashierName:    sale.cashierName,
        soldAt:         sale.soldAt,
        tableNumber:    sale.tableNumber,
        deliveryPerson: sale.deliveryPerson,
        lines,
        payments,
        changeGiven:    toCents(sale.changeGiven),
        total:          toCents(sale.total),
        kotCount:       sale.kotCount,
      },
    };

    const { queued, skipped } = queueTickets([ctx], targets);
    return { queued: queued.length, skipped };
  } catch (err) {
    console.error('[escpos] printSale failed (non-blocking):', err);
    return { queued: 0, skipped: [] };
  }
}
