import { useCallback, useEffect, useState } from 'react';

/**
 * Expiry — A413: stock batches and expiry dates. One screen for the owner (Stock › Expiry) and the manager (Manager ›
 * Expiry); the cloud decides what each may do (routes/batches.ts).
 *
 * Owner, 2026-10-06: "Batch and expiry-date tracking for stock". What is left in each batch is worked out, oldest expiry
 * first, from the branch's stock level — so the list is always in step with the stock figures.
 *
 *   List      — batches with stock left: expired first, then expiring within the chosen days, then the rest.
 *   Write off — an expired (or about to) batch goes to the wastage log as "Expired", with the batch named.
 *   Add       — a batch for stock already on the shelf (deliveries record theirs when received).
 *   Fix / close — a wrong date or lot number; a batch entered by mistake comes off the list (the owner).
 */

export interface ExpiryClient {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
  patch?: <T>(path: string, body: unknown) => Promise<T>;
}

interface Row {
  id: string; branch_id: string; branch_name: string | null; kind: 'product' | 'ingredient'; item_id: string; name: string; unit: string | null;
  batch_no: string | null; expiry_date: string | null; received_at: string; quantity_received: number; remaining: number;
  status: 'expired' | 'soon' | 'ok' | 'none'; days_left: number | null; unit_cost: number | null; value: number | null;
  source: string; source_ref: string | null;
}
interface List {
  today: string; soon_days: number; batches: Row[];
  unbatched: Array<{ kind: string; item_id: string; name: string; unit: string | null; branch_id: string; quantity: number }>;
  summary: { expired: number; soon: number; expiredValue: number; soonValue: number };
  can_write_off: boolean; can_close: boolean;
}
interface Item { kind: 'product' | 'ingredient'; id: string; name: string; unit: string | null; by_piece: boolean; stocked: boolean; held: number | null }

const errText = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;
const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const qty = (n: number) => Number(n).toLocaleString('en-KE', { maximumFractionDigits: 3 });

export function expiryText(r: Pick<Row, 'status' | 'days_left'>): string {
  if (r.days_left === null) return 'no expiry date';
  if (r.days_left < 0) return `expired ${-r.days_left} day${r.days_left === -1 ? '' : 's'} ago`;
  if (r.days_left === 0) return 'expires today';
  return `${r.days_left} day${r.days_left === 1 ? '' : 's'} left`;
}

const CHIP: Record<Row['status'], string> = {
  expired: 'bg-red-500/15 text-red-300 border-red-500/30',
  soon:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  ok:      'bg-gray-800 text-gray-300 border-gray-700',
  none:    'bg-gray-800 text-gray-400 border-gray-700',
};

