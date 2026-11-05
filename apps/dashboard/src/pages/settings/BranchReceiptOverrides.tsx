import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cleanCutoff, cutoffLabel, MAX_CUTOFF_MINUTES } from '@zaptill/core/businessDay';   // 0.6.34
import { cleanHistoryMethods } from '@zaptill/core/cashierHistory';   // 0.6.37 (A387)
import HistoryMethodsPicker from './HistoryMethodsPicker';
import BranchPaymentMethods from './BranchPaymentMethods';   // A429
import { PlatformPricesEditor } from './PlatformPrices';   // A619
import { enabledFromSetting } from '@zaptill/core/paymentCatalogue';
import { cleanRounding } from '@zaptill/core/platformPrices';
import { mpesaDescribe, type MpesaReceive } from '@zaptill/core/mpesaReceive';   // A492
import { CATEGORY_LAYOUT_KEY, CATEGORY_LAYOUT_PERMISSIONS, CATEGORY_LAYOUT_WORDS, categoryLayoutOf } from '@zaptill/core/categoryLayout';   // 8n
import { usePermissions } from '../../context/PermissionsContext';

/**
 * 8n (owner, 2026-11-05: categories in the side panel or across the top, "toggled per branch by the manager"): this
 * branch's POS — the desktop POS and the web POS — show the categories one way or the other. Two choices, the same words
 * as the desktop's Manager › Settings; no choice saved = the side panel. Changed with settings.pos_layout or
 * settings.branches (the cloud checks again); anyone else sees the choice, greyed.
 */
