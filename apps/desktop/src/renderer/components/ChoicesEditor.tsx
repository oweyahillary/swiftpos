/**
 * ChoicesEditor — resolve and edit a menu item's choices and upgrades.
 *
 * ── THE DISTINCTION THIS SCREEN EXISTS TO MAKE ──────────────────────────────
 * One mechanism was doing two unrelated jobs with nothing to tell them apart:
 *
 *   CHOICE   Normal / Spicy. Free. Preference only. No price column at all,
 *            because a price here is a category error rather than a valid value.
 *   UPGRADE  Regular / Medium +30 / Large +50. A ladder, where the first option
 *            is the included baseline at zero and the rest are what a customer
 *            pays to trade up.
 *
 * Because they were indistinguishable, a receipt could not tell "prefers spicy"
 * from "paid 60 more", and this screen could not know whether to show a price box.
 *
 * ── WHY 'REVIEW' IS LOUD ────────────────────────────────────────────────────
 * Migration 45 classified what it could and refused to guess at the rest. Those
 * groups still work exactly as they did, so nothing is broken — but they cannot be
 * priced correctly until a human says what they are, and a quiet "unknown" state
 * is one nobody ever clears. Hence amber, at the top, with the reason spelled out.
 *
 * ── THE BASELINE RULE ───────────────────────────────────────────────────────
 * An upgrade ladder needs one option at zero. Without it there is no "regular",
 * and making the group required charges every customer the cheapest step as a
 * minimum — which is precisely the state Cake / Size is in today.
 */

import { useCallback, useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { VariantKind } from '../lib/posApi';

interface Option {
  id: string;
  name: string;
  price_adjustment: number;
  sort_order: number;
}
interface Group {
  id: string;
  name: string;
  required: boolean;
  kind: VariantKind;
  variant_options?: Option[];
  options?: Option[];
}

const KIND_LABEL: Record<VariantKind, string> = {
  choice: 'Choice', upgrade: 'Upgrade', review: 'Needs review',
};

const KIND_HELP: Record<VariantKind, string> = {
  choice:  'Free preference — the customer picks one and the price does not change.',
  upgrade: 'Priced ladder — one option must be the included baseline at 0.',
  review:  'Not yet classified. It still works as before, but cannot be priced properly until you say what it is.',
};

export default function ChoicesEditor({
  productId, currency, onChanged,
}: { productId: string; currency: string; onChanged?: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const g = await posApi.manage.listVariantGroups(productId);
      setGroups(Array.isArray(g) ? g : []);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not load choices');
    } finally { setLoading(false); }
  }, [productId]);

  useEffect(() => { void load(); }, [load]);

  const optionsOf = (g: Group): Option[] =>
    [...(g.variant_options ?? g.options ?? [])].sort((a, b) => a.sort_order - b.sort_order);

  const setKind = async (g: Group, kind: VariantKind) => {
    setBusy(g.id);
    try {
      await posApi.manage.updateVariantGroup(g.id, { kind });
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message ?? 'Could not change the type');
    } finally { setBusy(null); }
  };

  const savePrice = async (opt: Option) => {
    const raw = drafts[opt.id];
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) { setError(`"${raw}" is not a valid amount`); return; }
    if (value === Number(opt.price_adjustment)) {
      setDrafts(d => { const { [opt.id]: _, ...rest } = d; return rest; });
      return;
    }
    setBusy(opt.id);
    try {
      await posApi.manage.updateVariantOption(opt.id, { price_adjustment: value });
      setDrafts(d => { const { [opt.id]: _, ...rest } = d; return rest; });
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message ?? 'Could not save');
    } finally { setBusy(null); }
  };

  if (loading) return <p className="text-xs text-gray-500">Loading choices…</p>;

  const review = groups.filter(g => g.kind === 'review');

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Loud, and first. A quiet unknown state is one nobody ever clears. */}
      {review.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
          <p className="text-xs text-amber-200 font-medium">
            {review.length === 1 ? '1 group needs review' : `${review.length} groups need review`}
          </p>
          <p className="text-[11px] text-amber-300/80 mt-0.5">
            Still working as before. Say whether each is a free choice or a priced
            upgrade so it can be shown and printed correctly.
          </p>
        </div>
      )}

      {groups.length === 0 && (
        <p className="text-xs text-gray-500">No choices or upgrades on this item.</p>
      )}

      {groups.map(g => {
        const opts = optionsOf(g);
        const hasBaseline = opts.some(o => Number(o.price_adjustment) === 0);
        const hasPriced = opts.some(o => Number(o.price_adjustment) !== 0);
        return (
          <div
            key={g.id}
            className={`border rounded-lg p-2.5 space-y-2 ${
              g.kind === 'review' ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-700'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-white font-medium">{g.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                {g.required ? 'required' : 'optional'}
              </span>
              <div className="ml-auto flex rounded-md overflow-hidden border border-gray-700">
                {(['choice', 'upgrade'] as VariantKind[]).map(k => (
                  <button
                    key={k}
                    disabled={busy === g.id}
                    onClick={() => setKind(g, k)}
                    className={`px-2 py-1 text-[11px] transition-colors ${
                      g.kind === k ? 'bg-green-500/15 text-green-400' : 'bg-gray-800 text-gray-400 hover:text-white'
                    } disabled:opacity-50`}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-gray-500">{KIND_HELP[g.kind]}</p>

            {/* The fault that put Cake / Size into review. Shown against the item
                rather than in a report, because this is where it gets fixed. */}
            {g.kind === 'upgrade' && !hasBaseline && (
              <p className="text-[11px] text-amber-400">
                No option at 0 — there is no "regular" here, so every customer pays
                at least the cheapest step. Set one option to 0.
              </p>
            )}
            {g.kind === 'choice' && hasPriced && (
              <p className="text-[11px] text-amber-400">
                Switching to Choice will set every price here to 0.
              </p>
            )}

            <div className="space-y-1">
              {opts.map(o => (
                <div key={o.id} className="flex items-center gap-2">
                  <span className="text-sm text-gray-300 flex-1">{o.name}</span>
                  {g.kind === 'choice' ? (
                    // No price box at all. A choice cannot carry a price, and an
                    // input showing 0 invites someone to type into it.
                    <span className="text-xs text-gray-600">free</span>
                  ) : (
                    <>
                      <span className="text-[11px] text-gray-500">{currency}</span>
                      <input
                        type="number" min={0} step="0.01" inputMode="decimal"
                        value={drafts[o.id] ?? String(o.price_adjustment ?? 0)}
                        onChange={e => setDrafts(d => ({ ...d, [o.id]: e.target.value }))}
                        onBlur={() => savePrice(o)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        disabled={busy === o.id}
                        className="w-20 text-right tabular-nums bg-gray-900 border border-gray-700
                                   rounded px-2 py-1 text-white text-xs disabled:opacity-50"
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
