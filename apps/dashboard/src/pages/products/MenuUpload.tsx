/**
 * MenuUpload — A165 slice 3. One upload for the whole menu.
 *
 * Reads ONE multi-tab workbook (Products · Upgrades & Spices · Recipe ·
 * Ingredients), previews what each tab contains + obvious errors, then applies
 * them in DEPENDENCY ORDER — ingredients → products → upgrades → recipe — so a
 * recipe row can resolve the ingredient and product names the earlier tabs just
 * created. Each tab is sparse and name-keyed on the server (A165 slices 1–2), so
 * a workbook with only one tab filled changes only that tab.
 *
 * Preview here is client-side and structural (row counts + missing-required-field
 * errors). It is NOT a server diff (create-vs-update counts) — that would need
 * dry-run modes on the import endpoints, noted as a later enhancement. The server
 * still validates every row and reports per-row errors on apply.
 */
import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';

type Tab = 'ingredients' | 'products' | 'upgrades' | 'recipe';
const ORDER: Tab[] = ['ingredients', 'products', 'upgrades', 'recipe'];
const LABEL: Record<Tab, string> = {
  ingredients: 'Ingredients', products: 'Products', upgrades: 'Upgrades & Spices', recipe: 'Recipe',
};
const MATCH: Record<Tab, (n: string) => boolean> = {
  ingredients: n => n.includes('ingredient'),
  products:    n => n.includes('product'),
  upgrades:    n => n.includes('upgrade') || n.includes('spice'),
  recipe:      n => n.includes('recipe'),
};

type Parsed = Record<Tab, Record<string, any>[]>;
type TabPreview = { rows: number; errors: { row: number; error: string }[] };
type TabResult = { created?: number; updated?: number; skipped?: number; cleared?: number; deleted?: number; errors?: any[] };

const empty = (): Parsed => ({ ingredients: [], products: [], upgrades: [], recipe: [] });
const val = (r: Record<string, any>, ...keys: string[]) => {
  for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
};
const isDelete = (s: string) => s.toUpperCase() === 'DELETE';

function normSheet(ws: XLSX.WorkSheet): Record<string, any>[] {
  const raw = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' });
  return raw
    .map(r => {
      const o: Record<string, any> = {};
      for (const k of Object.keys(r)) o[String(k).trim().toLowerCase().replace(/\s+/g, '_')] = r[k];
      return o;
    })
    .filter(r => Object.values(r).some(v => String(v).trim() !== ''));
}

// Light structural checks that mirror the server's required fields, so obvious
// mistakes surface before anything is written.
function validate(tab: Tab, rows: Record<string, any>[]): { row: number; error: string }[] {
  const e: { row: number; error: string }[] = [];
  rows.forEach((r, i) => {
    const rn = i + 2; // +1 header, +1 to 1-based
    if (tab === 'products' && !val(r, 'name')) e.push({ row: rn, error: 'name is required' });
    if (tab === 'ingredients') {
      if (!val(r, 'name')) e.push({ row: rn, error: 'name is required' });
      else if (!val(r, 'unit')) e.push({ row: rn, error: 'unit is required' });
    }
    if (tab === 'upgrades') {
      if (!val(r, 'product', 'apply_to_product', 'name')) e.push({ row: rn, error: 'product is required' });
      else if (!val(r, 'group')) e.push({ row: rn, error: 'group is required' });
    }
    if (tab === 'recipe') {
      const ing = val(r, 'ingredient');
      if (!val(r, 'product', 'name')) e.push({ row: rn, error: 'product is required' });
      else if (ing && !isDelete(ing) && val(r, 'quantity_per_serving', 'quantity', 'qty') === '')
        e.push({ row: rn, error: `quantity is required for ${ing}` });
    }
  });
  return e;
}

