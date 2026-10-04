/**
 * stockTakeAccess.ts — A394: what an open stock count means outside the count screens (routes/stockTakes.ts).
 *
 *   frozenAtBranch      — the products not to sell at a branch right now (POST /orders on the web, /api/pos/init for tills)
 *   hiddenWhileCounting — the items whose system figure a person counting must not see on the stock screens (blind)
 *
 * Neither ever throws: before migration 120, or on any error, nothing is frozen and nothing is hidden — a stock count
 * must never stop a sale by accident.
 */
import type { Request } from 'express';
import { supabase } from './supabase';
import { frozenProductIds } from './stockTakeRules';

export const MAX_LINES = 5000;

export function may(req: Request, key: string): boolean {
  const keys = req.permissionKeys ?? [];
  return Boolean(req.isOwner) || keys.includes('*') || keys.includes(key);
}

export interface TakeRow {
  id: string; business_id: string; branch_id: string; ref: string; status: string; freeze_sales: boolean;
  scope: unknown; note: string | null; started_at: string; started_by_name: string | null;
  submitted_at: string | null; submitted_by_name: string | null; posted_at: string | null; posted_by_name: string | null;
  cancelled_at: string | null; cancelled_by_name: string | null; summary: unknown; updated_at: string;
}

/** The open count at a branch, if any. */
export async function openTake(businessId: string, branchId: string): Promise<TakeRow | null> {
  const { data } = await supabase.from('stock_takes').select('*')
    .eq('business_id', businessId).eq('branch_id', branchId).in('status', ['counting', 'review']).maybeSingle();
  return (data as TakeRow | null) ?? null;
}

/**
 * Products that may not be sold at a branch right now (a frozen count, not yet counted). Never throws: a missing table
 * (before migration 120) or any error means nothing is frozen — a stock count must never stop a sale by accident.
 */
export async function frozenAtBranch(businessId: string, branchId: string | null | undefined): Promise<{ ref: string; productIds: string[] } | null> {
  if (!businessId || !branchId) return null;
  try {
    const take = await openTake(businessId, branchId);
    if (!take || !take.freeze_sales) return null;
    const { data } = await supabase.from('stock_take_lines').select('item_kind, product_id, counted_qty')
      .eq('stock_take_id', take.id).eq('item_kind', 'product').is('counted_qty', null).limit(MAX_LINES);
    const ids = frozenProductIds({ status: take.status, freeze: take.freeze_sales }, (data ?? []) as Array<{ item_kind: string; product_id: string | null; counted_qty: number | null }>);
    return { ref: take.ref, productIds: ids };
  } catch {
    return null;
  }
}

/**
 * Blind count, beyond the count screen: while a branch is counting, someone who may not change stock does not see the
 * system's figure for the items being counted on the stock screens either. Returns the item keys to hide ('p:<id>' /
 * 'i:<id>'), empty when nothing is hidden. Never throws.
 */
export async function hiddenWhileCounting(req: Request, branchId: string | null): Promise<Set<string>> {
  const hide = new Set<string>();
  if (!branchId || may(req, 'inventory.adjust')) return hide;
  try {
    const take = await openTake(req.businessId, branchId);
    if (!take) return hide;
    const { data } = await supabase.from('stock_take_lines').select('product_id, ingredient_id')
      .eq('stock_take_id', take.id).limit(MAX_LINES);
    for (const l of (data ?? []) as Array<{ product_id: string | null; ingredient_id: string | null }>) {
      if (l.product_id) hide.add(`p:${l.product_id}`);
      if (l.ingredient_id) hide.add(`i:${l.ingredient_id}`);
    }
  } catch { /* nothing hidden */ }
  return hide;
}
