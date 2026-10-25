import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { usePermissions } from '../../context/PermissionsContext';
import { WatchListLocked, LOSS_OFF_CODE } from '../WatchListPage';   // A580: premium only

// Settings › Business › Loss prevention — A576. The owner's switches for the watch list (pages/WatchListPage.tsx):
// which patterns are watched (only those that fit this kind of business), the amounts, and who is told. The cloud keeps
// them (GET / PUT /api/loss-alerts/settings, owner only) and cleans what is saved (lib/lossAlertRules.ts).
//
// Owner, 2026-10-23: a WARNING ONLY, for investigation; to the owner and managers, never on the cashier's screen.

export type NumKey = 'paid_void_count' | 'void_count' | 'refund_count' | 'peer_multiple' | 'discount_percent' | 'discount_amount'
  | 'big_discount_count' | 'discount_count' | 'free_count' | 'cash_tolerance' | 'cash_repeat' | 'price_count' | 'kitchen_count' | 'parking_count';
export interface LossSettings {
  enabled: boolean;
  kinds: Record<string, boolean>;
  recipients: { owner: boolean; partners: boolean; managers: boolean };
  daily_email: boolean;
  [k: string]: unknown;
}
export interface LossSettingsView {
  settings: LossSettings; defaults: LossSettings; limits: Record<NumKey, [number, number]>;
  kinds: Array<{ kind: string; label: string; hint: string }>; needs_data: string[]; business_type: string | null;
}

/** The amounts each kind is tuned by, in words around the box. */
export const KIND_FIELDS: Record<string, Array<{ key: NumKey; before: string; after: string }>> = {
  paid_voids:         [{ key: 'paid_void_count', before: 'At least', after: 'in a day' }],
  many_voids:         [{ key: 'void_count', before: 'At least', after: 'in a day, and well above the others' }],
  many_refunds:       [{ key: 'refund_count', before: 'At least', after: 'in a day, and well above the others' }],
  big_discounts:      [{ key: 'discount_percent', before: 'A discount of', after: '% of the bill' },
                       { key: 'discount_amount', before: 'or an amount of', after: 'or more' },
                       { key: 'big_discount_count', before: 'At least', after: 'such discounts in a day' }],
  frequent_discounts: [{ key: 'discount_count', before: 'At least', after: 'typed-in discounts in a day, and well above the others' }],
  free_sales:         [{ key: 'free_count', before: 'At least', after: 'in a day' }],
  cash_short:         [{ key: 'cash_tolerance', before: 'Short or over by', after: 'or more' },
                       { key: 'cash_repeat', before: 'Or short', after: 'times in 7 days' }],
  price_below_list:   [{ key: 'price_count', before: 'At least', after: 'in a day' }],
  kitchen_removed:    [{ key: 'kitchen_count', before: 'At least', after: 'items in a day, and well above the others' }],
  parking_no_charge:  [{ key: 'parking_count', before: 'At least', after: 'in a day at a branch, more than usual' }],
};

function Toggle({ on, onClick, testId, label }: { on: boolean; onClick: () => void; testId?: string; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} data-testid={testId}
      className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${on ? 'bg-swift-strong' : 'bg-gray-700'}`}>
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-5' : 'left-0.5'}`} />
    </button>
  );
}

