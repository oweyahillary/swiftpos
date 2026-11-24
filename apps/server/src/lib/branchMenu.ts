/**
 * branchMenu.ts — A625 (per-branch menu): a product can be off a branch's menu (product_branches_hidden, migration 194).
 * No rows for a product = it is on every branch's menu, exactly as before. The POS pull drops the hidden ones for the
 * branch; a LIVE web sale of one is refused (409 NOT_ON_MENU) — a till's offline/pushed sale already happened and is
 * never refused (the same rule as the A563 sold-out gate). A failed read answers "nothing hidden" (the sale goes ahead).
 */
import { supabase } from './supabase';

export const NOT_ON_MENU_CODE = 'NOT_ON_MENU';

/** The product ids hidden at this branch. No rows (or a failed read) → an empty set (nothing hidden). */
export async function hiddenProductsAt(businessId: string | null | undefined, branchId: string | null | undefined): Promise<Set<string>> {
  if (!businessId || !branchId) return new Set();
  try {
    const { data, error } = await supabase.from('product_branches_hidden').select('product_id')
      .eq('business_id', businessId).eq('branch_id', branchId);
    if (error) return new Set();
    return new Set((data ?? []).map((r: { product_id: string }) => String(r.product_id)));
  } catch { return new Set(); }
}

/** A LIVE web sale's refusal when a line's product is off this branch's menu — { error, code, items } or null. */
export async function branchMenuRefusal(businessId: string, branchId: string, items: unknown[]):
    Promise<{ error: string; code: typeof NOT_ON_MENU_CODE; items: Array<{ product_id: string }> } | null> {
  const ids = [...new Set((items ?? []).map((it) => String((it as { product_id?: unknown })?.product_id ?? '')).filter(Boolean))];
  if (!ids.length) return null;
  const hidden = await hiddenProductsAt(businessId, branchId);
  if (!hidden.size) return null;
  const off = ids.filter((id) => hidden.has(id));
  if (!off.length) return null;
  return { error: 'Some items are not on this branch\'s menu.', code: NOT_ON_MENU_CODE, items: off.map((product_id) => ({ product_id })) };
}
