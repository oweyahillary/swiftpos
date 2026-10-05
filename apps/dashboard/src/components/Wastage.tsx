import { useCallback, useEffect, useState } from 'react';

/**
 * Wastage — A399: the wastage log. One screen for the owner (Stock › Wastage) and the manager (Manager › Wastage); the
 * cloud decides what each may do (routes/wastage.ts).
 *
 * Owner, 2026-10-05: "i will work with your pic" — spoiled, expired or dropped items, each with a reason, and what it cost.
 *
 *   Record — items wasted at the branch, why, and a note. Stocked items and ingredients leave stock at once; an item made
 *            to order (not stock-tracked) is recorded for its value only.
 *   Report — a period: the total value, by reason, the most costly items, and every entry.
 *   Void   — (inventory.adjust: the owner by default) an entry recorded by mistake; the stock goes back.
 */

export interface WastageClient {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
}

interface Entry {
  id: string; ref: string; branch_id: string; item_kind: 'product' | 'ingredient'; name: string; quantity: number | string;
  unit_cost: number | string | null; value: number | string; stock_moved: boolean; reason: string; note: string | null;
  recorded_by_name: string | null; created_at: string; voided_at: string | null; voided_by_name: string | null; void_reason: string | null;
}
interface Summary {
  total: number; entries: number;
  byReason: Array<{ reason: string; label: string; value: number; entries: number }>;
  byItem: Array<{ name: string; kind: string; quantity: number; value: number; entries: number }>;
}
interface Report { from: string; to: string; entries: Entry[]; summary: Summary; reasons: Array<{ key: string; label: string }>; can_void: boolean }
interface Item { kind: 'product' | 'ingredient'; id: string; name: string; unit: string | null; by_piece: boolean; stocked: boolean; held: number | null; cost: number | null }

const isoDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
const errText = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;

