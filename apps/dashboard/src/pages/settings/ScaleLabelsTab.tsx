/**
 * ScaleLabelsTab — A577: Settings › Business › Scale labels.
 *
 * Owner, 2026-10-23 (approved): items sold by weight; the barcodes a weighing scale prints on their labels. Each scale is
 * set up to print one layout — the item's scale code and either the label's PRICE or the WEIGHT inside an EAN-13 that
 * starts 21–29. The owner picks the scale (a preset), or sets the layout by hand, and scans one real label into the test
 * box to see what the till will read from it — before relying on it. Saved as business_settings 'scale_barcodes'
 * (POST /api/business/settings, settings.business; the cloud cleans it — lib/scaleBarcode.ts cleanScaleSettings) and sent
 * to every till and the web POS with pos/init.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { useBusiness } from '../../context/BusinessContext';
import {
  SCALE_PRESETS, SCALE_SETTINGS_KEY, cleanScaleSettings, scaleSettingsOrDefault, presetSettings, explainScaleBarcode,
  findScaleProduct, scaleLine, formatWeight, layoutLength, type ScaleSettings,
} from '../../lib/scaleBarcode';

interface ProductRow { id: string; name: string; base_price: number; plu_code?: string | null; sold_by?: string | null; unit_label?: string | null; status?: string }

const PREFIXES = ['21', '22', '23', '24', '25', '26', '27', '28', '29'];
const field = 'w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-swift';

export default function ScaleLabelsTab() {
  const { business } = useBusiness();
  const currency = business?.currency ?? 'KES';
  const [settings, setSettings] = useState<ScaleSettings>(() => scaleSettingsOrDefault(null));
  const [saved, setSaved] = useState<string>('');
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [sample, setSample] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Array<{ key: string; value: string }>>('/api/business/settings')
      .then((rows) => {
        const s = scaleSettingsOrDefault((rows ?? []).find((r) => r.key === SCALE_SETTINGS_KEY)?.value ?? null);
        setSettings(s); setSaved(JSON.stringify(s));
      })
      .catch(() => { /* the default stays */ });
    api.get<ProductRow[]>('/api/products').then((p) => setProducts(p ?? [])).catch(() => setProducts([]));
  }, []);

  const check = cleanScaleSettings(settings);
  const problem = 'error' in check ? check.error : null;
  const dirty = JSON.stringify(settings) !== saved;
  const set = (patch: Partial<ScaleSettings>) => setSettings((s) => ({ ...s, ...patch, preset: 'custom' }));
  const togglePrefix = (p: string) => set({
    prefixes: settings.prefixes.includes(p) ? settings.prefixes.filter((x) => x !== p) : [...settings.prefixes.filter((x) => x !== '2'), p].sort(),
  });

  const tested = useMemo(() => {
    const code = sample.replace(/\s/g, '');
    if (!code) return null;
    const r = explainScaleBarcode(code, settings);
    if (!('reading' in r)) return { ok: false as const, text: r.reason };
    const product = findScaleProduct(products, r.reading.itemCode);
    const line = product ? scaleLine(Number(product.base_price), r.reading) : null;
    return { ok: true as const, reading: r.reading, product, line };
  }, [sample, settings, products]);

  async function save() {
    if (problem) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api.post<{ value: string }>('/api/business/settings', { key: SCALE_SETTINGS_KEY, value: settings });
      const s = scaleSettingsOrDefault(r?.value ?? settings);
      setSettings(s); setSaved(JSON.stringify(s));
      setMsg({ ok: true, text: 'Saved — the points of sale read it at their next sync.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' });
    } finally { setSaving(false); }
  }

  const weighed = products.filter((p) => p.sold_by === 'weight');
  const noCode = weighed.filter((p) => !p.plu_code);
  const preset = SCALE_PRESETS.find((p) => p.id === settings.preset);

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-5" data-testid="scale-labels">
      <div>
        <h2 className="text-lg font-bold text-white">Scale labels</h2>
        <p className="text-sm text-gray-500 mt-1">
          Items sold by weight are weighed on a label scale; the label's barcode carries the item's scale code and its price
          or weight. Choose your scale, then scan one of its labels below to check.
        </p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium text-gray-200">Read scale labels at the POS</span>
            <span className="block text-xs text-gray-500">Off: a scale's barcode is looked up like any other barcode.</span>
          </span>
          <input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
                 className="w-5 h-5 accent-teal-500" />
        </label>

        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Your scale</label>
          <select className={field} value={preset ? preset.id : 'custom'} data-testid="scale-preset"
                  onChange={(e) => { if (e.target.value !== 'custom') setSettings({ ...presetSettings(e.target.value), enabled: settings.enabled }); }}>
            {SCALE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="custom">Set up by hand</option>
          </select>
          <p className="text-xs text-gray-500 mt-1.5">
            {preset ? preset.layout : 'Your own layout'} — scales can be set up differently; scan a label below to be sure.
          </p>
        </div>

        <details className="rounded-lg border border-gray-800 p-3" open={!preset}>
          <summary className="text-sm text-gray-300 cursor-pointer">The label's layout</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div className="sm:col-span-2">
              <span className="block text-xs text-gray-500 mb-1.5">Prefixes the scale prints (20 is ZapTill's own codes — never a scale's)</span>
              <div className="flex flex-wrap gap-1.5">
                {PREFIXES.map((p) => (
                  <button key={p} type="button" onClick={() => togglePrefix(p)}
                          className={`px-2.5 py-1 rounded-md text-sm border ${settings.prefixes.includes(p) || settings.prefixes.includes('2') ? 'bg-teal-700 border-teal-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}`}>
                    {p}
                  </button>
                ))}
                <button type="button" onClick={() => set({ prefixes: settings.prefixes.includes('2') ? [...PREFIXES] : ['2'] })}
                        className={`px-2.5 py-1 rounded-md text-sm border ${settings.prefixes.includes('2') ? 'bg-teal-700 border-teal-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}`}>
                  2 + a 6-digit code
                </button>
              </div>
            </div>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1.5">Item code digits</span>
              <input type="number" min={3} max={7} className={field} value={settings.itemDigits} onChange={(e) => set({ itemDigits: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1.5">The label carries</span>
              <select className={field} value={settings.valueType}
                      onChange={(e) => set({ valueType: e.target.value === 'weight' ? 'weight' : 'price', decimals: e.target.value === 'weight' ? 3 : 0 })}>
                <option value="price">The price</option>
                <option value="weight">The weight</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1.5">{settings.valueType === 'weight' ? 'Weight' : 'Price'} digits</span>
              <input type="number" min={4} max={6} className={field} value={settings.valueDigits} onChange={(e) => set({ valueDigits: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1.5">Decimals</span>
              <select className={field} value={settings.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })}>
                {settings.valueType === 'weight'
                  ? <><option value={3}>3 — grams (00452 = 0.452 kg)</option><option value={2}>2 — tens of grams (00045 = 0.45 kg)</option></>
                  : <><option value={0}>0 — whole {currency} (00294 = 294)</option><option value={2}>2 — cents (29380 = 293.80)</option></>}
              </select>
            </label>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={settings.valueCheckDigit} onChange={(e) => set({ valueCheckDigit: e.target.checked })} className="accent-teal-500" />
              <span className="text-sm text-gray-300">The scale prints a check digit before the {settings.valueType} (DIGI-style)</span>
            </label>
          </div>
          <p className={`text-xs mt-3 ${problem ? 'text-red-400' : 'text-gray-500'}`} data-testid="scale-layout">
            {problem ?? `${layoutLength(settings)} digits: prefix + item code (${settings.itemDigits})${settings.valueCheckDigit ? ' + check' : ''} + ${settings.valueType} (${settings.valueDigits}) + check digit.`}
          </p>
        </details>

        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={!!problem || saving || !dirty}
                  className="px-4 py-2 rounded-lg bg-swift-strong text-white text-sm font-semibold disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {msg && <span className={`text-sm ${msg.ok ? 'text-swift-text' : 'text-red-400'}`}>{msg.text}</span>}
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">Test a label</h3>
        <input className={field} placeholder="Scan a label from your scale here (13 digits)" value={sample} data-testid="scale-test-input"
               onChange={(e) => setSample(e.target.value)} inputMode="numeric" />
        {tested && !tested.ok && <p className="text-sm text-amber-400" data-testid="scale-test-result">{tested.text}</p>}
        {tested && tested.ok && (
          <div className="text-sm space-y-1" data-testid="scale-test-result">
            <p className="text-gray-300">Item code <span className="text-white font-semibold">{tested.reading.itemCode}</span> ·{' '}
              {tested.reading.valueType === 'price'
                ? <>price <span className="text-white font-semibold">{money(tested.reading.price ?? 0, currency)}</span></>
                : <>weight <span className="text-white font-semibold">{formatWeight(tested.reading.weightKg ?? 0)}</span></>}
            </p>
            {tested.product && tested.line
              ? <p className="text-swift-text">→ {tested.product.name}: {formatWeight(tested.line.quantity, tested.product.unit_label === 'g' ? 'g' : 'kg')} @ {money(tested.product.base_price, currency)}/kg = {money(tested.line.lineTotal, currency)}</p>
              : <p className="text-amber-400">No item has the scale code {tested.reading.itemCode} — set it on the item (Products › Sold by weight › Scale code).</p>}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        {weighed.length} item{weighed.length === 1 ? '' : 's'} sold by weight{noCode.length ? ` · ${noCode.length} without a scale code (they are weighed at the POS with the keypad)` : ''}.
        A scale connected to the POS by cable is not read yet — print a label on the scale and scan it, or type the weight.
      </p>
    </div>
  );
}
