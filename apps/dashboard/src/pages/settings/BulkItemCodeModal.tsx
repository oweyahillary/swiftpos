/**
 * BulkItemCodeModal — assign KRA tax type + item classification codes across the
 * catalogue without editing products one by one. Two modes:
 *   1. By category — pick a category (or all), set tax type + one class code,
 *      optionally only fill products that don't have a code yet.
 *   2. CSV — export current products, fill the kra_item_class_code column, re-import.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';

interface Category { id: string; name: string; }
interface ProductLite {
  id: string; name: string; category_id: string | null;
  tax_type?: string; kra_item_class_code?: string | null;
}

const TAX_TYPES = [
  { code: 'A', label: 'A — Exempt' },
  { code: 'B', label: 'B — 16% (Standard)' },
  { code: 'C', label: 'C — Zero-rated' },
  { code: 'D', label: 'D — Non-VAT' },
  { code: 'E', label: 'E — 8%' },
];

export default function BulkItemCodeModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'category' | 'csv'>('category');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [categoryId, setCategoryId] = useState<string>('');     // '' = all
  const [taxType, setTaxType] = useState('B');
  const [classCode, setClassCode] = useState('');
  const [onlyUnset, setOnlyUnset] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [cats, prods] = await Promise.all([
        api.get<Category[]>('/api/categories'),
        api.get<ProductLite[]>('/api/products'),
      ]);
      setCategories(cats ?? []);
      setProducts(prods ?? []);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Failed to load' });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const scopeProducts = categoryId
    ? products.filter(p => p.category_id === categoryId)
    : products;
  const unsetCount = scopeProducts.filter(p => !p.kra_item_class_code).length;

  const applyByCategory = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.patch<{ updated: number }>('/api/products/bulk-tax/by-category', {
        category_id: categoryId || undefined,
        tax_type: taxType,
        kra_item_class_code: classCode.trim() || undefined,
        only_unset: onlyUnset,
      });
      setMsg({ kind: 'ok', text: `Updated ${r.updated} product(s)` });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Update failed' });
    } finally { setBusy(false); }
  };

  // ── CSV export: id, name, current code (so the merchant fills the blanks) ───
  const exportCsv = () => {
    const header = 'id,name,tax_type,kra_item_class_code';
    const lines = products.map(p => {
      const name = `"${(p.name ?? '').replace(/"/g, '""')}"`;
      return [p.id, name, p.tax_type ?? 'B', p.kra_item_class_code ?? ''].join(',');
    });
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'product-tax-codes.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // ── CSV import: parse, send rows with a code or tax type ────────────────────
  const importCsv = async (file: File) => {
    setBusy(true); setMsg(null);
    try {
      const text = await file.text();
      const rows = text.split(/\r?\n/).filter(Boolean);
      const header = rows.shift()?.split(',').map(h => h.trim().toLowerCase()) ?? [];
      const idIdx = header.indexOf('id');
      const taxIdx = header.indexOf('tax_type');
      const codeIdx = header.indexOf('kra_item_class_code');
      if (idIdx === -1) throw new Error('CSV must have an "id" column');

      const items = rows.map(line => {
        // naive CSV split that respects the one quoted field (name)
        const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) ?? line.split(',');
        const item: any = { id: cells[idIdx]?.replace(/^"|"$/g, '').trim() };
        if (taxIdx !== -1 && cells[taxIdx]) item.tax_type = cells[taxIdx].trim().toUpperCase();
        if (codeIdx !== -1) item.kra_item_class_code = (cells[codeIdx] ?? '').replace(/^"|"$/g, '').trim();
        return item;
      }).filter(i => i.id);

      const r = await api.patch<{ updated: number; skipped: number; errors: any[] }>(
        '/api/products/bulk-tax/by-ids', { items },
      );
      setMsg({ kind: 'ok', text: `Updated ${r.updated}, skipped ${r.skipped}, errors ${r.errors.length}` });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Import failed' });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Bulk KRA item codes</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>

        <div className="flex gap-2 mb-5">
          <button onClick={() => setTab('category')}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'category' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
            By category
          </button>
          <button onClick={() => setTab('csv')}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'csv' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
            CSV import / export
          </button>
        </div>

        {msg && (
          <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
            {msg.text}
          </div>
        )}

        {tab === 'category' ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Category</label>
              <select value={categoryId} onChange={e => setCategoryId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white">
                <option value="">All categories</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {scopeProducts.length} product(s) in scope · {unsetCount} without a code
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Tax type</label>
                <select value={taxType} onChange={e => setTaxType(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white">
                  {TAX_TYPES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Item class code</label>
                <input value={classCode} onChange={e => setClassCode(e.target.value)} placeholder="e.g. 50161509"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={onlyUnset} onChange={e => setOnlyUnset(e.target.checked)} />
              Only fill products that don't have a code yet
            </label>
            <button onClick={applyByCategory} disabled={busy}
              className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {busy ? 'Applying…' : 'Apply to scope'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Export your products, fill the <code className="text-gray-300">kra_item_class_code</code> column
              (and adjust <code className="text-gray-300">tax_type</code> if needed), then import the file back.
            </p>
            <button onClick={exportCsv}
              className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-sm">
              ⬇ Export {products.length} products to CSV
            </button>
            <label className="block">
              <span className="block text-sm text-gray-400 mb-1.5">Import filled CSV</span>
              <input type="file" accept=".csv" disabled={busy}
                onChange={e => { const f = e.target.files?.[0]; if (f) importCsv(f); }}
                className="block w-full text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-green-600 file:text-white hover:file:bg-green-500" />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
