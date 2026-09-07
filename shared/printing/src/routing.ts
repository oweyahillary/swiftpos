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
