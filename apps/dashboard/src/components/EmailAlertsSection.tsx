/**
 * EmailAlertsSection — A627 W3: a person's EMAIL alert toggles. One toggle per alert their rights permit (the cloud filters
 * the list); OFF opts them out of that alert, overriding the automatic include. `path` is the GET/PUT endpoint —
 * `/api/staff/<id>/notification-prefs` for a staff member, `/api/staff/me/notification-prefs` for the signed-in person.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Alert { key: string; label: string; description: string; enabled: boolean }

export default function EmailAlertsSection({ path, canEdit = true }: { path: string; canEdit?: boolean }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.get<{ alerts: Alert[] }>(path).then((r) => { if (live) setAlerts(r.alerts ?? []); }).catch(() => { if (live) setAlerts([]); });
    return () => { live = false; };
  }, [path]);

  const toggle = async (a: Alert) => {
    if (!canEdit || busy) return;
    const enabled = !a.enabled;
    setBusy(a.key); setError('');
    try {
      await api.put(path, { alert_type: a.key, enabled });   // A627: a bare path var (not a template literal) so check-api-routes resolves it, like the GET above
      setAlerts((cur) => (cur ?? []).map((x) => (x.key === a.key ? { ...x, enabled } : x)));
    } catch (e: any) { setError(e?.message ?? 'Could not save that change.'); } finally { setBusy(null); }
  };

  if (alerts === null) return <p className="text-xs text-gray-500">Loading email alerts…</p>;
  if (!alerts.length) return <p className="text-xs text-gray-500" data-testid="email-alerts-none">No email alerts — this person sees none of the reports an alert is based on.</p>;

  return (
    <div data-testid="email-alerts" className="space-y-2.5">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {alerts.map((a) => (
        <div key={a.key} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-white">{a.label}</p>
            <p className="text-xs text-gray-500">{a.description}</p>
          </div>
          <button type="button" disabled={!canEdit || busy === a.key} aria-pressed={a.enabled}
            data-testid={`email-alert-${a.key}`} onClick={() => toggle(a)}
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 disabled:opacity-60 ${a.enabled ? 'bg-swift-strong' : 'bg-gray-700'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${a.enabled ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
      ))}
    </div>
  );
}