export function LossAlertsSettingsView({ view, value, onChange, onSave, saving, saved, error }: {
  view: LossSettingsView; value: LossSettings; onChange: (next: LossSettings) => void;
  onSave?: () => void; saving?: boolean; saved?: boolean; error?: string;
}) {
  const s = value;
  const set = (patch: Partial<LossSettings>) => onChange({ ...s, ...patch });
  const num = (k: NumKey) => (s[k] as number | undefined) ?? (view.defaults[k] as number);
  const setNum = (k: NumKey, raw: string) => {
    const n = Number(raw);
    set({ [k]: raw === '' || !Number.isFinite(n) ? undefined : n } as Partial<LossSettings>);
  };
  const box = (k: NumKey) => (
    <input type="number" min={view.limits[k]?.[0]} max={view.limits[k]?.[1]} value={num(k)} data-testid={`loss-${k}`}
      onChange={(e) => setNum(k, e.target.value)}
      className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift w-24" />
  );

  return (
    <div className="p-4 sm:p-6 max-w-2xl space-y-6" data-testid="loss-settings">
      <div>
        <h3 className="text-white font-semibold mb-1">Loss prevention</h3>
        <p className="text-gray-500 text-sm">
          ZapTill watches for unusual patterns — per branch and per staff member, today and over the last 7 days — and lists the
          ten most worth a look on the Watch list. A warning to look into, never an accusation. Nothing is shown on the POS.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
        <div>
          <p className="text-white text-sm font-medium">Watch for unusual patterns</p>
          <p className="text-gray-500 text-xs">Worked out every hour from what the points of sale send.</p>
        </div>
        <Toggle on={s.enabled} onClick={() => set({ enabled: !s.enabled })} testId="loss-enabled" label="Watch for unusual patterns" />
      </div>

      {s.enabled && (
        <>
          <div data-testid="loss-kinds">
            <h3 className="text-white font-semibold mb-1">What to watch</h3>
            <p className="text-gray-500 text-xs mb-3">Only what fits your kind of business is listed.</p>
            <div className="space-y-3">
              {view.kinds.map((k) => {
                const on = s.kinds[k.kind] !== false;
                return (
                  <div key={k.kind} className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3" data-testid={`loss-kind-${k.kind}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-white text-sm font-medium">{k.label}</p>
                        <p className="text-gray-500 text-xs">{k.hint}</p>
                      </div>
                      <Toggle on={on} onClick={() => set({ kinds: { ...s.kinds, [k.kind]: !on } })} testId={`loss-toggle-${k.kind}`} label={k.label} />
                    </div>
                    {on && (KIND_FIELDS[k.kind] ?? []).map((f) => (
                      <label key={f.key} className="flex flex-wrap items-center gap-2 mt-3 text-xs text-gray-400">
                        {f.before}{box(f.key)}{f.after}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
            <p className="text-white text-sm font-medium">"Well above the others"</p>
            <label className="flex flex-wrap items-center gap-2 mt-2 text-xs text-gray-400">
              At least{box('peer_multiple')}times what the others at the branch usually do — and more than any of them.
            </label>
          </div>

          <div data-testid="loss-recipients">
            <h3 className="text-white font-semibold mb-1">Who is told</h3>
            <p className="text-gray-500 text-xs mb-3">In the dashboard's notifications (the bell). Nobody is ever told about themselves.</p>
            <div className="space-y-2.5">
              {([
                ['owner', 'You (the owner)', ''],
                ['partners', 'Partners', 'Staff you gave web dashboard access — for their branches'],
                ['managers', 'Managers', 'Anyone allowed to see Reports › Voids & Exceptions — for their branch'],
              ] as const).map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer" data-testid={`loss-to-${key}`}>
                  <input type="checkbox" className="mt-0.5 w-4 h-4" checked={s.recipients[key]}
                    onChange={() => set({ recipients: { ...s.recipients, [key]: !s.recipients[key] } })} />
                  <span>
                    <span className="text-gray-300 text-sm">{label}</span>
                    {hint && <span className="block text-gray-600 text-xs">{hint}</span>}
                  </span>
                </label>
              ))}
              <label className="flex items-start gap-3 cursor-pointer" data-testid="loss-daily-email">
                <input type="checkbox" className="mt-0.5 w-4 h-4" checked={s.daily_email} onChange={() => set({ daily_email: !s.daily_email })} />
                <span>
                  <span className="text-gray-300 text-sm">Also in the daily email</span>
                  <span className="block text-gray-600 text-xs">The day's list under "Worth a look", when the daily email is on (Integrations › Daily Report Email).</span>
                </span>
              </label>
            </div>
          </div>
        </>
      )}

      {view.needs_data.length > 0 && (
        <div className="bg-gray-800/30 border border-gray-700 rounded-xl px-4 py-3" data-testid="loss-needs-data">
          <p className="text-gray-300 text-sm font-medium">Not watched yet — the points of sale do not record it</p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            {view.needs_data.map((t) => <li key={t} className="text-gray-500 text-xs">{t}</li>)}
          </ul>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {saved && <p className="text-swift-text text-sm">✓ Saved</p>}
      {onSave && (
        <button onClick={onSave} disabled={saving}
          className="px-6 py-2.5 bg-swift-strong hover:bg-swift-deep disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}

export default function LossAlertsTab() {
  const { isOwner } = usePermissions();
  const [view, setView] = useState<LossSettingsView | null>(null);
  const [value, setValue] = useState<LossSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState<string | null>(null);   // A580: not premium — the cloud's words

  useEffect(() => {
    if (!isOwner) return;
    api.get<LossSettingsView>('/api/loss-alerts/settings')
      .then((v) => { setView(v); setValue(v.settings); })
      .catch((e) => { if (e?.code === LOSS_OFF_CODE) setLocked(e?.message ?? ''); else setError(e?.message ?? 'Could not load the settings'); });
  }, [isOwner]);

  if (!isOwner) return <div className="p-4 sm:p-6 text-gray-500 text-sm">Only the owner can change loss-prevention alerts.</div>;
  if (locked !== null) return <WatchListLocked message={locked} />;   // A580 (owner, 2026-10-23): premium, as Analytics
  if (!view || !value) return <div className="p-4 sm:p-6 text-gray-500 text-sm">{error || 'Loading…'}</div>;

  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const v = await api.put<LossSettingsView>('/api/loss-alerts/settings', { settings: value });
      setView(v); setValue(v.settings); setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e?.message ?? 'Could not save'); }
    finally { setSaving(false); }
  };
  return <LossAlertsSettingsView view={view} value={value} onChange={setValue} onSave={save} saving={saving} saved={saved} error={error} />;
}
