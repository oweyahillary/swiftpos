/**
 * LabelsPage — A571: print barcode labels on any printer, any label size (Menu › Products › Print labels).
 *
 * Owner, 2026-10-22: "for now i cant tell what my clients will use as their printer or the label size can we do all?"
 *
 * Two ways out from the web, chosen at print time:
 *   - a LABEL PRINTER (or any printer) through its own driver: one label per page, the page the label's size
 *     (`@page { size: Wmm Hmm; margin: 0 }`), the bars an SVG — crisp at whatever DPI the driver prints;
 *   - an A4 / Letter STICKER SHEET (3×7, 3×8, 4×10, 5×13 or custom), starting at label N so a part-used sheet is used up.
 * "Save as PDF" in the browser's print window makes a PDF of either. The raw label languages (TSPL / ZPL) and the
 * receipt printer are the till's (Manager › Stock › Labels) — a browser cannot reach a printer without a driver.
 *
 * The layout and the bars are lib/labels.ts and lib/barcode.ts (copies of shared/, the till runs the same).
 * The price on a label is the item's price NOW — labels are reprinted when a price changes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import type { Product, Category } from '../../types';
import { encodeBarcode, isInStoreCode, lacksBarcode } from '../../lib/barcode';
import {
  cleanLabelSettings, DEFAULT_LABEL_SETTINGS, LABEL_SIZE_PRESETS, SHEET_PRESETS, labelSvg, labelsHtml, layoutLabels,
  sheetGrid, MAX_LABELS_PER_RUN, type LabelSettings, type LabelRow, type SheetPresetId,
} from '../../lib/labels';

/** Print an HTML document from a hidden frame (the browser's own print window: any installed printer, or PDF). */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

const field = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-swift';
const btn = 'bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40';

