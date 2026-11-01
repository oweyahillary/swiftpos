/**
 * platformSale.ts — A619 (owner, 2026-11-01): a sale charged at a delivery platform's prices, checked in the main process.
 *
 * "the moment a cashier picks glovo or uber eats as the payment method the price changes": the payment screen re-prices
 * the sale with shared/platformPrices.ts and sends it with `price_list` (the platform) and, on each line, `normal` (the
 * line as it was rung: { unitPrice, modifiers }). Here, the authority on this POS (offline too):
 *   - a platform pays the whole bill: a claim with a split, or with another method, is refused;
 *   - each line must be what THIS POS's rules give from its normal price (the rule and rounding pulled from the cloud, the
 *     item's own platform price from its local catalogue) — the screen's figure is never trusted on its own;
 *   - the sale records the rule that applied and what it added (platform_rule / platform_uplift), and the cloud checks
 *     it again on its own catalogue (routes/orders.ts).
 * A sale with no claim is untouched (normal prices, whatever the method). The `normal` hints never leave this process.
 */
import {
  isPlatformMethod, salePlatform, priceLineForPlatform, lineAmount, platformRecord, type PlatformPricing,
} from './platformPrices';

export type PlatformCheck = { ok: true; platform: string | null } | { ok: false; error: string };

const NO_SPLIT = 'A delivery platform pays the whole bill — charge it to the platform alone, or pick another method.';
const STALE = 'The delivery platform prices changed — close the payment and open it again.';

const legMethods = (p: any): string[] => {
  const legs = Array.isArray(p?.payments) && p.payments.length ? p.payments : p?.payment ? [p.payment] : [];
  return legs.map((l: any) => String(l?.method ?? ''));
};

/**
 * Check (and complete) a sale's platform pricing in place. `ownPrice(productId, platform)` reads the item's own platform
 * price from this POS's catalogue (null: none).
 */
export function checkPlatformSale(payload: any, pricing: PlatformPricing,
  ownPrice: (productId: string, platform: string) => number | null): PlatformCheck {
  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const claim = payload?.price_list;
  const platform = salePlatform(claim, legMethods(payload));
  if (!platform) {
    if (isPlatformMethod(claim)) return { ok: false, error: NO_SPLIT };
    clearClaim(payload, items);
    return { ok: true, platform: null };
  }
  let normalTotal = 0, platformTotal = 0;
  for (const item of items) {
    const normal = normalLine(item);
    const expected = normal.product?.id
      ? priceLineForPlatform(normal, platform, pricing, ownPrice(String(normal.product.id), platform))
      : normal;
    if (Math.abs(lineAmount(expected) - lineAmount(item)) > 0.01) return { ok: false, error: STALE };
    normalTotal += lineAmount(normal);
    platformTotal += lineAmount(item);
    delete item.normal;
  }
  Object.assign(payload, platformRecord(platform, pricing, platformTotal - normalTotal));
  return { ok: true, platform };
}

/** The line as it was rung — from its `normal` hint; a line without one (no product, or nothing changed) is as sent. */
function normalLine(item: any): any {
  const n = item?.normal;
  if (!n || typeof n !== 'object') return item;
  const mods: any[] = Array.isArray(item.selectedModifiers) ? item.selectedModifiers : [];
  const normalMods = Array.isArray(n.modifiers) ? n.modifiers : [];
  return {
    ...item,
    unitPrice: Number(n.unitPrice) || 0,
    selectedModifiers: mods.map((m, i) => ({ ...m, price: Number(normalMods[i] ?? m?.price) || 0 })),
    lineTotal: undefined,
  };
}

function clearClaim(payload: any, items: any[]): void {
  delete payload.price_list; delete payload.platform_rule; delete payload.platform_uplift;
  for (const item of items) delete item?.normal;
}
