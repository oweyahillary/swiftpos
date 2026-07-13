/**
 * ParkingSettingsPage.tsx
 * Route: /dashboard/settings/parking
 * Converted to Tailwind — Session 2 Phase 2
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Bay {
  id: string; name: string; sort_order: number;
  capacity: number; slot_type: string;
  bay_status?: 'active' | 'reserved' | 'blocked';
  rate_per_hour?: number; zone?: string;
}

interface BizSetting { key: string; value: string; }

type Tab = 'bays' | 'rates' | 'settings';

const VEHICLE_TYPES = ['car', 'suv', 'truck', 'motorbike', 'minibus'];

const STATUS_MAP: Record<string, string> = {
  active:   'bg-green-500/10 border-green-500/30 text-green-400',
  reserved: 'bg-violet-500/10 border-violet-500/30 text-violet-400',
  blocked:  'bg-gray-700/50 border-gray-600/30 text-gray-400',
};

const STATUS_BORDER: Record<string, string> = {
  active:   'border-green-500/30 bg-green-500/5',
  reserved: 'border-violet-500/30 bg-violet-500/5',
  blocked:  'border-gray-600/30 bg-gray-800/30',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_MAP[status] ?? 'bg-gray-700/50 text-gray-400 border-gray-600/30'}`}>
      {status}
    </span>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${checked ? 'bg-blue-600' : 'bg-gray-700'}`}
    >
      <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

const EMPTY_BAY: Partial<Bay> = {
  name: '', capacity: 1, slot_type: 'parking_bay',
  bay_status: 'active', rate_per_hour: 200, zone: '',
};

export default function ParkingSettingsPage() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [tab, setTab]           = useState<Tab>('bays');
  const [bays, setBays]         = useState<Bay[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading]   = useState(true);
  const [editBay, setEditBay]   = useState<Partial<Bay> | null>(null);
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [bayData, settingData] = await Promise.all([
        api.get<Bay[]>('/api/tables?slot_type=parking_bay'),
        api.get<BizSetting[]>('/api/business/settings'),
      ]);
      setBays((bayData ?? []).sort((a, b) => a.sort_order - b.sort_order));
      const map: Record<string, string> = {};
      (settingData ?? []).forEach(s => { map[s.key] = s.value; });
      setSettings(map);
    } finally { setLoading(false); }
  }

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function saveBay() {
    if (!editBay?.name?.trim()) return;
    setSaving(true);
    try {
      if (editBay.id) {
        await api.patch(`/api/tables/${editBay.id}`, editBay);
      } else {
        await api.post('/api/tables', { ...editBay, slot_type: 'parking_bay' });
      }
      showToast(editBay.id ? 'Bay updated' : 'Bay created');
      setEditBay(null);
      loadData();
    } finally { setSaving(false); }
  }

  async function deleteBay(id: string) {
    showConfirm({
      title: 'Delete bay?',
      message: 'This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/tables/${id}`);
        showToast('Bay deleted');
        loadData();
      },
    });
  }

  async function saveSetting(key: string, value: string) {
    await api.post('/api/business/settings', { key, value });
    setSettings(prev => ({ ...prev, [key]: value }));
    showToast('Saved');
  }

  const zones = [...new Set(bays.map(b => b.zone || 'Main'))];
  const stats = {
    total:    bays.length,
    active:   bays.filter(b => b.bay_status === 'active').length,
    reserved: bays.filter(b => b.bay_status === 'reserved').length,
    blocked:  bays.filter(b => b.bay_status === 'blocked').length,
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'bays',     label: '🅿️ Bay Map' },
    { key: 'rates',    label: '💰 Rates & Zones' },
    { key: 'settings', label: '⚙️ Policies' },
  ];

  return (
    <div className="p-6 max-w-5xl">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Parking Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage bays, zones, rates and parking policies</p>
        </div>
        <button
          onClick={() => setEditBay({ ...EMPTY_BAY })}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
        >
          + Add Bay
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total bays', value: stats.total, cls: 'text-white' },
          { label: 'Active',     value: stats.active,   cls: 'text-green-400' },
          { label: 'Reserved',   value: stats.reserved, cls: 'text-violet-400' },
          { label: 'Blocked',    value: stats.blocked,  cls: 'text-gray-400' },
        ].map(st => (
          <div key={st.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className={`text-2xl font-bold ${st.cls}`}>{st.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{st.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-800">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm -mb-px border-b-2 transition-colors ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── BAY MAP ── */}
      {tab === 'bays' && (
        <div>
          {loading ? (
            <div className="text-center text-gray-500 text-sm py-10">Loading bays…</div>
          ) : bays.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">🅿️</div>
              <div className="text-gray-500 text-sm">No bays yet — add your first bay to get started</div>
              <button
                onClick={() => setEditBay({ ...EMPTY_BAY })}
                className="mt-4 px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
              >
                + Add first bay
              </button>
            </div>
          ) : (
            zones.map(zone => (
              <div key={zone} className="mb-6">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">{zone}</div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                  {bays.filter(b => (b.zone || 'Main') === zone).map(bay => (
                    <div
                      key={bay.id}
                      className={`border-2 rounded-xl p-3.5 ${STATUS_BORDER[bay.bay_status ?? 'active'] ?? 'border-gray-700 bg-gray-800/30'}`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <div className="text-base font-bold text-white">{bay.name}</div>
                        <StatusBadge status={bay.bay_status ?? 'active'} />
                      </div>
                      <div className="text-xs text-gray-500 my-2">Rate: KES {bay.rate_per_hour ?? '—'}/hr</div>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => setEditBay({ ...bay })}
                          className="px-2.5 py-1 text-xs text-blue-400 border border-gray-700 rounded-md hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteBay(bay.id)}
                          className="px-2.5 py-1 text-xs text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/5 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── RATES & ZONES ── */}
      {tab === 'rates' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-4">Default parking rates</h2>

          <div className="flex items-center justify-between py-3.5 border-b border-gray-800">
            <div>
              <div className="text-sm font-medium text-gray-200">Default rate per hour (KES)</div>
              <div className="text-xs text-gray-500 mt-0.5">Applied to new bays and sessions when no bay-specific rate is set</div>
            </div>
            <input
              type="number" min={0} step={50}
              className="w-28 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
              value={settings['default_parking_rate'] ?? '200'}
              onChange={e => saveSetting('default_parking_rate', e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between py-3.5 border-b border-gray-800">
            <div>
              <div className="text-sm font-medium text-gray-200">Minimum billing period</div>
              <div className="text-xs text-gray-500 mt-0.5">Minimum hours billed even for short stays</div>
            </div>
            <select
              className="bg-gray-950 border border-gray-700 rounded-lg text-white px-3 py-2 text-sm"
              value={settings['parking_min_hours'] ?? '1'}
              onChange={e => saveSetting('parking_min_hours', e.target.value)}
            >
              <option value="0.5">30 minutes</option>
              <option value="1">1 hour (default)</option>
              <option value="2">2 hours</option>
            </select>
          </div>

          <div className="flex items-center justify-between py-3.5 border-b border-gray-800">
            <div>
              <div className="text-sm font-medium text-gray-200">Billing rounding</div>
              <div className="text-xs text-gray-500 mt-0.5">How partial hours are billed</div>
            </div>
            <select
              className="bg-gray-950 border border-gray-700 rounded-lg text-white px-3 py-2 text-sm"
              value={settings['parking_billing_mode'] ?? 'ceil'}
              onChange={e => saveSetting('parking_billing_mode', e.target.value)}
            >
              <option value="ceil">Round up (ceiling) — default</option>
              <option value="round">Round to nearest hour</option>
              <option value="exact">Exact (pro-rata minutes)</option>
            </select>
          </div>

          <h2 className="text-base font-bold text-white mt-6 mb-1">Vehicle type rates</h2>
          <p className="text-xs text-gray-500 mb-4">Set a rate per vehicle type. Leave blank to use default rate.</p>
          {VEHICLE_TYPES.map(vt => (
            <div key={vt} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div className="text-sm font-medium text-gray-200 capitalize">{vt}</div>
              <input
                type="number" min={0} step={50} placeholder="Default"
                className="w-28 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                value={settings[`parking_rate_${vt}`] ?? ''}
                onChange={e => saveSetting(`parking_rate_${vt}`, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── POLICIES ── */}
      {tab === 'settings' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-4">Parking policies</h2>

          <div className="flex items-center justify-between py-3.5 border-b border-gray-800">
            <div>
              <div className="text-sm font-medium text-gray-200">Overstay threshold (hours)</div>
              <div className="text-xs text-gray-500 mt-0.5">Bays open longer than this are highlighted as overstay</div>
            </div>
            <input type="number" min={1} step={1}
              className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
              value={settings['parking_overstay_hours'] ?? '8'}
              onChange={e => saveSetting('parking_overstay_hours', e.target.value)} />
          </div>

          <div className="flex items-center justify-between py-3.5 border-b border-gray-800">
            <div>
              <div className="text-sm font-medium text-gray-200">Grace period (minutes)</div>
              <div className="text-xs text-gray-500 mt-0.5">Free time after payment before re-entry triggers a new session</div>
            </div>
            <input type="number" min={0} step={5}
              className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
              value={settings['parking_grace_minutes'] ?? '15'}
              onChange={e => saveSetting('parking_grace_minutes', e.target.value)} />
          </div>

          {[
            { key: 'parking_print_ticket', label: 'Print parking ticket on session open', hint: 'Automatically print a ticket when a parking session is created' },
            { key: 'parking_receipt_plate', label: 'Show vehicle plate on receipt', hint: '', defaultTrue: true },
          ].map(({ key, label, hint, defaultTrue }) => (
            <div key={key} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-200">{label}</div>
                {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
              </div>
              <Toggle
                checked={defaultTrue ? settings[key] !== 'false' : settings[key] === 'true'}
                onChange={v => saveSetting(key, String(v))}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── EDIT BAY MODAL ── */}
      {editBay && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-bold text-white">{editBay.id ? `Edit ${editBay.name}` : 'Add new bay'}</h3>
              <button onClick={() => setEditBay(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Bay name / number *</label>
              <input
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-gray-600"
                placeholder="e.g. A1, Bay 12, Rooftop-3"
                value={editBay.name ?? ''}
                onChange={e => setEditBay(p => ({ ...p!, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Status</label>
                <select
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                  value={editBay.bay_status ?? 'active'}
                  onChange={e => setEditBay(p => ({ ...p!, bay_status: e.target.value as Bay['bay_status'] }))}
                >
                  <option value="active">Active</option>
                  <option value="reserved">Reserved</option>
                  <option value="blocked">Blocked / Out of service</option>
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Zone / section</label>
                <input
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                  placeholder="e.g. Ground, Rooftop"
                  value={editBay.zone ?? ''}
                  onChange={e => setEditBay(p => ({ ...p!, zone: e.target.value }))}
                />
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Rate per hour (KES) — leave blank for default</label>
              <input
                type="number" min={0} step={50}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                placeholder={settings['default_parking_rate'] ?? '200'}
                value={editBay.rate_per_hour ?? ''}
                onChange={e => setEditBay(p => ({ ...p!, rate_per_hour: Number(e.target.value) || undefined }))}
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Display order</label>
              <input
                type="number" min={0}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                value={editBay.sort_order ?? 0}
                onChange={e => setEditBay(p => ({ ...p!, sort_order: Number(e.target.value) }))}
              />
            </div>

            <div className="flex gap-2.5 mt-5">
              <button onClick={() => setEditBay(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={saveBay} disabled={saving} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">
                {saving ? 'Saving…' : editBay.id ? 'Save changes' : 'Create bay'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