function BranchCategoryLayout({ value, onSave }: { value: string | undefined; onSave: (v: string) => void }) {
  const { can } = usePermissions();
  const mayChange = CATEGORY_LAYOUT_PERMISSIONS.some((k) => can(k));
  const layout = categoryLayoutOf(value);
  return (
    <div className="border-t border-gray-800 pt-4" data-testid="branch-category-layout">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{CATEGORY_LAYOUT_WORDS.title}</div>
      <div className="text-xs text-gray-600 mt-0.5">{CATEGORY_LAYOUT_WORDS.explain}</div>
      <div role="radiogroup" aria-label={CATEGORY_LAYOUT_WORDS.title} className="grid gap-2 sm:grid-cols-2 mt-3">
        {CATEGORY_LAYOUT_WORDS.options.map((o) => {
          const on = layout === o.value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} data-testid={`category-layout-${o.value}`}
              disabled={!mayChange} onClick={() => { if (!on && mayChange) onSave(o.value); }}
              className={`min-h-[48px] rounded-lg border px-3.5 py-2 text-left transition-colors disabled:opacity-60 ${
                on ? 'border-swift bg-swift/10 text-white' : 'border-gray-800 text-gray-300 hover:border-gray-600'}`}>
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-xs text-gray-500 mt-0.5">{o.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A492: what this branch's customers pay to by M-Pesa — read-only on the web; set on the branch's till by its manager. */
function BranchMpesaLine({ branchId }: { branchId: string }) {
  const [v, setV] = useState<{ own: MpesaReceive | null; inherited: MpesaReceive | null } | null>(null);
  useEffect(() => {
    let live = true;
    api.get<{ own: MpesaReceive | null; inherited: MpesaReceive | null }>(`/api/branches/${branchId}/mpesa`)
      .then((r) => { if (live) setV(r); }).catch(() => { if (live) setV(null); });
    return () => { live = false; };
  }, [branchId]);
  return (
    <div data-testid="branch-mpesa">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pay by M-Pesa</p>
      <p className="text-sm text-gray-300">
        {v?.own ? mpesaDescribe(v.own) : v?.inherited ? `Not set for this branch — receipts print the business-wide ${mpesaDescribe(v.inherited)}` : 'Not set for this branch'}
      </p>
      <p className="text-gray-500 text-xs mt-1">Set on the branch's POS by its manager: Manager › Settings › M-Pesa. You are notified whenever it changes.</p>
    </div>
  );
}

// A139: per-branch receipt text + hours that override the business default for a
// franchise branch. A branch either INHERITS the business default (no row) or
// OVERRIDES it (a row). The till resolves this server-side in /pos/init.

const TEXT_FIELDS = [
  { key: 'receipt_header', label: 'Receipt header' },
  { key: 'receipt_footer', label: 'Receipt footer' },
] as const;
// A492: the branch's M-Pesa number is no longer edited here — its manager sets it on the branch's till (Manager ›
// Settings › M-Pesa); this page shows it (BranchMpesaLine).

export default function BranchReceiptOverrides({ branchId }: { branchId: string }) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [defaults, setDefaults]   = useState<Record<string, string>>({});
  const [loading, setLoading]     = useState(true);
  const [toast, setToast]         = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<Record<string, string>>(`/api/branches/${branchId}/settings`),
      api.get<Array<{ key: string; value: string }>>(`/api/business/settings`),
    ]).then(([ov, biz]) => {
      if (!live) return;
      setOverrides(ov ?? {});
      const d: Record<string, string> = {};
      for (const r of biz ?? []) d[r.key] = r.value;
      setDefaults(d);
    }).catch(() => { if (live) showToast('Could not load branch overrides'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId]);

  async function save(key: string, value: string | null) {
    try {
      await api.post(`/api/branches/${branchId}/settings`, { key, value });
      setOverrides(prev => {
        const next = { ...prev };
        if (value === null) delete next[key]; else next[key] = value;
        return next;
      });
      showToast(value === null ? 'Reverted to business default' : 'Saved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save');
    }
  }

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>;

  const contOverridden = 'continuous_operation' in overrides;
  const contDefaultOn  = defaults.continuous_operation === 'true';
  const contValueOn    = contOverridden ? overrides.continuous_operation === 'true' : contDefaultOn;
  // A416: a cashier closing a shift sees their sales — this branch's own, or the business default (off unless set).
  const salesOverridden = 'cashier_sees_shift_sales' in overrides;
  const salesDefaultOn  = defaults.cashier_sees_shift_sales === 'true';
  const salesValueOn    = salesOverridden ? overrides.cashier_sees_shift_sales === 'true' : salesDefaultOn;
  // A418: the History total — only while the switch above is on at this branch.
  const totalsOverridden = 'cashier_history_totals' in overrides;
  const totalsDefaultOn  = defaults.cashier_history_totals === 'true';
  const totalsValueOn    = salesValueOn && (totalsOverridden ? overrides.cashier_history_totals === 'true' : totalsDefaultOn);
  // 0.6.34: the business-day end — the branch's own, or the business default.
  const cutOverridden  = 'business_day_cutoff' in overrides;
  const cutDefault     = cutoffLabel(cleanCutoff(defaults.business_day_cutoff) ?? 0);
  // 0.6.37 (A387): the methods a cashier's History shows — the branch's own, or the business default.
  const hmOverridden   = 'cashier_history_methods' in overrides;
  const hmDefault      = cleanHistoryMethods(defaults.cashier_history_methods ?? null) ?? [];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 left-4 sm:left-auto bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
      )}
      <div>
        <h2 className="text-white font-semibold">Receipt &amp; hours for this branch</h2>
        <p className="text-gray-500 text-xs mt-0.5">Overrides the business-wide defaults for this branch only. Leave inheriting to follow the business setting.</p>
      </div>

      {TEXT_FIELDS.map(f => {
        const overridden = f.key in overrides;
        return (
          <div key={f.key} className="border-t border-gray-800 pt-4 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{f.label}</label>
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox" checked={overridden}
                  onChange={e => e.target.checked ? save(f.key, defaults[f.key] ?? '') : save(f.key, null)}
                />
                Override for this branch
              </label>
            </div>
            {overridden ? (
              <textarea
                rows={3}
                value={overrides[f.key] ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, [f.key]: e.target.value }))}
                onBlur={e => save(f.key, e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift resize-y"
              />
            ) : (
              <div className="text-sm text-gray-500 bg-gray-950/60 border border-gray-800/60 rounded-lg px-3.5 py-2.5 whitespace-pre-wrap min-h-[2.5rem]">
                {defaults[f.key]?.trim() ? defaults[f.key] : <span className="italic text-gray-600">Using business default (empty)</span>}
              </div>
            )}
          </div>
        );
      })}

      <div className="border-t border-gray-800 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">24-hour operation</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {contOverridden ? 'Overridden for this branch' : `Using business default (${contDefaultOn ? 'On' : 'Off'})`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {contOverridden && (
              <button
                onClick={() => save('continuous_operation', contValueOn ? 'false' : 'true')}
                className={`w-11 h-6 rounded-full transition-colors relative ${contValueOn ? 'bg-swift-strong' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${contValueOn ? 'left-5' : 'left-0.5'}`} />
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox" checked={contOverridden}
                onChange={e => e.target.checked ? save('continuous_operation', contDefaultOn ? 'true' : 'false') : save('continuous_operation', null)}
              />
              Override
            </label>
          </div>
        </div>
        <div className="flex items-center justify-between mt-4">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Cashiers see their sales at close</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {salesOverridden ? 'Overridden for this branch' : `Using business default (${salesDefaultOn ? 'On' : 'Off'})`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {salesOverridden && (
              <button data-testid="branch-sees-sales-toggle"
                onClick={() => save('cashier_sees_shift_sales', salesValueOn ? 'false' : 'true')}
                className={`w-11 h-6 rounded-full transition-colors relative ${salesValueOn ? 'bg-swift-strong' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${salesValueOn ? 'left-5' : 'left-0.5'}`} />
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox" checked={salesOverridden}
                onChange={e => e.target.checked ? save('cashier_sees_shift_sales', salesDefaultOn ? 'true' : 'false') : save('cashier_sees_shift_sales', null)}
              />
              Override
            </label>
          </div>
        </div>
        <div className={`flex items-center justify-between mt-4 ${salesValueOn ? '' : 'opacity-50'}`}>
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Cashiers see a total in History</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {!salesValueOn ? 'Needs "Cashiers see their sales at close" on'
                : totalsOverridden ? 'Overridden for this branch' : `Using business default (${totalsDefaultOn ? 'On' : 'Off'})`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {totalsOverridden && (
              <button data-testid="branch-history-totals-toggle" disabled={!salesValueOn}
                onClick={() => save('cashier_history_totals', totalsValueOn ? 'false' : 'true')}
                className={`w-11 h-6 rounded-full transition-colors relative disabled:cursor-not-allowed ${totalsValueOn ? 'bg-swift-strong' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${totalsValueOn ? 'left-5' : 'left-0.5'}`} />
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox" checked={totalsOverridden} disabled={!salesValueOn}
                onChange={e => e.target.checked ? save('cashier_history_totals', totalsDefaultOn ? 'true' : 'false') : save('cashier_history_totals', null)}
              />
              Override
            </label>
          </div>
        </div>
      </div>

      {/* 0.6.34: this branch's own business-day end (e.g. a branch with a late bar). */}
      <div className="border-t border-gray-800 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Business day ends at</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {cutOverridden ? 'Overridden for this branch' : `Using business default (${cutDefault})`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {cutOverridden && (
              <select
                value={cutoffLabel(cleanCutoff(overrides.business_day_cutoff) ?? 0)}
                onChange={e => save('business_day_cutoff', e.target.value)}
                data-testid="branch-day-cutoff"
                className="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1 text-white text-xs"
              >
                {Array.from({ length: MAX_CUTOFF_MINUTES / 30 + 1 }, (_, i) => cutoffLabel(i * 30))
                  .map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox" checked={cutOverridden}
                onChange={e => e.target.checked ? save('business_day_cutoff', cutDefault) : save('business_day_cutoff', null)}
              />
              Override
            </label>
          </div>
        </div>
      </div>

      {/* 8n: how this branch's POS shows its categories — the side panel or the top bar. */}
      <BranchCategoryLayout value={overrides[CATEGORY_LAYOUT_KEY]} onSave={(v) => save(CATEGORY_LAYOUT_KEY, v)} />

      {/* 0.6.37 (A387): this branch's own choice of what cashiers see in History. */}
      <div className="border-t border-gray-800 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">What cashiers see in History</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {hmOverridden ? 'Overridden for this branch'
                : `Using business default (${hmDefault.length ? hmDefault.join(', ') : 'every method'})`}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox" checked={hmOverridden}
              onChange={e => e.target.checked ? save('cashier_history_methods', JSON.stringify(hmDefault)) : save('cashier_history_methods', null)}
            />
            Override
          </label>
        </div>
        {hmOverridden && (
          <div className="mt-3">
            <HistoryMethodsPicker value={overrides.cashier_history_methods}
              onChange={(list) => save('cashier_history_methods', JSON.stringify(list))} />
          </div>
        )}
        {/* A429: the payment methods this branch takes — each a switch. */}
        <BranchPaymentMethods override={overrides.payment_methods_enabled} businessDefault={defaults.payment_methods_enabled}
          onSave={(v) => save('payment_methods_enabled', v)} />
        {/* A619: this branch's delivery platform prices — only the platforms it takes (the rounding is the business's). */}
        <PlatformPricesEditor scope="branch" value={overrides.delivery_platform_prices} fallback={defaults.delivery_platform_prices}
          platforms={enabledFromSetting(overrides.payment_methods_enabled ?? defaults.payment_methods_enabled ?? null)}
          rounding={cleanRounding(defaults.delivery_platform_rounding)} onSave={(v) => save('delivery_platform_prices', v)} />
        {/* A492: the branch's M-Pesa number — shown; set on the branch's till by its manager. */}
        <div className="mt-4"><BranchMpesaLine branchId={branchId} /></div>
      </div>
    </div>
  );
}
