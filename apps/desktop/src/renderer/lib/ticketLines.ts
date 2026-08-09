/**
 * ticketLines — turns cart lines into the rows a production ticket prints.
 *
 * The till sells a combo as ONE line (one product, one price, optionally one
 * Spice variant). The customer receipt shows exactly that. But the two
 * production tickets need the components:
 *
 *   Dispatcher — everything, so the packer can assemble the box
 *   Kitchen    — only what is cooked, so the fryer isn't reading drink orders
 *
 * Component quantities are PER COMBO, matching how the incumbent system prints
 * them: "2  Kanka Combo [ 3: Chicken Burger ... ]" means each of the two combos
 * contains three burgers. Deliberately not multiplied out — the kitchen reads
 * the combo count and the recipe, and pre-multiplying invites double-cooking.
 *
 * Spice sits on the combo line rather than repeated onto each component. The
 * incumbent prints it per component, but it is a single all-or-nothing choice
 * at the till — a customer cannot have a spicy burger and a normal tender in the
 * same combo. Putting it on the parent says the same thing once, and avoids
 * stamping "spicy" onto components that don't come spicy at all.
 */

export interface TicketComponent {
  name: string;
  quantity: number;
  isKitchen: boolean;
  /** Stations this component prints at. Empty when routing is unconfigured. */
  stationIds: string[];
}

export interface TicketLine {
  name: string;
  quantity: number;
  /** Variant/modifier summary, e.g. "Spicy". Empty when there is none. */
  qualifier: string;
  /** Empty for a plain product; populated for a combo. */
  components: TicketComponent[];
  /**
   * Prep detail for the KITCHEN ticket, ITEMIZED: the product's description
   * split into one line per item, rendered in the same indented style as
   * combo components (which the sample test ticket demonstrates). Exists for
   * flat products whose composition lives in prose — honest limit: prose
   * cannot be filtered, so a drink named in it stays. Structured
   * kitchen-vs-packing separation is what COMBOS are for.
   */
  noteLines?: string[];
  /** Whether the line itself (not its components) is cooked. */
  isKitchen: boolean;
  /** Stations this line prints at. Empty when routing is unconfigured. */
  stationIds: string[];
}

type CartLike = {
  product: { id: string; name: string; category_id?: string | null; description?: string | null; is_kitchen?: boolean | number | null };
  quantity: number;
  selectedVariants?: Array<{ optionName: string }>;
  selectedModifiers?: Array<{ optionName: string }>;
};

export type ComboMap = Record<string, Array<{
  name: string; quantity: number; is_kitchen: boolean;
  product_id?: string; category_id?: string | null;
}>>;

/**
 * Category → station ids, plus the stations themselves.
 *
 * `stations` EMPTY means routing is not configured, and every function here falls
 * back to the old is_kitchen behaviour. That fallback matters more than the
 * feature: a till upgrading before anyone has created a station must print
 * exactly as it did yesterday. Anything else means a kitchen receiving nothing,
 * discovered mid-service.
 */
