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
import type { PrintContext, StationConfig, OrderLine, OrderUnit,
  PaymentLeg, OrderType } from '@swiftpos/printing';
// Routing + unit expansion now live in shared/printing (A249) so web and desktop
// run ONE copy. The desktop supplies the routing tables from its local DB (A250b).
import { toUnits, stationsForCategory, idsByKind, isExcludedFromKitchen,
  type CategoryRouting } from '@swiftpos/printing';

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
/**
 * Build the routing tables the shared `stationsForCategory`/`toUnits` need, from
 * this terminal's local DB. This is the desktop half of the A249 extraction: the
 * two SQLite reads that used to live inside the private `stationsForCategory` —
 * `category_stations` (the configured routing) and `categories.is_kitchen` (the
 * fallback) — read once per sale and passed in. Same data, same fallback.
 */
function buildCategoryRouting(): CategoryRouting {
  const db = getLocalDb();
  const rows = db.prepare(
    `SELECT category_id, station_id FROM category_stations`
  ).all() as Array<{ category_id: string; station_id: string }>;
  const byCategory: Record<string, string[]> = {};
  for (const r of rows) (byCategory[r.category_id] ??= []).push(r.station_id);

  const kitchenRows = db.prepare(
    `SELECT id FROM categories WHERE is_kitchen = 1`
  ).all() as Array<{ id: string }>;

  return { byCategory, kitchenCategories: new Set(kitchenRows.map(r => r.id)) };
}

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

    // The routing tables the shared stationsForCategory/toUnits used to read from
    // SQLite themselves, now read ONCE here and passed in (A250b). Same two reads,
    // same fallback — behaviour is identical to the private version this replaces.
    const routing = buildCategoryRouting();

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
        l.product.category_id ?? l.product.categories?.id, ids, routing),
      unitPrice:  toCents(l.unitPrice),
      lineTotal:  toCents(l.lineTotal),
      units:      toUnits(l, ids, stationsForCategory(
        l.product.category_id ?? l.product.categories?.id, ids, routing), routing).map(stripKitchen),
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
