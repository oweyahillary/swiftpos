/**
 * comboStock.ts — A400: a combo (set meal) uses up what is in it (pure; stockEffects and the food-cost report call it).
 *
 * Owner, 2026-10-05: recipes and ingredient stock — "selling a Family Meal takes away its burgers, pizza dough, fries
 * and soda, so you see true food cost per item". A combo is a product with is_combo = true and its items in
 * combo_items. Before, selling one did nothing to the stock or the ingredients of what was in it — only the combo's
 * own row (usually nothing) was looked at, so every set meal sold overstated stock and hid its food cost.
 *
 * One level: an item that is itself a combo is used as a product (its own stock and recipe), not opened again — a
 * combo inside a combo is rare, and opening it could loop.
 */

export interface ComboItem { combo_id: string; product_id: string; quantity: number | string }
export interface SoldLine { productId: string | null; quantity: number; variants?: unknown[] }

/** Each combo sold adds its items (quantity × item quantity), as lines of their own; the combo line stays. */
export function expandComboLines<T extends SoldLine>(lines: T[], items: ComboItem[]): Array<T | SoldLine> {
  const byCombo = new Map<string, ComboItem[]>();
  for (const it of items ?? []) {
    if (!it?.combo_id || !it?.product_id || it.product_id === it.combo_id) continue;
    const list = byCombo.get(it.combo_id) ?? []; list.push(it); byCombo.set(it.combo_id, list);
  }
  const out: Array<T | SoldLine> = [];
  for (const l of lines) {
    out.push(l);
    const parts = l.productId ? byCombo.get(l.productId) : undefined;
    if (!parts) continue;
    for (const p of parts) {
      const q = (Number(l.quantity) || 0) * (Number(p.quantity) || 1);
      if (q > 0) out.push({ productId: p.product_id, quantity: q, variants: [] });
    }
  }
  return out;
}

/** How many of each product were used: sold on its own plus inside combos. For the ingredient side of food cost. */
export function usageWithCombos(sold: Record<string, number>, items: ComboItem[]): Record<string, number> {
  const out: Record<string, number> = { ...sold };
  for (const it of items ?? []) {
    const n = sold[it.combo_id];
    if (!n || !it.product_id || it.product_id === it.combo_id) continue;
    out[it.product_id] = (out[it.product_id] ?? 0) + n * (Number(it.quantity) || 1);
  }
  return out;
}

/** What one serving of a product costs from its recipe, and of a combo from its own recipe plus its items'. */
export function servingCost(productId: string, ownCost: Record<string, number>, items: ComboItem[]): number | null {
  let cost: number | null = ownCost[productId] ?? null;
  for (const it of items ?? []) {
    if (it.combo_id !== productId || it.product_id === productId) continue;
    const c = ownCost[it.product_id];
    if (c === undefined) continue;
    cost = (cost ?? 0) + c * (Number(it.quantity) || 1);
  }
  return cost === null ? null : Math.round(cost * 10000) / 10000;
}
