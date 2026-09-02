// productImport.ts — A165, single-upload menu importer (server side, pure).
//
// Turns one parsed import row into a PRODUCT PATCH, sparsely: it sets ONLY the
// columns the row actually carries, so a re-upload of "name + price" changes the
// price and leaves description/category/tax/etc. exactly as they were. This is
// the behaviour the old full-row importer lacked — it rebuilt the whole record,
// so any column you left out was wiped.
//
// Rules (owner-agreed):
//   • absent column OR blank cell  -> omitted from the patch (leave the field alone)
//   • the literal  DELETE          -> clears that field to null (for nullable fields)
//   • price is required only when CREATING a new product; optional on update
//   • name is the human key; a stable plu_code/barcode key is handled by the caller
//   • friendly aliases accepted: price->base_price, category->category_name
//
// PURE: no DB, no request. Category-name -> id resolution and the actual
// insert/update live in the route; this only decides what to write.

const SOLD_BY = ['each', 'weight', 'volume', 'piece'];
const SOURCE  = ['purchased', 'central_kitchen'];
const STATUS  = ['active', 'inactive'];
const TAX     = ['A', 'B', 'C', 'D', 'E'];

/** First non-empty value among aliases, trimmed; undefined if none present. */
function val(row: Record<string, any>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] != null) {
      const s = String(row[k]).trim();
      if (s !== '') return s;
    }
  }
  return undefined;
}
const isDelete = (s: string) => s.toUpperCase() === 'DELETE';
function parseBool(s: string): boolean | undefined {
  const v = s.trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(v)) return true;
  if (['no', 'n', 'false', '0'].includes(v)) return false;
  return undefined;
}

export interface PatchOpts {
  isCreate: boolean;
  /** Did the row carry a (non-blank) category column? */
  categoryProvided: boolean;
  /** Resolved category id when categoryProvided (null = uncategorised). */
  categoryId: string | null;
}
export type PatchResult = { patch: Record<string, any> } | { error: string };

export function buildProductPatch(row: Record<string, any>, opts: PatchOpts): PatchResult {
  const patch: Record<string, any> = {};

  const name = val(row, 'name');
  if (opts.isCreate && !name) return { error: 'name is required' };
  if (name) patch.name = name;

  const price = val(row, 'base_price', 'price');
  if (price !== undefined) {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0) return { error: `invalid price: ${price}` };
    patch.base_price = n;
  } else if (opts.isCreate) {
    return { error: 'price is required for a new product' };
  }

  const cost = val(row, 'cost_price');
  if (cost !== undefined) {
    if (isDelete(cost)) patch.cost_price = null;
    else {
      const n = Number(cost);
      if (!Number.isFinite(n) || n < 0) return { error: `invalid cost_price: ${cost}` };
      patch.cost_price = n;
    }
  }

  const desc = val(row, 'description');
  if (desc !== undefined) patch.description = isDelete(desc) ? null : desc;

  if (opts.categoryProvided) patch.category_id = opts.categoryId;

  const soldBy = val(row, 'sold_by');
  if (soldBy !== undefined) {
    const v = soldBy.toLowerCase();
    if (!SOLD_BY.includes(v)) return { error: `invalid sold_by: ${soldBy} (use ${SOLD_BY.join('/')})` };
    patch.sold_by = v;
  }

  const unit = val(row, 'unit_label');
  if (unit !== undefined) patch.unit_label = unit;

  const ppu = val(row, 'pieces_per_unit');
  if (ppu !== undefined) {
    const n = Number(ppu);
    if (!Number.isInteger(n) || n < 1) return { error: `invalid pieces_per_unit: ${ppu}` };
    patch.pieces_per_unit = n;
  }

  const track = val(row, 'track_stock');
  if (track !== undefined) {
    const b = parseBool(track);
    if (b === undefined) return { error: `invalid track_stock: ${track} (use yes/no)` };
    patch.track_stock = b;
  }

  const source = val(row, 'source');
  if (source !== undefined) {
    const v = source.toLowerCase();
    if (!SOURCE.includes(v)) return { error: `invalid source: ${source} (use ${SOURCE.join('/')})` };
    patch.source = v;
  }

  const kitchen = val(row, 'is_kitchen');
  if (kitchen !== undefined) {
    const b = parseBool(kitchen);
    if (b === undefined) return { error: `invalid is_kitchen: ${kitchen} (use yes/no)` };
    patch.is_kitchen = b;
  }

  const tax = val(row, 'tax_type');
  if (tax !== undefined) {
    const t = tax.toUpperCase();
    if (!TAX.includes(t)) return { error: `invalid tax_type: ${tax} (use ${TAX.join('/')})` };
    patch.tax_type = t;
  }

  const kra = val(row, 'kra_item_class_code');
  if (kra !== undefined) patch.kra_item_class_code = isDelete(kra) ? null : kra;

  const reorder = val(row, 'reorder_level');
  if (reorder !== undefined) {
    if (isDelete(reorder)) patch.reorder_level = null;
    else {
      const n = Number(reorder);
      if (!Number.isInteger(n) || n < 0) return { error: `invalid reorder_level: ${reorder}` };
      patch.reorder_level = n;
    }
  }

  const plu = val(row, 'plu_code');
  if (plu !== undefined) patch.plu_code = isDelete(plu) ? null : plu;

  const barcode = val(row, 'barcode');
  if (barcode !== undefined) patch.barcode = isDelete(barcode) ? null : barcode;

  const status = val(row, 'status');
  if (status !== undefined) {
    const v = status.toLowerCase();
    if (!STATUS.includes(v)) return { error: `invalid status: ${status} (use ${STATUS.join('/')})` };
    patch.status = v;
  }

  return { patch };
}

