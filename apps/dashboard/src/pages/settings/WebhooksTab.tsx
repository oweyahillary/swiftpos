import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

// Outbound webhook endpoints. Extracted verbatim from SettingsPage (register
// A133) so Integrations and the legacy Staff page share one copy (rule 17).

interface Webhook {
  id: string; url: string; events: string[]; status: string;
  created_at: string; secret?: string;
}

// A146: a single delivery attempt, from GET /api/webhooks/:id/deliveries.
interface Delivery {
  id: string; event: string; response_status: number | null;
  response_body: string | null; attempt_count: number;
  delivered_at: string | null; created_at: string;
}

export default function WebhooksTab() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [hooks,     setHooks]     = useState<Webhook[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [showForm,  setShowForm]  = useState(false);
  const [formUrl,   setFormUrl]   = useState('');
  const [formEvents,setFormEvents]= useState<string[]>(['order.completed']);
  const [saving,    setSaving]    = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error,     setError]     = useState('');

  // A146: webhook observability — test-send + per-hook delivery log.
  const [testBusy,    setTestBusy]    = useState<string | null>(null);
  const [testResult,  setTestResult]  = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [openLog,     setOpenLog]     = useState<string | null>(null);
  const [logs,        setLogs]        = useState<Record<string, Delivery[]>>({});
  const [logBusy,     setLogBusy]     = useState<string | null>(null);

  const sendTest = async (wh: Webhook) => {
    setTestBusy(wh.id);
    setTestResult(r => { const { [wh.id]: _drop, ...rest } = r; return rest; });
    try {
      const res = await api.post<{ success?: boolean; error?: string; response_status?: number }>(`/api/webhooks/${wh.id}/test`, {});
      const ok = res?.success !== false;
      setTestResult(r => ({ ...r, [wh.id]: {
        ok,
        msg: ok
          ? `Test ping sent${res?.response_status ? ` (HTTP ${res.response_status})` : ''}`
          : (res?.error ?? 'Test failed'),
      } }));
      if (openLog === wh.id) loadLog(wh);   // refresh the log if it's open
    } catch (e: any) {
      setTestResult(r => ({ ...r, [wh.id]: { ok: false, msg: e?.message ?? 'Test failed' } }));
    } finally { setTestBusy(null); }
  };

  const loadLog = async (wh: Webhook) => {
    setLogBusy(wh.id);
    try {
      const data = await api.get<Delivery[]>(`/api/webhooks/${wh.id}/deliveries`) ?? [];
      setLogs(l => ({ ...l, [wh.id]: data }));
    }
    catch (e: any) { setError(e?.message ?? 'Could not load deliveries'); }
    finally { setLogBusy(null); }
  };

  const toggleLog = (wh: Webhook) => {
    if (openLog === wh.id) { setOpenLog(null); return; }
    setOpenLog(wh.id);
    if (!logs[wh.id]) loadLog(wh);
  };

  const ALL_EVENTS = ['order.completed', 'order.voided'];

  const load = useCallback(async () => {
    setLoading(true);
    try { setHooks(await api.get<Webhook[]>('/api/webhooks') ?? []); }
    catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!formUrl.trim() || !formUrl.startsWith('http')) { setError('Enter a valid URL'); return; }
    if (!formEvents.length) { setError('Select at least one event'); return; }
    setSaving(true); setError('');
    try {
      const wh = await api.post<Webhook & { secret: string }>('/api/webhooks', { url: formUrl.trim(), events: formEvents });
      setNewSecret(wh.secret);
      setFormUrl(''); setFormEvents(['order.completed']); setShowForm(false);
      await load();
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setSaving(false); }
  };

  const toggle = async (wh: Webhook) => {
    try {
      await api.patch(`/api/webhooks/${wh.id}`, { status: wh.status === 'active' ? 'inactive' : 'active' });
      setHooks(h => h.map(x => x.id === wh.id ? { ...x, status: x.status === 'active' ? 'inactive' : 'active' } : x));
    } catch { /* silent */ }
  };

  const remove = async (id: string) => {
    showConfirm({
      title: 'Delete webhook?',
      message: 'This endpoint will stop receiving events immediately.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/webhooks/${id}`);
        setHooks(h => h.filter(x => x.id !== id));
      },
    });
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold">Webhook endpoints</h3>
          <p className="text-gray-500 text-sm mt-0.5">Receive HTTP POST requests when orders complete or are voided.</p>
        </div>
        <button onClick={() => { setShowForm(true); setError(''); }}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-xl transition-colors">
          + Add endpoint
        </button>
      </div>

      {newSecret && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <p className="text-amber-400 text-sm font-semibold mb-2">⚠️ Copy your webhook secret — shown once only</p>
          <code className="block bg-gray-900 rounded-lg p-2.5 text-xs text-green-400 break-all font-mono">{newSecret}</code>
          <button onClick={() => setNewSecret(null)} className="text-xs text-gray-500 hover:text-gray-300 mt-2 transition-colors">Dismiss</button>
        </div>
      )}

      {loading && <div className="py-6 text-gray-500 text-sm">Loading…</div>}

      {!loading && hooks.length === 0 && (
        <div className="py-10 text-center text-gray-600 text-sm border border-dashed border-gray-800 rounded-xl">
          No webhook endpoints yet.
        </div>
      )}

      {hooks.map(wh => (
        <div key={wh.id} className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-white text-sm font-mono truncate">{wh.url}</p>
              <p className="text-gray-500 text-xs mt-1">{wh.events.join(', ')}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs font-semibold ${wh.status === 'active' ? 'text-green-400' : 'text-gray-600'}`}>
                {wh.status === 'active' ? '● Active' : '○ Inactive'}
              </span>
              <button onClick={() => sendTest(wh)} disabled={testBusy === wh.id}
                className="text-xs px-2.5 py-1 border border-gray-700 text-gray-400 hover:border-gray-600 disabled:opacity-40 rounded-lg transition-colors">
                {testBusy === wh.id ? 'Sending…' : 'Send test'}
              </button>
              <button onClick={() => toggleLog(wh)}
                className="text-xs px-2.5 py-1 border border-gray-700 text-gray-400 hover:border-gray-600 rounded-lg transition-colors">
                {openLog === wh.id ? 'Hide log' : 'Deliveries'}
              </button>
              <button onClick={() => toggle(wh)}
                className="text-xs px-2.5 py-1 border border-gray-700 text-gray-400 hover:border-gray-600 rounded-lg transition-colors">
                {wh.status === 'active' ? 'Disable' : 'Enable'}
              </button>
              <button onClick={() => remove(wh.id)}
                className="text-xs px-2.5 py-1 border border-red-500/20 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
                Delete
              </button>
            </div>
          </div>

          {testResult[wh.id] && (
            <p className={`text-xs mt-2 ${testResult[wh.id].ok ? 'text-green-400' : 'text-red-400'}`}>
              {testResult[wh.id].ok ? '✓ ' : '✗ '}{testResult[wh.id].msg}
            </p>
          )}

          {openLog === wh.id && (
            <div className="mt-3 border-t border-gray-700 pt-3">
              {logBusy === wh.id ? (
                <p className="text-gray-500 text-xs">Loading deliveries…</p>
              ) : (logs[wh.id]?.length ?? 0) === 0 ? (
                <p className="text-gray-500 text-xs">No deliveries recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 uppercase tracking-wide text-left">
                        <th className="pb-1.5 pr-3">When</th>
                        <th className="pb-1.5 pr-3">Event</th>
                        <th className="pb-1.5 pr-3">Status</th>
                        <th className="pb-1.5">Tries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs[wh.id].map(d => {
                        const ok = d.response_status != null && d.response_status >= 200 && d.response_status < 300;
                        return (
                          <tr key={d.id} className="border-t border-gray-800/60">
                            <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">{new Date(d.created_at).toLocaleString('en-KE')}</td>
                            <td className="py-1.5 pr-3 text-gray-300">{d.event}</td>
                            <td className={`py-1.5 pr-3 font-medium ${ok ? 'text-green-400' : 'text-red-400'}`}>
                              {d.response_status ?? 'no response'}
                            </td>
                            <td className="py-1.5 text-gray-400 tabular-nums">{d.attempt_count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-white font-bold">New webhook endpoint</h3>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Endpoint URL</label>
              <input value={formUrl} onChange={e => setFormUrl(e.target.value)} placeholder="https://your-server.com/webhook"
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Events</label>
              {ALL_EVENTS.map(ev => (
                <label key={ev} className="flex items-center gap-2.5 mb-2 cursor-pointer">
                  <input type="checkbox" checked={formEvents.includes(ev)}
                    onChange={e => setFormEvents(prev => e.target.checked ? [...prev, ev] : prev.filter(x => x !== ev))}
                    className="w-4 h-4 rounded border-gray-700 bg-gray-800 accent-blue-600" />
                  <span className="text-gray-300 text-sm font-mono">{ev}</span>
                </label>
              ))}
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-2.5 pt-1">
              <button onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-gray-700 rounded-lg text-gray-400 text-sm hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={create} disabled={saving}
                className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded-lg text-white text-sm font-bold transition-colors">
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