export default function LabelsPage() {
  const { business } = useBusiness();
  const [params] = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [settings, setSettings] = useState<LabelSettings>(DEFAULT_LABEL_SETTINGS);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [since, setSince] = useState('');
  const [startAt, setStartAt] = useState(1);
  const [msg, setMsg] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<Product[]>('/api/products'),
      api.get<Category[]>('/api/categories').catch(() => [] as Category[]),
      api.get<LabelSettings>('/api/products/labels/settings').catch(() => DEFAULT_LABEL_SETTINGS),
    ]).then(([p, c, s]) => {
      setProducts((p ?? []).filter((x) => x.status === 'active'));
      setCategories(c ?? []);
      setSettings(cleanLabelSettings(s));
      const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.length) setQty(Object.fromEntries(ids.map((id) => [id, 1])));
    }).catch((e: any) => setMsg(e?.message ?? 'Could not load the products'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<LabelSettings>) => { setSettings((s) => cleanLabelSettings({ ...s, ...patch })); setSaved(''); };
  const setSheet = (patch: Partial<LabelSettings['sheet']>) => set({ sheet: { ...settings.sheet, ...patch } });

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => (!category || p.category_id === category)
      && (!q || p.name.toLowerCase().includes(q) || String(p.barcode ?? '').includes(q)));
  }, [products, search, category]);
  const picked = useMemo(() => products.filter((p) => (qty[p.id] ?? 0) > 0), [products, qty]);
  const noCode = picked.filter((p) => lacksBarcode(p.barcode) || !encodeBarcode(p.barcode));
  const rows: LabelRow[] = picked.map((p) => ({
    item: { name: p.name, price: Number(p.base_price), currency: business?.currency || 'KES', business: business?.name ?? '' },
    barcode: p.barcode ?? null, copies: qty[p.id] ?? 0,
  }));
  const total = rows.reduce((s, r) => s + r.copies, 0);
  const sample = useMemo(() => (rows.length ? layoutLabels([{ ...rows[0], copies: 1 }], settings, encodeBarcode)[0] : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, picked[0]?.id, picked[0]?.barcode, picked[0]?.base_price]);
  const grid = sheetGrid(settings.sheet);

  const addAll = (list: Product[], n = 1) => setQty((q) => ({ ...q, ...Object.fromEntries(list.map((p) => [p.id, Math.max(q[p.id] ?? 0, n)])) }));
  const fromDelivery = async () => {
    if (!since) { setMsg('Pick the day the delivery came in.'); return; }
    setMsg('');
    try {
      const got = await api.get<{ product_id: string; quantity: number }[]>(`/api/products/labels/restocked?since=${since}`);
      if (!got.length) { setMsg('Nothing was restocked since that day.'); return; }
      setQty((q) => ({ ...q, ...Object.fromEntries(got.map((g) => [g.product_id, Math.ceil(g.quantity)])) }));
    } catch (e: any) { setMsg(e?.message ?? 'Could not read the deliveries'); }
  };
  const saveSettings = async () => {
    try { setSettings(cleanLabelSettings(await api.put<LabelSettings>('/api/products/labels/settings', settings))); setSaved('Saved for every till and the web.'); }
    catch (e: any) { setSaved(e?.message ?? 'Could not save'); }
  };
  const print = (mode: 'roll' | 'sheet') => {
    if (!total) { setMsg('Choose the items and how many labels of each.'); return; }
    const size = mode === 'sheet' ? { widthMm: grid.cells[0].w, heightMm: grid.cells[0].h } : {};
    const labels = layoutLabels(rows, settings, encodeBarcode, size);
    printHtml(labelsHtml(labels, { mode, sheet: settings.sheet, startAt, title: 'Labels' }));
  };

  return (
    <div className="p-4 sm:p-8 space-y-6" data-testid="labels-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Print labels</h1>
          <p className="text-gray-400 text-sm mt-0.5">Any label printer, an office printer, or A4 sticker sheets. <Link to="/dashboard/products" className="text-swift-text hover:underline">Back to products</Link></p>
        </div>
      </div>

      <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
        A label shows the item's price today. When you change a price, reprint that item's labels.
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* What to print */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h2 className="text-white font-semibold">1. What to print</h2>
          <div className="flex flex-wrap gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or barcode" className={`${field} flex-1 min-w-[10rem]`} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button className={btn} onClick={() => addAll(shown)}>Add all shown ({shown.length})</button>
            <button className={btn} onClick={() => addAll(products.filter((p) => isInStoreCode(p.barcode)))}>Add every generated code</button>
            <span className="text-xs text-gray-500">Delivery since</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={field} />
            <button className={btn} onClick={fromDelivery}>Add the items restocked</button>
            <button className={btn} onClick={() => setQty({})}>Clear</button>
          </div>
          <div className="max-h-80 overflow-y-auto border border-gray-800 rounded-lg">
            <table className="w-full text-sm">
              <tbody>
                {shown.slice(0, 300).map((p) => (
                  <tr key={p.id} className="border-b border-gray-800/60">
                    <td className="px-3 py-1.5 text-gray-200">{p.name}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{p.barcode || <span className="text-amber-400">no barcode</span>}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input type="number" min={0} max={999} value={qty[p.id] ?? 0} aria-label={`Labels of ${p.name}`}
                        onChange={(e) => setQty((q) => ({ ...q, [p.id]: Math.max(0, Math.min(999, Math.floor(Number(e.target.value) || 0))) }))}
                        className={`${field} w-20 text-right`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-gray-400">{picked.length} item{picked.length === 1 ? '' : 's'}, {total} label{total === 1 ? '' : 's'}
            {total > MAX_LABELS_PER_RUN && <span className="text-amber-400"> — only the first {MAX_LABELS_PER_RUN} print in one go</span>}</p>
          {noCode.length > 0 && (
            <p className="text-sm text-amber-400">{noCode.length} chosen item{noCode.length === 1 ? ' has' : 's have'} no barcode: the label prints without bars.
              Use <Link to="/dashboard/products" className="underline">Generate barcodes</Link> on the Products page first.</p>
          )}
        </section>

        {/* The label */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h2 className="text-white font-semibold">2. The label</h2>
          <div className="flex flex-wrap gap-2 items-center">
            <select className={field} aria-label="Label size"
              value={LABEL_SIZE_PRESETS.some((s) => s.widthMm === settings.widthMm && s.heightMm === settings.heightMm) ? `${settings.widthMm}x${settings.heightMm}` : 'custom'}
              onChange={(e) => { if (e.target.value !== 'custom') { const [w, h] = e.target.value.split('x').map(Number); set({ widthMm: w, heightMm: h }); } }}>
              {LABEL_SIZE_PRESETS.map((s) => <option key={`${s.widthMm}x${s.heightMm}`} value={`${s.widthMm}x${s.heightMm}`}>{s.widthMm} × {s.heightMm} mm</option>)}
              <option value="custom">Custom size</option>
            </select>
            <input type="number" className={`${field} w-20`} aria-label="Width (mm)" value={settings.widthMm} onChange={(e) => set({ widthMm: Number(e.target.value) })} />
            <span className="text-gray-500">×</span>
            <input type="number" className={`${field} w-20`} aria-label="Height (mm)" value={settings.heightMm} onChange={(e) => set({ heightMm: Number(e.target.value) })} />
            <span className="text-gray-500 text-sm">mm</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-gray-300">
            {([['showName', 'Item name'], ['showPrice', 'Price'], ['showBarcode', 'Barcode'], ['showDigits', 'Digits under the bars'], ['showBusiness', 'Business name']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={settings[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<LabelSettings>)} />{label}</label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-center text-sm text-gray-300">
            <span>After the price</span>
            <input className={`${field} w-32`} placeholder='e.g. "per kg"' value={settings.unitText} maxLength={20} onChange={(e) => set({ unitText: e.target.value })} />
            <span>Printer</span>
            <select className={field} value={settings.dpi} onChange={(e) => set({ dpi: Number(e.target.value) === 300 ? 300 : 203 })}>
              <option value={203}>203 dpi (most)</option><option value={300}>300 dpi</option>
            </select>
          </div>
          <div className="bg-white rounded-lg p-3 grid place-items-center min-h-[8rem]">
            {sample ? <div dangerouslySetInnerHTML={{ __html: labelSvg(sample) }} /> : <p className="text-gray-500 text-sm">Choose an item to see its label.</p>}
          </div>
          {sample?.warnings.map((w) => <p key={w} className="text-xs text-amber-400">{w}</p>)}
          <div className="flex items-center gap-3">
            <button className={btn} onClick={saveSettings}>Save as the business's label</button>
            {saved && <span className="text-xs text-gray-400">{saved}</span>}
          </div>
        </section>
      </div>

      {/* Print */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <h2 className="text-white font-semibold">3. Print</h2>
        {msg && <p className="text-sm text-amber-400">{msg}</p>}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-200">On a label printer (or any printer)</h3>
            <p className="text-xs text-gray-500">One label per page, {settings.widthMm} × {settings.heightMm} mm. In the print window pick the label printer;
              its driver's paper size must be the label's size (see the manual). Margins: none. "Save as PDF" makes a PDF.</p>
            <button onClick={() => print('roll')} disabled={!total} data-testid="print-roll"
              className="bg-swift hover:bg-swift-light text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-40">Print {total} label{total === 1 ? '' : 's'}</button>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-200">On A4 / Letter sticker sheets</h3>
            <div className="flex flex-wrap gap-2 items-center text-sm text-gray-300">
              <select className={field} value={settings.sheet.preset} aria-label="Sheet layout"
                onChange={(e) => { const id = e.target.value as SheetPresetId; set({ sheet: id === 'custom' ? { ...settings.sheet, preset: 'custom' } : { ...SHEET_PRESETS[id] } }); }}>
                <option value="3x7">A4 3 × 7 (21 labels)</option>
                <option value="3x8">A4 3 × 8 (24 labels)</option>
                <option value="4x10">A4 4 × 10 (40 labels)</option>
                <option value="5x13">A4 5 × 13 (65 labels)</option>
                <option value="custom">Custom</option>
              </select>
              <span>start at label</span>
              <input type="number" min={1} max={grid.cells.length} value={startAt} className={`${field} w-20`} aria-label="Start at label"
                onChange={(e) => setStartAt(Math.max(1, Math.min(grid.cells.length, Math.floor(Number(e.target.value) || 1))))} />
            </div>
            {settings.sheet.preset === 'custom' && (
              <div className="flex flex-wrap gap-2 items-center text-xs text-gray-400">
                <select className={field} value={settings.sheet.paper} onChange={(e) => setSheet({ paper: e.target.value === 'Letter' ? 'Letter' : 'A4' })}>
                  <option value="A4">A4</option><option value="Letter">Letter</option>
                </select>
                {([['cols', 'Columns'], ['rows', 'Rows'], ['marginTopMm', 'Top margin'], ['marginLeftMm', 'Side margin'], ['gapXMm', 'Gap across'], ['gapYMm', 'Gap down']] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1">{label}
                    <input type="number" className={`${field} w-16`} value={settings.sheet[k]} onChange={(e) => setSheet({ [k]: Number(e.target.value) } as Partial<LabelSettings['sheet']>)} />
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-500">Each label {grid.cells[0]?.w} × {grid.cells[0]?.h} mm, {grid.cells.length} a sheet{!grid.fits && <span className="text-amber-400"> — this grid runs off the page</span>}.
              Print at 100% ("Actual size"), margins none.</p>
            <button onClick={() => print('sheet')} disabled={!total} data-testid="print-sheet"
              className="bg-swift hover:bg-swift-light text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-40">Print on sheets</button>
          </div>
        </div>
        <p className="text-xs text-gray-500">A label printer with no Windows driver (TSPL or ZPL over the network or USB), or the receipt printer: print from the till — Manager › Stock › Labels.</p>
      </section>
    </div>
  );
}
