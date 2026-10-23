/**
 * GenerateBarcodes — A571: in-store barcodes for the products that have none.
 *
 * Owner, 2026-10-22: "we do not have barcode generation mechanism, what does it entail can we add it?"
 *
 * The ticked products (or, none ticked, every active product) WITHOUT a barcode get an in-store EAN-13: "20" + an item
 * number + the check digit (lib/barcode.ts — GS1 keeps 20–29 for a shop's own numbers; 21–29 are left for weighing-scale
 * codes). A product with a barcode is never changed. First the count (POST /api/products/barcodes/generate, dry_run),
 * then the confirm.
 *
 * A574: the codes follow the business's Barcode numbering (Print labels page: format, prefix, start number, digits);
 * the count answer carries it, and says when the range cannot give every product a code (nothing is then generated).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeNumbering, type BarcodeNumbering } from '../../lib/barcode';

type Preview = { count: number; already: number; sample: string[]; remaining?: number; numbering?: BarcodeNumbering; error?: string };

export default function GenerateBarcodes({ ids, onClose, onDone }: {
  /** The ticked products; null = every active product. */
  ids: string[] | null;
  onClose: () => void;
  onDone: (generated: number) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const body = ids ? { product_ids: ids } : {};

  useEffect(() => {
    let live = true;
    api.post<Preview>('/api/products/barcodes/generate', { ...body, dry_run: true })
      .then((r) => { if (live) setPreview(r); })
      .catch((e: any) => { if (live) setMsg(e?.message ?? 'Could not count the products'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post<{ count: number }>('/api/products/barcodes/generate', body);
      onDone(r.count ?? 0);
    } catch (e: any) { setMsg(e?.message ?? 'Generating failed'); setBusy(false); }
  }

  const scope = ids ? `the ${ids.length} ticked product${ids.length === 1 ? '' : 's'}` : 'every active product';
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()} data-testid="generate-barcodes">
        <div className="p-5 border-b border-gray-800">
          <h2 className="text-base font-bold text-white">Generate barcodes</h2>
          <p className="text-sm text-gray-500">For {scope} that has no barcode yet.</p>
        </div>
        <div className="p-5 space-y-3 text-sm text-gray-300">
          {!preview && !msg && <p className="text-gray-500">Counting…</p>}
          {preview && (
            <>
              <p><span className="font-semibold text-white">{preview.count}</span> product{preview.count === 1 ? '' : 's'} will get a barcode.
                {preview.already > 0 && <> {preview.already} already {preview.already === 1 ? 'has one' : 'have one'} and {preview.already === 1 ? 'is' : 'are'} left as {preview.already === 1 ? 'it is' : 'they are'}.</>}</p>
              {preview.sample.length > 0 && (
                <p className="text-gray-500">The first: <span className="font-mono text-gray-300">{preview.sample.join(', ')}</span></p>
              )}
              <p className="text-xs text-gray-500">{preview.numbering ? `${describeNumbering(preview.numbering)}. ` : ''}Your own numbers, set under Barcode numbering on the Print labels page.
                The tills scan them as soon as they next refresh the menu. Print them with Print labels.</p>
              {preview.error && <p className="text-red-400" data-testid="range-full">{preview.error}</p>}
            </>
          )}
          {msg && <p className="text-amber-400">{msg}</p>}
        </div>
        <div className="p-5 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
          <button onClick={generate} disabled={busy || !preview || preview.count === 0 || !!preview.error}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-swift hover:bg-swift-light text-gray-950 disabled:opacity-50">
            {busy ? 'Generating…' : `Generate ${preview?.count ?? ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
