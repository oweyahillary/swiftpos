import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';

// Settings › Business › Profile (A134). The one vertical-neutral home for
// company-level settings: editable identity (via PATCH /api/business) plus the
// business-wide receipt header/footer and 24-hour toggle (business_settings).
// Per-branch overrides for franchises are a separate cross-stack feature (A139).

interface BusinessRecord {
  id: string;
  name: string; currency: string; address: string | null;
  phone: string | null; email: string | null;
  tax_pin: string | null; vat_rate: number | null;
}

const IDENTITY_FIELDS: Array<{ key: keyof BusinessRecord; label: string; type?: string; help?: string }> = [
  { key: 'name',     label: 'Business name' },
  { key: 'address',  label: 'Address' },
  { key: 'phone',    label: 'Phone' },
  { key: 'email',    label: 'Contact email', type: 'email', help: 'Business contact address. Your sign-in email is changed by your SwiftPOS admin.' },
  { key: 'tax_pin',  label: 'Tax PIN (KRA)' },
  { key: 'vat_rate', label: 'VAT rate (%)', type: 'number' },
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
        currency: record.currency,
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

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  if (!record) return <div className="p-6 text-gray-500 text-sm">Could not load your business profile.</div>;

  const continuous = settings.continuous_operation === 'true';

  return (
    <div className="p-6 max-w-2xl space-y-8">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
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
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              {f.help && <p className="text-xs text-gray-600 mt-1">{f.help}</p>}
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Currency</label>
            <input
              value={record.currency ?? ''}
              onChange={e => setField('currency', e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-600 mt-1">Locked once you have recorded sales — historical amounts are denominated in it.</p>
          </div>
        </div>
        <button
          onClick={saveIdentity} disabled={savingId}
          className="mt-4 px-5 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-bold rounded-lg transition-colors"
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
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 resize-y"
              />
            </div>
          ))}
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
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${continuous ? 'bg-green-500' : 'bg-gray-700'}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${continuous ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
      </section>

      <p className="text-xs text-gray-600 pt-2">
        Franchise with multiple branches? Per-branch receipt text and hours that override these defaults are coming separately.
      </p>
    </div>
  );
}
