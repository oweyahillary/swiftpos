/**
 * stockGateStore.ts — A563: the owner's "When an item's stock reaches zero" choice on the cloud (rules: lib/stockGate.ts).
 *
 *   branchStockView(business, branch, ids?)  the known levels at a branch of TRACKED products (not fuel, not sold by the
 *                                            piece — those levels are not units) and the combos' items. `ids`: only
 *                                            what one sale holds (and its combos' items); none = the whole menu (web POS).
 *   webSaleStockRefusal(business, branch, items)  the refusal for a LIVE web sale, or null. The caller decides it is a
 *                                            web sale: a till's pushed sale already happened and is never refused.
 *
 * Any read that fails = nothing known = the sale goes ahead (never refuse what cannot be verified).
 */
import { supabase } from './supabase';
import { businessPosFeatures } from './posFeatureFlags';
import { pageAll, chunkPaged } from './pgQuery';
import { outOfStockMode, stockRefusals, refusalText, type OutOfStockMode, type StockView, type GateLine } from './stockGate';

export async function businessOutOfStockMode(businessId: string | null | undefined): Promise<OutOfStockMode> {
  return outOfStockMode((await businessPosFeatures(businessId)) as unknown as Record<string, unknown>);
}

type ProductRow = { id: string; track_stock?: boolean | null; sold_by?: string | null; is_fuel?: boolean | null };

export async function branchStockView(businessId: string, branchId: string, ids?: string[]): Promise<StockView> {
  const combos: NonNullable<StockView['combos']> = {};
  const levels: Record<string, number> = {};
  const wanted = ids ? [...new Set(ids.filter(Boolean))] : null;
  if (wanted && !wanted.length) return { levels, combos };
  // The combos' items: a combo in the sale brings its items into what is read.
  const comboIds = wanted ?? (await pageAll<{ id: string }>(() => supabase.from('products').select('id')
    .eq('business_id', businessId).eq('is_combo', true))).map((p) => p.id);
  const parts = comboIds.length
    ? await chunkPaged<{ combo_id: string; product_id: string; quantity: number | string }>(comboIds, (chunk) =>
        supabase.from('combo_items').select('id, combo_id, product_id, quantity').in('combo_id', chunk))
    : [];
  for (const p of parts) (combos[p.combo_id] ??= []).push({ product_id: p.product_id, quantity: Number(p.quantity) || 1 });
  const productIds = wanted ? [...new Set([...wanted, ...parts.map((p) => p.product_id)])] : null;
  const tracked = (productIds
    ? await chunkPaged<ProductRow>(productIds, (chunk) => supabase.from('products').select('id, track_stock, sold_by, is_fuel')
        .eq('business_id', businessId).eq('track_stock', true).in('id', chunk))
    : await pageAll<ProductRow>(() => supabase.from('products').select('id, track_stock, sold_by, is_fuel')
        .eq('business_id', businessId).eq('track_stock', true)))
    .filter((p) => p.track_stock === true && !p.is_fuel && p.sold_by !== 'piece');
  if (!tracked.length) return { levels, combos };
  const rows = await chunkPaged<{ product_id: string; quantity: number | string | null }>(tracked.map((p) => p.id), (chunk) =>
    supabase.from('stock_levels').select('id, product_id, quantity').eq('branch_id', branchId).in('product_id', chunk));
  for (const r of rows) {
    if (r.quantity === null || r.quantity === undefined || r.quantity === '') continue;
    const q = Number(r.quantity);
    if (Number.isFinite(q)) levels[r.product_id] = q;
  }
  return { levels, combos };
}

/** The lines of a web sale as the gate reads them (the POST /orders item shape, or stored order_items). */
export function webGateLines(items: unknown[]): GateLine[] {
  return (Array.isArray(items) ? items : []).map((raw) => {
    const i = (raw ?? {}) as { product?: { id?: string; name?: string }; productId?: string; product_id?: string; product_name?: string; name?: string; quantity?: unknown };
    return { product_id: i.product?.id ?? i.productId ?? i.product_id ?? null, name: i.product?.name ?? i.product_name ?? i.name ?? null,
      quantity: Number(i.quantity) || 0 };
  });
}

/** A LIVE web sale's refusal: { error, code: 'SOLD_OUT', items } — or null (sell, nothing known, or a read failed). */
export async function webSaleStockRefusal(businessId: string, branchId: string, items: unknown[]):
    Promise<{ error: string; code: 'SOLD_OUT'; items: Array<{ product_id: string; name: string; available: number }> } | null> {
  try {
    const mode = await businessOutOfStockMode(businessId);
    if (mode === 'sell') return null;
    const lines = webGateLines(items);
    const view = await branchStockView(businessId, branchId, lines.map((l) => String(l.product_id ?? '')).filter(Boolean));
    const refused = stockRefusals(mode, view, lines);
    if (!refused.length) return null;
    return { error: refusalText(refused), code: 'SOLD_OUT',
      items: refused.map((r) => ({ product_id: r.product_id, name: r.name, available: r.available })) };
  } catch (e) {
    console.error('[stock] A563 the sold-out check could not read stock (the sale goes ahead):', (e as Error)?.message ?? e);
    return null;
  }
}
