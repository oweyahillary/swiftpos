import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

// Report Scheduler — nightly DSR email. Extracted verbatim from SettingsPage
// (register A133) so the new Integrations page and the legacy Staff page can
// share ONE copy rather than two that drift (rule 17).
//
// A476 (owner, 2026-10-14): "tills not confirmed or closed by manager, and any other important email but the owner can
// turn them off. Branch manager should always get an email about tills which are not closed." — what the daily email
// includes, alerts as they happen (with their amounts), the weekly summary. Stored in the same report_schedule; a key
// that is missing is its default (the server cleans what is saved: jobs/ownerAlertsDecision.ts).

interface Schedule {
  id?: string;
  enabled: boolean;
  send_time: string;       // HH:MM
  recipients: string[];    // email addresses
  include_low_stock: boolean;
  include_top_products: boolean;
  /** A455: last month's pack (one Excel per branch) by email on the 1st — to the owner, branch managers and the recipients. */
  monthly_pack?: boolean;
  // A476: what the daily email includes (on unless switched off) …
  open_tills?: boolean;
  variances?: boolean;
  voids_refunds?: boolean;
  tills_not_syncing?: boolean;
  expenses?: boolean;
  low_stock?: boolean;
  // … alerts as they happen (on unless switched off), with their amounts …
  alert_not_syncing?: boolean;
  not_syncing_hours?: number;
  alert_big_void?: boolean;
  big_void_amount?: number;
  alert_variance?: boolean;
  variance_amount?: number;
  // … and the weekly summary (off unless switched on).
  weekly_summary?: boolean;
}

/** A476: the defaults the server applies to a key that is missing (jobs/ownerAlertsDecision.ts ALERT_DEFAULTS). */
const A476_DEFAULTS = {
  open_tills: true, variances: true, voids_refunds: true, tills_not_syncing: true, expenses: true, low_stock: true,
  alert_not_syncing: true, not_syncing_hours: 4, alert_big_void: true, big_void_amount: 5000,
  alert_variance: true, variance_amount: 1000, weekly_summary: false,
} as const;

type BoolKey = 'open_tills' | 'variances' | 'voids_refunds' | 'tills_not_syncing' | 'expenses' | 'low_stock'
  | 'include_top_products' | 'alert_not_syncing' | 'alert_big_void' | 'alert_variance' | 'weekly_summary';
type AmountKey = 'not_syncing_hours' | 'big_void_amount' | 'variance_amount';

const SECTIONS: { key: BoolKey; label: string; hint?: string }[] = [
  { key: 'open_tills',           label: 'Points of sale not closed or confirmed', hint: 'Open drawers and closed shifts waiting for a manager\'s count — or "All points of sale closed and confirmed ✓"' },
  { key: 'variances',            label: 'Cash differences at confirm',   hint: 'Shifts confirmed that day where the count was over or short' },
  { key: 'voids_refunds',        label: 'Voids and refunds',             hint: 'How many, how much, and the largest with who and why' },
  { key: 'tills_not_syncing',    label: 'Points of sale not syncing',             hint: 'Points of sale behind on sending their sales, or signed out' },
  { key: 'expenses',             label: 'Expenses',                      hint: 'The day\'s total and the largest items' },
  { key: 'low_stock',            label: 'Low stock',                     hint: 'Products below their threshold' },
  { key: 'include_top_products', label: 'Top products by revenue' },
];

/** A teal switch, the page's existing look. */
function Toggle({ on, onClick, testId }: { on: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onClick} data-testid={testId}
      className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${on ? 'bg-swift-strong' : 'bg-gray-700'}`}>
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-5' : 'left-0.5'}`} />
    </button>
  );
}

