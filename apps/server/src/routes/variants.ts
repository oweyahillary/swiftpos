import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, can } from '../middleware/rbac';
import { idsOfBusiness } from '../lib/branchGuard';   // A494
import { supabase } from '../lib/supabase';
import { buildChoiceImport, importKey } from '../lib/productImport';
import { tillChoiceGroups } from '../lib/choiceGroups';   // A591

const router = safeRouter();
router.use(requireAuth);

// Normalise a variant option's stock-impact fields (Track C). An option carries
// at most ONE stock target: a scale factor, a linked product, or a linked
// ingredient. Empties coerce to safe defaults; product wins if both links given.
/**
 * A494: what an option's price change needs. A price is what the customer pays — changing one is menu.prices (as a
 * product's price is), not menu.edit; a negative one is refused (it would be a discount nobody approved, as a negative
 * product price is — routes/products.ts). `changes` are [old, new] pairs (old null for a new option).
 * Returns the refusal, or null.
 */
function priceRefusal(req: any, changes: Array<[unknown, unknown]>): { status: number; body: Record<string, unknown> } | null {
  for (const [, next] of changes) {
    if (next === undefined) continue;
    const n = Number(next);
    if (next === null || next === '' || !Number.isFinite(n) || n < 0) return { status: 400, body: { error: 'A price cannot be negative.' } };
  }
  const changed = changes.some(([was, next]) => next !== undefined && Number(next) !== Number(was ?? 0));
  if (changed && !can(req, 'menu.prices')) return { status: 403, body: { error: 'Forbidden', detail: 'Missing permission: menu.prices' } };
  return null;
}

/** A494: the product / ingredient an option takes stock from must be this business's. */
async function linksOk(businessId: string, opts: any[]): Promise<boolean> {
  const prods = opts.map((o) => o?.linked_product_id).filter(Boolean);
  const ings = opts.map((o) => o?.linked_ingredient_id).filter(Boolean);
  return (await idsOfBusiness('products', businessId, prods)) && (await idsOfBusiness('ingredients', businessId, ings));
}

function stockFields(o: any): {
  stock_factor: number;
  linked_product_id: string | null;
  linked_ingredient_id: string | null;
  deduct_qty: number;
} {
  const factor = Number(o?.stock_factor);
  const dq     = Number(o?.deduct_qty);
  const prod   = o?.linked_product_id || null;
  const ing    = prod ? null : (o?.linked_ingredient_id || null); // product XOR ingredient
  return {
    stock_factor:         Number.isFinite(factor) && factor > 0 ? factor : 1,
    linked_product_id:    prod,
    linked_ingredient_id: ing,
    deduct_qty:           Number.isFinite(dq) && dq > 0 ? dq : 1,
  };
}

// ── Variant Groups ──────────────────────────────────────────

