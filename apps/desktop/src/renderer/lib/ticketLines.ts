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
}

export interface TicketLine {
  name: string;
  quantity: number;
  /** Variant/modifier summary, e.g. "Spicy". Empty when there is none. */
  qualifier: string;
  /** Empty for a plain product; populated for a combo. */
  components: TicketComponent[];
  /** Whether the line itself (not its components) is cooked. */
  isKitchen: boolean;
}

type CartLike = {
  product: { id: string; name: string; category_id?: string | null };
  quantity: number;
  selectedVariants?: Array<{ optionName: string }>;
  selectedModifiers?: Array<{ optionName: string }>;
};

export type ComboMap = Record<string, Array<{ name: string; quantity: number; is_kitchen: boolean }>>;

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

  return cart.map(item => {
    const components = (combos[item.product.id] ?? []).map(c => ({
      name: c.name,
      quantity: c.quantity,
      isKitchen: c.is_kitchen,
    }));
    return {
      name: item.product.name,
      quantity: item.quantity,
      qualifier: qualifierOf(item),
      components,
      isKitchen: routesToKitchen(item.product),
    };
  });
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

/** Sum of top-level quantities — the "Total Qty" footer. */
export function totalQty(lines: TicketLine[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}