export default function Expiry({ client, branchId, currency = 'KES' }: {
  client: ExpiryClient;
  /** The branch to show. The owner picks it in the sidebar (none = every branch); a manager is locked to their own. */
  branchId: string | null;
  currency?: string;
}) {
  const money = (v: unknown) => `${currency} ${Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
  const [days, setDays] = useState(7);
  const [showOk, setShowOk] = useState(false);
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const qs = new URLSearchParams({ soon_days: String(days), ...(branchId ? { branch_id: branchId } : {}) });
      setList(await client.get<List>(`/api/batches?${qs}`));
    } catch (e) { setError(errText(e, 'Could not load the expiry list.')); }
  }, [days, branchId]);   // eslint-disable-line react-hooks/exhaustive-deps — client is a new object every render
  useEffect(() => { void load(); }, [load]);

  const writeOff = async (r: Row) => {
    const typed = window.prompt(`Write off ${r.name}${r.batch_no ? ` (batch ${r.batch_no})` : ''} as expired.\n\nHow much? (${qty(r.remaining)}${r.unit ? ` ${r.unit}` : ''} left in this batch)`, String(r.remaining));
    if (typed === null) return;
    const n = Number(typed);
    if (!(n > 0)) { setError('Enter how much to write off.'); return; }
    setBusy(r.id); setError(''); setNotice('');
    try {
      const out = await client.post<{ ref: string }>('/api/wastage', { branch_id: r.branch_id, reason: 'expired',
        note: r.batch_no ? `Batch ${r.batch_no}${r.expiry_date ? `, expiry ${r.expiry_date}` : ''}` : (r.expiry_date ? `Expiry ${r.expiry_date}` : ''),
        items: [{ kind: r.kind, id: r.item_id, quantity: n, batch_id: r.id }] });
      setNotice(`Written off as ${out.ref} — it is in the wastage log.`);
      await load();
    } catch (e) { setError(errText(e, 'Could not write it off.')); }
    finally { setBusy(''); }
  };

  const fixDate = async (r: Row) => {
    if (!client.patch) return;
    const typed = window.prompt(`Expiry date for ${r.name}${r.batch_no ? ` (batch ${r.batch_no})` : ''} — YYYY-MM-DD, blank for none`, r.expiry_date ?? '');
    if (typed === null) return;
    setBusy(r.id); setError('');
    try { await client.patch(`/api/batches/${r.id}`, { expiry_date: typed.trim() || null }); await load(); }
    catch (e) { setError(errText(e, 'Could not change the date.')); }
    finally { setBusy(''); }
  };

  const close = async (r: Row) => {
    if (!window.confirm(`Take ${r.name}${r.batch_no ? ` batch ${r.batch_no}` : ''} off the list? Use this only for a batch entered by mistake — the stock does not change.`)) return;
    setBusy(r.id); setError('');
    try { await client.post(`/api/batches/${r.id}/close`, {}); await load(); }
    catch (e) { setError(errText(e, 'Could not close it.')); }
    finally { setBusy(''); }
  };

  const rows = (list?.batches ?? []).filter((r) => showOk || r.status === 'expired' || r.status === 'soon');
  const s = list?.summary;

  return (
    <div className="space-y-5" data-testid="expiry">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Expiry</h1>
          <p className="mt-0.5 text-sm text-gray-400">Batches and their expiry dates. What is left in each batch follows the stock level — oldest expiry goes first.</p>
        </div>
        <button disabled={!branchId} onClick={() => setAdding(true)} data-testid="add-batch"
          className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
          Add a batch
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="text-gray-400">Expiring within{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="ml-1 rounded-xl border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200">
            {[3, 7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select></label>
        <label className="flex items-center gap-2 text-gray-400">
          <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> Show every batch
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-action-400">{notice}</p>}
      {!list && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {s && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4" data-testid="expired-total">
            <div className="text-xs text-gray-500">Expired, still in stock</div>
            <div className="mt-1 text-2xl font-bold text-red-400">{s.expired} batch{s.expired === 1 ? '' : 'es'}</div>
            <div className="mt-0.5 text-xs text-gray-500">{money(s.expiredValue)} at cost</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <div className="text-xs text-gray-500">Expiring within {list?.soon_days} days</div>
            <div className="mt-1 text-2xl font-bold text-amber-400">{s.soon} batch{s.soon === 1 ? '' : 'es'}</div>
            <div className="mt-0.5 text-xs text-gray-500">{money(s.soonValue)} at cost</div>
          </div>
        </div>
      )}

      {list && (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-xs text-gray-500">
              <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2 text-right">Left</th><th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  {showOk ? 'No batches with stock left.' : `Nothing expired or expiring within ${list.soon_days} days.`}
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-200">{r.name}
                    <div className="text-xs text-gray-500">{r.kind === 'ingredient' ? 'ingredient' : 'product'}{!branchId && r.branch_name ? ` · ${r.branch_name}` : ''}</div></td>
                  <td className="px-3 py-2 text-gray-300">{r.batch_no ?? '—'}
                    <div className="text-xs text-gray-500">received {fmtDate(r.received_at.slice(0, 10))}{r.source_ref ? ` · ${r.source_ref}` : ''}</div></td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${CHIP[r.status]}`}>{expiryText(r)}</span>
                    <div className="mt-0.5 text-xs text-gray-500">{fmtDate(r.expiry_date)}</div></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-gray-200">{qty(r.remaining)}{r.unit ? ` ${r.unit}` : ''}
                    <div className="text-xs text-gray-500">of {qty(r.quantity_received)}</div></td>
                  <td className="px-3 py-2 text-right text-gray-300">{r.value === null ? '—' : money(r.value)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {list.can_write_off && r.remaining > 0 && (r.status === 'expired' || r.status === 'soon') && (
                      <button disabled={busy === r.id} onClick={() => writeOff(r)} data-testid="write-off"
                        className="rounded-lg px-2 py-1 text-xs text-red-300 hover:bg-gray-800 disabled:opacity-40">Write off</button>)}
                    {client.patch && <button disabled={busy === r.id} onClick={() => fixDate(r)}
                      className="rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-white disabled:opacity-40">Date</button>}
                    {list.can_close && <button disabled={busy === r.id} onClick={() => close(r)}
                      className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-white disabled:opacity-40">Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list && list.unbatched.length > 0 && showOk && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-xs text-gray-400">
          <div className="mb-1 text-gray-300">Stock with no batch recorded (it was there before batches were recorded, so it is counted as going first)</div>
          {list.unbatched.map((u) => <div key={`${u.kind}:${u.item_id}:${u.branch_id}`}>{qty(u.quantity)}{u.unit ? ` ${u.unit}` : ''} × {u.name}</div>)}
        </div>
      )}

      {adding && branchId && (
        <AddBatch client={client} branchId={branchId} onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); void load(); }} />
      )}
    </div>
  );
}

