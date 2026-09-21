import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { prepareRasterLogo } from '../lib/prepareRasterLogo';
import { resolveBranding } from '../../shared/contrast';

/**
 * BrandingEditor — A302. The tech-gated FEED for A301's branding write path: an accent
 * picker + a PNG/JPEG logo upload that call posApi.branding.set, so a real client accent/logo
 * can be written and SEEN on the lock screen (PinPage's existing read seam) before any cloud
 * branding UI exists. Lives inside the technician gate (rendered by TechPage) — branch/brand
 * changes belong behind the tech gate (HANDOFF-2026-09-20 §6).
 *
 * businessId comes from the owner session (the branding row's PK). Accent legibility is
 * previewed with the same resolveBranding guard the lock screen uses, judged against the same
 * lock-card surface. The logo is shrunk client-side by prepareRasterLogo (raster only; SVG is
 * rejected until the sanitiser slice). Every write re-validates in main (brandingGuard) and is
 * audited via tech.logAction.
 */

// The lock-screen card the accent is measured against — must match PinPage's LOCK_SURFACE.
const LOCK_SURFACE = '#0d1424';

export default function BrandingEditor() {
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [accentHex, setAccentHex] = useState('');       // '' = unset (SwiftPOS default)
  const [logoPng, setLogoPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = async () => {
    const s = await posApi.auth.getSession().catch(() => null);
    setBusinessId(s?.business?.id ?? null);
    const b = await posApi.branding.get().catch(() => null);
    setAccentHex(b?.accentHex ?? '');
    setLogoPng(b?.logoPng ?? null);
  };
  useEffect(() => { load(); }, []);

  // Live legibility preview — the same decision the lock screen makes.
  const brand = resolveBranding(accentHex.trim() || null, LOCK_SURFACE);

  const onPickLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';                       // let the same file re-trigger onChange later
    if (!file) return;
    setMsg(''); setWarnings([]);
    try {
      const { logoPng: png, warnings: w } = await prepareRasterLogo(file);
      setLogoPng(png);
      setWarnings(w);
    } catch (err: any) {
      setMsg(String(err?.message ?? err));
    }
  };

  const save = async () => {
    if (!businessId) { setMsg('No business on this till yet — enrol it first.'); return; }
    setBusy(true); setMsg('');
    try {
      await posApi.branding.set({ businessId, accentHex: accentHex.trim() || null, logoPng });
      await posApi.tech.logAction('tech.branding.set',
        { hasAccent: !!accentHex.trim(), hasLogo: !!logoPng });
      setMsg('Saved. The lock screen picks it up next time the PIN pad shows.');
      await load();
    } catch (err: any) {
      setMsg(String(err?.message ?? err));      // e.g. main-side guard rejected the logo
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!businessId) return;
    setBusy(true); setMsg('');
    try {
      await posApi.branding.set({ businessId, accentHex: null, logoPng: null });
      await posApi.tech.logAction('tech.branding.clear');
      setAccentHex(''); setLogoPng(null); setWarnings([]);
      setMsg('Cleared — back to the SwiftPOS default.');
    } catch (err: any) {
      setMsg(String(err?.message ?? err));
    } finally { setBusy(false); }
  };

  return (
    <section className="bg-[#0d1424] border border-[#1e293b] rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Client branding</h2>

      {!businessId && (
        <p className="text-xs text-amber-400 mb-3">This till has no business yet — enrol it before setting branding.</p>
      )}

      {/* Accent */}
      <label className="block text-xs text-gray-300 mb-1">Accent colour</label>
      <div className="flex items-center gap-3 mb-1">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(accentHex.trim()) ? accentHex.trim() : '#0d9488'}
          onChange={(e) => setAccentHex(e.target.value)}
          className="h-9 w-12 rounded bg-transparent border border-[#1e293b] p-0"
          aria-label="Accent colour"
        />
        <input
          type="text"
          value={accentHex}
          onChange={(e) => setAccentHex(e.target.value)}
          placeholder="#0d9488"
          className="flex-1 bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-2 text-sm font-mono text-gray-200"
        />
      </div>
      <p className="text-xs mb-4" style={{ color: brand.usedFallback ? '#f59e0b' : '#9ca3af' }}>
        {accentHex.trim() === ''
          ? 'Empty = SwiftPOS default (teal).'
          : brand.usedFallback
            ? 'Not legible on the lock screen — this will fall back to the default.'
            : 'Legible on the lock screen.'}
      </p>

      {/* Logo */}
      <label className="block text-xs text-gray-300 mb-1">Logo (PNG or JPEG)</label>
      <div className="flex items-center gap-3 mb-1">
        <div className="h-16 w-16 rounded-lg bg-white flex items-center justify-center overflow-hidden shrink-0">
          {logoPng
            ? <img src={logoPng} alt="logo preview" className="max-h-full max-w-full object-contain" />
            : <span className="text-[10px] text-gray-400">no logo</span>}
        </div>
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={onPickLogo}
          className="flex-1 text-xs text-gray-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#1e293b] file:px-3 file:py-2 file:text-gray-200 hover:file:bg-[#26344b]"
        />
      </div>
      <p className="text-xs text-gray-400 mb-1">Shrunk to fit automatically; max 250 KB stored. SVG isn't supported yet.</p>
      {warnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-400">{w}</p>
      ))}

      {/* Actions */}
      <div className="flex gap-2 mt-4">
        <button
          onClick={save}
          disabled={busy || !businessId}
          className="flex-1 bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm"
        >
          Save branding
        </button>
        <button
          onClick={clear}
          disabled={busy || !businessId}
          className="bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg px-4 py-2 text-sm"
        >
          Reset to default
        </button>
      </div>

      {msg && <p className="text-xs text-gray-300 mt-3">{msg}</p>}
    </section>
  );
}