// POST /api/variants/bulk — A165 slice 2. Import the Upgrades & Spices tab.
// Body: { rows: [{ product, group, type(free|upgrade), option, price_added }] }
// Name-keyed by product; an uploaded (product, group) REPLACES that group's
// options wholesale and sets its kind from `type`. option=DELETE removes the group.
router.post('/bulk', requirePermission('menu.bulk'), async (req, res) => {   // A595: many items at once (menu.bulk)
  const { rows } = req.body ?? {};
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: 'rows array is required' }); return; }
  if (rows.length > 2000) { res.status(400).json({ error: 'Maximum 2000 rows per import' }); return; }

  const { groups, errors } = buildChoiceImport(rows);
  // A494: an imported option with a price sets a price — menu.prices (the parser already refuses a negative one).
  if (groups.some((g) => g.options.some((o) => Number(o.price_adjustment) !== 0)) && !can(req, 'menu.prices')) {
    res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: menu.prices (the file sets option prices)' }); return;
  }
  const results = { created: 0, updated: 0, deleted: 0, merged: 0, errors: [...errors] as { row: number; error: string }[] };

  // Resolve products (name or plu) within this business only — variant_groups
  // have no business_id, so scoping is via the owning product.
  // 2026-10-04: names compared on importKey; an ACTIVE product wins over an archived one of the same name (the same
  // rule as the Products tab), so the choices land on the product the owner sees.
  const prods: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: pErr } = await supabase
      .from('products').select('id, name, plu_code, status, created_at').eq('business_id', req.businessId)
      .order('created_at', { ascending: true }).range(from, from + 999);
    if (pErr) { sendError(res, pErr); return; }
    prods.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  prods.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
  const byName: Record<string, string> = {};
  const byPlu: Record<string, string> = {};
  for (const p of prods) {
    const n = importKey(p.name);
    const pl = importKey(p.plu_code);
    if (n && !(n in byName)) byName[n] = p.id;
    if (pl && !(pl in byPlu)) byPlu[pl] = p.id;
  }

  for (const g of groups) {
    const productId = byPlu[importKey(g.product)] || byName[importKey(g.product)];
    if (!productId) { results.errors.push({ row: 0, error: `unknown product: ${g.product}` }); continue; }

    // 2026-10-04 (owner: "the variants were added on the same product which were there"): the group was looked up by
    // its EXACT name with maybeSingle — "Drink size" ≠ "Drink Size", and once a product held two groups of one name
    // maybeSingle errored, read as "none", and every upload added ANOTHER. Now: this product's own groups (not a
    // shared or combo-component one), matched on importKey; the oldest is kept and any copies an earlier upload left
    // are removed (their options go with them) — a re-upload heals the duplicates instead of adding to them.
    const { data: own, error: gErr } = await supabase
      .from('variant_groups').select('id, name, shared, combo_item_id, created_at')
      .eq('product_id', productId).order('created_at', { ascending: true });
    if (gErr) { results.errors.push({ row: 0, error: `${g.product}/${g.group}: ${gErr.message}` }); continue; }
    const same = ((own ?? []) as any[]).filter((x) => !x.shared && !x.combo_item_id && importKey(x.name) === importKey(g.group));
    const existing = same[0] ?? null;
    for (const dup of same.slice(g.del ? 0 : 1)) {
      await supabase.from('variant_options').delete().eq('variant_group_id', dup.id);
      await supabase.from('variant_groups').delete().eq('id', dup.id);
      if (g.del) results.deleted++; else results.merged++;
    }

    if (g.del) continue;

    let groupId: string;
    if (existing) {
      await supabase.from('variant_groups').update({ kind: g.kind, required: g.required }).eq('id', existing.id);
      await supabase.from('variant_options').delete().eq('variant_group_id', existing.id); // replace options wholesale
      groupId = existing.id;
      results.updated++;
    } else {
      const { data: created, error } = await supabase
        .from('variant_groups').insert({ product_id: productId, name: g.group, kind: g.kind, required: g.required, sort_order: 0 })
        .select('id').single();
      if (error || !created) { results.errors.push({ row: 0, error: `${g.product}/${g.group}: ${error?.message ?? 'insert failed'}` }); continue; }
      groupId = created.id;
      results.created++;
    }

    if (g.options.length > 0) {
      const { error: optErr } = await supabase.from('variant_options').insert(
        g.options.map(o => ({ variant_group_id: groupId, name: o.name, price_adjustment: o.price_adjustment, sort_order: o.sort_order })),
      );
      if (optErr) { results.errors.push({ row: 0, error: `${g.product}/${g.group} options: ${optErr.message}` }); continue; }
    }

    // The till only pulls variants for products flagged has_variants.
    await supabase.from('products').update({ has_variants: true }).eq('id', productId).eq('business_id', req.businessId);
  }

  res.json(results);
});

