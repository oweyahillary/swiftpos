/**
 * ApprovalsPage — A448: changes made on a till that clash with the cloud, for the owner to decide.
 *
 * Owner, 2026-10-12: "if they are the same keep them, if not notify the owner requesting approval". A till saves a
 * manager's change first (a print station, a category, a product) and sends it later; when someone changed the same thing
 * differently meanwhile (on the web, another till), it waits here — with the till's value next to the cloud's. Approve =
 * the till's is applied everywhere; Keep the cloud's = the till takes the cloud's on its next sync.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Change {
  id: string; entity: string; op: string; summary: string; proposed: Record<string, unknown> | null; cloud_value: Record<string, unknown> | null;
  made_by_name: string | null; made_at: string | null; received_at: string; message: string | null;
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const FIELD: Record<string, string> = { name: 'Name', base_price: 'Price', kind: 'Prints', active: 'On', status: 'Status', category_id: 'Category',
  description: 'Description', show_days: 'Days', barcode: 'Barcode', plu_code: 'PLU', is_kitchen: 'Kitchen', track_stock: 'Track stock',
  color: 'Colour', icon: 'Icon', sort_order: 'Order', cost_price: 'Cost' };

export default function ApprovalsPage() {
  const [rows, setRows] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState('');

  const load = () => {
    setLoading(true); setError('');
    api.get<Change[]>('/api/changes?status=awaiting').then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => setError(e?.message ?? 'Could not load the changes.')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const decide = async (c: Change, approve: boolean) => {
    setBusy(c.id); setError(''); setDone('');
    try {
      await api.post(`/api/changes/${c.id}/decide`, { approve });
      setDone(approve ? `${c.summary}: the till's change is applied everywhere.` : `${c.summary}: the cloud's is kept; the till takes it on its next sync.`);
      load();
    } catch (e: any) { setError(e?.message ?? 'Could not save your decision.'); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-white">Approvals</h1>
        <p className="text-sm text-gray-400 mt-1">Changes made on a till that differ from what was changed elsewhere. The till keeps its own until you decide.</p>
      </div>
      {error && <div className="text-sm text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">{error}</div>}
      {done && <div className="text-sm text-gray-200 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">{done}</div>}
      {loading && <p className="text-sm text-gray-400">Loading…</p>}
      {!loading && !rows.length && !error && <p className="text-sm text-gray-400 py-10 text-center">Nothing waits for your approval.</p>}
      {rows.map((c) => {
        const fields = Object.keys(c.proposed ?? {}).filter((k) => k !== 'pin_set');
        return (
          <div key={c.id} data-testid="approval-row" className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-white font-medium">{c.summary}</p>
                <p className="text-xs text-gray-400 mt-0.5">On a till by {c.made_by_name ?? 'a manager'}{c.made_at ? `, ${new Date(c.made_at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-400"><th className="text-left font-medium py-1">Field</th><th className="text-left font-medium py-1">The till's</th><th className="text-left font-medium py-1">The cloud's now</th></tr></thead>
              <tbody className="divide-y divide-gray-800">
                {fields.map((k) => (
                  <tr key={k}>
                    <td className="py-1.5 text-gray-400">{FIELD[k] ?? k}</td>
                    <td className="py-1.5 text-white">{show(c.proposed?.[k])}</td>
                    <td className="py-1.5 text-gray-300">{show(c.cloud_value?.[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-2">
              <button data-testid="approve" disabled={busy === c.id} onClick={() => void decide(c, true)}
                className="px-4 py-2 bg-swift hover:bg-swift-light text-black text-sm font-semibold rounded-lg disabled:opacity-50">Take the till's</button>
              <button disabled={busy === c.id} onClick={() => void decide(c, false)}
                className="px-4 py-2 rounded-lg border border-gray-700 text-gray-200 text-sm hover:border-gray-500 disabled:opacity-50">Keep the cloud's</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