/** Which non-blank key a row offers, in priority order, for matching an existing
 *  product: barcode, then a stable plu_code, then the name. Lets an operator
 *  rename an item without creating a duplicate, as long as it has a code. */
export function rowMatchKeys(row: Record<string, any>): { barcode?: string; plu?: string; name?: string } {
  return {
    barcode: val(row, 'barcode'),
    plu:     val(row, 'plu_code'),
    name:    val(row, 'name'),
  };
}

// ── Upgrades & Spices tab → variant groups + options (A165 slice 2) ───────────
export interface ChoiceOption { name: string; price_adjustment: number; sort_order: number }
export interface ChoiceGroup {
  product: string;
  group: string;
  kind: 'choice' | 'upgrade';
  required: boolean;
  del: boolean;                 // true = delete this whole group
  options: ChoiceOption[];
}
export interface ChoiceImport { groups: ChoiceGroup[]; errors: { row: number; error: string }[] }

/**
 * Group the Upgrades & Spices rows by (product, group) and validate each group.
 *
 * THE RULES THAT MATTER (from the Choices editor's own model):
 *   • free (a spice/preference) → kind 'choice', and EVERY option must be 0 — a
 *     price on a free choice is a category error, not a valid value.
 *   • upgrade (a size ladder) → kind 'upgrade', and exactly one option must be 0
 *     (the included baseline). Without a 0 baseline the group would charge every
 *     customer the cheapest step — the single most damaging misconfiguration, so
 *     it's a hard error here, not a silent import.
 * An option row whose option cell is DELETE marks the whole group for removal.
 */
