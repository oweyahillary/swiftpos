/**
 * stockEffects.ts — everything a completed sale does to stock.
 *
 * WHY THIS FILE EXISTS
 * This ran only inside POST /orders. The dine-in path, POST /orders/:id/pay,
 * had its own four-line version that updated stock_levels.quantity and nothing
 * else. It ignored track_stock, ignored sold_by='piece', wrote no
 * stock_movements audit row, and performed NO recipe, variant-linked, packaging
 * or fuel deduction at all.
 *
 * So on the one order path restaurants actually use, the entire recipe system
 * was bypassed. Every dine-in service overstated ingredient stock silently:
 * reorder points wrong, variance unexplainable, and nothing in the books to say
 * why. The bug was not that the logic was wrong — it is that it only existed on
 * one of the two paths.
 *
 * Two call sites now share this. If a third order path is ever added, it calls
 * this too rather than growing a third dialect of stock deduction.
 *
 * EVERYTHING HERE IS BEST-EFFORT AND MUST NEVER THROW.
 * It runs AFTER the order is committed and the customer has paid. A stock
 * problem must not turn a completed sale into an error — the sale is real
 * whatever the stock table says. Each section has its own try/catch, and the
 * whole function has one more around it.
 */
import { supabase } from './supabase';
import { checkLowStock, checkLowIngredients } from '../jobs/lowStockChecker';

/**
 * One sold line, normalised. POST /orders builds these from the client cart;
 * /pay builds them from order_items + order_item_variants.
 *
 * Variants may arrive with an optionId (cart) or only names (rebuilt from the
 * DB). lineStockImpact resolves either — see vImpactKey below.
 */
export interface StockLine {
  productId: string | null;
  quantity: number;
  variants?: Array<{ groupName?: string; optionName?: string; optionId?: string; id?: string }>;
}

export interface StockEffectsParams {
  businessId:  string;
  branchId:    string;
  userId?:     string | null;
  orderId:     string;
  orderNumber: string;
  /** 'takeaway' consumes packaging; dine-in does not. */
  orderType:   string;
  /** Petrol only: resolves which tank to draw litres from. */
  pumpId?:     string | null;
  lines:       StockLine[];
}

