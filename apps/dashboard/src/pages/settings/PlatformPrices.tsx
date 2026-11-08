/**
 * PlatformPrices — A619 (owner, 2026-11-01: "assume 3 piece chicken is 1000 normal price ordering with glovo it is 1150 a
 * 15% bump so the receipt shows 1150 not the percentage increase but the price in glovo").
 *
 * Each delivery platform's prices: a percentage (+15%: 1,000 → 1,150) or a fixed amount on every item (+250: a 350 soda →
 * 600); blank = normal prices. The business default (Payment methods page, with the rounding — once per business) and a
 * branch's own (Settings › Branches › a branch: its value wins, "Back to the default" clears it). The POS re-prices a sale
 * when the cashier picks the platform as the payment method (lib/platformPrices.ts). An item's own platform price is set
 * on the item (Products › an item › Delivery platform prices).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { PAYMENT_CATALOGUE } from '@zaptill/core/paymentCatalogue';
import {
  PLATFORM_METHODS, PLATFORM_PRICES_KEY, PLATFORM_ROUNDING_KEY, PLATFORM_ROUNDINGS, cleanRules, cleanRounding,
  platformUnitPrice, rulesSettingValue, type PlatformRounding, type PlatformRule, type UpliftKind,
} from '@zaptill/core/platformPrices';

type Draft = Record<string, { kind: UpliftKind; value: string }>;

const draftOf = (rules: Record<string, PlatformRule>): Draft =>
  Object.fromEntries(PLATFORM_METHODS.map((c) => [c, { kind: rules[c]?.kind ?? 'percent', value: rules[c] ? String(rules[c].value) : '' }]));

const nameOf = (code: string) => PAYMENT_CATALOGUE.find((m) => m.code === code)?.name ?? code;

/** "1,000 → 1,150" for the rule as typed, at the business's rounding. */
function example(d: { kind: UpliftKind; value: string }, rounding: PlatformRounding): string {
  const v = Number(d.value);
  if (!(v > 0)) return 'normal prices';
  const to = platformUnitPrice({ unit: 1000 }, { kind: d.kind, value: v }, rounding);
  return `1,000 → ${to.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
}

/** The rules editor: one row per platform switched on (a percentage or an amount per item; blank = normal prices). */
export function PlatformPricesEditor({ value, fallback, platforms, rounding, scope, onSave }: {
  /** The stored rules (JSON) — the branch's own, or the business default on the business page; undefined = not set. */
  value: string | undefined;
  /** The business default a branch falls back to (branch scope only). */
  fallback?: string | undefined;
  /** The platforms to show: those switched on where this applies. */
  platforms: string[];
  rounding: PlatformRounding;
  scope: 'business' | 'branch';
  onSave: (stored: string | null) => void | Promise<void>;
}) {
  const own = value !== undefined;
  const shown = cleanRules(own ? value : fallback);
  const [draft, setDraft] = useState<Draft>(() => draftOf(shown));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(draftOf(cleanRules(value !== undefined ? value : fallback))); }, [value, fallback]);
  const list = PLATFORM_METHODS.filter((c) => platforms.includes(c));
  if (!list.length) return null;

  const save = () => {
    const rules = Object.fromEntries(list.map((c) => [c, { kind: draft[c].kind, value: draft[c].value.trim() }]));
    const stored = rulesSettingValue(rules);
    if (stored === null) { setError('A percentage up to 500, or an amount per item.'); return; }
    setError('');
    void onSave(stored);
  };

  return (
    <div className={scope === 'branch' ? 'border-t border-gray-800 pt-4 mt-4' : ''} data-testid={`platform-prices-${scope}`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Delivery platform prices</div>
          <div className="text-xs text-gray-600 mt-0.5">
            {scope === 'business' ? 'Every branch uses these unless it sets its own. Blank = normal prices.'
              : own ? 'Set for this branch' : 'Using the business default — change any to set this branch\'s own'}
          </div>
        </div>
        {scope === 'branch' && own && (
          <button type="button" onClick={() => void onSave(null)} className="text-xs text-gray-400 hover:text-white underline">Back to the default</button>
        )}
      </div>
      <div className="space-y-1.5">
        {list.map((c) => (
          <div key={c} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-28 text-gray-300 truncate">{nameOf(c)}</span>
            <select value={draft[c].kind} onChange={(e) => setDraft({ ...draft, [c]: { ...draft[c], kind: e.target.value as UpliftKind } })}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 text-xs" aria-label={`${nameOf(c)}: how`}>
              <option value="percent">+ %</option>
              <option value="amount">+ amount per item</option>
            </select>
            <input type="number" min="0" inputMode="decimal" value={draft[c].value} placeholder="0"
              onChange={(e) => setDraft({ ...draft, [c]: { ...draft[c], value: e.target.value } })}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs" aria-label={`${nameOf(c)}: by`} />
            <span className="text-xs text-gray-500">{example(draft[c], rounding)}</span>
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      <button type="button" onClick={save} data-testid={`platform-prices-save-${scope}`}
        className="mt-2 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded-lg px-3 py-1.5">Save platform prices</button>
      <p className="text-xs text-gray-600 mt-2">An item's own platform price (Products › an item) wins over these. The receipt shows the platform price only.</p>
    </div>
  );
}

/** The business-wide rules and the rounding (Payment methods page) — every platform (any branch may switch one on). */
export function BusinessPlatformPrices() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    api.get<Array<{ key: string; value: string }>>('/api/business/settings')
      .then((rows) => { if (live) setSettings(Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]))); })
      .catch(() => { if (live) setSettings({}); });
    return () => { live = false; };
  }, []);
  if (!settings) return null;
  const rounding = cleanRounding(settings[PLATFORM_ROUNDING_KEY]);
  const save = async (key: string, value: string) => {
    setMsg('');
    try {
      const r = await api.post<{ value: string }>('/api/business/settings', { key, value });
      setSettings({ ...settings, [key]: r?.value ?? value });
      setMsg('Saved — the points of sale follow on their next sync.');
    } catch (e: any) { setMsg(e?.message ?? 'Could not save'); }
  };
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
      <PlatformPricesEditor scope="business" value={settings[PLATFORM_PRICES_KEY]} platforms={[...PLATFORM_METHODS]} rounding={rounding}
        onSave={(v) => save(PLATFORM_PRICES_KEY, v ?? '{}')} />
      <label className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
        Round platform prices
        <select value={rounding} onChange={(e) => void save(PLATFORM_ROUNDING_KEY, e.target.value)} data-testid="platform-rounding"
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 text-xs">
          {PLATFORM_ROUNDINGS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <span className="text-xs text-gray-500">— each item's platform price, for every branch</span>
      </label>
      {msg && <p className="text-xs text-gray-400">{msg}</p>}
    </div>
  );
}