export interface StationRouting {
  stations: Array<{ id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt'; sort_order: number }>;
  byCategory: Record<string, string[]>;
}

export const ROUTING_UNCONFIGURED: StationRouting = { stations: [], byCategory: {} };

/** True when stations are set up and should decide routing. */
export function routingIsConfigured(r?: StationRouting | null): boolean {
  return !!r && r.stations.length > 0;
}

function qualifierOf(item: CartLike): string {
  return [
    ...(item.selectedVariants ?? []).map(v => v.optionName),
    ...(item.selectedModifiers ?? []).map(m => m.optionName),
  ].filter(Boolean).join(', ');
}

/** All lines, combos expanded. Used by the dispatcher ticket. */
export function buildTicketLines(
  cart: CartLike[],
  combos: ComboMap,
  kitchenCategoryIds: string[],
  routing: StationRouting = ROUTING_UNCONFIGURED,
): TicketLine[] {
  const kitchenSet = new Set(kitchenCategoryIds);

  /**
   * Does this product get cooked?
   *
   * A product-level override beats its category; absent one, the category
   * decides. Written as an explicit typeof check rather than `??` because the
   * override is a TRI-STATE — an explicit `false` has to beat a kitchen
   * category, and `??` would only catch null/undefined, letting a deliberate
   * "never cook this" fall through to "yes, cook it".
   *
   * SQLite has no booleans, so a value pulled from the local catalogue arrives
   * as 1 / 0 / null. Both shapes are handled here rather than at the call site.
   */
  const routesToKitchen = (product: any): boolean => {
    const override = product?.is_kitchen;
    if (override === true  || override === 1) return true;
    if (override === false || override === 0) return false;
    return product?.category_id ? kitchenSet.has(product.category_id) : false;
  };

  /** Stations a category prints at. Empty when unconfigured or unrouted. */
  const stationsForCategory = (categoryId?: string | null): string[] =>
    categoryId ? (routing.byCategory[categoryId] ?? []) : [];

  return cart.map(item => {
    const components = (combos[item.product.id] ?? []).map(c => ({
      name: c.name,
      quantity: c.quantity,
      isKitchen: c.is_kitchen,
      stationIds: stationsForCategory(c.category_id),
    }));
    return {
      name: item.product.name,
      quantity: item.quantity,
      qualifier: qualifierOf(item),
      components,
      // Only when the product has no structured components — a combo's ticket
      // already lists exactly what to make, and prose under it would compete.
      noteLines: components.length === 0 ? parseDescriptionLines(item.product.description) : undefined,
      isKitchen: routesToKitchen(item.product),
      stationIds: stationsForCategory(item.product.category_id),
    };
  });
}

/**
 * The lines one station should print.
 *
 * Mirrors kitchenOnly's shape: a combo appears when ANY of its components route
 * here, carrying only those components. A packing station therefore gets the whole
 * order while the grill gets the same order minus the drinks — which is the point
 * of stations, and what a single is_kitchen flag could never express.
 *
 * Falls back to kitchenOnly when routing is unconfigured, so a till that upgrades
 * before stations are created keeps printing exactly as it did before.
 */
export function linesForStation(
  lines: TicketLine[],
  stationId: string,
  routing: StationRouting = ROUTING_UNCONFIGURED,
): TicketLine[] {
  if (!routingIsConfigured(routing)) return kitchenOnly(lines);

  return lines
    .map(l => {
      if (l.components.length === 0) return l;
      return { ...l, components: l.components.filter(c => c.stationIds.includes(stationId)) };
    })
    .filter(l =>
      l.components.length > 0
      // A plain product with no components prints when the line itself routes
      // here. A combo whose components ALL routed elsewhere is dropped entirely
      // rather than printed as a bare name — a ticket saying "3PC Combo" with no
      // contents tells the kitchen nothing and invites a guess.
      || (l.components.length === 0 && l.stationIds.includes(stationId)));
}

/**
 * Kitchen view: only what gets cooked.
 *
 * A combo is kept when ANY component is cooked, and its component list is
 * filtered to just those — so a Kanka Combo appears with its burger and tenders
 * but without the Coca-Cola. A combo whose components are all non-kitchen (a
 * drinks bundle, say) drops out entirely rather than printing an empty bracket.
 */
export function kitchenOnly(lines: TicketLine[]): TicketLine[] {
  return lines
    .map(l => {
      if (l.components.length === 0) return l;
      return { ...l, components: l.components.filter(c => c.isKitchen) };
    })
    .filter(l => (l.components.length > 0) || (l.components.length === 0 && l.isKitchen));
}

/**
 * Split a flat product's prose description into itemized prep lines.
 * Separators, in order of trust: newlines, then commas/semicolons/bullets.
 * "3pc chicken, 2 fries, 1 soda 500ml" → three lines, exactly as a combo's
 * components print. Capped so a paragraph-length marketing description cannot
 * eat half a ticket; empty result = undefined = nothing rendered.
 */
export function parseDescriptionLines(description?: string | null): string[] | undefined {
  const raw = String(description ?? '').trim();
  if (!raw) return undefined;
  // '+' is a first-class separator: the Kudo menu writes components as
  // "5pc chicken + cole slaw + medium fries" — exactly the list a kitchen
  // ticket itemizes.
  const parts = (raw.includes('\n') ? raw.split(/\r?\n/) : raw.split(/[,;•·+]+/))
    .map(p => p.trim().replace(/^[-–—*+]\s*/, ''))
    .filter(Boolean)
    .slice(0, 8)
    .map(p => p.slice(0, 60));
  return parts.length ? parts : undefined;
}

/**
 * ⚠ OWNER RULE — FIELD-APPROVED 04 Aug 2026. DO NOT MODIFY without explicit
 * owner sign-off: sauces and soft drinks NEVER appear on the KITCHEN ticket;
 * they always appear on the dispatcher/packing ticket. This list is that rule.
 */
export const KITCHEN_NOTE_EXCLUDE =
  /\b(sauces?|dips?|soft\s*drinks?|sodas?|drinks?|juices?|water|coke|fanta|sprite|krest|stoney|minute\s*maid)\b/i;

/**
 * The prep lines the KITCHEN sees: everything except the owner-excluded terms.
 * `extraTerms` is the owner's own list (Printers → Kitchen exclusions, one
 * term per line) — matched case-insensitively as substrings, ON TOP of the
 * built-in rule, never instead of it. This is how "some more items" get
 * excluded next month without a code change.
 */
export function kitchenPrepLines(noteLines?: string[], extraTerms?: string): string[] {
  const extras = String(extraTerms ?? '')
    .split(/\r?\n/).map(t => t.trim().toLowerCase()).filter(Boolean);
  return (noteLines ?? []).filter(l =>
    !KITCHEN_NOTE_EXCLUDE.test(l)
    && !extras.some(t => l.toLowerCase().includes(t)));
}

/** Sum of top-level quantities — the "Total Qty" footer. */
export function totalQty(lines: TicketLine[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}
