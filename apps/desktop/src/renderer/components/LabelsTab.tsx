/**
 * LabelsTab — A571: barcode labels on the till (Manager › Stock › Labels), on any printer and any label size.
 *
 * Owner, 2026-10-22: "for now i cant tell what my clients will use as their printer or the label size can we do all?"
 *
 * Pick the items (search, a category, every generated code) and how many of each; the label (size, what is on it — the
 * business's, shared with the web's Print labels page); then print, the way chosen at print time:
 *   - Windows driver: any printer Windows knows (a label printer with its driver, or an office printer);
 *   - TSPL: TSC and most Xprinter label printers, no driver — by its IP (port 9100) or the USB printer, raw;
 *   - ZPL: Zebra, no driver — the same way;
 *   - Receipt printer: a barcode slip on the till roll (GS k or the bars as an image).
 * The items and prices are this till's own (offline too); the price is today's — reprint when a price changes.
 * Main does the printing (main/ipc/labels.ts); the preview here is the same layout (shared/labels.ts).
 *
 * A574 — every label carries a barcode (owner, 2026-10-22: "label should contain barcodes"): the barcode is no longer a
 * choice. Items chosen without one are given one when you print — "N items have no barcode yet — generate them and
 * print?" — through the cloud with your own sign-in (menu.edit); offline, or without that right, they are left out and
 * named, the rest print. Barcode numbering (format, prefix, start number, digits — owner: "i should also be able to set
 * barcode start sequence, number of digits i need etc") is set here too, with the next codes shown.
 */
import { useEffect, useMemo, useState } from 'react';
import { posApi, type LabelSetup, type LabelPrinter, type LabelPath } from '../lib/posApi';
import {
  encodeBarcode, isGeneratedCode, lacksBarcode, cleanBarcodeNumbering, numberingPreview, CODE128N_MIN_LENGTH, CODE128N_MAX_LENGTH,
  type BarcodeNumbering, type NumberingFormat,
} from '@zaptill/core/barcode';
import { cleanLabelSettings, labelSvg, layoutLabel, LABEL_SIZE_PRESETS, type LabelSettings } from '@zaptill/core/labels';
import { businessTerms } from '@zaptill/core/businessTerms';   // A574: every business type in its own words
import { labelsIntro } from '../lib/labelsWords';

const FORMAT_LABEL: Record<NumberingFormat, string> = {
  EAN13: 'EAN-13 (13 digits, most scanners)', EAN8: 'EAN-8 (8 digits, small items)', UPCA: 'UPC-A (12 digits)', CODE128N: 'Code 128, digits only (choose the length)',
};

const PATH_LABEL: Record<LabelPath, string> = {
  windows: 'Windows printer (driver installed)',
  tspl: 'Label printer, no driver: TSC / Xprinter (TSPL)',
  zpl: 'Label printer, no driver: Zebra (ZPL)',
  escpos: 'Receipt printer',
};
const field = 'bg-gray-900 border border-gray-600 rounded-md px-2 py-1.5 text-white text-sm';
const btn = 'px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-white text-sm disabled:opacity-40';

