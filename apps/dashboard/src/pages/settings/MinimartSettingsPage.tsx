/**
 * MinimartSettingsPage.tsx
 * Route: /dashboard/settings/minimart
 * Converted to Tailwind — Session 2 Phase 2
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import BulkProductImport from '../products/BulkProductImport';

interface Product {
  id: string; name: string; base_price: number;
  barcode?: string; plu_code?: string; sold_by?: string;
  status: string; categories?: { name: string } | null;
}

interface BizSetting { key: string; value: string; }

type Tab = 'scan' | 'products' | 'import';

const SOLD_BY_OPTS = [
  { value: 'each',   label: 'Each / unit' },
  { value: 'weight', label: 'By weight (kg)' },
  { value: 'volume', label: 'By volume (L)' },
];

function Badge({ children, color }: { children: React.ReactNode; color: 'blue' | 'violet' | 'amber' | 'cyan' | 'slate' }) {
  const map = {
    blue:   'bg-blue-500/10 border border-blue-500/30 text-blue-400',
    violet: 'bg-violet-500/10 border border-violet-500/30 text-violet-400',
    amber:  'bg-amber-500/10 border border-amber-500/30 text-amber-400',
    cyan:   'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400',
    slate:  'bg-slate-700/50 border border-slate-600/30 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${map[color]}`}>
      {children}
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

export default function MinimartSettingsPage() {
  const [tab, setTab]             = useState<Tab>('scan');
  const [products, setProducts]   = useState<Product[]>([]);
  const [settings, setSettings]   = useState<Record<string, string>>({});
  const [search, setSearch]       = useState('');
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState('');
  const [editProduct, setEditProduct] = useState<Product | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const [prods, biz] = await Promise.all([
      api.get<Product[]>('/api/products'),
      api.get<BizSetting[]>('/api/business/settings'),
    ]);
    setProducts(prods ?? []);
    const map: Record<string, string> = {};
    (biz ?? []).forEach(s => { map[s.key] = s.value; });
    setSettings(map);
  }

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function saveSetting(key: string, value: string) {
    setSaving(true);
    try {
      await api.post('/api/business/settings', { key, value });
      setSettings(prev => ({ ...prev, [key]: value }));
      showToast('Saved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save');
    } finally { setSaving(false); }
  }

  async function saveProduct(product: Product) {
    try {
      await api.patch(`/api/products/${product.id}`, {
        barcode:  product.barcode || null,
        plu_code: product.plu_code || null,
        sold_by:  product.sold_by || 'each',
      });
      setProducts(prev => prev.map(p => p.id === product.id ? product : p));
      setEditProduct(null);
      showToast('Product updated');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not update the product');
    }
  }

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.barcode ?? '').includes(search) ||
    (p.plu_code ?? '').includes(search)
  );

  const tabs: { key: Tab; label: string }[] = [
    { key: 'scan',     label: '📡 Scanner' },
    { key: 'products', label: '📦 Products & Barcodes' },
    { key: 'import',   label: '📤 Bulk Import' },
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Minimart Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your minimart POS behaviour, products and barcode scanner</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-800">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── SCAN SETTINGS ── */}
      {tab === 'scan' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-base font-bold text-white mb-4">Scanner behaviour</h2>

          {[
            { key: 'hold_requires_pin', label: 'Hold order requires manager PIN', hint: 'When enabled, cashiers need a manager PIN to hold or unhold orders' },
            { key: 'minimart_catalogue_default', label: 'Show product catalogue by default', hint: 'Catalogue is hidden by default — enable to always show it on load' },
            { key: 'scanner_beep', label: 'Scanner beep on successful scan', hint: 'Play audio confirmation when barcode is found', defaultTrue: true },
          ].map(({ key, label, hint, defaultTrue }) => (
            <div key={key} className="flex items-center justify-between py-3.5 border-b border-gray-800 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-200">{label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
              </div>
              <Toggle
                checked={defaultTrue ? settings[key] !== 'false' : settings[key] === 'true'}
                onChange={v => saveSetting(key, String(v))}
              />
            </div>
          ))}

          <div className="flex items-center justify-between py-3.5">
            <div>
              <div className="text-sm font-medium text-gray-200">Default weight unit</div>
              <div className="text-xs text-gray-500 mt-0.5">Unit displayed for weighed items on receipts</div>
            </div>
            <select
              className="bg-gray-950 border border-gray-700 rounded-lg text-white px-3 py-2 text-sm"
              value={settings['weight_unit'] ?? 'kg'}
              onChange={e => saveSetting('weight_unit', e.target.value)}
            >
              <option value="kg">Kilograms (kg)</option>
              <option value="g">Grams (g)</option>
              <option value="lb">Pounds (lb)</option>
            </select>
          </div>
        </div>
      )}

      {/* ── PRODUCTS & BARCODES ── */}
      {tab === 'products' && (
        <div>
          <div className="mb-4">
            <input
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-gray-600"
              placeholder="Search by name, barcode or PLU…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Product', 'Category', 'Price', 'Barcode', 'PLU', 'Sold by', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-3 py-3 text-sm font-semibold text-white">{p.name}</td>
                    <td className="px-3 py-3 text-xs text-gray-500">{p.categories?.name ?? '—'}</td>
                    <td className="px-3 py-3 text-sm font-semibold text-green-400">{Number(p.base_price).toFixed(2)}</td>
                    <td className="px-3 py-3">
                      {p.barcode ? <Badge color="blue">{p.barcode}</Badge> : <span className="text-gray-700 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      {p.plu_code ? <Badge color="violet">{p.plu_code}</Badge> : <span className="text-gray-700 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <Badge color={p.sold_by === 'weight' ? 'amber' : p.sold_by === 'volume' ? 'cyan' : 'slate'}>
                        {p.sold_by ?? 'each'}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => setEditProduct({ ...p })}
                        className="px-3 py-1 text-xs text-blue-400 border border-gray-700 rounded-md hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Edit product modal */}
          {editProduct && (
            <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl">
                <div className="flex justify-between items-center mb-5">
                  <h3 className="text-base font-bold text-white">Edit: {editProduct.name}</h3>
                  <button onClick={() => setEditProduct(null)} className="w-7 h-7 bg-gray-800 hover:bg-gray-700 border-none rounded-md text-gray-400 text-sm cursor-pointer">✕</button>
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Barcode (EAN-13, Code128, etc.)</label>
                  <input
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-gray-600"
                    placeholder="e.g. 5900215123456"
                    value={editProduct.barcode ?? ''}
                    onChange={e => setEditProduct(p => p ? { ...p, barcode: e.target.value } : p)}
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">PLU Code (for scale-printed barcodes)</label>
                  <input
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-gray-600"
                    placeholder="e.g. 00142" maxLength={5}
                    value={editProduct.plu_code ?? ''}
                    onChange={e => setEditProduct(p => p ? { ...p, plu_code: e.target.value } : p)}
                  />
                  <p className="text-xs text-gray-600 mt-1">5-digit code embedded in weighed-item EAN-13 barcodes</p>
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Sold by</label>
                  <select
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm"
                    value={editProduct.sold_by ?? 'each'}
                    onChange={e => setEditProduct(p => p ? { ...p, sold_by: e.target.value } : p)}
                  >
                    {SOLD_BY_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                <div className="flex gap-2.5 mt-5">
                  <button onClick={() => setEditProduct(null)} className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors">Cancel</button>
                  <button onClick={() => saveProduct(editProduct!)} className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors">Save changes</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── BULK IMPORT ── */}
      {tab === 'import' && <BulkProductImport onImported={loadData} onToast={showToast} />}
    </div>
  );
}
