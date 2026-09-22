import { useEffect, useMemo, useRef, useState } from 'react';
import { monoRasterFromRGBA, monoRasterToString, monoRasterFromString, RECEIPT_LOGO_MAX_WIDTH, RECEIPT_LOGO_MAX_HEIGHT, type MonoRaster } from '../../lib/escposRenderer';
import { api } from '../../lib/api';

/**
 * Settings › Business › Branding (A308, SCOPE-A295 §6). The owner/admin-facing editor for
 * client branding: pick an accent (a vetted palette + an optional custom colour, legibility-
 * guarded) and upload a logo (PNG/JPEG, auto-shrunk to the 250 KB cap the till stores), with a
 * LIVE lock-screen preview so the client sees exactly what a till will show.
 *
 * Writes the same `business_branding` row (PUT /api/business/branding, A303) the till pulls and
 * renders (A304). The server re-validates at the persist boundary; this page just makes it
 * settable without a technician.
 *
 * A313: receipt preview + "Print logo on receipts" toggle added — the raster is thresholded HERE with
 * the bundled shared/printing rule, so what the client approves is byte-for-byte what a till prints.
 * (Earlier note, kept for history:) SCOPE §6 also asks for a RECEIPT preview. Receipt-logo printing (monochrome `logo_receipt`)
 * is not built yet (the receipt renderer prints no logo today), so a receipt preview would show a
 * feature that doesn't print. Deferred with that slice; this page ships the lock-screen half, which
 * is the live feature. The receipt preview becomes required the moment receipt-logo printing lands.
 */

// SCOPE §8.A — the vetted accent palette (WCAG-checked on the lock surface + white button text).
const PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'SwiftPOS Blue', hex: '#3b82f6' },
  { name: 'Indigo',        hex: '#6366f1' },
  { name: 'Violet',        hex: '#7c3aed' },
  { name: 'Emerald',       hex: '#059669' },
  { name: 'Teal',          hex: '#0d9488' },
  { name: 'Rose',          hex: '#e11d48' },
  { name: 'Pink',          hex: '#db2777' },
  { name: 'Amber',         hex: '#b45309' },
];
const DEFAULT_ACCENT = '#0d9488';      // the till's shipped default (A295 — teal)
const LOCK_SURFACE = '#0f172a';        // the lock-screen card the accent sits on
const MAX_LOGO_BYTES = 250 * 1024;

// ── WCAG contrast (enough to guard a custom accent; the palette is pre-vetted) ──────────────
function lum(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: string, b: string): number {
  const [L1, L2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (L1 + 0.05) / (L2 + 0.05);
}
const HEX6 = /^#[0-9a-fA-F]{6}$/;
// Legible if it reads on the dark surface (divider/dot) AND white button text sits on it — 3:1
// each, the SCOPE §8.A threshold.
function isLegible(hex: string): boolean {
  return HEX6.test(hex) && ratio(hex, LOCK_SURFACE) >= 3 && ratio('#ffffff', hex) >= 3;
}

// ── client-side logo resize: shrink to fit the 250 KB cap, re-encode PNG (shrink, never crop) ──
const STEP_EDGES = [1024, 768, 512, 384, 256];
function dataUriBytes(u: string): number {
  const b64 = u.slice(u.indexOf(',') + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}
async function prepareLogo(file: File): Promise<{ dataUri: string; warning?: string }> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) throw new Error('SVG isn’t supported yet — upload a PNG or JPEG.');
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Use a PNG or JPEG image.');
  if (file.size > 10 * 1024 * 1024) throw new Error('That image is over 10 MB — use a smaller file.');
  const bmp = await createImageBitmap(file);
  try {
    const longest = Math.max(bmp.width, bmp.height);
    const start = Math.min(longest, 1024);
    for (const edge of [start, ...STEP_EDGES.filter((e) => e < start)]) {
      const scale = Math.min(1, edge / longest);
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); if (!ctx) throw new Error('Could not process the image.');
      ctx.clearRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
      const uri = c.toDataURL('image/png');
      if (dataUriBytes(uri) <= MAX_LOGO_BYTES) {
        return { dataUri: uri, warning: edge < start ? `Logo reduced to ${edge}px to fit the ${MAX_LOGO_BYTES / 1024} KB limit.` : (longest < 128 ? 'This logo is small; it may look soft on the card.' : undefined) };
      }
    }
    throw new Error('This logo is too detailed to store under 250 KB — use a simpler mark.');
  } finally { bmp.close(); }
}

/** A313: the receipt raster for a prepared logo — decode on a canvas (≤384×240, alpha kept),
 *  then threshold with the SAME shared/printing rule the till uses. Returns the stored string. */
async function receiptRasterFor(dataUri: string): Promise<string> {
  const bmp = await createImageBitmap(await (await fetch(dataUri)).blob());
  try {
    const scale = Math.min(1, RECEIPT_LOGO_MAX_WIDTH / bmp.width, RECEIPT_LOGO_MAX_HEIGHT / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Could not read the logo pixels.');
    ctx.clearRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
    return monoRasterToString(monoRasterFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h));
  } finally { bmp.close(); }
}

