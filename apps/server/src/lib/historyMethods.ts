/**
 * historyMethods.ts — 0.6.37 (A387): the payment methods a cashier's History shows, for GET /api/orders (the web POS).
 *
 * The business default ('cashier_history_methods' in business_settings), or the branch's own (branch_settings). [] =
 * every method. Cached a minute per business/branch; the settings routes call invalidateHistoryMethods on a change.
 */
import { supabase } from './supabase';
import { CASHIER_HISTORY_METHODS_KEY, cleanHistoryMethods } from './cashierHistory';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; methods: string[] }>();

export function invalidateHistoryMethods(businessId: string | undefined): void {
  if (!businessId) return;
  for (const k of [...cache.keys()]) if (k.startsWith(`${businessId}|`)) cache.delete(k);
}

/** The allowed methods ([] = every method). Never throws: a failed read is [] — every method, as before. */
export async function getHistoryMethods(businessId: string | undefined, branchId?: string | null): Promise<string[]> {
  if (!businessId) return [];
  const key = `${businessId}|${branchId ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.methods;
  let methods: string[] = [];
  try {
    const { data: biz } = await supabase.from('business_settings').select('value')
      .eq('business_id', businessId).eq('key', CASHIER_HISTORY_METHODS_KEY).maybeSingle();
    methods = cleanHistoryMethods((biz as any)?.value) ?? [];
    if (branchId) {
      const { data: br } = await supabase.from('branch_settings').select('value')
        .eq('business_id', businessId).eq('branch_id', branchId).eq('key', CASHIER_HISTORY_METHODS_KEY).maybeSingle();
      if (br) methods = cleanHistoryMethods((br as any).value) ?? methods;
    }
  } catch { methods = []; }
  cache.set(key, { at: Date.now(), methods });
  return methods;
}