export function buildChoiceImport(rows: Record<string, any>[]): ChoiceImport {
  const errors: { row: number; error: string }[] = [];
  const order: string[] = [];
  const map = new Map<string, { product: string; group: string; kind?: 'choice' | 'upgrade'; del: boolean; opts: ChoiceOption[]; firstRow: number }>();

  rows.forEach((row, i) => {
    const rn = i + 1;
    const product = val(row, 'product', 'apply_to_product', 'name');
    const group   = val(row, 'group');
    const typeRaw = val(row, 'type');
    const option  = val(row, 'option');
    const priceS  = val(row, 'price_added', 'price');

    if (!product) { errors.push({ row: rn, error: 'product is required' }); return; }
    if (!group)   { errors.push({ row: rn, error: 'group is required' }); return; }

    const key = `${product.toLowerCase()}\u0000${group.toLowerCase()}`;
    if (!map.has(key)) { map.set(key, { product, group, del: false, opts: [], firstRow: rn }); order.push(key); }
    const g = map.get(key)!;

    if (option && isDelete(option)) { g.del = true; return; }
    if (!option) { errors.push({ row: rn, error: 'option is required' }); return; }

    // type: free/choice → choice ; upgrade → upgrade
    const t = (typeRaw ?? '').toLowerCase();
    const kind: 'choice' | 'upgrade' | undefined =
      (t === 'free' || t === 'choice') ? 'choice' : (t === 'upgrade' ? 'upgrade' : undefined);
    if (!kind) { errors.push({ row: rn, error: `type must be free or upgrade (got "${typeRaw ?? ''}")` }); return; }
    if (g.kind && g.kind !== kind) { errors.push({ row: rn, error: `group "${group}" has mixed types` }); return; }
    g.kind = kind;

    let price = 0;
    if (priceS !== undefined) {
      const n = Number(priceS);
      if (!Number.isFinite(n) || n < 0) { errors.push({ row: rn, error: `invalid price_added: ${priceS}` }); return; }
      price = n;
    }
    g.opts.push({ name: option, price_adjustment: price, sort_order: g.opts.length });
  });

  const groups: ChoiceGroup[] = [];
  for (const key of order) {
    const g = map.get(key)!;
    if (g.del) { groups.push({ product: g.product, group: g.group, kind: 'choice', required: true, del: true, options: [] }); continue; }
    if (!g.kind) { continue; } // only delete/blank rows — nothing to write
    if (g.opts.length === 0) { errors.push({ row: g.firstRow, error: `group "${g.group}" has no options` }); continue; }

    if (g.kind === 'choice' && g.opts.some(o => o.price_adjustment !== 0)) {
      errors.push({ row: g.firstRow, error: `free choice "${g.group}" cannot have a price — set every option to 0 or make it an upgrade` });
      continue;
    }
    if (g.kind === 'upgrade' && !g.opts.some(o => o.price_adjustment === 0)) {
      errors.push({ row: g.firstRow, error: `upgrade "${g.group}" needs one option at 0 (the included baseline)` });
      continue;
    }
    groups.push({ product: g.product, group: g.group, kind: g.kind, required: true, del: false, options: g.opts });
  }
  return { groups, errors };
}

// ── Recipe tab → recipes rows (A165 slice 2) ─────────────────────────────────
export interface RecipeLine { ingredient: string; quantity_per_serving: number; unit: string | null; notes: string | null }
export interface RecipeProduct { product: string; lines: RecipeLine[] }
export interface RecipeImport { products: RecipeProduct[]; errors: { row: number; error: string }[] }

/**
 * Group the Recipe rows by product. A product that appears in the file has its
 * recipe REPLACED by the listed lines (matching the existing per-product save);
 * a product not in the file is left alone. A line whose ingredient cell is DELETE
 * is dropped, so listing a product with a single DELETE line clears its recipe.
 */
export function buildRecipeImport(rows: Record<string, any>[]): RecipeImport {
  const errors: { row: number; error: string }[] = [];
  const order: string[] = [];
  const map = new Map<string, RecipeProduct>();

  rows.forEach((row, i) => {
    const rn = i + 1;
    const product    = val(row, 'product', 'name');
    const ingredient = val(row, 'ingredient');
    const qtyS       = val(row, 'quantity_per_serving', 'quantity', 'qty');
    const unit       = val(row, 'unit');
    const notes      = val(row, 'notes');

    if (!product) { errors.push({ row: rn, error: 'product is required' }); return; }
    const key = product.toLowerCase();
    if (!map.has(key)) { map.set(key, { product, lines: [] }); order.push(key); }
    const p = map.get(key)!;

    if (ingredient && isDelete(ingredient)) return; // drop — supports clearing a recipe
    if (!ingredient) { errors.push({ row: rn, error: 'ingredient is required' }); return; }
    if (qtyS === undefined) { errors.push({ row: rn, error: `quantity_per_serving is required for ${ingredient}` }); return; }
    const q = Number(qtyS);
    if (!Number.isFinite(q) || q <= 0) { errors.push({ row: rn, error: `invalid quantity for ${ingredient}: ${qtyS}` }); return; }

    p.lines.push({ ingredient, quantity_per_serving: q, unit: unit ?? null, notes: notes ?? null });
  });

  return { products: order.map(k => map.get(k)!), errors };
}
