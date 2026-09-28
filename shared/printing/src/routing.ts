/**
 * routing — station routing + unit expansion, shared by desktop and web.
 *
 * Lifted VERBATIM from the desktop's `main/escposBridge.ts` (the proven,
 * field-tested logic) with the ONLY change being that the two SQLite reads inside
 * `stationsForCategory` become a plain `CategoryRouting` argument. Desktop builds
 * that argument from its local DB; the web builds it from the API. Same code, one
 * copy — so a kitchen ticket routes identically on both (A249, print-parity Ph2).
 *
 * Pure and browser-safe (no Node/SQLite/Electron imports), so the web can bundle
 * it exactly as it bundles the renderer.
 */
import type { OrderUnit, UnitAttribute, StationConfig } from './types';

const toCents = (v: unknown): number => Math.round((Number(v) || 0) * 100);

/** The station ids that actually exist on this terminal, grouped by kind. */
export interface StationIds { kitchen: string[]; dispatch: string[] }

/**
 * The routing tables `stationsForCategory` used to read from SQLite, passed in
 * instead. `byCategory[categoryId]` = the station ids the business configured for
 * that category (from `category_stations`); `kitchenCategories` = the set of
 * category ids whose `categories.is_kitchen` is true (the fallback).
 */
export interface CategoryRouting {
  byCategory: Record<string, string[]>;
  kitchenCategories: Set<string>;
}

/** A cart line in the minimal shape routing needs (desktop and web both map to this). */
export interface RoutableLine {
  product: {
    id: string;
    name: string;
    category_id?: string | null;
    description?: string | null;
  };
  selectedVariants?: Array<{ groupName?: string; optionName?: string }>;
  selectedModifiers?: Array<{ name?: string; price?: number }>;
  comboComponents?: Array<{
    name: string;
    quantity: number;
    is_kitchen?: boolean;
    category_id?: string | null;
  }>;
}

export function idsByKind(stations: StationConfig[]): StationIds {
  return {
    kitchen:  stations.filter(s => s.kind === 'kitchen').map(s => s.id),
    dispatch: stations.filter(s => s.kind === 'dispatch').map(s => s.id),
  };
}

/**
 * Which stations a line belongs to. Reads the configured routing; keeps only ids
 * that exist on this terminal; falls back to is_kitchen when nothing is
 * configured — identical to the desktop's SQLite version, data supplied instead.
 */
export function stationsForCategory(
  categoryId: string | null | undefined,
  ids: StationIds,
  routing: CategoryRouting,
): string[] {
  const all = [...ids.kitchen, ...ids.dispatch];
  if (!categoryId) return ids.dispatch;

  const configured = (routing.byCategory[categoryId] ?? []).filter(id => all.includes(id));
  if (configured.length) return configured;

  return routing.kitchenCategories.has(categoryId) ? ids.kitchen : ids.dispatch;
}

/** Last-resort composition read out of a product's own description. Verbatim. */
export function describeFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const raw = text.trim();
  if (!raw || raw.length > 200) return [];

  const SEPARATORS = [/\r?\n/, /\s*[•·]\s*/, /\s+\+\s+/, /\s*,\s*/, /\s*\/\s*/];

  for (const sep of SEPARATORS) {
    const parts = raw.split(sep).map(t => t.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    if (parts.length > 12) continue;

    const looksLikeItems = parts.every(t =>
      t.length <= 40 && t.split(/\s+/).length <= 6 && !/[.;:!?]$/.test(t));
    if (!looksLikeItems) continue;

    return parts;
  }
  return [];
}

/** Whole-word / phrase, case-insensitive exclusion match. Verbatim. */
export function isExcludedFromKitchen(name: string, exclusions: string[]): boolean {
  if (!name) return false;
  const hay = name.toLowerCase();
  return exclusions.some(term => {
    const t = term.trim().toLowerCase();
    if (!t) return false;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay);
  });
}

