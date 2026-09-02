/**
 * BulkProductImport — CSV bulk create/update of products.
 *
 * Extracted verbatim from MinimartSettingsPage's "Bulk Import" tab (register
 * A140) so the same importer can be surfaced on the general Products page for
 * every product-carrying business type, not just minimart. Self-contained:
 * holds its own parse/validate/POST state; the only outward coupling is two
 * optional callbacks.
 *
 *   onImported — called after a successful POST so the host can refresh its list
 *                (minimart: loadData; products: fetchAll).
 *   onToast    — optional transient message hook (minimart passes its toast;
 *                the products modal shows the inline result block instead).
 *
 * POSTs { rows } to /api/products/bulk (≤500 rows; existing rows matched by
 * barcode). Behaviour is identical to the original inline tab.
 */
import { useState, useRef } from 'react';
import { api } from '../../lib/api';

export default function BulkProductImport({
  onImported,
  onToast,
}: {
  onImported?: () => void;
  onToast?: (msg: string) => void;
}) {
  const [importRows, setImportRows]     = useState<any[]>([]);
  const [importErrors, setImportErrors] = useState<{ row: number; error: string }[]>([]);
  const [importing, setImporting]       = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text   = ev.target?.result as string;
      const lines  = text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
      const rows   = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
        return obj;
      });
      const errors: { row: number; error: string }[] = [];
      rows.forEach((row, i) => {
        if (!row.name) errors.push({ row: i + 2, error: 'name is required' });
        if (!row.base_price || isNaN(parseFloat(row.base_price)))
          errors.push({ row: i + 2, error: `invalid price: ${row.base_price}` });
      });
      setImportRows(rows); setImportErrors(errors); setImportResult(null);
    };
    reader.readAsText(file);
  }

  async function runImport() {
    if (importErrors.length > 0) return;
    setImporting(true);
    try {
      const result = await api.post<any>('/api/products/bulk', { rows: importRows });
      setImportResult(result);
      onToast?.(`Import complete: ${result.summary.created} created, ${result.summary.updated} updated`);
      onImported?.();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Import failed');
    } finally { setImporting(false); }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-base font-bold text-white mb-1">Bulk product import</h2>
      <p className="text-sm text-gray-500 mb-4">
        Upload a CSV file to create or update products. Max 500 rows per import.
        Existing products are matched by barcode — if a barcode matches, the product is updated.
      </p>

      <a
        className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mb-4 no-underline"
        href="data:text/csv;charset=utf-8,name,base_price,cost_price,category_name,barcode,plu_code,sold_by,description"
        download="swiftpos_products_template.csv"
      >
        ⬇ Download CSV template
      </a>

      <div
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-gray-600 transition-colors mt-2"
      >
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        <div className="text-3xl mb-2">📂</div>
        <div className="text-sm text-gray-400">
          {importRows.length > 0 ? `${importRows.length} rows loaded` : 'Click to choose CSV file'}
        </div>
        {importRows.length > 0 && <div className="text-xs text-gray-600 mt-1">Click to replace file</div>}
      </div>

      {importErrors.length > 0 && (
        <div className="bg-red-500/8 border border-red-500/30 rounded-lg p-4 mt-4">
          <div className="font-semibold mb-2 text-red-300 text-sm">
            {importErrors.length} validation error{importErrors.length !== 1 ? 's' : ''} — fix before importing
          </div>
          {importErrors.slice(0, 10).map((e, i) => (
            <div key={i} className="text-xs text-red-300 py-0.5">Row {e.row}: {e.error}</div>
          ))}
          {importErrors.length > 10 && (
            <div className="text-xs text-gray-500 mt-1">…and {importErrors.length - 10} more</div>
          )}
        </div>
      )}

      {importRows.length > 0 && importErrors.length === 0 && (
        <div className="overflow-x-auto my-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                {Object.keys(importRows[0]).map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {importRows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-b border-gray-800/50">
                  {Object.values(row).map((v: any, j) => (
                    <td key={j} className="px-3 py-2 text-xs text-gray-400">{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {importRows.length > 5 && (
            <div className="text-xs text-gray-500 py-2">Showing 5 of {importRows.length} rows</div>
          )}
        </div>
      )}

      {importResult && (
        <div className="bg-green-500/8 border border-green-500/30 rounded-lg p-4 mt-4">
          <div className="font-bold text-green-300 mb-2">Import complete</div>
          <div className="text-sm text-green-400">✓ {importResult.summary.created} products created</div>
          <div className="text-sm text-green-400">✓ {importResult.summary.updated} products updated</div>
          {importResult.summary.failed > 0 && (
            <div className="text-sm text-red-300">✗ {importResult.summary.failed} failed</div>
          )}
        </div>
      )}

      <div className="flex gap-2.5 mt-4">
        <button
          disabled={importRows.length === 0 || importErrors.length > 0 || importing}
          onClick={runImport}
          className="flex-1 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed border-none rounded-lg text-white text-sm font-bold cursor-pointer transition-colors"
        >
          {importing ? 'Importing…' : `Import ${importRows.length} products`}
        </button>
        {importRows.length > 0 && (
          <button
            onClick={() => { setImportRows([]); setImportErrors([]); setImportResult(null); if (fileRef.current) fileRef.current.value = ''; }}
            className="flex-1 py-2.5 bg-transparent border border-gray-700 rounded-lg text-gray-400 text-sm cursor-pointer hover:border-gray-600 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