export default function ReportSchedulerTab() {
  const [schedule, setSchedule]   = useState<Schedule>({
    enabled: false, send_time: '21:00', recipients: [],
    include_low_stock: true, include_top_products: true, ...A476_DEFAULTS,
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
      .then(d => { if (d) setSchedule({ ...A476_DEFAULTS, ...d }); })
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

  // A476: a switch's state — a missing key is its default
  const isOn = (k: BoolKey): boolean => {
    const v = schedule[k as keyof Schedule];
    if (k === 'include_top_products') return v !== false;
    return v === undefined ? (A476_DEFAULTS as Record<string, unknown>)[k] === true : v === true;
  };
  const flip = (k: BoolKey) => setSchedule(s => {
    const next = !isOn(k);
    return { ...s, [k]: next, ...(k === 'low_stock' ? { include_low_stock: next } : {}) };
  });
  const setAmount = (k: AmountKey, raw: string) => {
    const n = Number(raw);
    setSchedule(s => ({ ...s, [k]: raw === '' || !Number.isFinite(n) ? undefined : n }));
  };
  const amountOf = (k: AmountKey) => schedule[k] ?? A476_DEFAULTS[k];

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
          className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${schedule.enabled ? 'bg-swift-strong' : 'bg-gray-700'}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${schedule.enabled ? 'left-5' : 'left-0.5'}`} />
        </button>
      </div>

      {/* A455: the monthly pack */}
      <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3" data-testid="monthly-pack-toggle">
        <div>
          <p className="text-white text-sm font-medium">Email the monthly pack on the 1st</p>
          <p className="text-gray-500 text-xs">Last month, one Excel file per branch (daily sales, expenses, cash and M-Pesa books) — to the owner, branch managers and the recipients below. Also in Reports › Monthly pack.</p>
        </div>
        <button onClick={() => setSchedule(s => ({ ...s, monthly_pack: !s.monthly_pack }))}
          className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${schedule.monthly_pack ? 'bg-swift-strong' : 'bg-gray-700'}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${schedule.monthly_pack ? 'left-5' : 'left-0.5'}`} />
        </button>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Send time (EAT)</label>
        <input type="time" value={schedule.send_time}
          onChange={e => setSchedule(s => ({ ...s, send_time: e.target.value }))}
          className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-swift w-40" />
        <p className="text-gray-600 text-xs mt-1.5">The daily email goes at this time — and so does the branch managers' "points of sale not closed" email.</p>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Recipients</label>
        <p className="text-gray-600 text-xs mb-2">You always get these emails; add anyone else who should.</p>
        <div className="flex gap-2 mb-2">
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addEmail()}
            placeholder="owner@example.com"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
          <button onClick={addEmail}
            className="px-4 py-2 bg-swift-strong hover:bg-swift-deep text-white text-sm rounded-xl transition-colors">Add</button>
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

      {/* A476: the sections of the daily email */}
      <div data-testid="daily-sections">
        <h3 className="text-white font-semibold mb-1">What the daily email includes</h3>
        <p className="text-gray-500 text-xs mb-3">
          A section only appears when it has something to show.{!schedule.enabled && ' Switch on daily reports above to receive it.'}
        </p>
        <div className="space-y-2.5">
          {SECTIONS.map(opt => (
            <label key={opt.key} className="flex items-start gap-3 cursor-pointer" data-testid={`section-${opt.key}`}>
              <div onClick={() => flip(opt.key)}
                className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  isOn(opt.key) ? 'bg-swift-strong border-swift-strong' : 'border-gray-600'
                }`}>
                {isOn(opt.key) && <span className="text-white text-[10px] font-bold">✓</span>}
              </div>
              <span>
                <span className="text-gray-300 text-sm">{opt.label}</span>
                {opt.hint && <span className="block text-gray-600 text-xs">{opt.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* A476: alerts as they happen */}
      <div data-testid="alerts-section">
        <h3 className="text-white font-semibold mb-1">Alerts as they happen</h3>
        <p className="text-gray-500 text-xs mb-3">Sent within 15 minutes, once per event, to you and the recipients above — whether or not the daily email is on.</p>
        <div className="space-y-3">
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-white text-sm font-medium">A POS is not syncing</p>
                <p className="text-gray-500 text-xs">Its sales have not reached the cloud while the branch is trading, or it was signed out and needs rejoining. Also sent to that branch's managers.</p>
              </div>
              <Toggle on={isOn('alert_not_syncing')} onClick={() => flip('alert_not_syncing')} testId="alert-not-syncing" />
            </div>
            {isOn('alert_not_syncing') && (
              <label className="flex items-center gap-2 mt-3 text-xs text-gray-400">
                Not synced for
                <input type="number" min={1} max={72} step={1} value={amountOf('not_syncing_hours')}
                  onChange={e => setAmount('not_syncing_hours', e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift w-20" />
                hours
              </label>
            )}
          </div>

          <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-white text-sm font-medium">A big void or refund</p>
                <p className="text-gray-500 text-xs">One sale voided or refunded for this amount or more — with who did it, who approved it and why.</p>
              </div>
              <Toggle on={isOn('alert_big_void')} onClick={() => flip('alert_big_void')} testId="alert-big-void" />
            </div>
            {isOn('alert_big_void') && (
              <label className="flex items-center gap-2 mt-3 text-xs text-gray-400">
                Amount of at least
                <input type="number" min={1} step={100} value={amountOf('big_void_amount')}
                  onChange={e => setAmount('big_void_amount', e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift w-28" />
              </label>
            )}
          </div>

          <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-white text-sm font-medium">A big cash difference at confirm</p>
                <p className="text-gray-500 text-xs">A manager confirmed a shift whose cash count was over or short by this much or more.</p>
              </div>
              <Toggle on={isOn('alert_variance')} onClick={() => flip('alert_variance')} testId="alert-variance" />
            </div>
            {isOn('alert_variance') && (
              <label className="flex items-center gap-2 mt-3 text-xs text-gray-400">
                Over or short by at least
                <input type="number" min={1} step={100} value={amountOf('variance_amount')}
                  onChange={e => setAmount('variance_amount', e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift w-28" />
              </label>
            )}
          </div>
        </div>
      </div>

      {/* A476: weekly summary */}
      <div data-testid="weekly-section">
        <h3 className="text-white font-semibold mb-1">Weekly summary</h3>
        <div className="flex items-center justify-between gap-3 bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
          <div>
            <p className="text-white text-sm font-medium">Email a weekly summary on Monday at 08:00</p>
            <p className="text-gray-500 text-xs">Last week against the week before: sales, orders, average order, top items, voids, expenses and cash differences — to you, branch managers and the recipients above.</p>
          </div>
          <Toggle on={isOn('weekly_summary')} onClick={() => flip('weekly_summary')} testId="weekly-summary-toggle" />
        </div>
      </div>

      <div className="bg-gray-800/30 border border-gray-700 rounded-xl px-4 py-3" data-testid="branch-manager-note">
        <p className="text-gray-300 text-sm font-medium">Branch managers always hear about points of sale not closed</p>
        <p className="text-gray-500 text-xs">Each branch's managers get an email listing their branch's drawers still open or waiting for a confirmed count — at the send time, and again at 09:00 if any are still not done. This one cannot be switched off.</p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {saved && <p className="text-green-400 text-sm">✓ Saved</p>}

      <button onClick={save} disabled={saving || (schedule.enabled && schedule.recipients.length === 0)}
        className="px-6 py-2.5 bg-swift-strong hover:bg-swift-deep disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
        {saving ? 'Saving…' : 'Save schedule'}
      </button>
    </div>
  );
}