export async function applyStockEffects(params: StockEffectsParams): Promise<void> {
  const { businessId, userId, lines, pumpId, orderType } = params;
  // Aliased rather than renamed throughout: the moved code refers to branch_id
  // and order_number in dozens of places, including inside PostgREST filter
  // STRINGS like `branch_id.eq.${branch_id}`. A rename would have silently
  // corrupted those — they are data, not identifiers, so the compiler would not
  // have caught it.
  const branch_id    = params.branchId;
  const order_number = params.orderNumber;
  const order_id     = params.orderId;
  const order_type   = orderType;
  const pump_id      = pumpId ?? null;

  try {
      // 6. Stock deduction
      // 6a. Product-level stock (for minimart / retail products with track_stock=true)
      //     Handles both sold_by='each' (unit deduction) and sold_by='piece' (piece deduction)
      const productIds = lines.map(l => l.productId).filter((id): id is string => !!id);
      // is_fuel is selected because a fuel product's stock lives in fuel_tanks,
      // not stock_levels — see the deduction loop below (BUG-20).
      const { data: trackedProducts } = await supabase
        .from('products')
        .select('id, track_stock, sold_by, is_fuel')
        .in('id', productIds)
        .eq('track_stock', true);

      const trackedMap = new Map(
        ((trackedProducts ?? []) as Array<{ id: string; track_stock: boolean; sold_by?: string | null; is_fuel?: boolean | null; pieces_per_unit?: number | null }>)
          .map(p => [p.id, p] as const),
      );

      // Every fuel product in this order, tracked or not. 6a-bis needs this to
      // know which lines are litres out of a tank rather than units off a shelf;
      // before, it treated EVERY line as a possible fuel line and relied on the
      // fuel_tanks lookup returning nothing for the rest.
      const { data: fuelProducts } = await supabase
        .from('products')
        .select('id')
        .in('id', productIds.length ? productIds : ['00000000-0000-0000-0000-000000000000'])
        .eq('is_fuel', true);
      const fuelIds = new Set((fuelProducts ?? []).map((p: { id: string }) => p.id));

      // ── Variant stock impact (Track C: 25_variant_stock_and_packaging.sql) ─────
      // A selected variant option can carry a stock consequence:
      //   • stock_factor      — scales the PARENT product's deduction (Large = 1.5)
      //   • linked_product_id — deducts a DIFFERENT product's stock (bottled drink SKU)
      //   • deduct_qty        — units of the linked product per unit sold
      // Fetch every option (with these columns) for the products in this order and
      // index it both by option id and by product|group|option, mirroring how
      // recomputeOrderTotals resolves selected variants.
      type StockLink = { kind: 'product' | 'ingredient'; id: string; qty: number };
      const vFactorById  = new Map<string, number>();
      const vLinkById    = new Map<string, StockLink>();
      const vFactorByKey = new Map<string, number>();
      const vLinkByKey   = new Map<string, StockLink>();
      const vImpactKey = (pid: string, group: string, option: string) =>
        `${pid}|${(group ?? '').toLowerCase()}|${(option ?? '').toLowerCase()}`;
      {
        const { data: vgroups } = await supabase
          .from('variant_groups')
          .select('name, product_id, variant_options ( id, name, stock_factor, linked_product_id, linked_ingredient_id, deduct_qty )')
          .in('product_id', productIds.length ? productIds : ['00000000-0000-0000-0000-000000000000']);
        for (const g of (vgroups ?? []) as Array<{ name: string; product_id: string; variant_options: Array<{ id: string; name: string; stock_factor: string | number; linked_product_id: string | null; linked_ingredient_id: string | null; deduct_qty: string | number }> }>) {
          for (const o of (g.variant_options ?? [])) {
            const factor = Number(o.stock_factor ?? 1) || 1;
            const qty    = Number(o.deduct_qty ?? 1) || 1;
            const link: StockLink | null = o.linked_product_id
              ? { kind: 'product', id: String(o.linked_product_id), qty }
              : o.linked_ingredient_id
                ? { kind: 'ingredient', id: String(o.linked_ingredient_id), qty }
                : null;
            const key = vImpactKey(g.product_id, g.name, o.name);
            if (o.id) { vFactorById.set(String(o.id), factor); if (link) vLinkById.set(String(o.id), link); }
            vFactorByKey.set(key, factor);
            if (link) vLinkByKey.set(key, link);
          }
        }
      }

      // Effective multiplier + linked deductions for one order line. The factor
      // is the product of every selected option's stock_factor (default 1 → no-op).
      const lineStockImpact = (item: StockLine): { factor: number; links: StockLink[] } => {
        let factor = 1;
        const links: StockLink[] = [];
        const pid = item.productId ?? '';
        for (const v of (item.variants ?? []) as Array<{ groupName?: string; optionName?: string; optionId?: string; id?: string }>) {
          const oid = String(v.optionId ?? v.id ?? '');
          const key = vImpactKey(pid, v.groupName ?? '', v.optionName ?? '');
          const f = (oid && vFactorById.has(oid)) ? vFactorById.get(oid)! : vFactorByKey.get(key);
          if (f !== undefined) factor *= f;
          const link = (oid && vLinkById.has(oid)) ? vLinkById.get(oid)! : vLinkByKey.get(key);
          if (link) links.push(link);
        }
        return { factor, links };
      };

      for (const item of lines) {
        if (!item.productId) continue; // skip non-catalogue lines (custom/parking)
        const prod = trackedMap.get(item.productId);
        if (!prod) continue;

        // ── Fuel is deducted from the TANK, not from stock_levels (BUG-20) ──
        // A fuel product with track_stock=true was being hit twice: once here,
        // and again in 6a-bis, which deducts litres from fuel_tanks. Two
        // deductions for one sale, so the shelf figure ran down at double rate
        // and disagreed with the dipstick.
        //
        // The tank is authoritative — it is the physical container, it is
        // measured in litres, and a station can have more than one tank per
        // grade. stock_levels is kept in step by MIRRORING the tank total after
        // the tank deduction (see the end of 6a-bis), never by a second
        // subtraction of its own.
        if (prod.is_fuel) continue;

        // Scale mode: Large fries (factor 1.5) deducts 1.5× the finished-good units.
        const deductUnits = item.quantity * lineStockImpact(item).factor;

        // Atomic, via the RPC that already existed for exactly this (migration
        // 61) and that this path never called. What was here before read
        // stock_levels, subtracted in JavaScript and wrote the result back —
        // the same read-modify-write migration 61 was written to remove from
        // the restock, transfer and void paths. Two tills selling the same
        // product at once both read the same figure and the second write
        // silently discarded the first sale's deduction.
        //
        // GREATEST(...,0) is deliberately NOT applied. The old code clamped at
        // zero, which quietly hid oversell: the shelf read 0 whether you were
        // level or twelve units short. Stock is allowed to go negative here —
        // a negative figure is a real fact about the shop that somebody needs
        // to see, and clamping is how it stayed invisible.
        //
        // qty_pieces is an INTEGER column and a variant stock_factor is
        // numeric, so a factor of 1.5 produces a fractional piece count.
        // Rounding here rather than letting Postgres round on assignment keeps
        // the value we write and the value in stock_movements identical (C8).
        const isPiece    = prod.sold_by === 'piece';
        const qtyDelta   = isPiece ? 0 : -deductUnits;
        const pieceDelta = isPiece ? -Math.round(deductUnits) : 0;

        const { data: adjusted, error: adjErr } = await supabase.rpc('adjust_product_stock', {
          p_product_id:  item.productId,
          p_branch_id:   branch_id,
          p_qty_delta:   qtyDelta,
          p_piece_delta: pieceDelta,
        });
        if (adjErr) { console.error('[stockEffects] product deduction failed (non-fatal):', adjErr.message); continue; }

        const row      = Array.isArray(adjusted) ? adjusted[0] : adjusted;
        const after    = isPiece ? Number(row?.qty_pieces ?? 0) : Number(row?.quantity ?? 0);

        await supabase
          .from('stock_movements')
          .insert({
            product_id: item.productId,
            branch_id,
            movement_type: 'sale',
            quantity_change: isPiece ? pieceDelta : qtyDelta,
            quantity_after: after,
            notes: isPiece ? `Order ${order_number} (pieces)` : `Order ${order_number}`,
            reference_type: 'order',
            reference_id:   order_id,
            created_by:     userId ?? null,
          });
      }

      // 6a-linked. Distinct-SKU / ingredient variant deductions (Track C).
      // A selected option with linked_product_id deducts THAT product's stock
      // (e.g. bottled Coke 1L); one with linked_ingredient_id deducts an ingredient
      // (e.g. Large chips → extra frozen fries). Aggregated across lines, from the
      // order's branch. Best-effort — never blocks a sale.
      try {
        const linkedProductDeductions:    Record<string, number> = {};
        const linkedIngredientDeductions: Record<string, number> = {};
        for (const item of lines) {
          for (const l of lineStockImpact(item).links) {
            const bucket = l.kind === 'ingredient' ? linkedIngredientDeductions : linkedProductDeductions;
            bucket[l.id] = (bucket[l.id] ?? 0) + l.qty * item.quantity;
          }
        }

        // Product-linked SKUs → deduct product stock (stock_levels).
        // Atomic, same RPC and same reasoning as the main deduction above: a
        // bottled-drink SKU is exactly the kind of shared item two tills sell
        // at the same moment.
        for (const [linkedPid, qty] of Object.entries(linkedProductDeductions)) {
          const { data: adjusted, error: linkErr } = await supabase.rpc('adjust_product_stock', {
            p_product_id:  linkedPid,
            p_branch_id:   branch_id,
            p_qty_delta:   -qty,
            p_piece_delta: 0,
          });
          if (linkErr) { console.error('[stockEffects] linked SKU deduction failed (non-fatal):', linkErr.message); continue; }
          const newQty = Number((Array.isArray(adjusted) ? adjusted[0] : adjusted)?.quantity ?? 0);

          await supabase
            .from('stock_movements')
            .insert({
              product_id: linkedPid,
              branch_id,
              movement_type: 'sale',
              quantity_change: -qty,
              quantity_after: newQty,
              notes: `Order ${order_number} (variant SKU)`,
              reference_type: 'order',
              reference_id:   order_id,
              created_by:     userId ?? null,
            });
        }

        // Ingredient-linked options → deduct ingredient stock via the same atomic
        // RPC recipes use, with movement audit + low-stock alert.
        const linkedIngredientIds = Object.keys(linkedIngredientDeductions);
        for (const [ingredientId, qty] of Object.entries(linkedIngredientDeductions)) {
          const { data: newStock, error: iErr } = await supabase.rpc('adjust_ingredient_stock', {
            p_ingredient_id: ingredientId,
            p_branch_id:     branch_id,
            p_business_id:   businessId,
            p_delta:         -qty,
          });
          if (iErr) { console.error('Linked-ingredient deduction error (non-fatal):', iErr.message); continue; }
          await supabase
            .from('ingredient_stock_movements')
            .insert({
              business_id:     businessId,
              ingredient_id:   ingredientId,
              branch_id,
              movement_type:   'sale',
              quantity_change: -qty,
              quantity_after:  newStock,
              notes:           `Order ${order_number} (variant ingredient)`,
              created_by:      userId,
            });
        }
        if (linkedIngredientIds.length > 0) {
          checkLowIngredients(businessId, branch_id, linkedIngredientIds).catch(() => {});
        }
      } catch (err) {
        console.error('[orders] linked variant deduction failed (non-blocking):', err);
      }

      // 6a-bis. Fuel wet-stock deduction.
      // Deducts litres from the correct tank using the following priority:
      //   1. pump_id on the order → pump.tank_id → deduct from that specific tank
      //      (exact when a station has multiple tanks of the same grade)
      //   2. Fallback: match tanks by fuel_product_id (original behaviour — works
      //      when only one tank per grade, i.e. most single-site stations)
      try {
        // Only FUEL lines. This used to build the map from every line in the
        // order and lean on the fuel_tanks lookup to filter — which worked, but
        // meant a non-fuel product could reach the tank code at all. Scoping it
        // here is what makes "deducted once, from the tank" checkable.
        const litresByProduct: Record<string, number> = {};
        for (const item of lines) {
          const pid = item.productId;
          if (pid && fuelIds.has(pid)) {
            litresByProduct[pid] = (litresByProduct[pid] ?? 0) + Number(item.quantity);
          }
        }
        const fuelProductIds = Object.keys(litresByProduct);
        if (fuelProductIds.length > 0) {
          // Strategy 1: if the order has a pump_id, check if that pump has a tank_id.
          // The order object carries pump_id (set from the request body when it was
          // built above), so the tank deduction reads it directly.
          let specificTankId: string | null = null;
          if (pump_id) {
            const { data: pump } = await supabase
              .from('pumps')
              .select('tank_id, fuel_product_id')
              .eq('id', pump_id)
              .eq('business_id', businessId)
              .single();
            if (pump?.tank_id) {
              specificTankId = pump.tank_id;
            }
          }

          let tanksToDeduct: Array<{ id: string; fuel_product_id: string; current_level: string }> = [];

          if (specificTankId) {
            // Exact match — deduct from the pump's assigned tank only
            const { data: specificTank } = await supabase
              .from('fuel_tanks')
              .select('id, fuel_product_id, current_level')
              .eq('id', specificTankId)
              .eq('business_id', businessId)
              .single();
            if (specificTank) tanksToDeduct = [specificTank];
          } else {
            // Fallback — match by fuel_product_id (works for single-tank-per-grade)
            let tankQuery = supabase
              .from('fuel_tanks')
              .select('id, fuel_product_id, current_level')
              .eq('business_id', businessId)
              .in('fuel_product_id', fuelProductIds);
            if (branch_id && /^[0-9a-fA-F-]{36}$/.test(branch_id)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tankQuery = (tankQuery as any).or(`branch_id.eq.${branch_id},branch_id.is.null`);
            }
            const { data: tanks } = await tankQuery;
            tanksToDeduct = tanks ?? [];
          }

          const touchedFuelProducts = new Set<string>();

          for (const tank of tanksToDeduct) {
            const litres = litresByProduct[tank.fuel_product_id] ?? 0;
            if (litres > 0) {
              // Atomic. Two pumps drawing the same tank at once both read the
              // same level under the old read-compute-write and the second
              // write discarded the first sale's litres — the same lost-update
              // the ingredient path has been protected from since migration 23
              // and the product path since 61. Tanks were the last one left.
              const { data: lvl, error: tankErr } = await supabase.rpc('adjust_fuel_tank_level', {
                p_tank_id: tank.id,
                p_delta:   -litres,
              });
              if (tankErr) {
                console.error('[fuel-sale] tank deduction failed (non-fatal):', tankErr.message);
                continue;
              }
              const newLevel = Number(Array.isArray(lvl) ? lvl[0]?.current_level : lvl) || 0;
              touchedFuelProducts.add(tank.fuel_product_id);

              supabase.from('stock_movements').insert({
                // No business_id column — tenancy is via branch_id -> branches.
                product_id:      tank.fuel_product_id,
                branch_id:       branch_id ?? null,
                movement_type:   'sale',
                quantity_change: -litres,
                quantity_after:   newLevel,
                notes:           `Fuel sale — order ${order_number}`,
                reference_type:  'order',
                reference_id:    order_id,
                created_by:      userId ?? null,
              }).then(() => {}, e => console.error('[fuel-sale] movement log failed:', e));
            }
          }

          // ── Mirror the tank total into stock_levels ──────────────────────
          // Fuel is deducted once, from the tank. But stock_levels is what the
          // inventory screens, the low-stock alert and every product-level
          // report read, so leaving it untouched would make fuel invisible
          // there. Rather than a second deduction (which is what BUG-20 was),
          // the level is SET to the sum of that product's tanks at this branch.
          //
          // A set, not a delta: it cannot drift, it self-heals if a tank is
          // dipped or refilled outside the sale path, and it is correct with
          // several tanks of one grade, where a delta would not be.
          for (const pid of touchedFuelProducts) {
            const { data: tankRows } = await supabase
              .from('fuel_tanks')
              .select('current_level')
              .eq('business_id', businessId)
              .eq('fuel_product_id', pid);
            const totalLitres = (tankRows ?? [])
              .reduce((s: number, t: { current_level: string | number }) => s + Number(t.current_level), 0);

            await supabase
              .from('stock_levels')
              .upsert(
                { product_id: pid, branch_id, quantity: totalLitres, updated_at: new Date().toISOString() },
                { onConflict: 'product_id,branch_id' },
              );
          }
        }
      } catch (err) {
        console.error('[orders] fuel tank deduction failed (non-blocking):', err);
      }

      // 6b. Ingredient deduction via recipes
      // For each item sold, look up its recipe and deduct ingredient quantities.
      // This is best-effort — we never block a sale due to stock issues.
      try {
        // Fetch all recipes for the products in this order in one query
        const { data: recipeRows } = await supabase
          .from('recipes')
          .select('product_id, ingredient_id, quantity_per_serving')
          .eq('business_id', businessId)
          .in('product_id', productIds);

        if (recipeRows && recipeRows.length > 0) {
          // Aggregate total deduction per ingredient across all items in the order
          const deductions: Record<string, number> = {};

          for (const item of lines) {
            // Scale recipe consumption by the variant factor (Large deducts more).
            const factor = lineStockImpact(item).factor;
            const recipe = recipeRows.filter((r: { product_id: string; ingredient_id: string; quantity_per_serving: string }) => item.productId && r.product_id === item.productId);
            for (const line of recipe) {
              const totalQty = Number(line.quantity_per_serving) * item.quantity * factor;
              deductions[line.ingredient_id] = (deductions[line.ingredient_id] ?? 0) + totalQty;
            }
          }

          // Apply deductions per-branch via the atomic RPC (concurrency-safe:
          // the read+write happen in one statement, so simultaneous sales of the
          // same item can't clobber each other's stock).
          const ingredientIds = Object.keys(deductions);
          if (ingredientIds.length > 0) {
            for (const [ingredientId, deductQty] of Object.entries(deductions)) {
              const { data: newQty, error: decErr } = await supabase.rpc('adjust_ingredient_stock', {
                p_ingredient_id: ingredientId,
                p_branch_id:     branch_id,
                p_business_id:   businessId,
                p_delta:         -deductQty, // negative = deduct; allowed to go negative (never block a sale)
              });
              if (decErr) { console.error('Ingredient deduction error (non-fatal):', decErr.message); continue; }

              await supabase
                .from('ingredient_stock_movements')
                .insert({
                  business_id:     businessId,
                  ingredient_id:   ingredientId,
                  branch_id,
                  movement_type:   'sale',
                  quantity_change: -deductQty,
                  quantity_after:  newQty,
                  notes:           `Order ${order_number}`,
                  created_by:      userId,
                });
            }

            // Fire low-ingredient alerts (non-blocking)
            checkLowIngredients(businessId, branch_id, ingredientIds).catch(() => {});
          }
        }
      } catch (recipeErr) {
        // Never let recipe deduction fail an order
        console.error('Recipe deduction error (non-fatal):', recipeErr?.message);
      }

      // 6c. Packaging deduction (Track C).
      // Takeaway AND delivery orders consume their configured packaging
      // (product_packaging → packaging ingredient) — both leave the premises in a
      // container, so both draw down packaging stock uniformly. Dine-in does not
      // (eaten on a plate on-site). Deducted per-branch via the same atomic RPC as
      // recipes; the cost is captured once at purchase — this is consumption, not
      // an expense. (A131: delivery joined takeaway here. Before, only takeaway
      // deducted packaging, so once delivery orders began reaching the cloud
      // (A129) their packaging went uncounted — every to-go order now deducts it.)
      if (order_type === 'takeaway' || order_type === 'delivery') {
        try {
          const { data: pkgRows } = await supabase
            .from('product_packaging')
            .select('product_id, ingredient_id, quantity')
            .eq('business_id', businessId)
            .in('product_id', productIds);

          if (pkgRows && pkgRows.length > 0) {
            const pkgDeductions: Record<string, number> = {};
            for (const item of lines) {
              const rows = pkgRows.filter((r: { product_id: string }) => item.productId && r.product_id === item.productId);
              for (const r of rows as Array<{ ingredient_id: string; quantity: string | number }>) {
                pkgDeductions[r.ingredient_id] = (pkgDeductions[r.ingredient_id] ?? 0) + Number(r.quantity) * item.quantity;
              }
            }

            const pkgIds = Object.keys(pkgDeductions);
            for (const [ingredientId, deductQty] of Object.entries(pkgDeductions)) {
              const { data: newQty, error: pErr } = await supabase.rpc('adjust_ingredient_stock', {
                p_ingredient_id: ingredientId,
                p_branch_id:     branch_id,
                p_business_id:   businessId,
                p_delta:         -deductQty,
              });
              if (pErr) { console.error('Packaging deduction error (non-fatal):', pErr.message); continue; }

              await supabase
                .from('ingredient_stock_movements')
                .insert({
                  business_id:     businessId,
                  ingredient_id:   ingredientId,
                  branch_id,
                  movement_type:   'sale',
                  quantity_change: -deductQty,
                  quantity_after:  newQty,
                  notes:           `Order ${order_number} (packaging)`,
                  created_by:      userId,
                });
            }

            if (pkgIds.length > 0) {
              checkLowIngredients(businessId, branch_id, pkgIds).catch(() => {});
            }
          }
        } catch (pkgErr: any) {
          console.error('Packaging deduction error (non-fatal):', pkgErr?.message);
        }
      }

    // Low-stock alerts for the tracked products just sold. This lived at step 7b
    // in POST /orders and never ran for dine-in at all, so a restaurant selling
    // its last tracked item at a table got no alert.
    const trackedProductIds = lines
      .map(l => l.productId)
      .filter((id): id is string => !!id && trackedMap.has(id));
    if (trackedProductIds.length > 0) {
      checkLowStock(businessId, branch_id, trackedProductIds).catch(() => {});
    }
  } catch (err) {
    // The order is already committed and paid for. Nothing here may fail it.
    console.error('[stockEffects] failed (non-blocking):', err);
  }
}
