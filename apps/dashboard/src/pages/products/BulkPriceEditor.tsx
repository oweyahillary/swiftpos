/**
 * BulkPriceEditor — A166, day-to-day bulk price changes.
 *
 * "all sodas +20 / drinks +10% / round to nearest 10" — and now also "these 6
 * items I ticked". Two scopes: a whole CATEGORY, or an explicit SELECTION of
 * product ids passed in from the Products table. Pick an operation, PREVIEW the
 * exact old→new prices, then apply. Preview and apply both hit
 * POST /api/products/bulk-price (dry_run true then false), computed by one
 * server-side helper — so the numbers you confirm are exactly what gets written.
 */
import { useState } from 'react';
import { api } from '../../lib/api';

type OpType = 'set' | 'plus' | 'percent' | 'round';
type Row = { id: string; name: string; current: number; next?: number; error?: string };

const OP_LABEL: Record<OpType, string> = {
  set:     'Set price to',
  plus:    'Add / subtract amount',
  percent: 'Change by percent',
  round:   'Round to nearest',
};
const OP_HINT: Record<OpType, string> = {
  set:     'Every item in scope becomes this price.',
  plus:    'Use a negative number to reduce (e.g. -20).',
  percent: 'Use a negative number for a discount (e.g. -10 for 10% off).',
  round:   'e.g. 10 rounds 253 → 250, 256 → 260.',
};

export default function BulkPriceEditor({
  categories,
  productIds,
  onApplied,
  onClose,
  onToast,
}: {
  categories: { id: string; name: string }[];
  /** When provided (non-empty), the tool targets exactly these products instead
   *  of a category — this is the row-level selection from the Products table. */
  productIds?: string[];
  onApplied?: () => void;
  onClose: () => void;
  onToast?: (msg: string) => void;
}) {
  const selectionMode = !!(productIds && productIds.length);

  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? '');
  const [opType, setOpType] = useState<OpType>('percent');
  const [value, setValue] = useState<string>('');
  const [preview, setPreview] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const scopeLabel = selectionMode
    ? `${productIds!.length} selected item${productIds!.length === 1 ? '' : 's'}`
    : (categories.find(c => c.id === categoryId)?.name ?? '');

  const body = () => selectionMode
    ? { ids: productIds, op: { type: opType, value: Number(value) } }
    : { category_id: categoryId, op: { type: opType, value: Number(value) } };

  // Any change invalidates a shown preview, so nobody applies stale numbers.
  const dirty = () => setPreview(null);

  async function runPreview() {
    if (!selectionMode && !categoryId) { setMsg('Pick a category.'); return; }
    if (value.trim() === '' || !Number.isFinite(Number(value))) { setMsg('Enter a number.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await api.post<{ preview: Row[]; would_update: number; errors: number }>(
        '/api/products/bulk-price', { ...body(), dry_run: true });
      setPreview(r?.preview ?? []);
      if (!r?.preview?.length) setMsg('No products in scope.');
    } catch (e: any) { setMsg(e?.message ?? 'Preview failed'); }
    finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post<{ updated: number; errors: { id: string; error: string }[] }>(
        '/api/products/bulk-price', body());
      onToast?.(`Updated ${r.updated} price${r.updated === 1 ? '' : 's'}` +
        (r.errors?.length ? `, ${r.errors.length} skipped` : ''));
      onApplied?.();
      onClose();
    } catch (e: any) { setMsg(e?.message ?? 'Apply failed'); }
    finally { setBusy(false); }
  }

  const changing = (preview ?? []).filter(r => r.next !== undefined && r.next !== r.current).length;
  const errored  = (preview ?? []).filter(r => r.error).length;

  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-800">
          <h2 className="text-base font-bold text-white">Bulk price change</h2>
          <p className="text-sm text-gray-500">
            {selectionMode ? `Change the price of your ${scopeLabel}.` : 'Change every price in a category at once.'}
          </p>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {selectionMode ? (
            <div className="text-sm text-gray-300 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2">
              Scope: <span className="font-semibold text-white">{scopeLabel}</span>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Category</label>
              <select value={categoryId} onChange={e => { setCategoryId(e.target.value); dirty(); }}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Operation</label>
              <select value={opType} onChange={e => { setOpType(e.target.value as OpType); dirty(); }}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                {(Object.keys(OP_LABEL) as OpType[]).map(t => <option key={t} value={t}>{OP_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{opType === 'percent' ? 'Percent' : 'Amount'}</label>
              <input type="number" value={value} onChange={e => { setValue(e.target.value); dirty(); }}
                     className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                     placeholder={opType === 'percent' ? 'e.g. 10' : 'e.g. 20'} />
            </div>
          </div>
          <p className="text-xs text-gray-500">{OP_HINT[opType]}</p>

          {msg && <p className="text-sm text-amber-400">{msg}</p>}

          {preview && preview.length > 0 && (
            <div className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-3 py-2 text-xs text-gray-400 bg-gray-800/40 border-b border-gray-800">
                {changing} will change{errored ? ` · ${errored} can't (shown in red)` : ''}
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {preview.map(r => (
                      <tr key={r.id} className="border-b border-gray-800/60">
                        <td className="px-3 py-1.5 text-gray-200">{r.name}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{r.current}</td>
                        <td className="px-2 py-1.5 text-center text-gray-600">→</td>
                        <td className={'px-3 py-1.5 text-right font-medium ' +
                          (r.error ? 'text-red-400' : r.next === r.current ? 'text-gray-600' : 'text-green-400')}>
                          {r.error ? 'skip' : r.next}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
          {!preview
            ? <button onClick={runPreview} disabled={busy}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50">
                {busy ? 'Working…' : 'Preview'}
              </button>
            : <button onClick={apply} disabled={busy || changing === 0}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-400 text-gray-950 disabled:opacity-50">
                {busy ? 'Applying…' : `Apply to ${changing}`}
              </button>}
        </div>
      </div>
    </div>
  );
}