// GET /api/variants/groups?product_id=xxx
router.get('/groups', async (req, res) => {
  const { product_id } = req.query;
  if (!product_id) { res.status(400).json({ error: 'product_id required' }); return; }

  // A591: a till's whole-menu pull asks this for every product — answered from one read of the business's groups
  // (lib/choiceGroups.ts); the dashboard's ask (one product) reads as before.
  if (req.isTill || req.surface === 'desktop') {
    try {
      const m = await tillChoiceGroups('variant', req.businessId, String(product_id));
      if (m) {
        if (!m.found) { res.status(404).json({ error: 'Product not found' }); return; }
        res.json(m.groups); return;
      }
    } catch (e) { sendError(res, e as Error); return; }
  }

  // Verify product belongs to this business
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data, error } = await supabase
    .from('variant_groups')
    .select('*, variant_options(*)')
    .eq('product_id', product_id)
    .order('sort_order');

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// POST /api/variants/groups
// Body: { product_id, name, required, options: [{ name, price_adjustment }] }
router.post('/groups', requirePermission('menu.edit'), async (req, res) => {
  const { product_id, name, required = false, options = [] } = req.body;
  if (!product_id || !name) { res.status(400).json({ error: 'product_id and name required' }); return; }

  // Verify ownership
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }
  if (!Array.isArray(options)) { res.status(400).json({ error: 'options must be a list' }); return; }
  const refusal = priceRefusal(req, options.map((o: any) => [null, o?.price_adjustment ?? 0] as [unknown, unknown]));   // A494
  if (refusal) { res.status(refusal.status).json(refusal.body); return; }
  if (!(await linksOk(req.businessId, options))) { res.status(400).json({ error: "An option takes stock from an item that is not this business's." }); return; }

  const { data: group, error: gErr } = await supabase
    .from('variant_groups')
    .insert({ product_id, name, required, sort_order: 0 })
    .select()
    .single();

  if (gErr) { sendError(res, gErr); return; }

  if (options.length > 0) {
    const { error: oErr } = await supabase
      .from('variant_options')
      .insert(options.map((o: { name: string; price_adjustment: number }, i: number) => ({
        variant_group_id: group.id,
        name: o.name,
        price_adjustment: o.price_adjustment ?? 0,
        sort_order: i,
        ...stockFields(o),
      })));
    if (oErr) { sendError(res, oErr); return; }
  }

  // Return group with options
  const { data: full } = await supabase
    .from('variant_groups')
    .select('*, variant_options(*)')
    .eq('id', group.id)
    .single();

  // Mark product as has_variants
  await supabase.from('products').update({ has_variants: true }).eq('id', product_id);

  res.status(201).json(full);
});

