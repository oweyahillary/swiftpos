/**
 * PlatformPriceFields — A619 (owner, 2026-11-01): an item's own delivery platform price ("Delivery platform prices" on the
 * product form). It wins over the platform's uplift for this item — drinks unchanged, a hand-priced combo. Blank = the
 * platform's uplift. Shown only when the business takes a delivery platform; saved through its own route
 * (PUT /api/products/:id/platform-prices) so the product itself always saves.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { PAYMENT_CATALOGUE, enabledFromSetting } from '@zaptill/core/paymentCatalogue';
import { PLATFORM_METHODS, cleanOwnPrices, ownPricesValue } from '@zaptill/core/platformPrices';

export type PlatformPriceDraft = Record<string, string>;

export function platformDraftOf(raw: unknown): PlatformPriceDraft {
  const own = cleanOwnPrices(raw);
  return Object.fromEntries(Object.entries(own).map(([k, v]) => [k, String(v)]));
}

/** Save the item's own platform prices when they changed; returns an error message, or '' when saved / unchanged. */
export async function savePlatformPrices(productId: string, draft: PlatformPriceDraft, before: PlatformPriceDraft): Promise<string> {
  const now = ownPricesValue(draft);
  if (now === null) return 'A platform price is an amount (blank = the platform\'s uplift).';
  if (JSON.stringify(now) === JSON.stringify(ownPricesValue(before))) return '';
  try { await api.put(`/api/products/${productId}/platform-prices`, { prices: now }); return ''; }
  catch (e: any) { return `The item was saved, but its platform prices were not: ${e?.message ?? 'error'}`; }
}

/** The platforms the business takes (its default list) — none: the section is not shown. */
export function usePlatformsTaken(): string[] {
  const [taken, setTaken] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api.get<Array<{ key: string; value: string }>>('/api/business/settings')
      .then((rows) => {
        if (!live) return;
        const enabled = enabledFromSetting((rows ?? []).find((r) => r.key === 'payment_methods_enabled')?.value ?? null);
        setTaken(PLATFORM_METHODS.filter((c) => enabled.includes(c)));
      })
      .catch(() => { if (live) setTaken([]); });
    return () => { live = false; };
  }, []);
  return taken;
}

export default function PlatformPriceFields({ platforms, value, onChange, currency }: {
  platforms: string[]; value: PlatformPriceDraft; onChange: (v: PlatformPriceDraft) => void; currency: string;
}) {
  if (!platforms.length) return null;
  return (
    <div className="border border-gray-800 rounded-lg p-3" data-testid="platform-price-fields">
      <label className="block text-sm text-gray-400 mb-1.5">Delivery platform prices <span className="text-gray-500">(optional)</span></label>
      <div className="grid grid-cols-2 gap-2">
        {platforms.map((c) => (
          <label key={c} className="text-xs text-gray-400">
            {PAYMENT_CATALOGUE.find((m) => m.code === c)?.name ?? c} ({currency})
            <input type="number" min="0" inputMode="decimal" value={value[c] ?? ''} placeholder="The platform's uplift"
              onChange={(e) => onChange({ ...value, [c]: e.target.value })}
              className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-1.5">This item's own price when the platform is the payment method — it wins over the platform's percentage or amount. Blank = the platform's uplift.</p>
    </div>
  );
}