/** Paint a MonoRaster onto a canvas, 1 px per dot, for the receipt preview. */
function paintRaster(r: MonoRaster, c: HTMLCanvasElement): void {
  c.width = r.width; c.height = r.height;
  const ctx = c.getContext('2d'); if (!ctx) return;
  const img = ctx.createImageData(r.width, r.height);
  const stride = Math.ceil(r.width / 8);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const black = (r.bytes[y * stride + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
    const p = (y * r.width + x) * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = black ? 0 : 255; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export default function BrandingTab() {
  const [accentHex, setAccentHex] = useState<string>('');     // '' = default
  const [logoPng, setLogoPng] = useState<string | null>(null);
  const [logoReceipt, setLogoReceipt] = useState<string | null>(null);        // A313: mono1 raster string
  const [receiptLogoEnabled, setReceiptLogoEnabled] = useState(false);      // A313: opt-in toggle
  const [bizName, setBizName] = useState('Your business');
  const receiptRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ accent_hex: string | null; logo_png: string | null; logo_receipt?: string | null; receipt_logo_enabled?: boolean } | null>('/api/business/branding')
      .then((b) => { setAccentHex(b?.accent_hex ?? ''); setLogoPng(b?.logo_png ?? null); setLogoReceipt(b?.logo_receipt ?? null); setReceiptLogoEnabled(b?.receipt_logo_enabled === true); })
      .then(() => api.get<{ name?: string }>('/api/business').then((biz) => { if (biz?.name) setBizName(biz.name); }).catch(() => {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const custom = accentHex.trim() !== '' && !PALETTE.some((p) => p.hex.toLowerCase() === accentHex.trim().toLowerCase());
  const legible = accentHex.trim() === '' || isLegible(accentHex.trim());
  const shownAccent = legible && accentHex.trim() ? accentHex.trim() : DEFAULT_ACCENT;

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!f) return; setMsg(''); setWarn('');
    try { const { dataUri, warning } = await prepareLogo(f); setLogoPng(dataUri); if (warning) setWarn(warning); setLogoReceipt(await receiptRasterFor(dataUri)); }
    catch (err: any) { setMsg(String(err?.message ?? err)); }
  };

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await api.put('/api/business/branding', {
        accent_hex: accentHex.trim() || null,
        logo_png: logoPng,
        logo_receipt: logoPng ? logoReceipt : null,           // A313: no logo → no raster
        receipt_logo_enabled: !!logoPng && receiptLogoEnabled,
      });
      setMsg('Saved. Tills pick up the new branding within about 20 seconds — no restart needed.');
    } catch (err: any) { setMsg(err?.message ?? 'Could not save branding.'); }
    finally { setBusy(false); }
  };

  const clearAll = async () => {
    setBusy(true); setMsg('');
    try {
      await api.put('/api/business/branding', { accent_hex: null, logo_png: null, logo_receipt: null, receipt_logo_enabled: false });
      setAccentHex(''); setLogoPng(null); setLogoReceipt(null); setReceiptLogoEnabled(false); setWarn('');
      setMsg('Reset to the SwiftPOS default.');
    } catch (err: any) { setMsg(err?.message ?? 'Could not reset branding.'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="p-6 text-gray-500">Loading branding…</div>;

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold mb-1">Branding</h2>
      <p className="text-sm text-gray-500 mb-6">Your logo and accent colour on the till lock screen. Changes reach tills automatically.</p>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Controls */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Accent colour</label>
          <div className="flex flex-wrap gap-2 mb-3">
            {PALETTE.map((p) => (
              <button key={p.hex} title={p.name} onClick={() => setAccentHex(p.hex)}
                className={`h-8 w-8 rounded-full border-2 ${accentHex.trim().toLowerCase() === p.hex.toLowerCase() ? 'border-gray-900' : 'border-transparent'}`}
                style={{ background: p.hex }} aria-label={p.name} />
            ))}
            <button title="SwiftPOS default" onClick={() => setAccentHex('')}
              className={`h-8 px-3 rounded-full border text-xs ${accentHex.trim() === '' ? 'border-gray-900' : 'border-gray-300'} text-gray-700`}>
              Default
            </button>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <input type="text" value={accentHex} onChange={(e) => setAccentHex(e.target.value)} placeholder="#0d9488"
              className="border rounded-lg px-3 py-2 text-sm font-mono w-36" />
            <span className="text-xs text-gray-500">or a custom hex</span>
          </div>
          {custom && !legible && (
            <p className="text-xs text-amber-600 mb-4">That colour isn’t legible on the lock screen — tills will fall back to the default. Pick a stronger shade or use the palette.</p>
          )}
          {custom && legible && <p className="text-xs text-green-600 mb-4">Legible ✓</p>}

          <label className="block text-sm font-medium text-gray-700 mb-2 mt-2">Logo</label>
          <div className="flex items-center gap-3 mb-1">
            <div className="h-16 w-16 rounded-lg bg-white border flex items-center justify-center overflow-hidden shrink-0">
              {logoPng ? <img src={logoPng} alt="logo" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-gray-400">none</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={onPick} className="text-sm" />
          </div>
          <p className="text-xs text-gray-500">PNG or JPEG. Shrunk to fit automatically (≤250 KB). SVG isn’t supported yet.</p>
          {logoPng && <button onClick={() => { setLogoPng(null); setLogoReceipt(null); setReceiptLogoEnabled(false); }} className="text-xs text-gray-500 underline mt-1">Remove logo</button>}
          {warn && <p className="text-xs text-amber-600 mt-1">{warn}</p>}

          {/* A313: opt-in receipt logo */}
          <label className="flex items-center gap-2 mt-4 text-sm text-gray-700">
            <input type="checkbox" checked={receiptLogoEnabled} disabled={!logoPng} onChange={(e) => setReceiptLogoEnabled(e.target.checked)} />
            Print logo on customer receipts
          </label>
          <p className="text-xs text-gray-500 ml-6">Off by default. Check the receipt preview first — thermal printers are black-and-white.</p>

          <div className="flex gap-2 mt-6">
            <button onClick={save} disabled={busy} className="bg-gray-900 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-40">Save branding</button>
            <button onClick={clearAll} disabled={busy} className="border rounded-lg px-4 py-2 text-sm disabled:opacity-40">Reset to default</button>
          </div>
          {msg && <p className="text-xs text-gray-600 mt-3">{msg}</p>}
        </div>

        {/* Live lock-screen preview */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Lock-screen preview</label>
          <LockPreview accent={shownAccent} logo={logoPng} />
          <p className="text-xs text-gray-500 mt-2">This is how a till’s lock screen will look.</p>

          {/* A313: receipt preview — the exact 1-bit raster a till will print (SCOPE addendum §C) */}
          <label className="block text-sm font-medium text-gray-700 mb-2 mt-6">Receipt preview</label>
          <ReceiptPreview raster={logoPng && receiptLogoEnabled ? monoRasterFromString(logoReceipt) : null} name={bizName} canvasRef={receiptRef} />
          <p className="text-xs text-gray-500 mt-2">{logoPng && receiptLogoEnabled
            ? 'Solid marks print crisply; gradients and colour wash out. If it looks wrong, upload a cleaner mark or leave the toggle off.'
            : 'Turn on "Print logo on customer receipts" to see the logo here.'}</p>
        </div>
      </div>
    </div>
  );
}

// A small, honest mock of the till lock screen (two columns, accent on divider/dot/Enter,
// logo on a white chip, non-removable "powered by SwiftPOS").
function LockPreview({ accent, logo }: { accent: string; logo: string | null }) {
  const btnText = ratio('#ffffff', accent) >= ratio('#000000', accent) ? '#ffffff' : '#000000';
  return (
    <div className="rounded-xl overflow-hidden border" style={{ background: LOCK_SURFACE }}>
      <div className="flex" style={{ minHeight: 220 }}>
        <div className="flex-1 p-5 flex flex-col items-center justify-center gap-3">
          <div className="h-16 w-16 rounded-lg bg-white flex items-center justify-center overflow-hidden">
            {logo ? <img src={logo} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-gray-400">SP</span>}
          </div>
          <div className="text-gray-200 text-sm font-medium">Your Business</div>
          <div className="text-gray-500 text-xs">Main Branch</div>
        </div>
        <div className="w-px" style={{ background: accent }} />
        <div className="flex-1 p-5 flex flex-col items-center justify-center gap-3">
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: i === 0 ? accent : '#334155' }} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {['1','2','3','4','5','6','7','8','9'].map((d) => (
              <span key={d} className="h-8 w-8 rounded-md bg-[#1e293b] text-gray-300 text-sm flex items-center justify-center">{d}</span>
            ))}
          </div>
          <button className="w-full rounded-md py-1.5 text-sm font-semibold" style={{ background: accent, color: btnText }}>Enter</button>
        </div>
      </div>
      <div className="text-[10px] text-gray-500 px-3 pb-2">powered by SwiftPOS</div>
    </div>
  );
}

/** A313: a paper-coloured strip showing the mono raster above the name, as the printer will lay it out. */
function ReceiptPreview({ raster, name, canvasRef }: { raster: MonoRaster | null; name: string; canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (raster) paintRaster(raster, c); else { c.width = 1; c.height = 1; }
  }, [raster, canvasRef]);
  return (
    <div className="bg-white border rounded-lg p-3 w-[280px] font-mono text-[11px] text-gray-900" style={{ boxShadow: 'inset 0 0 0 1px #eee' }}>
      {raster
        ? <canvas ref={canvasRef} className="block mx-auto max-w-full" style={{ imageRendering: 'pixelated', width: Math.min(raster.width, 240) }} />
        : <div className="text-center text-gray-300">[no logo]</div>}
      <div className="text-center font-bold mt-1">{name.toUpperCase()}</div>
      <div className="text-center text-gray-500">------------------------</div>
      <div className="text-gray-500">Item            Qty   Amt</div>
      <div className="text-gray-400">...</div>
    </div>
  );
}