/**
 * A276 (2026-09-28): drinks never print on the KITCHEN ticket — the owner's field rule (04 Aug 2026: "sauces and soft
 * drinks NEVER appear on the KITCHEN ticket; they always appear on the dispatcher/packing ticket"), applied to WHOLE
 * lines, not only to a line's units.
 *
 * Found reading the live path (not a bench guess): both the till (escposBridge.printSale) and the web
 * (printRouted.ts) stripped kitchen stations from excluded UNITS only. A plain line — a standalone soda has no units —
 * routes by its own `stationIds`, so a soda in a category flagged for the kitchen (or mapped to the kitchen station)
 * printed there whatever the exclusions said. And those paths applied only the owner's typed terms (Printers →
 * Exclusions), never the built-in rule, which lived in the till's prose-note filter alone.
 *
 * The built-in list here is the DRINKS part of that rule. Sauces and dips are deliberately NOT applied to whole lines:
 * cooked dishes are named after their sauce ("Wings in BBQ Sauce"), and taking one of those off the kitchen ticket is
 * far worse than a stray soda. The owner's own terms apply to lines and units alike, as before for units.
 */
export const KITCHEN_DRINK_TERMS: readonly string[] = [
  'soda', 'sodas', 'soft drink', 'soft drinks', 'drink', 'drinks', 'juice', 'juices', 'water',
  'coke', 'fanta', 'sprite', 'krest', 'stoney', 'minute maid',
];

/** The terms that keep a line or unit off the kitchen: the built-in drinks plus the owner's exclusions. */
export function kitchenExclusionTerms(ownerTerms: string[] = []): string[] {
  return [...KITCHEN_DRINK_TERMS, ...ownerTerms];
}

/**
 * A358 (2026-09-28): an item that IS a sauce or dip — its name ends in "sauce(s)" / "dip(s)": "BBQ Sauce", "Honey
 * Mustard Sauce", "Garlic Dip" — never goes to the kitchen (owner, on v0.6.18: "sauces still print in kitchen printer";
 * B Foods sells them as their own items in a "Sauces" category). A dish named after its sauce stays: "Wings in BBQ
 * Sauce", "Chicken with Pepper Sauce" contain "in" / "with" before it, and a cooked dish must never leave the kitchen
 * ticket — that is why sauces are not a plain word rule like the drinks.
 */
export function isStandaloneSauce(name: string): boolean {
  const n = String(name ?? '').trim();
  if (!/(^|[^a-z0-9])(sauces?|dips?)$/i.test(n)) return false;
  return !/(^|[^a-z0-9])(in|with)([^a-z0-9])/i.test(n);
}

/**
 * `stationIds` without the kitchen stations when `name` is excluded from the kitchen (a drink or an owner term — the
 * `terms` — or a standalone sauce/dip); unchanged otherwise.
 */
export function stripKitchenIfExcluded(name: string, stationIds: string[], ids: StationIds, terms: string[]): string[] {
  return isExcludedFromKitchen(name, terms) || isStandaloneSauce(name)
    ? stationIds.filter(id => !ids.kitchen.includes(id))
    : stationIds;
}

/**
 * Expand a cart line into printable units. Verbatim from escposBridge.toUnits,
 * with `stationsForCategory` taking `routing` instead of reading SQLite.
 */
export function toUnits(
  line: RoutableLine,
  ids: StationIds,
  lineStationIds: string[],
  routing: CategoryRouting,
): OrderUnit[] {
  const lineProductId = line.product.id;
  const lineName = line.product.name;
  const units: OrderUnit[] = [];

  for (const c of line.comboComponents ?? []) {
    units.push({
      productId:  c.name,
      name:       c.name,
      quantity:   c.quantity,
      portions:   1,
      priceDelta: 0,
      chosen:     false,
      attributes: [],
      stationIds: c.category_id
        ? stationsForCategory(c.category_id, ids, routing)
        : (c.is_kitchen ? ids.kitchen : ids.dispatch),
    });
  }

  if (units.length === 0) {
    for (const part of describeFromText(line.product.description)) {
      units.push({
        productId:  part,
        name:       part,
        quantity:   1,
        portions:   1,
        priceDelta: 0,
        chosen:     false,
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
      units[0].attributes = attrs;
      units[0].chosen = true;
    } else {
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
      stationIds: ids.dispatch,
    });
  }

  return units;
}
