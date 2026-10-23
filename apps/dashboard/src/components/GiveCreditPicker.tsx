import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { candidateNote, candidatesPath, limitFromInput, limitRequest } from '../lib/creditLimit';

interface Candidate { id: string; name: string; phone: string | null; credit_limit: number; credit_balance: number }

/**
 * GiveCreditPicker — A567: Credit Accounts › "+ Give credit". Find an EXISTING customer by name or phone, set their credit
 * limit, confirm: they then buy on account (Credit Accounts, and the tills at their next pull). The person confirming
 * approves the limit — the cloud records who and when. Shown only to someone with customers.credit.
 */
export default function GiveCreditPicker({ currency, onClose, onGiven }: {
  currency: string; onClose: () => void; onGiven: (name: string, limit: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fmt = (n: number) => money(n, currency);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    let live = true;
    timer.current = setTimeout(() => {
      setLoading(true);
      api.get<Candidate[]>(candidatesPath(search))
        .then((r) => { if (live) { setRows(r ?? []); setError(''); } })
        .catch((e: any) => { if (live) { setRows([]); setError(e?.message ?? 'Could not load customers'); } })
        .finally(() => { if (live) setLoading(false); });
    }, 300);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [search]);

  const pick = (c: Candidate) => { setPicked(c); setLimit(c.credit_limit > 0 ? String(c.credit_limit) : ''); setError(''); };

  const confirm = async () => {
    if (!picked) return;
    const r = limitFromInput(limit);
    if (r.ok === false) { setError(r.error); return; }
    if (r.value <= 0) { setError('Give a credit limit above 0.'); return; }
    setBusy(true); setError('');
    try {
      const req = limitRequest(picked.id, r.value);
      await api.patch(req.path, req.body);
      onGiven(picked.name, r.value);
    } catch (e: any) { setError(e?.message ?? 'Could not give credit'); }
    finally { setBusy(false); }
  };

  const field = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600';
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}
        data-testid="give-credit-picker">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-white">Give credit</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">An existing customer (Customers › New Customer adds one). You approve the limit you set.</p>

        {!picked ? (
          <>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or phone…" className={`${field} mb-3`} />
            {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
            {loading ? <p className="text-gray-500 text-sm">Loading…</p> : rows.length === 0 ? (
              <p className="text-gray-500 text-sm">No customer matches. Add them in Customers first.</p>
            ) : (
              <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg">
                {rows.map(c => (
                  <li key={c.id}>
                    <button onClick={() => pick(c)} className="w-full text-left px-4 py-2.5 hover:bg-gray-800/60">
                      <span className="text-white text-sm">{c.name}</span>
                      <span className="text-gray-500 text-xs ml-2">{c.phone ?? 'no phone'}</span>
                      <span className="block text-xs text-gray-500">{candidateNote(c, fmt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className="bg-gray-800 rounded-lg p-3 mb-4">
              <p className="text-white font-medium">{picked.name}</p>
              <p className="text-xs text-gray-500">{picked.phone ?? 'no phone'} · {candidateNote(picked, fmt)}</p>
            </div>
            <label className="block text-sm text-gray-400 mb-1.5">Credit limit ({currency})</label>
            <input autoFocus type="number" min={0} value={limit} onChange={e => setLimit(e.target.value)} placeholder="e.g. 5000" className={`${field} mb-3`} />
            {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => void confirm()} disabled={busy || !limit.trim()}
                className="flex-1 px-4 py-2.5 bg-swift-strong hover:bg-swift-deep disabled:opacity-50 text-white rounded-lg text-sm">
                {busy ? 'Saving…' : 'Confirm credit limit'}
              </button>
              <button onClick={() => { setPicked(null); setError(''); }} className="px-4 py-2.5 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm">Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
