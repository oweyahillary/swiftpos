import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import StaffTab   from './settings/StaffTab';
import DevicesTab from './settings/DevicesTab';
import RolesTab from './settings/RolesTab';
import ConfirmModal, { useConfirm } from '../components/ConfirmModal';

interface Branch { id: string; name: string; is_main: boolean; }

const TABS = [
  { key: 'staff',     label: 'Staff Members' },
  { key: 'roles',     label: 'Roles & Permissions' },
  { key: 'devices',   label: 'Devices' },
  { key: 'security',  label: 'Security' },
  { key: 'scheduler', label: 'Report Scheduler' },
  { key: 'webhooks',  label: 'Webhooks' },
];


// ── Report Scheduler Tab ──────────────────────────────────────────────────────

interface Schedule {
  id?: string;
  enabled: boolean;
  send_time: string;       // HH:MM
  recipients: string[];    // email addresses
  include_low_stock: boolean;
  include_top_products: boolean;
}

function ReportSchedulerTab() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [schedule, setSchedule]   = useState<Schedule>({
    enabled: false, send_time: '21:00', recipients: [],
    include_low_stock: true, include_top_products: true,
  });
  const [newEmail, setNewEmail]   = useState('');
  const [loading, setLoading]     = useState(true);
  const [saving,  setSaving]      = useState(false);
  const [saved,   setSaved]       = useState(false);
  const [error,   setError]       = useState('');

  useEffect(() => {
    api.get<Schedule>('/api/business/settings/report-schedule')
      .then(d => { if (d) setSchedule(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      await api.post('/api/business/settings', {
        key: 'report_schedule',
        value: JSON.stringify(schedule),
      });
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e.message ?? 'Failed to save'); }
    finally { setSaving(false); }
  };

  const addEmail = () => {
    const e = newEmail.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    if (schedule.recipients.includes(e)) return;
    setSchedule(s => ({ ...s, recipients: [...s.recipients, e] }));
    setNewEmail('');
  };

  if (loading) return <div className="py-8 text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h3 className="text-white font-semibold mb-1">Daily Report Email</h3>
        <p className="text-gray-500 text-sm">Automatically email a full DSR to your inbox every night.</p>
      </div>

      <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
        <div>
          <p className="text-white text-sm font-medium">Enable daily reports</p>
          <p className="text-gray-500 text-xs">Sends every night at the scheduled time</p>
        </div>
        <button onClick={() => setSchedule(s => ({ ...s, enabled: !s.enabled }))}
          className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${schedule.enabled ? 'bg-green-500' : 'bg-gray-700'}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${schedule.enabled ? 'left-5' : 'left-0.5'}`} />
        </button>
      </div>

      {schedule.enabled && (
        <>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Send time (EAT)</label>
            <input type="time" value={schedule.send_time}
              onChange={e => setSchedule(s => ({ ...s, send_time: e.target.value }))}
              className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 w-40" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Recipients</label>
            <div className="flex gap-2 mb-2">
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addEmail()}
                placeholder="owner@example.com"
                className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <button onClick={addEmail}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded-xl transition-colors">Add</button>
            </div>
            {schedule.recipients.length === 0
              ? <p className="text-gray-600 text-xs">No recipients yet — add at least one email.</p>
              : <div className="flex flex-wrap gap-2">
                  {schedule.recipients.map(email => (
                    <span key={email} className="flex items-center gap-1.5 text-xs bg-gray-800 border border-gray-700 text-gray-300 px-3 py-1.5 rounded-full">
                      {email}
                      <button onClick={() => setSchedule(s => ({ ...s, recipients: s.recipients.filter(r => r !== email) }))}
                        className="text-gray-500 hover:text-red-400 transition-colors">✕</button>
                    </span>
                  ))}
                </div>
            }
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Include in report</label>
            <div className="space-y-2.5">
              {[
                { key: 'include_top_products', label: 'Top products by revenue' },
                { key: 'include_low_stock',    label: 'Low stock alerts' },
              ].map(opt => (
                <label key={opt.key} className="flex items-center gap-3 cursor-pointer">
                  <div onClick={() => setSchedule(s => ({ ...s, [opt.key]: !s[opt.key as keyof Schedule] }))}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      schedule[opt.key as keyof Schedule] ? 'bg-blue-600 border-blue-600' : 'border-gray-600'
                    }`}>
                    {schedule[opt.key as keyof Schedule] && <span className="text-white text-[10px] font-bold">✓</span>}
                  </div>
                  <span className="text-gray-300 text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {saved && <p className="text-green-400 text-sm">✓ Saved</p>}

      <button onClick={save} disabled={saving || (schedule.enabled && schedule.recipients.length === 0)}
        className="px-6 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
        {saving ? 'Saving…' : 'Save schedule'}
      </button>
    </div>
  );
}