export default function Wastage({ client, branchId, branches, currency = 'KES' }: {
  client: WastageClient;
  /** The branch to record at. The owner picks it in the sidebar; a manager is locked to their own. */
  branchId: string | null;
  branches?: { id: string; name: string }[];
  currency?: string;
}) {
  const money = (v: unknown) => `${currency} ${Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [report, setReport] = useState<Report | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ from, to, ...(branchId ? { branch_id: branchId } : {}) });
      setReport(await client.get<Report>(`/api/wastage?${qs}`));
    } catch (e) { setError(errText(e, 'Could not load wastage.')); }
    finally { setLoading(false); }
  }, [from, to, branchId]);   // eslint-disable-line react-hooks/exhaustive-deps — client is a new object every render (POSAuthContext)
  useEffect(() => { void load(); }, [load]);

  const voidEntry = async (e: Entry) => {
    const reason = window.prompt(`Void ${e.ref} — ${Number(e.quantity)} × ${e.name}?${e.stock_moved ? ' The stock goes back.' : ''}\n\nWhy is it wrong?`);
    if (!reason?.trim()) return;
    try { await client.post(`/api/wastage/${e.id}/void`, { reason }); await load(); }
    catch (err) { setError(errText(err, 'Could not void it.')); }
  };

  const s = report?.summary;
  const branchName = (id: string) => branches?.find((b) => b.id === id)?.name;

  return (
    <div className="space-y-5" data-testid="wastage">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Wastage</h1>
          <p className="mt-0.5 text-sm text-gray-400">Write off what spoiled, expired or was damaged — with the reason and what it cost.</p>
        </div>
        <button disabled={!branchId} onClick={() => setRecording(true)} data-testid="record-wastage"
          className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
          Record wastage
        </button>
      </div>
      {!branchId && <p className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">Choose a branch to record wastage.</p>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-400">From<br />
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
        <label className="text-xs text-gray-400">To<br />
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && !report && <p className="text-sm text-gray-500">Loading…</p>}

      {s && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4" data-testid="wastage-total">
            <div className="text-xs text-gray-500">Wasted in this period</div>
            <div className="mt-1 text-2xl font-bold text-red-400">{money(s.total)}</div>
            <div className="mt-0.5 text-xs text-gray-500">{s.entries} entr{s.entries === 1 ? 'y' : 'ies'} · at cost</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <div className="mb-2 text-xs text-gray-500">By reason</div>
            {s.byReason.length === 0 ? <div className="text-sm text-gray-500">Nothing recorded.</div> : s.byReason.map((r) => (
              <div key={r.reason} className="flex justify-between py-0.5 text-sm"><span className="text-gray-300">{r.label} <span className="text-gray-500">({r.entries})</span></span><span className="text-gray-200">{money(r.value)}</span></div>
            ))}
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <div className="mb-2 text-xs text-gray-500">Most costly items</div>
            {s.byItem.length === 0 ? <div className="text-sm text-gray-500">Nothing recorded.</div> : s.byItem.slice(0, 8).map((i) => (
              <div key={`${i.kind}:${i.name}`} className="flex justify-between py-0.5 text-sm"><span className="truncate text-gray-300">{i.quantity} × {i.name}</span><span className="text-gray-200">{money(i.value)}</span></div>
            ))}
          </div>
        </div>
      )}

      {report && (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-xs text-gray-500">
              <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Item</th><th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2">By</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {report.entries.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No wastage in this period.</td></tr>}
              {report.entries.map((e) => (
                <tr key={e.id} className={e.voided_at ? 'opacity-50' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">{when(e.created_at)}<div className="text-xs text-gray-600">{e.ref}{!branchId && branchName(e.branch_id) ? ` · ${branchName(e.branch_id)}` : ''}</div></td>
                  <td className="px-3 py-2 text-gray-200">{Number(e.quantity)} × {e.name}{!e.stock_moved && !e.voided_at && <div className="text-xs text-gray-500">made to order — value only</div>}</td>
                  <td className="px-3 py-2 text-gray-300">{report.reasons.find((r) => r.key === e.reason)?.label ?? e.reason}{e.note && <div className="text-xs text-gray-500">{e.note}</div>}</td>
                  <td className="px-3 py-2 text-right text-gray-200">{money(e.value)}</td>
                  <td className="px-3 py-2 text-gray-400">{e.recorded_by_name ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {e.voided_at
                      ? <span className="text-xs text-gray-500" title={e.void_reason ?? ''}>Void · {e.voided_by_name ?? ''}</span>
                      : report.can_void && <button onClick={() => voidEntry(e)} className="rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-red-400">Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recording && branchId && report && (
        <RecordSheet client={client} branchId={branchId} reasons={report.reasons} money={money}
          onClose={() => setRecording(false)} onDone={() => { setRecording(false); void load(); }} />
      )}
    </div>
  );
}

function RecordSheet({ client, branchId, reasons, money, onClose, onDone }: {
  client: WastageClient; branchId: string; reasons: Array<{ key: string; label: string }>; money: (v: unknown) => string;
  onClose: () => void; onDone: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Array<Item & { qty: string }>>([]);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    client.get<Item[]>(`/api/wastage/items?branch_id=${branchId}`).then(setItems).catch((e) => setError(errText(e, 'Could not load the items.')));
  }, [branchId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const matches = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) && !lines.some((l) => l.id === i.id)).slice(0, 8) : [];
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (l.cost ?? 0), 0);

  const save = async () => {
    setError('');
    if (!lines.length) { setError('Add the items wasted.'); return; }
    if (!reason) { setError('Choose why.'); return; }
    if (reason === 'other' && !note.trim()) { setError('Say what happened.'); return; }
    setBusy(true);
    try {
      await client.post('/api/wastage', { branch_id: branchId, reason, note,
        items: lines.map((l) => ({ kind: l.kind, id: l.id, quantity: l.qty })) });
      onDone();
    } catch (e) { setError(errText(e, 'Could not record it.')); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-900 p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold text-white">Record wastage</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item or ingredient…" data-testid="wastage-search"
          className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-swift focus:outline-none" />
        {matches.length > 0 && (
          <div className="mt-1 divide-y divide-gray-800 rounded-xl border border-gray-800">
            {matches.map((m) => (
              <button key={`${m.kind}:${m.id}`} onClick={() => { setLines([...lines, { ...m, qty: '1' }]); setQ(''); }}
                className="flex w-full justify-between px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800">
                <span>{m.name}{m.kind === 'ingredient' && <span className="text-gray-500"> · ingredient</span>}</span>
                <span className="text-xs text-gray-500">{m.stocked ? `${m.held ?? 0}${m.unit ? ` ${m.unit}` : ''} here` : 'made to order'}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          {lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_90px_24px] items-center gap-2 text-sm">
              <span className="truncate text-gray-200">{l.name}{l.cost !== null && <span className="text-xs text-gray-500"> · {money(l.cost)} each</span>}</span>
              <input value={l.qty} inputMode="decimal" onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, qty: e.target.value } : x)))}
                className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-right text-gray-200" aria-label={`Quantity of ${l.name}`} />
              <button onClick={() => setLines(lines.filter((x) => x.id !== l.id))} className="text-gray-500 hover:text-red-400" aria-label="Remove">×</button>
            </div>
          ))}
        </div>
        <label className="mt-4 block text-xs text-gray-400">Why<br />
          <select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="wastage-reason"
            className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200">
            <option value="">Choose…</option>
            {reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select></label>
        <label className="mt-3 block text-xs text-gray-400">Note{reason === 'other' ? '' : ' (optional)'}<br />
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
            className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
        {lines.length > 0 && <p className="mt-3 text-sm text-gray-300">Value at cost: <b className="text-white">{money(total)}</b></p>}
        <p className="mt-1 text-xs text-gray-500">Stocked items and ingredients leave this branch's stock now. Only the owner can undo an entry.</p>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
          <button disabled={busy} onClick={save} data-testid="wastage-save" className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Saving…' : 'Record'}</button>
        </div>
      </div>
    </div>
  );
}
