/**
 * PetrolSettingsPage.tsx
 * Route: /dashboard/settings/petrol
 * Converted to Tailwind — Session 2 Phase 2
 * NOTE: Tank gauge fill bar keeps inline style={{ width: `${level}%` }} — dynamic value.
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Branch { id: string; name: string; }

interface Pump {
  id: string; name: string; sort_order: number;
  status: 'idle' | 'dispensing' | 'inactive' | 'error';
  fuel_product_id?: string;
  tank_id?: string;           // direct tank link (preferred over fuel_product_id for multi-tank stations)
}

interface FuelTank {
  id: string; name: string; fuel_product_id: string;
  capacity_litres: number; current_level: number; reorder_level: number;
}

interface FuelProduct {
  id: string; name: string; base_price: number; is_fuel: boolean;
  fuel_unit?: string; status: string;
}

interface BizSetting { key: string; value: string; }

type Tab = 'pumps' | 'tanks' | 'grades' | 'settings' | 'history';

function gradeColour(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('diesel'))  return '#f59e0b';
  if (n.includes('premium')) return '#a78bfa';
  if (n.includes('kero'))    return '#06b6d4';
  return '#22c55e'; // petrol / super / default
}

function pct(level: number, capacity: number): number {
  return capacity > 0 ? Math.min(100, Math.round((level / capacity) * 100)) : 0;
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

const PUMP_STATUS_CLS: Record<string, string> = {
  idle:       'bg-green-500/10 text-green-400',
  dispensing: 'bg-blue-500/10 text-blue-400',
  inactive:   'bg-gray-700/50 text-gray-400',
  error:      'bg-red-500/10 text-red-400',
};

export default function PetrolSettingsPage() {
  const { branches } = useBranch();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [tab, setTab]               = useState<Tab>('pumps');
  const [pumps, setPumps]           = useState<Pump[]>([]);
  const [tanks, setTanks]           = useState<FuelTank[]>([]);
  const [fuelProducts, setFuelProducts] = useState<FuelProduct[]>([]);
  const [settings, setSettings]     = useState<Record<string, string>>({});
  const [loading, setLoading]       = useState(true);
  const [toast, setToast]           = useState('');
  const [saving, setSaving]         = useState(false);
  const [history, setHistory]       = useState<any[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const [editPump, setEditPump]     = useState<Partial<Pump> | null>(null);
  const [editTank, setEditTank]     = useState<Partial<FuelTank> | null>(null);
  const [stockEntry, setStockEntry] = useState<{ tank: FuelTank; litres: string } | null>(null);

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab]);

  async function loadData() {
    setLoading(true);
    try {
      const [pumpData, tankData, prodData, settingData] = await Promise.all([
        api.get<Pump[]>('/api/pumps'),
        api.get<FuelTank[]>('/api/fuel-tanks'),
        api.get<FuelProduct[]>('/api/products?is_fuel=true'),
        api.get<BizSetting[]>('/api/business/settings'),
      ]);
      setPumps((pumpData ?? []).sort((a, b) => a.sort_order - b.sort_order));
      setTanks(tankData ?? []);
      setFuelProducts((prodData ?? []).filter(p => p.is_fuel));
      const map: Record<string, string> = {};
      (settingData ?? []).forEach(s => { map[s.key] = s.value; });
      setSettings(map);
    } finally { setLoading(false); }
  }

  async function loadHistory() {
    setHistLoading(true);
    try {
      // Fetch last 50 stock movements for fuel products (sales + deliveries)
      const data = await api.get<any[]>('/api/fuel-tanks/movements?limit=50');
      setHistory(data ?? []);
    } catch { setHistory([]); }
    finally { setHistLoading(false); }
  }

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function savePump() {
    if (!editPump?.name?.trim()) return;
    setSaving(true);
    try {
      if (editPump.id) await api.patch(`/api/pumps/${editPump.id}`, editPump);
      else await api.post('/api/pumps', editPump);
      showToast(editPump.id ? 'Pump updated' : 'Pump created');
      setEditPump(null); loadData();
    } finally { setSaving(false); }
  }

  async function deletePump(id: string) {
    showConfirm({
      title: 'Delete pump?',
      message: 'Fuel sales history is preserved.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/pumps/${id}`);
        showToast('Pump deleted');
        loadData();
      },
    });
  }

  async function saveTank() {
    if (!editTank?.name?.trim() || !editTank.fuel_product_id) return;
    setSaving(true);
    try {
      if (editTank.id) await api.patch(`/api/fuel-tanks/${editTank.id}`, editTank);
      else await api.post('/api/fuel-tanks', editTank);
      showToast(editTank.id ? 'Tank updated' : 'Tank created');
      setEditTank(null); loadData();
    } finally { setSaving(false); }
  }

  async function recordDelivery() {
    if (!stockEntry) return;
    const litres = parseFloat(stockEntry.litres);
    if (isNaN(litres) || litres <= 0) return;
    await api.post(`/api/fuel-tanks/${stockEntry.tank.id}/delivery`, { litres });
    showToast(`Added ${litres}L to ${stockEntry.tank.name}`);
    setStockEntry(null); loadData();
  }

  async function saveSetting(key: string, value: string) {
    await api.post('/api/business/settings', { key, value });
    setSettings(prev => ({ ...prev, [key]: value }));
    showToast('Saved');
  }

  const lowTanks = tanks.filter(t => t.current_level <= t.reorder_level);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'pumps',    label: 'Pumps' },
    { key: 'tanks',    label: 'Wet Stock' },
    { key: 'grades',   label: 'Fuel Grades' },
    { key: 'history',  label: 'Stock History' },
    { key: 'settings', label: 'Policies' },
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
          <h1 className="text-2xl font-bold text-white">Petrol Station Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage pumps, tanks, fuel grades and station policies</p>
        </div>
        <div className="flex gap-2.5">
          {tab === 'pumps' && (
            <button
              onClick={() => setEditPump({ name: '', status: 'idle', sort_order: pumps.length })}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
            >
              + Add Pump
            </button>
          )}
          {tab === 'tanks' && (
            <button
              onClick={() => setEditTank({ name: '', capacity_litres: 10000, current_level: 0, reorder_level: 2000 })}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
            >
              + Add Tank
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Pumps',     value: pumps.length, cls: 'text-white' },
          { label: 'Idle',      value: pumps.filter(p => p.status === 'idle').length, cls: 'text-green-400' },
          { label: 'Tanks',     value: tanks.length, cls: 'text-amber-400' },
          { label: 'Low tanks', value: lowTanks.length, cls: lowTanks.length > 0 ? 'text-red-400' : 'text-green-400' },
        ].map(st => (
          <div key={st.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className={`text-2xl font-bold ${st.cls}`}>{st.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{st.label}</div>
          </div>
        ))}
      </div>

      {/* Low stock alert */}
      {lowTanks.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2.5 text-sm text-red-300 mb-4">
          ⚠ {lowTanks.length} tank{lowTanks.length > 1 ? 's' : ''} below reorder level:{' '}
          {lowTanks.map(t => t.name).join(', ')}
        </div>
      )}

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

      {/* ── PUMPS ── */}
      {tab === 'pumps' && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {pumps.length === 0 ? (
            <div className="col-span-full text-center text-gray-500 text-sm py-16">No pumps configured yet</div>
          ) : pumps.map(pump => {
            const product = fuelProducts.find(fp => fp.id === pump.fuel_product_id);
            const assignedTank = tanks.find(t => t.id === pump.tank_id);
            const samegradeTanks = tanks.filter(t => t.fuel_product_id === pump.fuel_product_id);
            const needsTankLink = samegradeTanks.length > 1 && !pump.tank_id;
            return (
              <div key={pump.id} className={`bg-gray-900 border rounded-xl p-4 ${pump.status === 'error' ? 'border-red-500/30' : needsTankLink ? 'border-amber-500/40' : 'border-gray-800'}`}>
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="text-base font-bold text-white">{pump.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: product ? gradeColour(product.name) : '#64748b' }}>
                      {product ? product.name : 'No grade assigned'}
                    </div>
                    {assignedTank && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        Tank: {assignedTank.name} ({assignedTank.current_level.toFixed(0)}L)
                      </div>
                    )}
                    {needsTankLink && (
                      <div className="text-xs text-amber-400 mt-0.5">
                        ⚠ Multiple {product?.name} tanks — assign a specific tank
                      </div>
                    )}
                  </div>
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${PUMP_STATUS_CLS[pump.status] ?? 'bg-gray-700/50 text-gray-400'}`}>
                    {pump.status}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditPump({ ...pump })} className="px-2.5 py-1 text-xs text-blue-400 border border-gray-700 rounded-md hover:border-blue-500/50 transition-colors">Edit</button>
                  <button onClick={() => deletePump(pump.id)} className="px-2.5 py-1 text-xs text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/5 transition-colors">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── WET STOCK / TANKS ── */}
      {tab === 'tanks' && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {tanks.length === 0 ? (
            <div className="col-span-full text-center text-gray-500 text-sm py-16">No tanks configured yet</div>
          ) : tanks.map(tank => {
            const product = fuelProducts.find(fp => fp.id === tank.fuel_product_id);
            const level   = pct(tank.current_level, tank.capacity_litres);
            const isLow   = tank.current_level <= tank.reorder_level;
            const colour  = product ? gradeColour(product.name) : '#3b82f6';
            const reorderPct = pct(tank.reorder_level, tank.capacity_litres);

            return (
              <div key={tank.id} className={`bg-gray-900 border rounded-xl p-4 ${isLow ? 'border-red-500/30' : 'border-gray-800'}`}>
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="text-base font-bold text-white">{tank.name}</div>
                    {product && (
                      <div className="text-xs mt-0.5" style={{ color: gradeColour(product.name) }}>{product.name}</div>
                    )}
                  </div>
                  {isLow && (
                    <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-red-500/15 text-red-300">LOW</span>
                  )}
                </div>

                {/* Gauge bar — width is dynamic, must stay inline */}
                <div className="mb-3">
                  <div className="flex justify-between mb-1.5">
                    <span className="text-xs text-gray-500">{tank.current_level.toLocaleString()}L remaining</span>
                    <span className={`text-xs font-bold ${isLow ? 'text-red-400' : 'text-white'}`}>{level}%</span>
                  </div>
                  <div className="h-2 bg-gray-950 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${level}%`, background: isLow ? '#ef4444' : colour }}
                    />
                  </div>
                  {/* Reorder marker — position is dynamic */}
                  <div className="relative h-1 mt-0.5">
                    <div
                      className="absolute top-0 w-0.5 h-1 bg-red-500 rounded-sm"
                      style={{ left: `${reorderPct}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label: 'Capacity', val: `${tank.capacity_litres.toLocaleString()}L` },
                    { label: 'Current',  val: `${tank.current_level.toLocaleString()}L` },
                    { label: 'Reorder',  val: `${tank.reorder_level.toLocaleString()}L` },
                  ].map(({ label, val }) => (
                    <div key={label} className="text-center">
                      <div className="text-xs font-bold text-white">{val}</div>
                      <div className="text-[10px] text-gray-600">{label}</div>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button onClick={() => setEditTank({ ...tank })} className="flex-1 px-2.5 py-1.5 text-xs text-blue-400 border border-gray-700 rounded-md hover:border-blue-500/50 transition-colors">Edit</button>
                  <button onClick={() => setStockEntry({ tank, litres: '' })} className="flex-1 px-2.5 py-1.5 text-xs text-green-400 border border-green-500/20 rounded-md hover:bg-green-500/5 transition-colors">+ Delivery</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── FUEL GRADES ── */}
      {tab === 'grades' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-1">Fuel grade pricing</h2>
          <p className="text-sm text-gray-500 mb-4">
            Fuel grades are managed as products with the "Is fuel" flag enabled. Go to Products to add new grades.
          </p>
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                {['Grade', 'Price per litre', 'Unit', 'Status', ''].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fuelProducts.length === 0 ? (
                <tr><td colSpan={5} className="text-center text-gray-600 py-6 text-sm">
                  No fuel products — add products with "Is fuel" enabled in the Products page
                </td></tr>
              ) : fuelProducts.map(fp => (
                <tr key={fp.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: gradeColour(fp.name) }} />
                      <span className="text-sm font-semibold text-white">{fp.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-sm font-bold text-green-400">KES {Number(fp.base_price).toFixed(2)}</td>
                  <td className="px-3 py-3 text-sm text-gray-500">{fp.fuel_unit ?? 'L'}</td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${fp.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                      {fp.status}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <a href="/dashboard/products" className="text-xs text-blue-400 hover:text-blue-300 no-underline">Edit in Products →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── STOCK HISTORY ── */}
      {tab === 'history' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <div>
              <h2 className="text-base font-bold text-white">Stock Movement History</h2>
              <p className="text-xs text-gray-500 mt-0.5">Sales deductions and deliveries across all tanks</p>
            </div>
            <button onClick={loadHistory} className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
              Refresh
            </button>
          </div>
          {histLoading ? (
            <div className="py-12 text-center text-gray-500 text-sm">Loading…</div>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-gray-500 text-sm">
              No movements yet. Stock deductions appear here automatically when fuel sales are made.
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Date', 'Tank', 'Grade', 'Type', 'Litres', 'Level After', 'Note'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {history.map((m: any, i: number) => {
                  const isSale     = m.movement_type === 'sale' || Number(m.quantity_change) < 0;
                  const isDelivery = m.movement_type === 'restock' || Number(m.quantity_change) > 0;
                  const litres     = Math.abs(Number(m.quantity_change));
                  return (
                    <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                        {m.created_at ? new Date(m.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-white font-medium">{m.tank_name ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-300">{m.product_name ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                          isSale ? 'bg-red-500/10 text-red-400' : isDelivery ? 'bg-green-500/10 text-green-400' : 'bg-gray-700 text-gray-400'
                        }`}>
                          {isSale ? '▼ Sale' : isDelivery ? '▲ Delivery' : m.movement_type}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-sm font-semibold tabular-nums ${isSale ? 'text-red-400' : 'text-green-400'}`}>
                        {isSale ? '−' : '+'}{litres.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L
                      </td>
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-300">
                        {m.quantity_after != null ? `${Number(m.quantity_after).toLocaleString('en-KE', { maximumFractionDigits: 0 })} L` : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[180px] truncate">{m.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── POLICIES ── */}
      {tab === 'settings' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-4">Station policies</h2>
          {[
            { key: 'fuel_show_litres_dispensed',    label: 'Show litres dispensed on receipt',      type: 'toggle' },
            { key: 'fuel_require_attendant_name',   label: 'Require attendant name on fuel sale',   type: 'toggle' },
            { key: 'fuel_auto_print_receipt',       label: 'Auto-print receipt after fuel payment', type: 'toggle' },
          ].map(setting => (
            <div key={setting.key} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div className="text-sm font-medium text-gray-200">{setting.label}</div>
              <Toggle
                checked={settings[setting.key] !== 'false'}
                onChange={v => saveSetting(setting.key, String(v))}
              />
            </div>
          ))}
          <div className="flex items-center justify-between py-3.5">
            <div className="text-sm font-medium text-gray-200">Fuel unit on receipts</div>
            <select
              className="bg-gray-950 border border-gray-700 rounded-lg text-white px-3 py-2 text-sm"
              value={settings['fuel_unit_display'] ?? 'L'}
              onChange={e => saveSetting('fuel_unit_display', e.target.value)}
            >
              <option value="L">Litres (L)</option>
              <option value="gal">Gallons (gal)</option>
            </select>
          </div>
        </div>
      )}

      {/* ── EDIT PUMP MODAL ── */}
      {editPump && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-bold text-white">{editPump.id ? `Edit ${editPump.name}` : 'Add pump'}</h3>
              <button onClick={() => setEditPump(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pump name *</label>
              <input className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none" placeholder="e.g. Pump 1, Pump A"
                value={editPump.name ?? ''} onChange={e => setEditPump(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Assigned fuel grade</label>
              <select className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                value={editPump.fuel_product_id ?? ''} onChange={e => setEditPump(p => ({ ...p!, fuel_product_id: e.target.value || undefined, tank_id: undefined }))}>
                <option value="">Multi-grade / select at dispense</option>
                {fuelProducts.map(fp => <option key={fp.id} value={fp.id}>{fp.name}</option>)}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                Assigned tank
                <span className="ml-1.5 text-gray-600 font-normal normal-case">— required when you have multiple tanks of the same grade</span>
              </label>
              <select className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                value={editPump.tank_id ?? ''} onChange={e => setEditPump(p => ({ ...p!, tank_id: e.target.value || undefined }))}>
                <option value="">Auto (match by fuel grade)</option>
                {tanks
                  .filter(t => !editPump.fuel_product_id || t.fuel_product_id === editPump.fuel_product_id)
                  .map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.current_level.toFixed(0)}L / {t.capacity_litres.toFixed(0)}L)
                    </option>
                  ))}
              </select>
              {!editPump.tank_id && editPump.fuel_product_id && tanks.filter(t => t.fuel_product_id === editPump.fuel_product_id).length > 1 && (
                <p className="text-amber-400 text-xs mt-1.5">
                  ⚠ Multiple tanks have this grade — assign a specific tank so deductions go to the right one.
                </p>
              )}
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Status</label>
              <select className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                value={editPump.status ?? 'idle'} onChange={e => setEditPump(p => ({ ...p!, status: e.target.value as Pump['status'] }))}>
                <option value="idle">Idle (available)</option>
                <option value="inactive">Inactive (out of service)</option>
                <option value="error">Error (needs attention)</option>
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Display order</label>
              <input type="number" min={0} className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                value={editPump.sort_order ?? 0} onChange={e => setEditPump(p => ({ ...p!, sort_order: Number(e.target.value) }))} />
            </div>
            <div className="flex gap-2.5 mt-5">
              <button onClick={() => setEditPump(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={savePump} disabled={saving} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">
                {saving ? 'Saving…' : editPump.id ? 'Save' : 'Create pump'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT TANK MODAL ── */}
      {editTank && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-bold text-white">{editTank.id ? `Edit ${editTank.name}` : 'Add tank'}</h3>
              <button onClick={() => setEditTank(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Branch (optional)</label>
              <select className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                value={(editTank as any).branch_id ?? ''}
                onChange={e => setEditTank(p => ({ ...p!, branch_id: e.target.value || null }))}>
                <option value="">All branches (business-wide)</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Tank name *</label>
              <input className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none" placeholder="e.g. Tank A — Diesel"
                value={editTank.name ?? ''} onChange={e => setEditTank(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Fuel grade *</label>
              <select className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                value={editTank.fuel_product_id ?? ''} onChange={e => setEditTank(p => ({ ...p!, fuel_product_id: e.target.value }))}>
                <option value="">Select grade…</option>
                {fuelProducts.map(fp => <option key={fp.id} value={fp.id}>{fp.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Capacity (L)', field: 'capacity_litres' as const },
                { label: 'Current (L)',  field: 'current_level' as const },
                { label: 'Reorder (L)', field: 'reorder_level' as const },
              ].map(({ label, field }) => (
                <div key={field} className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{label}</label>
                  <input type="number" min={0} className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none"
                    value={(editTank as any)[field] ?? ''} onChange={e => setEditTank(p => ({ ...p!, [field]: Number(e.target.value) }))} />
                </div>
              ))}
            </div>
            <div className="flex gap-2.5 mt-2">
              <button onClick={() => setEditTank(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={saveTank} disabled={saving || !editTank.fuel_product_id} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">
                {saving ? 'Saving…' : editTank.id ? 'Save' : 'Create tank'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELIVERY MODAL ── */}
      {stockEntry && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-bold text-white">Record delivery — {stockEntry.tank.name}</h3>
              <button onClick={() => setStockEntry(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Current level: {stockEntry.tank.current_level.toLocaleString()}L of {stockEntry.tank.capacity_litres.toLocaleString()}L capacity
            </p>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Litres delivered *</label>
              <input type="number" min={0} step={100} autoFocus placeholder="e.g. 5000"
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                value={stockEntry.litres} onChange={e => setStockEntry(p => p ? { ...p, litres: e.target.value } : p)} />
            </div>
            {stockEntry.litres && (
              <p className="text-sm text-green-400 mb-4">
                New level after delivery:{' '}
                {Math.min(stockEntry.tank.current_level + parseFloat(stockEntry.litres || '0'), stockEntry.tank.capacity_litres).toLocaleString()}L
              </p>
            )}
            <div className="flex gap-2.5">
              <button onClick={() => setStockEntry(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={recordDelivery} className="flex-1 py-2.5 bg-green-700 hover:bg-green-600 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">Record delivery</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