// ── Webhooks Tab ──────────────────────────────────────────────────────────────

interface Webhook {
  id: string; url: string; events: string[]; status: string;
  created_at: string; secret?: string;
}

function WebhooksTab() {
  const [hooks,     setHooks]     = useState<Webhook[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [showForm,  setShowForm]  = useState(false);
  const [formUrl,   setFormUrl]   = useState('');
  const [formEvents,setFormEvents]= useState<string[]>(['order.completed']);
  const [saving,    setSaving]    = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error,     setError]     = useState('');

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
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('staff');
  const [branches, setBranches] = useState<Branch[]>([]);

  // Supervisor PIN state
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState('');
  const [pinSet, setPinSet] = useState(false); // whether a PIN is already configured

  useEffect(() => {
    api.get<Branch[]>('/api/branches')
      .then(data => setBranches(data ?? []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (activeTab === 'security') loadPinStatus();
  }, [activeTab]);

  async function loadPinStatus() {
    try {
      const settings = await api.get<{ key: string; value: string }[]>('/api/business/settings');
      const pin = (settings ?? []).find(s => s.key === 'supervisor_pin');
      setPinSet(!!pin?.value);
    } catch { /* silent */ }
  }

  async function savePin() {
    setPinError(''); setPinSuccess('');
    if (!/^\d{4,6}$/.test(newPin)) { setPinError('PIN must be 4–6 digits'); return; }
    if (newPin !== confirmPin) { setPinError('PINs do not match'); return; }
    setPinSaving(true);
    try {
      await api.post('/api/business/settings', { key: 'supervisor_pin', value: newPin });
      setPinSuccess('Supervisor PIN updated successfully');
      setPinSet(true);
      setCurrentPin(''); setNewPin(''); setConfirmPin('');
    } catch (err: any) {
      setPinError(err.message ?? 'Failed to save PIN');
    } finally { setPinSaving(false); }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-white text-2xl font-bold">Staff Management</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your team and permissions</p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 flex-shrink-0 border-r border-gray-800 p-4 space-y-1">
          {TABS.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                activeTab === tab.key
                  ? 'bg-gray-800 text-white font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'staff'     && <StaffTab branches={branches} />}
          {activeTab === 'devices'   && <DevicesTab />}
          {activeTab === 'roles'     && <RolesTab />}
          {activeTab === 'scheduler' && <ReportSchedulerTab />}
          {activeTab === 'webhooks'  && <WebhooksTab />}
          {activeTab === 'security' && (
            <div className="max-w-lg">
              <h2 className="text-lg font-bold text-white mb-1">Supervisor PIN</h2>
              <p className="text-sm text-gray-500 mb-6">
                Required to void paid orders at the POS. Keep this separate from cashier PINs.
                {pinSet
                  ? <span className="ml-1 text-green-400 font-medium">● PIN is configured</span>
                  : <span className="ml-1 text-amber-400 font-medium">● No PIN set — voids are blocked</span>}
              </p>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    New PIN (4–6 digits)
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="••••"
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 tracking-widest"
                    value={newPin}
                    onChange={e => setNewPin(e.target.value.replace(/\D/g, ''))}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    Confirm PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="••••"
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 tracking-widest"
                    value={confirmPin}
                    onChange={e => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  />
                </div>

                {pinError && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-sm text-red-400">
                    {pinError}
                  </div>
                )}
                {pinSuccess && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2.5 text-sm text-green-400">
                    {pinSuccess}
                  </div>
                )}

                <button
                  onClick={savePin}
                  disabled={pinSaving || !newPin || !confirmPin}
                  className="w-full py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white text-sm font-bold transition-colors"
                >
                  {pinSaving ? 'Saving…' : pinSet ? 'Update PIN' : 'Set PIN'}
                </button>
              </div>

              <div className="mt-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-500 leading-relaxed">
                  <span className="text-gray-400 font-semibold">When is it needed?</span><br />
                  Only when voiding an order that has already been paid. Free (unpaid) orders can be voided without a PIN.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
  );
}
