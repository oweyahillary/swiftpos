/**
 * BulkImageUpload — attach many product images at once (register A142).
 *
 * There is no stored filename↔product convention, so instead of forcing one this
 * auto-matches each file's name (without extension) to a product by barcode →
 * plu_code → name (case-insensitive) and shows the result for confirmation: every
 * row has a product dropdown the user can correct or set to "skip". On confirm it
 * loops the existing `uploadImage` (Cloudinary, same as single upload) and PATCHes
 * each product's `image_url`. Self-contained; the only coupling is the products
 * list in and an onDone callback out.
 *
 * Inherits `lib/upload.ts`'s current cloud-only limitation (its local/VPS branch
 * is still a TODO) — it works wherever the single-image upload already does.
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { uploadImage } from '../../lib/upload';
import type { Product } from '../../types';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const stemOf = (filename: string) => norm(filename.replace(/\.[^.]+$/, ''));

interface Item { file: File; preview: string; productId: string }

export default function BulkImageUpload({
  products,
  onDone,
}: {
  products: Product[];
  onDone?: () => void;
}) {
  const [items, setItems]         = useState<Item[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress]   = useState(0);
  const [done, setDone]           = useState<{ ok: number; failed: number; skipped: number; errors: string[] } | null>(null);

  // Revoke object URLs when the set changes or the component unmounts.
  useEffect(() => () => { items.forEach(it => URL.revokeObjectURL(it.preview)); }, [items]);

  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));

  function autoMatch(filename: string): string {
    const stem = stemOf(filename);
    if (!stem) return '';
    const byBarcode = products.find(p => p.barcode && norm(p.barcode) === stem);
    if (byBarcode) return byBarcode.id;
    const byPlu = products.find(p => p.plu_code && norm(p.plu_code) === stem);
    if (byPlu) return byPlu.id;
    const byName = products.find(p => norm(p.name) === stem);
    if (byName) return byName.id;
    return '';
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('image/'));
    setItems(files.map(f => ({ file: f, preview: URL.createObjectURL(f), productId: autoMatch(f.name) })));
    setDone(null);
  }

  function setProductFor(idx: number, productId: string) {
    setItems(prev => prev.map((it, i) => (i === idx ? { ...it, productId } : it)));
  }

  const matchedCount = items.filter(it => it.productId).length;

  async function upload() {
    const toDo = items.filter(it => it.productId);
    if (toDo.length === 0) return;
    setUploading(true); setProgress(0);
    let ok = 0, failed = 0; const errors: string[] = [];
    for (let i = 0; i < toDo.length; i++) {
      const it = toDo[i];
      try {
        const url = await uploadImage(it.file);
        await api.patch(`/api/products/${it.productId}`, { image_url: url });
        ok++;
      } catch (e) {
        failed++; errors.push(`${it.file.name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
      setProgress(i + 1);
    }
    setDone({ ok, failed, skipped: items.length - toDo.length, errors });
    setUploading(false);
    onDone?.();
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-base font-bold text-white mb-1">Bulk product images</h2>
      <p className="text-sm text-gray-500 mb-4">
        Choose image files — each is matched to a product by <strong className="text-gray-400">barcode, PLU, or name</strong>
        {' '}(the filename without its extension). Check the matches below and fix any before uploading.
      </p>

      <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium cursor-pointer">
        📷 Choose images
        <input type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} />
      </label>

      {items.length > 0 && (
        <>
          <div className="text-xs text-gray-500 mt-3 mb-2">
            {matchedCount} of {items.length} matched · {items.length - matchedCount} to skip
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-800/50 border border-gray-700 rounded-lg p-2">
                <img src={it.preview} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-400 truncate">{it.file.name}</div>
                  <select
                    value={it.productId}
                    onChange={e => setProductFor(i, e.target.value)}
                    className={`mt-1 w-full bg-gray-900 border rounded-md px-2 py-1.5 text-sm ${it.productId ? 'border-gray-700 text-white' : 'border-amber-600/50 text-amber-300'}`}
                  >
                    <option value="">— skip —</option>
                    {sorted.map(p => (
                      <option key={p.id} value={p.id}>{p.name}{p.barcode ? ` (${p.barcode})` : ''}</option>
                    ))}
                  </select>
                </div>
                {it.productId ? (
                  <span className="text-xs text-green-400 flex-shrink-0">matched</span>
                ) : (
                  <span className="text-xs text-amber-400 flex-shrink-0">no match</span>
                )}
              </div>
            ))}
          </div>

          {done && (
            <div className="bg-green-500/8 border border-green-500/30 rounded-lg p-4 mt-4 text-sm">
              <div className="font-semibold text-green-300 mb-1">Upload complete</div>
              <div className="text-gray-300">
                {done.ok} uploaded · {done.skipped} skipped
                {done.failed > 0 && <span className="text-red-300"> · {done.failed} failed</span>}
              </div>
              {done.errors.slice(0, 8).map((e, i) => (
                <div key={i} className="text-xs text-red-300 py-0.5">{e}</div>
              ))}
            </div>
          )}

          {!done && (
            <button
              onClick={upload}
              disabled={uploading || matchedCount === 0}
              className="mt-3 px-4 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold"
            >
              {uploading ? `Uploading ${progress}/${matchedCount}…` : `Upload ${matchedCount} image${matchedCount !== 1 ? 's' : ''}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
