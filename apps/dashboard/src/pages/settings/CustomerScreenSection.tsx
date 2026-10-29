/**
 * CustomerScreenSection.tsx — A606: Settings › Branding › Customer screen. The owner's slideshow for the customer-facing
 * second screen of a dual-screen POS (shown while the POS is idle): up to 10 images, in order, and how many seconds each
 * shows. Uploaded like product pictures (lib/upload.ts); the list is saved on the cloud (PUT /api/business/customer-screen)
 * and every POS keeps its own copy of each image, so the slideshow plays offline. The owner's alone, and part of the
 * online licence (the cloud checks both again on save).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { uploadImage } from '../../lib/upload';
import { MAX_SLIDES, SLIDE_SECONDS_MIN, SLIDE_SECONDS_MAX, SLIDE_SECONDS_DEFAULT, slideFileError, type Slide } from '../../lib/customerScreen';

interface Answer { slides: Slide[]; seconds: number; editable: boolean; licensed: boolean }

export default function CustomerScreenSection() {
  const [data, setData] = useState<Answer | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [seconds, setSeconds] = useState(String(SLIDE_SECONDS_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<Answer>('/api/business/customer-screen').then((a) => {
      setData(a); setSlides(a.slides ?? []); setSeconds(String(a.seconds ?? SLIDE_SECONDS_DEFAULT));
    }).catch(() => setData(null));
  }, []);
  if (!data) return null;

  const dirty = JSON.stringify(slides) !== JSON.stringify(data.slides) || Number(seconds) !== data.seconds;
  const canEdit = data.editable && data.licensed;

  const add = async (files: FileList | null) => {
    setMsg(''); setErr('');
    const list = Array.from(files ?? []);
    if (!list.length) return;
    if (slides.length + list.length > MAX_SLIDES) { setErr(`Up to ${MAX_SLIDES} images — remove some first.`); return; }
    for (const f of list) { const e = slideFileError(f); if (e) { setErr(`${f.name}: ${e}`); return; } }
    setBusy(true);
    try {
      const added: Slide[] = [];
      for (const f of list) added.push({ url: await uploadImage(f) });
      setSlides((s) => [...s, ...added].slice(0, MAX_SLIDES));
      setMsg('Uploaded — save to send them to your points of sale.');
    } catch (e: any) { setErr(`Upload failed: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  };
  const move = (i: number, d: -1 | 1) => setSlides((s) => {
    const j = i + d; if (j < 0 || j >= s.length) return s;
    const n = [...s]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const save = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const out = await api.put<{ slides: Slide[]; seconds: number }>('/api/business/customer-screen', { slides, seconds: Number(seconds) });
      setData({ ...data, ...out }); setSlides(out.slides); setSeconds(String(out.seconds));
      setMsg('Saved. Points of sale show the new slideshow within half an hour.');
    } catch (e: any) { setErr(e?.message ?? 'Not saved.'); }
    finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5 mt-6" data-testid="customer-screen-section">
      <h3 className="text-sm font-semibold text-white">Customer screen</h3>
      <p className="text-xs text-gray-400 mt-1 mb-4">
        On a POS with a second screen facing the customer, every sale shows the items, the total and the change. While the
        POS is idle, your own images play there one after another. Turn the screen on at the POS (Manager › Settings).
      </p>
      {!data.licensed && (
        <p className="text-sm text-gray-300" data-testid="customer-screen-premium">The slideshow and the M-Pesa details on the customer screen are part of the online licence — ask ZapTill to turn it on.</p>
      )}
      {data.licensed && !data.editable && (
        <p className="text-xs text-gray-400 mb-3">Only the owner chooses these images.</p>
      )}
      {data.licensed && (<>
        {slides.length === 0 ? (
          <p className="text-sm text-gray-400 mb-3">No images yet — the customer screen shows your business name while idle.</p>
        ) : (
          <ol className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-4" data-testid="customer-screen-slides">
            {slides.map((s, i) => (
              <li key={s.url} className="rounded-lg border border-gray-800 overflow-hidden bg-gray-950">
                <img src={s.url} alt={`Image ${i + 1}`} className="w-full aspect-video object-contain bg-black" />
                <div className="flex items-center justify-between px-2 py-1 text-xs text-gray-400">
                  <span>{i + 1}</span>
                  {canEdit && (<span className="flex gap-2">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Earlier" className="disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === slides.length - 1} aria-label="Later" className="disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => setSlides((x) => x.filter((_, k) => k !== i))} className="hover:text-red-400">Remove</button>
                  </span>)}
                </div>
              </li>
            ))}
          </ol>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <label className={`cursor-pointer rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 ${busy || slides.length >= MAX_SLIDES ? 'opacity-50 pointer-events-none' : ''}`}>
              Add images
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only"
                onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              Each image shows for
              <input type="number" min={SLIDE_SECONDS_MIN} max={SLIDE_SECONDS_MAX} value={seconds} onChange={(e) => setSeconds(e.target.value)}
                className="w-16 border border-gray-700 bg-gray-800 rounded-lg px-2 py-1 text-sm" aria-label="Seconds per image" />
              seconds
            </label>
            <button type="button" onClick={() => void save()} disabled={busy || !dirty}
              className="rounded-lg bg-swift-strong hover:bg-swift-deep px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" data-testid="customer-screen-save">Save customer screen</button>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">Up to {MAX_SLIDES} images, JPEG, PNG or WebP, 2 MB each. Landscape pictures fill the screen best.</p>
      </>)}
      {msg && <p className="text-xs text-gray-300 mt-2">{msg}</p>}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </section>
  );
}