export default function MenuUpload({
  onDone, onClose, onToast,
}: {
  onDone?: () => void;
  onClose: () => void;
  onToast?: (m: string) => void;
}) {
  const { activeBranchId } = useBranch();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [preview, setPreview] = useState<Record<Tab, TabPreview> | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<Tab, TabResult> | null>(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['SwiftPOS — Restaurant menu upload template'],
      ['Fill any tabs. Rows are matched by name and UPDATED, never duplicated. Only the tabs/columns'],
      ['you fill are changed. Leave a cell blank to leave it alone; put DELETE to clear it.'],
      ['Upgrades: type = free (no price) or upgrade (a 0 baseline + priced steps).'],
    ]), 'Read me');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['name', 'category', 'price', 'cost_price', 'description', 'sold_by', 'unit_label', 'pieces_per_unit',
        'track_stock', 'source', 'is_kitchen', 'tax_type', 'kra_item_class_code', 'reorder_level', 'plu_code', 'barcode', 'status'],
      ['Crispy Chicken Burger', 'Burgers', 550, '', 'Crispy fillet + house sauce', 'each', 'pc', 1,
        'yes', 'central_kitchen', 'yes', 'B', '', '', 'CCB01', '', 'active'],
    ]), 'Products');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['product', 'group', 'type', 'option', 'price_added', 'notes'],
      ['Soda', 'Drink size', 'upgrade', '350ml', 0, 'baseline — must be 0'],
      ['Soda', 'Drink size', 'upgrade', '1.25L', 130, ''],
      ['Crispy Chicken Burger', 'Spice level', 'free', 'Spicy', 0, 'free — no price change'],
    ]), 'Upgrades & Spices');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['product', 'ingredient', 'quantity_per_serving', 'unit', 'notes'],
      ['Crispy Chicken Burger', 'Chicken Fillet', 1, 'pc', ''],
    ]), 'Recipe');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['name', 'category', 'unit', 'unit_cost', 'reorder_level', 'is_packaging', 'notes'],
      ['Chicken Fillet', 'Meat', 'pc', 70, 40, 'no', ''],
    ]), 'Ingredients');
    XLSX.writeFile(wb, 'swiftpos-restaurant-import-template.xlsx');
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setResults(null); setMsg('');
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target!.result as ArrayBuffer), { type: 'array' });
        const out = empty();
        for (const sheetName of wb.SheetNames) {
          const n = sheetName.trim().toLowerCase();
          const tab = ORDER.find(t => MATCH[t](n));
          if (tab) out[tab] = normSheet(wb.Sheets[sheetName]);
        }
        const pv = {} as Record<Tab, TabPreview>;
        for (const t of ORDER) pv[t] = { rows: out[t].length, errors: validate(t, out[t]) };
        setParsed(out); setPreview(pv);
        if (ORDER.every(t => out[t].length === 0)) setMsg('No recognisable tabs found (Products, Upgrades & Spices, Recipe, Ingredients).');
      } catch (err: any) { setMsg(`Could not read the file: ${err?.message ?? err}`); setParsed(null); setPreview(null); }
    };
    reader.readAsArrayBuffer(file);
  }

  const totalRows = preview ? ORDER.reduce((s, t) => s + preview[t].rows, 0) : 0;
  const totalErrs = preview ? ORDER.reduce((s, t) => s + preview[t].errors.length, 0) : 0;
  const needsBranch = !!(preview && preview.ingredients.rows > 0 && !activeBranchId);

  async function apply() {
    if (!parsed) return;
    if (needsBranch) { setMsg('Ingredients carry per-branch opening stock — pick a specific branch in the top bar first.'); return; }
    setBusy(true); setMsg('');
    const res = {} as Record<Tab, TabResult>;
    try {
      for (const t of ORDER) {
        const rows = parsed[t];
        if (rows.length === 0) continue;
        if (t === 'ingredients') res[t] = await api.post('/api/stock/ingredients/bulk', { rows, branch_id: activeBranchId });
        else if (t === 'products') res[t] = await api.post('/api/products/bulk', { rows });
        else if (t === 'upgrades') res[t] = await api.post('/api/variants/bulk', { rows });
        else if (t === 'recipe')   res[t] = await api.post('/api/recipes/bulk', { rows });
      }
      setResults(res);
      onToast?.('Menu upload applied');
      onDone?.();
    } catch (e: any) { setMsg(e?.message ?? 'Upload failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-white">Menu upload</h2>
            <p className="text-sm text-gray-500">One workbook — products, upgrades, recipes and ingredients.</p>
          </div>
          <button onClick={downloadTemplate} className="text-sm text-green-400 hover:text-green-300 whitespace-nowrap">↓ Template</button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" />
            <button onClick={() => fileRef.current?.click()}
                    className="w-full border border-dashed border-gray-700 rounded-lg py-6 text-sm text-gray-400 hover:border-green-500 hover:text-white transition-colors">
              {fileName ? `📄 ${fileName} — choose another` : 'Choose an .xlsx workbook'}
            </button>
          </div>

          {msg && <p className="text-sm text-amber-400">{msg}</p>}

          {preview && !results && (
            <div className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-3 py-2 text-xs text-gray-400 bg-gray-800/40 border-b border-gray-800">
                {totalRows} row{totalRows === 1 ? '' : 's'} across {ORDER.filter(t => preview[t].rows > 0).length} tab(s){totalErrs ? ` · ${totalErrs} to fix` : ''}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {ORDER.map(t => (
                    <tr key={t} className="border-b border-gray-800/60">
                      <td className="px-3 py-2 text-gray-200">{LABEL[t]}</td>
                      <td className="px-3 py-2 text-right text-gray-400">{preview[t].rows || '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {preview[t].errors.length
                          ? <span className="text-red-400">{preview[t].errors.length} error{preview[t].errors.length === 1 ? '' : 's'}</span>
                          : preview[t].rows ? <span className="text-green-400">ok</span> : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalErrs > 0 && (
                <div className="px-3 py-2 text-xs text-red-300 bg-red-500/5 border-t border-gray-800 max-h-28 overflow-y-auto">
                  {ORDER.flatMap(t => preview[t].errors.slice(0, 5).map((er, i) =>
                    <div key={t + i}>{LABEL[t]} row {er.row}: {er.error}</div>))}
                </div>
              )}
              {needsBranch && <div className="px-3 py-2 text-xs text-amber-300 border-t border-gray-800">Pick a specific branch in the top bar — ingredients opening stock is per-branch.</div>}
            </div>
          )}

          {results && (
            <div className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-3 py-2 text-xs text-gray-400 bg-gray-800/40 border-b border-gray-800">Applied</div>
              <table className="w-full text-sm">
                <tbody>
                  {ORDER.filter(t => results[t]).map(t => {
                    const r = results[t]; const errs = r.errors?.length ?? 0;
                    const done = (r.created ?? 0) + (r.updated ?? 0);
                    return (
                      <tr key={t} className="border-b border-gray-800/60">
                        <td className="px-3 py-2 text-gray-200">{LABEL[t]}</td>
                        <td className="px-3 py-2 text-right text-green-400">{done} saved</td>
                        <td className="px-3 py-2 text-right">{errs ? <span className="text-red-400">{errs} skipped</span> : <span className="text-gray-600">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800">
            {results ? 'Close' : 'Cancel'}
          </button>
          {preview && !results && (
            <button onClick={apply} disabled={busy || totalRows === 0 || needsBranch}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-400 text-gray-950 disabled:opacity-50">
              {busy ? 'Applying…' : `Apply ${totalRows} row${totalRows === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