// PATCH /api/variants/groups/:id
router.patch('/groups/:id', requirePermission('menu.edit'), async (req, res) => {
  const { id } = req.params;

  // Build the patch from the keys ACTUALLY sent.
  //
  // This used to destructure { name, required } and update both unconditionally.
  // It survived only because supabase-js drops undefined during serialisation —
  // so a patch of just the name silently relied on that to avoid clearing
  // `required`. One JSON-shape change away from wiping a field nobody edited.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body?.required !== undefined) patch.required = req.body.required === true;
  if (req.body?.combo_item_id !== undefined) patch.combo_item_id = req.body.combo_item_id || null;

  // kind: 'choice' free preference, 'upgrade' priced ladder, 'review' unclassified.
  if (req.body?.kind !== undefined) {
    const kind = String(req.body.kind);
    if (!['choice', 'upgrade', 'review'].includes(kind)) {
      res.status(400).json({ error: "kind must be 'choice', 'upgrade' or 'review'" });
      return;
    }
    patch.kind = kind;
  }

  // Verify via product → business chain
  const { data: group } = await supabase
    .from('variant_groups')
    .select('product_id')
    .eq('id', id)
    .single();

  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', group.product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(403).json({ error: 'Forbidden' }); return; }

  // A group declared a free CHOICE cannot carry prices — that is the whole
  // distinction. Zeroing the options here rather than trusting the client keeps
  // the promise true no matter which screen made the call.
  if (patch.kind === 'choice') {
    // A494: zeroing the options' prices is a price change — menu.prices when any option has one.
    const { data: priced } = await supabase.from('variant_options').select('price_adjustment').eq('variant_group_id', id);
    const refusal = priceRefusal(req, ((priced ?? []) as Array<{ price_adjustment: unknown }>).map((o) => [o.price_adjustment, 0] as [unknown, unknown]));
    if (refusal) { res.status(refusal.status).json(refusal.body); return; }
    const { error: zeroErr } = await supabase
      .from('variant_options').update({ price_adjustment: 0 }).eq('variant_group_id', id);
    if (zeroErr) { sendError(res, zeroErr); return; }
  }

  const { data, error } = await supabase
    .from('variant_groups')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/variants/groups/:id  (cascades to variant_options)
// A595 (docs/PERMISSIONS-AUDIT.md F24): deleting is its own part of menu.edit (menu.delete — migration 176 gave it to every
// holder of menu.edit).
router.delete('/groups/:id', requirePermission('menu.delete'), async (req, res) => {
  const { id } = req.params;

  const { data: group } = await supabase
    .from('variant_groups')
    .select('product_id')
    .eq('id', id)
    .single();

  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', group.product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(403).json({ error: 'Forbidden' }); return; }

  await supabase.from('variant_groups').delete().eq('id', id);

  // If no groups remain, clear the flag
  const { count } = await supabase
    .from('variant_groups')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', group.product_id);

  if (count === 0) {
    await supabase.from('products').update({ has_variants: false }).eq('id', group.product_id);
  }

  res.status(204).send();
});

// ── Variant Options ─────────────────────────────────────────
// Ownership for an option is verified by walking the chain:
//   variant_option → variant_group → product → business_id.
// Without this, any authenticated user could edit/delete another
// tenant's option rows by guessing their UUID (cross-tenant IDOR).

// Returns true if the given variant group belongs to the caller's business.
async function variantGroupOwned(groupId: string, businessId: string): Promise<boolean> {
  const { data: group } = await supabase
    .from('variant_groups').select('product_id').eq('id', groupId).single();
  if (!group) return false;
  const { data: product } = await supabase
    .from('products').select('id').eq('id', group.product_id).eq('business_id', businessId).single();
  return !!product;
}

// Returns true if the given variant option belongs to the caller's business.
async function variantOptionOwned(optionId: string, businessId: string): Promise<boolean> {
  const { data: option } = await supabase
    .from('variant_options').select('variant_group_id').eq('id', optionId).single();
  if (!option) return false;
  return variantGroupOwned(option.variant_group_id, businessId);
}

// POST /api/variants/options
router.post('/options', requirePermission('menu.edit'), async (req, res) => {
  const { variant_group_id, name, price_adjustment = 0 } = req.body;
  if (!variant_group_id || !name) { res.status(400).json({ error: 'variant_group_id and name required' }); return; }

  if (!(await variantGroupOwned(variant_group_id, req.businessId))) {
    res.status(404).json({ error: 'Variant group not found' }); return;
  }
  const refusal = priceRefusal(req, [[null, price_adjustment]]);   // A494
  if (refusal) { res.status(refusal.status).json(refusal.body); return; }
  if (!(await linksOk(req.businessId, [req.body]))) { res.status(400).json({ error: "The option takes stock from an item that is not this business's." }); return; }

  const { data, error } = await supabase
    .from('variant_options')
    .insert({ variant_group_id, name, price_adjustment, sort_order: 0, ...stockFields(req.body) })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// PATCH /api/variants/options/:id
router.patch('/options/:id', requirePermission('menu.edit'), async (req, res) => {
  const { id } = req.params;
  const { name, price_adjustment } = req.body;

  if (!(await variantOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Variant option not found' }); return;
  }
  // A494: a changed price is menu.prices (never negative); a stock link must be this business's.
  if (price_adjustment !== undefined) {
    const { data: cur } = await supabase.from('variant_options').select('price_adjustment').eq('id', id).maybeSingle();
    const refusal = priceRefusal(req, [[(cur as { price_adjustment?: unknown } | null)?.price_adjustment ?? 0, price_adjustment]]);
    if (refusal) { res.status(refusal.status).json(refusal.body); return; }
  }
  if (!(await linksOk(req.businessId, [req.body ?? {}]))) { res.status(400).json({ error: "The option takes stock from an item that is not this business's." }); return; }

  // Only touch stock fields when the caller sends them, so a name/price edit
  // can't accidentally reset a factor or clear a link.
  const hasStockIntent = ['stock_factor', 'linked_product_id', 'linked_ingredient_id', 'deduct_qty']
    .some(k => k in (req.body ?? {}));

  const { data, error } = await supabase
    .from('variant_options')
    .update({ name, price_adjustment, ...(hasStockIntent ? stockFields(req.body) : {}) })
    .eq('id', id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/variants/options/:id
// A595 (docs/PERMISSIONS-AUDIT.md F24): deleting is its own part of menu.edit (menu.delete — migration 176 gave it to every
// holder of menu.edit).
router.delete('/options/:id', requirePermission('menu.delete'), async (req, res) => {
  const { id } = req.params;

  if (!(await variantOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Variant option not found' }); return;
  }

  await supabase.from('variant_options').delete().eq('id', id);
  res.status(204).send();
});

export default router;
