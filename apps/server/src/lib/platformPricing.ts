/**
 * platformPricing.ts — A619 (owner, 2026-11-01: "the moment a cashier picks glovo or uber eats as the payment method the
 * price changes"): where the cloud reads a delivery platform's prices from. The pricing itself is shared/platformPrices.ts
 * (lib/platformPrices.ts here); this file only reads the settings and the items' own prices.
 *
 *   rules     business_settings / branch_settings `delivery_platform_prices` — the branch's own wins (the A387 pattern);
 *   rounding  business_settings `delivery_platform_rounding` (once per business);
 *   own       products.platform_prices (migration 187).
 *
 * Tolerant by design (migration 187 may run before or after this deploy): a read that fails — a missing column, the
 * database busy — gives normal prices / no own prices, never a failed sale or a failed pull.
 */
import { supabase } from './supabase';
import { chunkIn } from './pgQuery';
import {
  PLATFORM_PRICES_KEY, PLATFORM_ROUNDING_KEY, NO_PLATFORM_PRICING, cleanRounding, cleanRules, cleanOwnPrices,
  type PlatformPricing,
} from './platformPrices';

const settingValue = (rows: Array<{ key: string; value: unknown }> | null | undefined, key: string): unknown =>
  (rows ?? []).find((r) => r.key === key)?.value;

/** The pricing a branch's POS uses: the business's rounding and the branch's rules (its own, else the business's). */
export async function loadPlatformPricing(businessId: string | undefined, branchId: string | null): Promise<PlatformPricing> {
  if (!businessId) return { ...NO_PLATFORM_PRICING, rules: {} };
  try {
    const [biz, br] = await Promise.all([
      supabase.from('business_settings').select('key, value').eq('business_id', businessId)
        .in('key', [PLATFORM_PRICES_KEY, PLATFORM_ROUNDING_KEY]),
      branchId
        ? supabase.from('branch_settings').select('key, value').eq('business_id', businessId).eq('branch_id', branchId)
          .eq('key', PLATFORM_PRICES_KEY)
        : Promise.resolve({ data: [] as Array<{ key: string; value: unknown }>, error: null }),
    ]);
    if (biz.error) return { ...NO_PLATFORM_PRICING, rules: {} };
    const bizRows = (biz.data ?? []) as Array<{ key: string; value: unknown }>;
    const ownRule = br.error ? undefined : settingValue(br.data as Array<{ key: string; value: unknown }>, PLATFORM_PRICES_KEY);
    return {
      rounding: cleanRounding(settingValue(bizRows, PLATFORM_ROUNDING_KEY)),
      rules: cleanRules(ownRule !== undefined ? ownRule : settingValue(bizRows, PLATFORM_PRICES_KEY)),
    };
  } catch {
    return { ...NO_PLATFORM_PRICING, rules: {} };
  }
}

/** Each product's own price on `platform` (only those that have one). Before migration 187: none. */
export async function ownPlatformPrices(businessId: string, productIds: string[], platform: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!productIds.length) return out;
  try {
    const rows = await chunkIn<{ id: string; platform_prices: unknown }>('products', 'id', productIds,
      (q) => q.select('id, platform_prices').eq('business_id', businessId));
    for (const r of rows) {
      const own = cleanOwnPrices(r.platform_prices)[platform];
      if (own !== undefined) out.set(r.id, own);
    }
  } catch { /* migration 187 not applied: no own prices */ }
  return out;
}

/**
 * Reports (A619 "of which uplift"): what the platform prices added in the period, by platform — { glovo: 2550 }. Read on
 * its own so a report never fails over it: before migration 187 (or on any error) it is empty.
 */
export async function upliftByPlatform(
  query: () => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<Record<string, number>> {
  try {
    const { data, error } = await query();
    if (error) return {};
    const out: Record<string, number> = {};
    for (const o of (data ?? []) as Array<{ price_list?: string | null; platform_uplift?: number | string | null; status?: string }>) {
      if (!o.price_list || (o.status && o.status !== 'completed')) continue;
      out[o.price_list] = Math.round(((out[o.price_list] ?? 0) + (Number(o.platform_uplift) || 0)) * 100) / 100;
    }
    return out;
  } catch {
    return {};
  }
}
