import { mpesaFromSettings, mpesaDescribe } from '@zaptill/core/mpesaReceive';   // A492
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { cleanCutoff, cutoffLabel, MAX_CUTOFF_MINUTES } from '@zaptill/core/businessDay';   // 0.6.34

// Settings › Business › Profile (A134). The one vertical-neutral home for
// company-level settings: editable identity (via PATCH /api/business) plus the
// business-wide receipt header/footer and 24-hour toggle (business_settings).
// Per-branch overrides for franchises are a separate cross-stack feature (A139).

interface BusinessRecord {
  id: string;
  name: string; currency: string; address: string | null;
  phone: string | null; email: string | null;
  tax_pin: string | null; vat_rate: number | null; ctl_rate: number | null; logo_url: string | null;
}

const IDENTITY_FIELDS: Array<{ key: keyof BusinessRecord; label: string; type?: string; help?: string }> = [
  { key: 'name',     label: 'Business name' },
  { key: 'address',  label: 'Address' },
  { key: 'phone',    label: 'Phone' },
  { key: 'email',    label: 'Contact email', type: 'email', help: 'Business contact address. Your sign-in email is changed by your ZapTill admin.' },
  { key: 'tax_pin',  label: 'Tax PIN (KRA)' },
  { key: 'vat_rate', label: 'VAT rate (%)', type: 'number' },
  { key: 'ctl_rate', label: 'Catering/Tourism Levy (%)', type: 'number', help: 'Charged on the same net as VAT. 0 = not applicable. Shows on receipts and tax reports when above 0.' },
  { key: 'logo_url', label: 'Logo image URL', help: 'Paste a hosted image URL (PNG/JPG). It prints on your POs, GRNs, transfer notes and Z reports.' },
];

