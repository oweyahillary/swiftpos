/**
 * RestaurantSettingsPage.tsx
 * Route: /dashboard/settings/restaurant
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import FloorPlanTab from './FloorPlanTab';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Branch { id: string; name: string; }

interface Table {
  id: string; name: string; capacity: number; sort_order: number;
  slot_type: 'dining'; zone?: string; shape?: 'rect' | 'circle';
  pos_x?: number; pos_y?: number;
}

interface BizSetting { key: string; value: string; }

type Tab = 'tables' | 'floor_plan' | 'service' | 'periods';

const SECTION_CLS: Record<string, string> = {
  'Main Hall': 'text-blue-400 border-blue-500/30 bg-blue-500/5',
  'Terrace':   'text-green-400 border-green-500/30 bg-green-500/5',
  'Private':   'text-violet-400 border-violet-500/30 bg-violet-500/5',
  'Bar':       'text-amber-400 border-amber-500/30 bg-amber-500/5',
  'VIP':       'text-pink-400 border-pink-500/30 bg-pink-500/5',
};
const SECTION_DOT: Record<string, string> = {
  'Main Hall': 'bg-blue-400',
  'Terrace':   'bg-green-400',
  'Private':   'bg-violet-400',
  'Bar':       'bg-amber-400',
  'VIP':       'bg-pink-400',
};
const DEFAULT_CLS = 'text-gray-400 border-gray-600/30 bg-gray-800/30';
const DEFAULT_DOT = 'bg-gray-400';

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

export default function RestaurantSettingsPage() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  // Match the sidebar's dynamic label exactly ("Café Setup" / "Restaurant Setup")
  // — this page is shared by café and restaurant business types.
  const { business } = useBusiness();
  const SETUP_TITLES: Record<string, string> = {
    restaurant: 'Restaurant Setup',
    cafe:       'Café Setup',
  };
  const pageTitle = SETUP_TITLES[business?.type ?? ''] ?? 'Dine-in Settings';
  const [tab, setTab]             = useState<Tab>('tables');
  const [tables, setTables]       = useState<Table[]>([]);
  const [settings, setSettings]   = useState<Record<string, string>>({});
  const [branches, setBranches]   = useState<Branch[]>([]);
  const [loading, setLoading]     = useState(true);
  const [editTable, setEditTable] = useState<Partial<Table> | null>(null);
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [settingData, branchData] = await Promise.all([
        api.get<BizSetting[]>('/api/business/settings'),
        api.get<Branch[]>('/api/branches'),
      ]);
      const map: Record<string, string> = {};
      (settingData ?? []).forEach(s => { map[s.key] = s.value; });
      setSettings(map);
      const bList = branchData ?? [];
      setBranches(bList);
      // Auto-select first branch if none selected
      if (!selectedBranchId && bList.length > 0) {
        setSelectedBranchId(bList[0].id);
        await loadTables(bList[0].id);
      } else if (selectedBranchId) {
        await loadTables(selectedBranchId);
      }
    } finally { setLoading(false); }
  }

  async function loadTables(branchId: string) {
    if (!branchId) return;
    const data = await api.get<Table[]>(`/api/tables?branch_id=${branchId}`);
    setTables((data ?? []).sort((a, b) => a.sort_order - b.sort_order));
  }

  async function onBranchChange(branchId: string) {
    setSelectedBranchId(branchId);
    setTables([]);
    if (branchId) await loadTables(branchId);
  }

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function saveTable() {
    if (!editTable?.name?.trim()) return;
    setSaving(true);
    try {
      if (editTable.id) {
        await api.patch(`/api/tables/${editTable.id}`, editTable);
      } else {
        await api.post('/api/tables', { ...editTable, slot_type: 'dining', branch_id: selectedBranchId });
      }
      showToast(editTable.id ? 'Table updated' : 'Table created');
      setEditTable(null);
      if (selectedBranchId) await loadTables(selectedBranchId);
    } finally { setSaving(false); }
  }

  async function deleteTable(id: string) {
    showConfirm({
      title: 'Delete table?',
      message: 'Open orders on this table are unaffected.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/tables/${id}`);
        showToast('Table deleted');
        if (selectedBranchId) await loadTables(selectedBranchId);
      },
    });
  }

  async function saveSetting(key: string, value: string) {
    await api.post('/api/business/settings', { key, value });
    setSettings(prev => ({ ...prev, [key]: value }));
    showToast('Saved');
  }

  const sections = [...new Set(tables.map(t => t.zone || 'Main Hall'))];
  const stats = {
    total:    tables.length,
    covers:   tables.reduce((s, t) => s + t.capacity, 0),
    sections: sections.length,
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'tables',     label: '🪑 Tables' },
    { key: 'floor_plan', label: '🗺 Floor Plan' },
    { key: 'service',    label: '🍽 Service' },
    { key: 'periods',    label: '🕐 Menu Periods' },
  ];

  return (
    <div className="p-6 max-w-5xl">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">{pageTitle}</h1>
          <p className="text-sm text-gray-500 mt-1">Tables, service configuration and menu periods</p>
        </div>
        {tab === 'tables' && (
          <button
            onClick={() => setEditTable({ name: '', capacity: 4, sort_order: tables.length, slot_type: 'dining', zone: 'Main Hall', shape: 'rect' })}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
          >
            + Add Table
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total tables',  value: stats.total,    cls: 'text-white' },
          { label: 'Total covers',  value: stats.covers,   cls: 'text-blue-400' },
          { label: 'Sections',      value: stats.sections, cls: 'text-violet-400' },
          { label: 'Avg capacity',  value: stats.total ? Math.round(stats.covers / stats.total) : 0, cls: 'text-green-400' },
        ].map(st => (
          <div key={st.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className={`text-2xl font-bold ${st.cls}`}>{st.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{st.label}</div>
          </div>
        ))}
      </div>

      {/* Branch picker — shown on Tables and Floor Plan tabs */}
      {(tab === 'tables' || tab === 'floor_plan') && branches.length > 1 && (
        <div className="flex items-center gap-3 mb-4">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Branch</label>
          <select
            className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
            value={selectedBranchId}
            onChange={e => onBranchChange(e.target.value)}
          >
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
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

      {/* ── TABLES ── */}
      {tab === 'tables' && (
        <div>
          {loading ? (
            <div className="text-center text-gray-500 text-sm py-10">Loading tables…</div>
          ) : tables.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">🪑</div>
              <div className="text-gray-500 text-sm">No tables yet</div>
              <button
                onClick={() => setEditTable({ name: '', capacity: 4, sort_order: 0, slot_type: 'dining', zone: 'Main Hall' })}
                className="mt-4 px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
              >
                + Add first table
              </button>
            </div>
          ) : sections.map(section => {
            const dot  = SECTION_DOT[section] ?? DEFAULT_DOT;
            const card = SECTION_CLS[section] ?? DEFAULT_CLS;
            const sectionTables = tables.filter(t => (t.zone || 'Main Hall') === section);
            return (
              <div key={section} className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full ${dot}`} />
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">{section}</span>
                  <span className="text-xs text-gray-600">({sectionTables.length} tables)</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
                  {sectionTables.map(table => (
                    <div key={table.id} className={`border-2 rounded-xl py-3.5 px-2.5 ${card}`}>
                      <div className="flex justify-center mb-2.5">
                        <div className={`flex items-center justify-center text-xs font-bold border-2 border-current/60 bg-current/10 ${
                          table.shape === 'circle' ? 'w-12 h-12 rounded-full' : 'w-12 h-8 rounded-lg'
                        }`}>
                          {table.name}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 text-center mb-2">👥 {table.capacity} covers</div>
                      <div className="flex gap-1.5 justify-center">
                        <button onClick={() => setEditTable({ ...table })} className="px-2 py-1 text-[11px] text-blue-400 border border-gray-700 rounded-md hover:border-blue-500/50 transition-colors">Edit</button>
                        <button onClick={() => deleteTable(table.id)} className="px-2 py-1 text-[11px] text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/5 transition-colors">Del</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── FLOOR PLAN ── */}
      {tab === 'floor_plan' && (
        selectedBranchId
          ? <FloorPlanTab branchId={selectedBranchId} />
          : <div className="text-center py-12 text-gray-500 text-sm">Select a branch to edit its floor plan.</div>
      )}

      {/* ── SERVICE SETTINGS ── */}
      {tab === 'service' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-1">Service model</h2>
          <p className="text-sm text-gray-500 mb-4">Controls how orders flow from the POS to the kitchen.</p>
          <div className="grid grid-cols-2 gap-3 mb-6">
            {[
              { value: 'pay_first',   icon: '🧾', label: 'Pay first',   desc: 'Customer orders and pays at the counter. Kitchen ticket fires on payment. Best for cafés, fast food, takeaway.' },
              { value: 'order_first', icon: '🍽️', label: 'Order first', desc: 'Waiter takes order, sends to kitchen, customer pays at the end. Best for sit-down restaurants.' },
            ].map(opt => {
              const active = (settings['restaurant_order_mode'] ?? 'pay_first') === opt.value;
              return (
                <button key={opt.value} onClick={() => saveSetting('restaurant_order_mode', opt.value)}
                  className={`text-left p-4 rounded-xl border-2 transition-colors cursor-pointer ${active ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 bg-gray-950 hover:border-gray-600'}`}>
                  <div className="text-2xl mb-2">{opt.icon}</div>
                  <div className={`text-sm font-bold mb-1 ${active ? 'text-blue-400' : 'text-white'}`}>
                    {opt.label}
                    {active && <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">Active</span>}
                  </div>
                  <div className="text-xs text-gray-500 leading-relaxed">{opt.desc}</div>
                </button>
              );
            })}
          </div>
          <h2 className="text-base font-bold text-white mb-4">Service configuration</h2>
          {[
            { key: 'enable_covers',            label: 'Enable covers (guest count)',     hint: 'Prompt for number of guests when opening a table',               type: 'toggle' },
            { key: 'enable_course_firing',      label: 'Enable course-by-course firing', hint: 'Allow sending starters before mains to kitchen',                 type: 'toggle' },
            { key: 'auto_print_kot',            label: 'Auto-print KOT on order confirm',hint: 'Automatically send kitchen order ticket when order is placed',   type: 'toggle' },
            { key: 'enable_split_bill',         label: 'Enable split bill by covers',    hint: 'Allow splitting the bill evenly among guests',                   type: 'toggle' },
            { key: 'service_charge_pct',        label: 'Service charge (%)',             hint: 'Auto-apply service charge to all dine-in orders (0 = disabled)', type: 'number' },
            { key: 'table_turnover_alert_mins', label: 'Table turnover alert (minutes)', hint: 'Highlight tables that have been open longer than this',           type: 'number' },
          ].map(setting => (
            <div key={setting.key} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-200">{setting.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{setting.hint}</div>
              </div>
              {setting.type === 'toggle' ? (
                <Toggle checked={settings[setting.key] !== 'false'} onChange={v => saveSetting(setting.key, String(v))} />
              ) : (
                <input type="number" min={0}
                  className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                  value={settings[setting.key] ?? '0'}
                  onChange={e => saveSetting(setting.key, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── MENU PERIODS ── */}
      {tab === 'periods' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-1">Menu periods</h2>
          <p className="text-sm text-gray-500 mb-1">Define time-based menu periods (e.g. Breakfast, Lunch, Dinner).</p>
          <p className="text-xs text-gray-600 mb-5 italic">Full period-based product filtering — coming in a future update.</p>
          {[
            { key: 'period_breakfast', label: 'Breakfast', icon: '🌅', default: '07:00–11:00' },
            { key: 'period_lunch',     label: 'Lunch',     icon: '☀️', default: '11:00–15:00' },
            { key: 'period_dinner',    label: 'Dinner',    icon: '🌙', default: '18:00–23:00' },
            { key: 'period_allday',    label: 'All day',   icon: '⏰', default: '00:00–23:59' },
          ].map(period => (
            <div key={period.key} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-200">{period.icon} {period.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">Time range for this period (24h format, e.g. {period.default})</div>
              </div>
              <input
                className="w-36 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                placeholder={period.default}
                value={settings[period.key] ?? ''}
                onChange={e => saveSetting(period.key, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── EDIT TABLE MODAL ── */}
      {editTable && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-bold text-white">{editTable.id ? `Edit ${editTable.name}` : 'Add table'}</h3>
              <button onClick={() => setEditTable(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Table name / number *</label>
              <input className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                placeholder="e.g. T1, Table 12, Booth A"
                value={editTable.name ?? ''}
                onChange={e => setEditTable(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Max covers (seats)</label>
                <input type="number" min={1} max={50}
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                  value={editTable.capacity ?? 4}
                  onChange={e => setEditTable(p => ({ ...p!, capacity: Number(e.target.value) }))} />
              </div>
              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Section</label>
                <input className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                  placeholder="e.g. Main Hall, Terrace"
                  value={editTable.zone ?? ''}
                  onChange={e => setEditTable(p => ({ ...p!, zone: e.target.value }))} />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Table shape</label>
              <div className="flex gap-2.5">
                {(['rect', 'circle'] as const).map(shape => (
                  <button key={shape} onClick={() => setEditTable(p => ({ ...p!, shape }))}
                    className={`flex-1 py-3 px-2 border-2 rounded-xl text-xs text-center cursor-pointer transition-colors ${
                      editTable.shape === shape ? 'border-blue-500 bg-blue-500/10 text-blue-400' : 'border-gray-700 bg-gray-950 text-gray-500 hover:border-gray-600'
                    }`}>
                    <div className={`mx-auto mb-1.5 border-2 border-current ${shape === 'circle' ? 'w-6 h-6 rounded-full' : 'w-6 h-4 rounded'}`} />
                    {shape === 'rect' ? 'Rectangle' : 'Round'}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Display order</label>
              <input type="number" min={0}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none"
                value={editTable.sort_order ?? 0}
                onChange={e => setEditTable(p => ({ ...p!, sort_order: Number(e.target.value) }))} />
            </div>
            <div className="flex gap-2.5 mt-5">
              <button onClick={() => setEditTable(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
              <button onClick={saveTable} disabled={saving} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">
                {saving ? 'Saving…' : editTable.id ? 'Save changes' : 'Create table'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
