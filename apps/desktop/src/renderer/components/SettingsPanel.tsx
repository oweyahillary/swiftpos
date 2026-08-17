import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import PaymentMethodsPanel from './PaymentMethodsPanel';

// The till's Settings screen (A104) — business-wide options plus the payment
// methods manager moved in here. 24-hour operation controls whether an unclosed
// prior day hard-locks the till at rollover or gets a short grace window first.
export default function SettingsPanel({ canEdit = true }: { canEdit?: boolean }) {
  const [continuous, setContinuous] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.manage.getContinuousOperation()
      .then(r => setContinuous(!!r?.enabled))
      .catch(() => setContinuous(false));
  }, []);

  const toggle = async () => {
    if (!canEdit || continuous === null) return;
    const next = !continuous;
    setContinuous(next); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setContinuousOperation(next);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setContinuous(!next);                       // roll back the optimistic flip
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Settings</h2>
        <p className="text-sm text-gray-400 mt-1">Business-wide options for every till.</p>
      </div>

      {/* 24-hour operation */}
      <section>
        <div className="flex items-start justify-between gap-4 border border-gray-800 rounded-xl p-4">
          <div className="flex-1">
            <p className="text-white text-sm font-medium">24-hour operation</p>
            <p className="text-xs text-gray-400 mt-1">
              For a business that never closes overnight. When on, an unclosed trading
              day doesn't stop the till the moment the date changes — it keeps running
              for a 2-hour grace window behind a reminder, so a manager can count the
              cash and close the day without halting service. After the grace window
              the till still locks until the day is closed. Off: the till locks
              immediately at rollover, as before.
            </p>
          </div>
          <button
            onClick={toggle}
            disabled={!canEdit || busy || continuous === null}
            role="switch"
            aria-checked={continuous === true}
            className={`shrink-0 w-12 h-7 rounded-full transition-colors relative disabled:opacity-40 ${
              continuous ? 'bg-green-500' : 'bg-gray-700'
            }`}
          >
            <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${
              continuous ? 'left-6' : 'left-1'
            }`} />
          </button>
        </div>
        <div className="h-4 mt-1">
          {error && <span className="text-xs text-red-400">{error}</span>}
          {saved && !error && <span className="text-xs text-emerald-400">Saved</span>}
        </div>
      </section>

      {/* Payment methods, moved here from its own tab. */}
      <section className="border-t border-gray-800 pt-6">
        <PaymentMethodsPanel canEdit={canEdit} />
      </section>
    </div>
  );
}
