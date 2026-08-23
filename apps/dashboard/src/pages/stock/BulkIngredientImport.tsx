/**
 * BulkIngredientImport — CSV bulk create/update of ingredients WITH opening stock
 * (register A141). Mirrors BulkProductImport, but posts to
 * /api/stock/ingredients/bulk with a branch_id, because opening stock and reorder
 * levels are per-branch. Opening stock is applied only to ingredients the import
 * CREATES (a re-import to fix a name/cost never re-adds stock — the server enforces
 * this too). Self-contained: holds its own parse/validate/POST state.
 *
 *   branchId    — the branch that opening stock lands in (required; the host gates
 *                 on a specific branch being selected, like the adjust flow).
 *   branchLabel — shown so the user can see where stock will be seeded.
 *   onImported  — called after a successful POST so the host can refresh its list.
 *   onToast     — optional transient message hook.
 */
import { useState, useRef } from 'react';
import { api } from '../../lib/api';

const TEMPLATE =
  'name,category,unit,unit_cost,reorder_level,opening_stock,notes,is_packaging';

export default function BulkIngredientImport({
  branchId,
  branchLabel,
  onImported,
  onToast,
}: {
  branchId: string;
  branchLabel?: string;
  onImported?: () => void;
  onToast?: (msg: string) => void;
}) {
  const [rows, setRows]         = useState<Record<string, string>[]>([]);
  const [errors, setErrors]     = useState<{ row: number; error: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult]     = useState<{ created: number; updated: number; stocked: number; errors: { row: number; error: string }[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text    = ev.target?.result as string;
      const lines   = text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
      const parsed  = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
        return obj;
      });
      const errs: { row: number; error: string }[] = [];
      parsed.forEach((row, i) => {
        if (!row.name) errs.push({ row: i + 2, error: 'name is required' });
        if (!row.unit) errs.push({ row: i + 2, error: 'unit is required' });
        if (row.opening_stock && isNaN(parseFloat(row.opening_stock)))
          errs.push({ row: i + 2, error: `invalid opening_stock: ${row.opening_stock}` });
        if (row.unit_cost && isNaN(parseFloat(row.unit_cost)))
          errs.push({ row: i + 2, error: `invalid unit_cost: ${row.unit_cost}` });
      });
      setRows(parsed); setErrors(errs); setResult(null);
    };
    reader.readAsText(file);
  }

  async function runImport() {
    if (errors.length > 0 || rows.length === 0) return;
    setImporting(true);
    try {
      const res = await api.post<typeof result>('/api/stock/ingredients/bulk', { rows, branch_id: branchId });
      setResult(res);
      onToast?.(`Import complete: ${res!.created} created, ${res!.updated} updated, ${res!.stocked} stocked`);
      onImported?.();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Import failed');
    } finally { setImporting(false); }
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-3">
        Upload a CSV to create or update ingredients (max 500 rows). Existing
        ingredients are matched by name — a match updates rather than duplicates.
        <strong className="text-gray-400"> Opening stock is added only to newly created
        ingredients</strong>, seeded into
        {' '}<strong className="text-gray-300">{branchLabel || 'the selected branch'}</strong>.
      </p>

      <a
        className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mb-3 no-underline"
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}
        download="swiftpos_ingredients_template.csv"
      >
        ⬇ Download CSV template
      </a>

      <div
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-gray-600 transition-colors"
      >
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        <div className="text-3xl mb-2">📂</div>
        <div className="text-sm text-gray-400">
          {rows.length > 0 ? `${rows.length} rows loaded` : 'Click to choose CSV file'}
        </div>
        {rows.length > 0 && <div className="text-xs text-gray-600 mt-1">Click to replace file</div>}
      </div>

      {errors.length > 0 && (
        <div className="bg-red-500/8 border border-red-500/30 rounded-lg p-4 mt-4">
          <div className="font-semibold mb-2 text-red-300 text-sm">
            {errors.length} validation error{errors.length !== 1 ? 's' : ''} — fix before importing
          </div>
          {errors.slice(0, 10).map((e, i) => (
            <div key={i} className="text-xs text-red-300 py-0.5">Row {e.row}: {e.error}</div>
          ))}
          {errors.length > 10 && <div className="text-xs text-gray-500 mt-1">…and {errors.length - 10} more</div>}
        </div>
      )}

      {rows.length > 0 && errors.length === 0 && (
        <div className="overflow-x-auto my-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                {Object.keys(rows[0]).map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-b border-gray-800/50">
                  {Object.values(row).map((v, j) => (
                    <td key={j} className="px-3 py-2 text-xs text-gray-400">{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 5 && <div className="text-xs text-gray-500 py-2">Showing 5 of {rows.length} rows</div>}
        </div>
      )}

      {result && (
        <div className="bg-green-500/8 border border-green-500/30 rounded-lg p-4 mt-4 text-sm">
          <div className="font-semibold text-green-300 mb-1">Import complete</div>
          <div className="text-gray-300">
            {result.created} created · {result.updated} updated · {result.stocked} stocked
            {result.errors?.length > 0 && <span className="text-red-300"> · {result.errors.length} row error(s)</span>}
          </div>
          {result.errors?.slice(0, 10).map((e, i) => (
            <div key={i} className="text-xs text-red-300 py-0.5">Row {e.row}: {e.error}</div>
          ))}
        </div>
      )}

      {rows.length > 0 && errors.length === 0 && !result && (
        <button
          onClick={runImport}
          disabled={importing}
          className="mt-2 px-4 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold"
        >
          {importing ? 'Importing…' : `Import ${rows.length} ingredient${rows.length !== 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}