export default function LabelsTab() {
  const [setup, setSetup] = useState<LabelSetup | null>(null);
  const [settings, setSettings] = useState<LabelSettings | null>(null);
  const [printer, setPrinter] = useState<LabelPrinter | null>(null);
  const [windowsPrinters, setWindowsPrinters] = useState<string[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [numbering, setNumbering] = useState<BarcodeNumbering | null>(null);
  const [numMsg, setNumMsg] = useState('');

  useEffect(() => {
    posApi.labels.setup().then((s) => { setSetup(s); setSettings(cleanLabelSettings(s.settings)); setPrinter(s.printer); setNumbering(cleanBarcodeNumbering(s.numbering)); })
      .catch((e: any) => setMsg({ ok: false, text: e?.message ?? 'Could not open labels.' }));
    posApi.print.list().then((list) => setWindowsPrinters((list ?? []).map((p) => p.name))).catch(() => {});
  }, []);

  const products = setup?.products ?? [];
  const categories = useMemo(() => [...new Map(products.filter((p) => p.category_id).map((p) => [p.category_id as string, p.category ?? ''])).entries()], [products]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return products.filter((p) => (!category || p.category_id === category) && (!t || p.name.toLowerCase().includes(t) || (p.barcode ?? '').includes(t)));
  }, [products, q, category]);
  const picked = products.filter((p) => (qty[p.id] ?? 0) > 0);
  const total = picked.reduce((s, p) => s + (qty[p.id] ?? 0), 0);
  const first = picked[0] ?? shown[0];
  const numPreview = useMemo(() => (numbering ? numberingPreview(numbering, setup?.barcodes ?? products.map((p) => p.barcode)) : null), [numbering, setup, products]);
  // A574: an item without a barcode is shown with the next code it would get (an example) — never a label without bars.
  const firstBars = first ? encodeBarcode(first.barcode) : null;
  const exampleBars = firstBars ?? encodeBarcode(numPreview?.next[0] ?? '2000000000015');
  const preview = settings && first && exampleBars ? layoutLabel(settings, { name: first.name, price: first.price, currency: setup?.business.currency, business: setup?.business.name },
    exampleBars) : null;
  const missing = picked.filter((p) => lacksBarcode(p.barcode));

  if (!setup || !settings || !printer || !numbering) return <div className="p-6 text-gray-300">{msg?.text ?? 'Loading…'}</div>;

  const set = (patch: Partial<LabelSettings>) => setSettings((s) => cleanLabelSettings({ ...s, ...patch }));
  const setP = (patch: Partial<LabelPrinter>) => setPrinter((p) => ({ ...(p as LabelPrinter), ...patch }));
  const addAll = (list: typeof products) => setQty((cur) => ({ ...cur, ...Object.fromEntries(list.map((p) => [p.id, Math.max(cur[p.id] ?? 0, 1)])) }));

  const save = async () => {
    setBusy(true);
    try {
      const r = await posApi.labels.save({ settings, printer });
      setMsg({ ok: true, text: r.cloud === 'saved' ? 'Saved — the label is the business\'s, on every POS and the web.'
        : r.cloud === 'offline' ? 'Saved on this POS; the business\'s label is updated when the cloud can be reached.'
        : 'Saved on this POS (changing the business\'s label needs the right to edit products).' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Could not save.' }); }
    finally { setBusy(false); }
  };
  const print = async () => {
    // A574: items with no barcode get one first — the person is asked; without menu.edit main leaves them out and says so.
    let generate = false;
    if (missing.length && setup.canGenerate) {
      const n = missing.length;
      if (!window.confirm(`${n} item${n === 1 ? ' has' : 's have'} no barcode yet — generate ${n === 1 ? 'it' : 'them'} and print?`)) return;
      generate = true;
    }
    setBusy(true); setMsg(null);
    try {
      await posApi.labels.save({ printer });
      const r = await posApi.labels.print({ items: picked.map((p) => ({ product_id: p.id, copies: qty[p.id] })), path: printer.path, settings, generate });
      const gen = r.generated ?? [];
      if (gen.length) {
        const got = new Map(gen.map((g) => [g.id, g.barcode]));
        setSetup((s) => (s ? { ...s, products: s.products.map((p) => (got.has(p.id) ? { ...p, barcode: got.get(p.id) ?? p.barcode } : p)),
          barcodes: [...s.barcodes, ...gen.map((g) => g.barcode)] } : s));
      }
      const made = gen.length ? ` ${gen.length} barcode${gen.length === 1 ? '' : 's'} generated.` : '';
      setMsg(r.ok ? { ok: !r.skipped?.length, text: `${r.labels} label${r.labels === 1 ? '' : 's'} sent to the printer.${made}${r.warnings?.length ? ' ' + r.warnings.join('. ') + '.' : ''}${r.notice ? ' ' + r.notice : ''}` }
        : { ok: false, text: r.error ?? 'The labels did not print.' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'The labels did not print.' }); }
    finally { setBusy(false); }
  };
  const setNum = (patch: Partial<BarcodeNumbering>) => { setNumbering((n) => cleanBarcodeNumbering({ ...n, ...patch })); setNumMsg(''); };
  const saveNumbering = async () => {
    setBusy(true);
    try {
      const r = await posApi.labels.numbering(numbering);
      setNumbering(cleanBarcodeNumbering(r.numbering));
      setNumMsg(r.ok ? 'Saved — new barcodes follow this numbering, on every POS and the web. Existing barcodes are not changed.' : (r.error ?? 'Not saved.'));
    } catch (e: any) { setNumMsg(e?.message ?? 'Not saved.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 space-y-4 text-gray-200" data-testid="labels-tab">
      <div>
        <h2 className="text-lg font-semibold text-white">Labels</h2>
        <p className="text-sm text-gray-400" data-testid="labels-intro">{labelsIntro(setup.business.type)} Every label has a barcode. A label shows today's price — reprint it when the price changes.</p>
      </div>

      <section className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2">
        <h3 className="font-semibold text-white">1. Items</h3>
        <div className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${businessTerms(setup.business.type).products.toLowerCase()} by name or barcode`} className={`${field} flex-1`} />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
            <option value="">All categories</option>
            {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button className={btn} onClick={() => addAll(shown)}>Add all shown</button>
          <button className={btn} onClick={() => addAll(products.filter((p) => isGeneratedCode(p.barcode, numbering)))}>Add every generated code</button>
          <button className={btn} onClick={() => setQty({})}>Clear</button>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {shown.slice(0, 200).map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-1 border-b border-gray-700/60 text-sm">
              <span className="flex-1">{p.name}</span>
              <span className="font-mono text-xs text-gray-400">{p.barcode || <span className="text-amber-300">no barcode</span>}</span>
              <input type="number" min={0} max={999} value={qty[p.id] ?? 0} aria-label={`Labels of ${p.name}`}
                onChange={(e) => setQty((cur) => ({ ...cur, [p.id]: Math.max(0, Math.min(999, Math.floor(Number(e.target.value) || 0))) }))}
                className={`${field} w-20 text-right`} />
            </div>
          ))}
        </div>
        <p className="text-sm text-gray-400">{picked.length} item{picked.length === 1 ? '' : 's'}, {total} label{total === 1 ? '' : 's'}.
          {missing.length > 0 && <span className="text-amber-300" data-testid="labels-missing"> {missing.length} {missing.length === 1 ? 'has' : 'have'} no barcode yet — {setup.canGenerate
            ? 'one is generated when you print (needs the internet).' : 'ask a manager to generate barcodes for them; the others print.'}</span>}</p>
      </section>

      <section className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2">
        <h3 className="font-semibold text-white">2. The label</h3>
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <select className={field} aria-label="Label size"
            value={LABEL_SIZE_PRESETS.some((s) => s.widthMm === settings.widthMm && s.heightMm === settings.heightMm) ? `${settings.widthMm}x${settings.heightMm}` : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') { const [w, h] = e.target.value.split('x').map(Number); set({ widthMm: w, heightMm: h }); } }}>
            {LABEL_SIZE_PRESETS.map((s) => <option key={`${s.widthMm}x${s.heightMm}`} value={`${s.widthMm}x${s.heightMm}`}>{s.widthMm} × {s.heightMm} mm</option>)}
            <option value="custom">Custom</option>
          </select>
          <input type="number" className={`${field} w-16`} aria-label="Width (mm)" value={settings.widthMm} onChange={(e) => set({ widthMm: Number(e.target.value) })} />×
          <input type="number" className={`${field} w-16`} aria-label="Height (mm)" value={settings.heightMm} onChange={(e) => set({ heightMm: Number(e.target.value) })} />mm
          <span className="ml-2">gap</span><input type="number" className={`${field} w-14`} aria-label="Gap (mm)" value={settings.gapMm} onChange={(e) => set({ gapMm: Number(e.target.value) })} />mm
          <select className={field} value={settings.dpi} onChange={(e) => set({ dpi: Number(e.target.value) === 300 ? 300 : 203 })}>
            <option value={203}>203 dpi</option><option value={300}>300 dpi</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {/* A574: no Barcode switch — every label carries one. */}
          {([['showName', 'Name'], ['showPrice', 'Price'], ['showDigits', 'Digits under the bars'], ['showBusiness', 'Business name']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={settings[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<LabelSettings>)} />{label}</label>
          ))}
          <label className="flex items-center gap-1">After the price <input className={`${field} w-24`} maxLength={20} value={settings.unitText} onChange={(e) => set({ unitText: e.target.value })} placeholder="per kg" /></label>
        </div>
        <div className="bg-white rounded-md p-2 inline-block">{preview ? <div dangerouslySetInnerHTML={{ __html: labelSvg(preview) }} /> : <span className="text-gray-500 text-sm">No items</span>}</div>
        {first && !firstBars && <p className="text-xs text-gray-400">{first.name} has no barcode yet: the preview shows the next code as an example.</p>}
        {preview?.warnings.map((w) => <p key={w} className="text-xs text-amber-300">{w}</p>)}
      </section>

      {/* A574: barcode numbering — how new barcodes are made. */}
      <section className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2" data-testid="barcode-numbering">
        <h3 className="font-semibold text-white">Barcode numbering</h3>
        <p className="text-xs text-gray-400">How new barcodes are made (when you print an item without one, or generate on the web). Existing barcodes never change.</p>
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <select className={field} aria-label="Barcode format" value={numbering.format} disabled={!setup.canGenerate}
            onChange={(e) => setNum({ format: e.target.value as NumberingFormat })}>
            {(Object.keys(FORMAT_LABEL) as NumberingFormat[]).map((k) => <option key={k} value={k}>{FORMAT_LABEL[k]}</option>)}
          </select>
          <label className="flex items-center gap-1">Prefix <input className={`${field} w-24 font-mono`} inputMode="numeric" value={numbering.prefix} disabled={!setup.canGenerate}
            onChange={(e) => setNum({ prefix: e.target.value })} aria-label="Prefix" /></label>
          <label className="flex items-center gap-1">Start at <input type="number" min={1} className={`${field} w-28`} value={numbering.start} disabled={!setup.canGenerate}
            onChange={(e) => setNum({ start: Number(e.target.value) })} aria-label="Start number" /></label>
          {numbering.format === 'CODE128N' ? (
            <>
              <label className="flex items-center gap-1">Digits <input type="number" min={CODE128N_MIN_LENGTH} max={CODE128N_MAX_LENGTH} className={`${field} w-16`} value={numbering.length}
                disabled={!setup.canGenerate} onChange={(e) => setNum({ length: Number(e.target.value) })} aria-label="Number of digits" /></label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={numbering.checkDigit} disabled={!setup.canGenerate}
                onChange={(e) => setNum({ checkDigit: e.target.checked })} />Add a check digit</label>
            </>
          ) : <span className="text-gray-400">Digits: {numbering.length} (fixed by the format; the last is a check digit the scanner uses to catch misreads)</span>}
        </div>
        {numPreview && (
          <div className="text-xs space-y-0.5">
            <p className="text-gray-400">{numPreview.describe}</p>
            <p className="text-gray-300">Next: <span className="font-mono">{numPreview.next.join(', ') || '—'}</span> · {numPreview.remaining.toLocaleString()} code{numPreview.remaining === 1 ? '' : 's'} left in this range</p>
            {numPreview.exhausted && <p className="text-red-300">This range is used up: change the prefix or the number of digits.</p>}
            {numPreview.warnings.map((w) => <p key={w} className="text-amber-300">{w}</p>)}
          </div>
        )}
        {setup.canGenerate
          ? <div className="flex items-center gap-2"><button className={btn} onClick={saveNumbering} disabled={busy}>Save numbering</button>{numMsg && <span className="text-xs text-gray-300">{numMsg}</span>}</div>
          : <p className="text-xs text-gray-500">Changing the numbering needs the right to edit products.</p>}
      </section>

      <section className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2">
        <h3 className="font-semibold text-white">3. Printer</h3>
        <select className={field} value={printer.path} onChange={(e) => setP({ path: e.target.value as LabelPath })} aria-label="Print on">
          {(Object.keys(PATH_LABEL) as LabelPath[]).map((k) => <option key={k} value={k}>{PATH_LABEL[k]}</option>)}
        </select>
        {printer.path === 'windows' && (
          <div className="text-sm space-y-1">
            <select className={field} value={printer.windowsPrinter} onChange={(e) => setP({ windowsPrinter: e.target.value })}>
              <option value="">Windows default printer</option>
              {windowsPrinters.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="text-xs text-gray-400">In the printer's Windows settings, set the paper to {settings.widthMm} × {settings.heightMm} mm (the label), margins 0.</p>
          </div>
        )}
        {(printer.path === 'tspl' || printer.path === 'zpl') && (
          <div className="text-sm space-y-1">
            <input className={`${field} w-72`} value={printer.rawTarget} onChange={(e) => setP({ rawTarget: e.target.value })} placeholder="192.168.1.50  or  printer:Xprinter XP-365B" />
            <select className={field} value="" onChange={(e) => { if (e.target.value) setP({ rawTarget: `printer:${e.target.value}` }); }}>
              <option value="">USB: pick the Windows printer…</option>
              {windowsPrinters.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="text-xs text-gray-400">A network printer: its IP address (port 9100). USB: the printer as Windows names it — sent raw, no driver settings needed.</p>
          </div>
        )}
        {printer.path === 'escpos' && (
          <div className="text-sm space-y-1">
            <input className={`${field} w-72`} value={printer.escposTarget} onChange={(e) => setP({ escposTarget: e.target.value })}
              placeholder={setup.receiptPrinter ? `This POS's receipt printer (${setup.receiptPrinter.target})` : 'IP address, or printer:<name>'} />
            <select className={field} value={printer.escposWidthMm} onChange={(e) => setP({ escposWidthMm: Number(e.target.value) === 58 ? 58 : 80 })}>
              <option value={80}>80 mm</option><option value={58}>58 mm</option>
            </select>
            <select className={field} value={printer.escposMode} onChange={(e) => setP({ escposMode: e.target.value === 'raster' ? 'raster' : 'gsk' })}>
              <option value="gsk">Printer draws the barcode</option><option value="raster">Send the barcode as an image</option>
            </select>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <button onClick={print} disabled={busy || total === 0} data-testid="labels-print"
            className="px-4 py-2 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
            {busy ? 'Printing…' : `Print ${total} label${total === 1 ? '' : 's'}`}</button>
          <button onClick={save} disabled={busy} className={btn}>Save these settings</button>
        </div>
        {msg && <p className={`text-sm ${msg.ok ? 'text-gray-200' : 'text-red-300'}`} data-testid="labels-msg">{msg.text}</p>}
      </section>
    </div>
  );
}
