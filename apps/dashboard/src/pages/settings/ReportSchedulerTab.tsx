import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

// Report Scheduler — nightly DSR email. Extracted verbatim from SettingsPage
// (register A133) so the new Integrations page and the legacy Staff page can
// share ONE copy rather than two that drift (rule 17).

interface Schedule {
  id?: string;
  enabled: boolean;
  send_time: string;       // HH:MM
  recipients: string[];    // email addresses
  include_low_stock: boolean;
  include_top_products: boolean;
}

export default function ReportSchedulerTab() {
  const [schedule, setSchedule]   = useState<Schedule>({
    enabled: false, send_time: '21:00', recipients: [],
    include_low_stock: true, include_top_products: true,
  });
  const [newEmail, setNewEmail]   = useState('');
  const [loading, setLoading]     = useState(true);
  const [saving,  setSaving]      = useState(false);
  const [saved,   setSaved]       = useState(false);
  const [error,   setError]       = useState('');
  const [testing, setTesting]     = useState(false);
  const [testMsg, setTestMsg]     = useState('');

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

  const sendTest = async () => {
    setTesting(true); setTestMsg('');
    try {
      await api.post('/api/notifications/test-email', {});
      setTestMsg('✓ Test email sent to your account address. Check your inbox (and spam).');
    } catch (e: any) {
      setTestMsg(e?.message ?? 'Could not send the test email.');
    } finally {
      setTesting(false);
    }
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
          <p className="text-white text-sm font-medium">Test email delivery</p>
          <p className="text-gray-500 text-xs">Send a test to your account email to confirm the mail pipeline works.</p>
          {testMsg && <p className="text-xs mt-1 text-gray-300">{testMsg}</p>}
        </div>
        <button onClick={sendTest} disabled={testing}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-xl transition-colors disabled:opacity-40 flex-shrink-0">
          {testing ? 'Sending…' : 'Send test email'}
        </button>
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
