import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import MethodDot from './MethodDot';
import { PAYMENT_CATALOGUE, enabledFromSetting } from '../../shared/paymentCatalogue';

// A429 — Manager → Settings → Payment methods (shared/paymentCatalogue.ts).
// Owner, 2026-10-10: "add them but as toggles — by default the current payment methods are on but the manager can turn
// them on or off; add the others but the manager has to turn them on; per branch is also valid and I like it".
// Every method is a switch for THIS branch: what the tills took before (Cash, M-Pesa, Card, Glovo; On account on the
// web) is on until switched off, the rest off until switched on. Saved on the cloud for the branch (it needs a
// connection); this till uses it at once, the branch's other tills on their next pull, the web POS on its next load.
// A business's own methods (Settings › Payment methods on the web) still show after these.
export default function BranchPaymentMethodsPanel({ canEdit }: { canEdit: boolean }) {
  const [enabled, setEnabled] = useState<string[]>(enabledFromSetting(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.pos.paymentMethodsEnabled().then((r) => setEnabled(enabledFromSetting(r?.enabled ?? null))).catch(() => {});
  }, []);

  const toggle = async (code: string) => {
    if (!canEdit || busy) return;
    const next = enabled.includes(code) ? enabled.filter((c) => c !== code) : [...enabled, code];
    if (!next.some((c) => !PAYMENT_CATALOGUE.find((m) => m.code === c)?.webOnly)) {
      setError('Leave at least one method switched on for the tills.'); return;
    }
    const before = enabled;
    setEnabled(enabledFromSetting(next)); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setPaymentMethodsEnabled(enabledFromSetting(next));
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setEnabled(before);
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  const group = (title: string, delivery: boolean) => (
    <div className="border border-gray-800 rounded-xl p-4">
      <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">{title}</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {PAYMENT_CATALOGUE.filter((m) => (m.kind === 'delivery') === delivery).map((m) => {
          const on = enabled.includes(m.code);
          return (
            <button key={m.code} type="button" role="switch" aria-checked={on} disabled={!canEdit || busy}
              onClick={() => void toggle(m.code)} data-testid={`pay-method-${m.code}`}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800/60 disabled:opacity-60">
              <span className="flex items-center gap-1.5 min-w-0">
                <MethodDot method={m.code} /><span aria-hidden>{m.icon}</span>
                <span className="truncate">{m.name}</span>
                {m.webOnly && <span className="text-[10px] text-gray-500 whitespace-nowrap">web POS only</span>}
              </span>
              <span className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-action-500' : 'bg-gray-700'}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-3" data-testid="payment-methods-panel">
      <div>
        <h3 className="text-white text-sm font-semibold">Payment methods — this branch</h3>
        <p className="text-xs text-gray-400 mt-1">
          The ways to pay this branch takes, on every till and the web POS. Switch on the ones your customers use; old sales
          paid by a method you switch off still show in History and the reports.
        </p>
      </div>
      {group('Money', false)}
      {group('Delivery apps', true)}
      <div className="h-4">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && !error && <span className="text-xs text-gray-300">Saved for this branch</span>}
      </div>
    </div>
  );
}