function AddBatch({ client, branchId, onClose, onDone }: { client: ExpiryClient; branchId: string; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [item, setItem] = useState<Item | null>(null);
  const [amount, setAmount] = useState('');
  const [expiry, setExpiry] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    client.get<Item[]>(`/api/wastage/items?branch_id=${branchId}`)
      .then((all) => setItems(all.filter((i) => i.stocked)))
      .catch((e) => setError(errText(e, 'Could not load the items.')));
  }, [branchId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const matches = needle && !item ? items.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 8) : [];

  const save = async () => {
    setError('');
    if (!item) { setError('Choose the item.'); return; }
    if (!(Number(amount) > 0)) { setError('Enter how much is in this batch.'); return; }
    if (!expiry && !batchNo.trim()) { setError('Give the expiry date or the batch number.'); return; }
    setBusy(true);
    try {
      await client.post('/api/batches', { branch_id: branchId, kind: item.kind, id: item.id, quantity: amount,
        expiry_date: expiry || null, batch_no: batchNo.trim() || null });
      onDone();
    } catch (e) { setError(errText(e, 'Could not add the batch.')); }
    finally { setBusy(false); }
  };

  const unit = item ? (item.by_piece ? 'pieces' : item.unit ?? '') : '';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-900 p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white">Add a batch</h2>
        <p className="mb-4 mt-0.5 text-xs text-gray-500">For stock already on the shelf — nothing is added to stock. Deliveries record their batch when received.</p>
        {item ? (
          <div className="flex items-center justify-between rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200">
            <span>{item.name}<span className="text-xs text-gray-500"> · {item.held ?? 0}{item.unit ? ` ${item.unit}` : ''} here</span></span>
            <button onClick={() => setItem(null)} className="text-xs text-gray-400 hover:text-white">Change</button>
          </div>
        ) : (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item or ingredient…" autoFocus
            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-swift focus:outline-none" />
        )}
        {matches.length > 0 && (
          <div className="mt-1 divide-y divide-gray-800 rounded-xl border border-gray-800">
            {matches.map((m) => (
              <button key={`${m.kind}:${m.id}`} onClick={() => { setItem(m); setQ(''); }}
                className="flex w-full justify-between px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800">
                <span>{m.name}{m.kind === 'ingredient' && <span className="text-gray-500"> · ingredient</span>}</span>
              </button>
            ))}
          </div>
        )}
        <label className="mt-4 block text-xs text-gray-400">How much is in this batch{unit ? ` (${unit})` : ''}<br />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
            className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
        <label className="mt-3 block text-xs text-gray-400">Expiry date<br />
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)}
            className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
        <label className="mt-3 block text-xs text-gray-400">Batch / lot number (optional)<br />
          <input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} maxLength={60}
            className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200" /></label>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
          <button disabled={busy} onClick={save} className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Saving…' : 'Add'}</button>
        </div>
      </div>
    </div>
  );
}