export default function BusinessProfileTab() {
  const { refresh } = useBusiness();
  const [record, setRecord]   = useState<BusinessRecord | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(false);
  const [toast, setToast]     = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3500); }

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<BusinessRecord>('/api/business/'),
      api.get<Array<{ key: string; value: string }>>('/api/business/settings'),
    ]).then(([biz, kv]) => {
      if (!live) return;
      setRecord(biz);
      const map: Record<string, string> = {};
      for (const row of kv ?? []) map[row.key] = row.value;
      setSettings(map);
    }).catch(() => { if (live) showToast('Could not load your business profile'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  function setField<K extends keyof BusinessRecord>(key: K, value: BusinessRecord[K]) {
    setRecord(r => (r ? { ...r, [key]: value } : r));
  }

  async function saveIdentity() {
    if (!record) return;
    if (!record.name?.trim()) { showToast('Business name is required'); return; }
    setSavingId(true);
    try {
      const payload = {
        name: record.name, address: record.address, phone: record.phone,
        email: record.email, tax_pin: record.tax_pin, vat_rate: record.vat_rate,
        ctl_rate: record.ctl_rate,
        currency: record.currency, logo_url: record.logo_url,
      };
      const updated = await api.patch<BusinessRecord>('/api/business/', payload);
      setRecord(updated);
      refresh();                       // keep the cached business (nav, header) in sync
      showToast('Business profile saved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save the profile');
    } finally { setSavingId(false); }
  }

  // Each receipt/hours setting saves on its own so a slow field can't block others.
  async function saveSetting(key: string, value: string) {
    setSettings(prev => ({ ...prev, [key]: value }));
    try {
      await api.post('/api/business/settings', { key, value });
      showToast('Saved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save');
    }
  }

  if (loading) return <div className="p-4 sm:p-6 text-gray-500 text-sm">Loading…</div>;
  if (!record) return <div className="p-4 sm:p-6 text-gray-500 text-sm">Could not load your business profile.</div>;

  const continuous = settings.continuous_operation === 'true';
  // A627: the two "cashiers see sales" switches (A416 close-shift sales, A418 History total) are retired — they are RIGHTS
  // now, set per person on Roles and permissions. The note below replaces the toggles.
  // 0.6.34: every half hour from midnight to 06:00 (lib/businessDay.ts).
  const CUTOFF_CHOICES = Array.from({ length: MAX_CUTOFF_MINUTES / 30 + 1 }, (_, i) => cutoffLabel(i * 30));

  return (
    <div className="p-4 sm:p-6 max-w-2xl space-y-8">
      {toast && (
        <div className="fixed bottom-6 right-6 left-4 sm:left-auto bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
      )}

      {/* ── Identity ── */}
      <section>
        <h3 className="text-white font-semibold">Business details</h3>
        <p className="text-gray-500 text-sm mt-0.5 mb-4">Your company information, shown on receipts and reports.</p>
        <div className="grid gap-4">
          {IDENTITY_FIELDS.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{f.label}</label>
              <input
                type={f.type ?? 'text'}
                value={(record[f.key] ?? '') as string | number}
                onChange={e => setField(f.key, (f.type === 'number' ? Number(e.target.value) : e.target.value) as never)}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift"
              />
              {f.help && <p className="text-xs text-gray-600 mt-1">{f.help}</p>}
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Currency</label>
            <input
              value={record.currency ?? ''}
              onChange={e => setField('currency', e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift"
            />
            <p className="text-xs text-gray-600 mt-1">Locked once you have recorded sales — historical amounts are denominated in it.</p>
          </div>
        </div>
        <button
          onClick={saveIdentity} disabled={savingId}
          className="mt-4 px-5 py-2.5 bg-swift-strong hover:bg-swift-deep disabled:opacity-40 text-white text-sm font-bold rounded-lg transition-colors"
        >
          {savingId ? 'Saving…' : 'Save business details'}
        </button>
      </section>

      <div className="border-t border-gray-800" />

      {/* ── Receipt text ── */}
      <section>
        <h3 className="text-white font-semibold">Receipt text</h3>
        <p className="text-gray-500 text-sm mt-0.5 mb-4">Free-text printed above and below every receipt — address, PIN, a thank-you line. Saved as you leave each field.</p>
        <div className="grid gap-4">
          {[
            { key: 'receipt_header', label: 'Header (top of receipt)' },
            { key: 'receipt_footer', label: 'Footer (bottom of receipt)' },
          ].map(f => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{f.label}</label>
              <textarea
                rows={3}
                value={settings[f.key] ?? ''}
                onChange={e => setSettings(prev => ({ ...prev, [f.key]: e.target.value }))}
                onBlur={e => saveSetting(f.key, e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift resize-y"
              />
            </div>
          ))}
          {/* A492: the M-Pesa number is per branch, set on the branch's till by its manager (owner, 2026-10-15). Shown here
              read-only when an older business-wide one is still printed by branches that have not set their own. */}
          <div data-testid="receipt-pay-readonly">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pay by M-Pesa (printed under the payments)</label>
            {(() => {
              const v = mpesaFromSettings(settings.receipt_pay_label, settings.receipt_pay_number, settings.receipt_pay_account);
              return v
                ? <p className="text-sm text-gray-300">Business-wide (older set-up): {mpesaDescribe(v)} — printed by branches that have not set their own.</p>
                : null;
            })()}
            <p className="text-gray-500 text-xs mt-1">Each branch sets its own M-Pesa number on its POS: Manager › Settings › M-Pesa (Buy Goods till number, or Paybill with its account number). You are notified whenever it changes.</p>
          </div>
        </div>
      </section>

      <div className="border-t border-gray-800" />

      {/* ── Hours ── */}
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-white font-semibold">24-hour operation</h3>
            <p className="text-gray-500 text-sm mt-0.5">For a business that never closes overnight — end-of-day totals won't roll at midnight.</p>
          </div>
          <button
            onClick={() => saveSetting('continuous_operation', continuous ? 'false' : 'true')}
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${continuous ? 'bg-swift-strong' : 'bg-gray-700'}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${continuous ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
        {/* 0.6.34: when the business day ends — a bar trading past midnight keeps selling until the day's end. */}
        <div className="flex items-center justify-between mt-6 gap-4">
          <div>
            <h3 className="text-white font-semibold">Business day ends at</h3>
            <p className="text-gray-500 text-sm mt-0.5">
              Sales before this time count to the night before — on the points of sale, the reports and the daily email. A bar open
              until 3 am sets 04:00, and closes the day after service. Midnight (00:00) unless you change it.
            </p>
          </div>
          <select
            value={cutoffLabel(cleanCutoff(settings.business_day_cutoff) ?? 0)}
            onChange={e => saveSetting('business_day_cutoff', e.target.value)}
            data-testid="business-day-cutoff"
            className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-white text-sm flex-shrink-0"
          >
            {CUTOFF_CHOICES.map(t => <option key={t} value={t}>{t === '00:00' ? '00:00 (midnight)' : t}</option>)}
          </select>
        </div>
        {/* A627 (owner, 2026-11-26: "remove all sales toggle and add them as user rights for easy management"): the
            "cashiers see sales" switches (close-shift sales, History total) AND the History payment-methods picker (A387)
            are now RIGHTS, set per person on Roles and permissions — easier to manage and lockable per cashier. */}
        <div data-testid="cashier-sales-rights-note" className="mt-6 rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
          <h3 className="text-white font-semibold">What cashiers see of sales</h3>
          <p className="text-gray-500 text-sm mt-0.5">
            Seeing the shift's sales when closing, a running total in History, and which payments show in History are set per
            person on <span className="text-gray-400">Roles and permissions</span> — grant{' '}
            <span className="text-gray-400">“See own shift sales at close”</span>,{' '}
            <span className="text-gray-400">“See a running total in History”</span> or{' '}
            <span className="text-gray-400">“See all payments in History”</span> (without the last, a cashier's History shows
            only cash sales). The count stays blind either way: a cashier without the right only keys in the cash they counted.
          </p>
        </div>
      </section>

      <p className="text-xs text-gray-600 pt-2">
        Franchise with multiple branches? Per-branch receipt text and hours that override these defaults are coming separately.
      </p>
    </div>
  );
}
