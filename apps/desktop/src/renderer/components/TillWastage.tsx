/**
 * TillWastage — A414: record wastage on the till (Manager › Stock › Wastage).
 *
 * Owner, 2026-10-06: "Recording wastage on the till itself" — saved on the till first, sent to the cloud after
 * (main/tillWastage.ts). Also shows what is expired or expiring at this branch (A413), when the cloud can be reached.
 */
import { useCallback, useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { WasteItem, WasteRecordingView, ExpiringBatch } from '../lib/posApi';

const REASONS: Array<{ key: string; label: string }> = [
  { key: 'expired', label: 'Expired' }, { key: 'spoiled', label: 'Spoiled / gone off' }, { key: 'damaged', label: 'Damaged / dropped' },
  { key: 'kitchen_mistake', label: 'Kitchen mistake' }, { key: 'returned', label: 'Returned by a customer' },
  { key: 'staff_meal', label: 'Staff meal' }, { key: 'other', label: 'Other' },
];
const reasonLabel = (k: string) => REASONS.find((r) => r.key === k)?.label ?? k;
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
const daysText = (b: ExpiringBatch) => b.days_left === null ? 'no date' : b.days_left < 0 ? `expired ${-b.days_left}d ago` : b.days_left === 0 ? 'expires today' : `${b.days_left}d left`;

export default function TillWastage() {
  const [items, setItems] = useState<WasteItem[]>([]);
  const [source, setSource] = useState<'cloud' | 'saved' | 'till' | ''>('');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Array<WasteItem & { qty: string }>>([]);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<WasteRecordingView[]>([]);
  const [refused, setRefused] = useState<Array<WasteRecordingView & { refused_at: string; message: string }>>([]);
  const [expiring, setExpiring] = useState<ExpiringBatch[] | null>(null);
  const [expiryNote, setExpiryNote] = useState('');

  const loadState = useCallback(async () => {
    try { const s = await posApi.manage.wastageState(); setPending(s.pending); setRefused(s.refused); } catch { /* shown on next save */ }
  }, []);
  useEffect(() => {
    posApi.manage.wastageItems().then((r) => { setItems(r.items ?? []); setSource(r.source); }).catch((e) => setError(e?.message ?? 'Could not load the items.'));
    posApi.manage.expiringBatches().then((r) => {
      if (r.online) setExpiring((r.batches ?? []).filter((b) => b.remaining > 0 && (b.status === 'expired' || b.status === 'soon')));
      else setExpiryNote('The expiry list needs the connection.');
    }).catch(() => setExpiryNote('The expiry list needs the connection.'));
    void loadState();
    const t = setInterval(() => { void loadState(); }, 20_000);
    return () => clearInterval(t);
  }, [loadState]);

  const needle = q.trim().toLowerCase();
  const matches = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) && !lines.some((l) => l.id === i.id)).slice(0, 8) : [];

  const addLine = (i: WasteItem, qty = '1') => { setLines((ls) => ls.some((l) => l.id === i.id) ? ls : [...ls, { ...i, qty }]); setQ(''); };
  const writeOffBatch = (b: ExpiringBatch) => {
    const item = items.find((i) => i.id === b.item_id && i.kind === b.kind)
      ?? { kind: b.kind, id: b.item_id, name: b.name, unit: b.unit, by_piece: false, stocked: true, held: null, cost: null };
    addLine(item, String(b.remaining)); setReason('expired');
    if (b.batch_no && !note) setNote(`Batch ${b.batch_no}`);
  };

  const save = async () => {
    setError(''); setNotice('');
    if (!lines.length) { setError('Add the items wasted.'); return; }
    if (!reason) { setError('Choose why.'); return; }
    if (reason === 'other' && !note.trim()) { setError('Say what happened.'); return; }
    setBusy(true);
    try {
      const out = await posApi.manage.recordWastage({ reason, note,
        items: lines.map((l) => ({ kind: l.kind, id: l.id, name: l.name, quantity: Number(l.qty) })) });
      if (out.state === 'saved') setNotice(`Recorded as ${out.ref}.`);
      else if (out.state === 'pending') setNotice('Saved on this till — it goes to the cloud when the connection is back.');
      else setError(`Not recorded: ${out.message ?? 'the cloud refused it'}`);
      if (out.state !== 'refused') { setLines([]); setReason(''); setNote(''); }
      await loadState();
    } catch (e: any) { setError(e?.message ?? 'Could not record it.'); }
    finally { setBusy(false); }
  };

  const field = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm';
  return (
    <div className="max-w-3xl space-y-5" data-testid="till-wastage">
      <div>
        <h2 className="text-lg font-semibold text-white">Wastage</h2>
        <p className="text-sm text-gray-400">Write off what spoiled, expired or was dropped. Saved on this till at once; it goes to the cloud now, or when the connection is back.</p>
      </div>

      {expiring && expiring.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm font-medium text-amber-200">Expired or expiring within 7 days</p>
          <div className="mt-2 space-y-1">
            {expiring.slice(0, 12).map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-gray-200">{b.name}{b.batch_no ? <span className="text-gray-400"> · {b.batch_no}</span> : null}
                  <span className={b.status === 'expired' ? 'text-red-300' : 'text-amber-300'}> · {daysText(b)}</span>
                  <span className="text-gray-400"> · {b.remaining}{b.unit ? ` ${b.unit}` : ''} left</span></span>
                <button onClick={() => writeOffBatch(b)} className="rounded-lg px-2 py-1 text-xs text-red-300 hover:bg-gray-800">Write off</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {expiryNote && <p className="text-xs text-gray-500">{expiryNote}</p>}

      <div className="space-y-3 rounded-lg border border-gray-700 p-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item…" className={field} data-testid="till-wastage-search" />
        {source && source !== 'cloud' && (
          <p className="text-xs text-amber-300">{source === 'saved' ? 'Offline — the item list is the one this till saved last.' : 'Offline — this till\'s own items (ingredients need the connection).'}</p>
        )}
        {matches.length > 0 && (
          <div className="divide-y divide-gray-800 rounded-lg border border-gray-800">
            {matches.map((m) => (
              <button key={`${m.kind}:${m.id}`} onClick={() => addLine(m)} className="flex w-full justify-between px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800">
                <span>{m.name}{m.kind === 'ingredient' && <span className="text-gray-500"> · ingredient</span>}</span>
                <span className="text-xs text-gray-500">{m.stocked ? (m.held === null ? '' : `${m.held}${m.unit ? ` ${m.unit}` : ''} here`) : 'made to order'}</span>
              </button>
            ))}
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className="grid grid-cols-[1fr_100px_28px] items-center gap-2 text-sm">
            <span className="truncate text-gray-200">{l.name}</span>
            <input value={l.qty} inputMode="decimal" aria-label={`Quantity of ${l.name}`}
              onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, qty: e.target.value } : x)))}
              className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-right text-white" />
            <button onClick={() => setLines(lines.filter((x) => x.id !== l.id))} className="text-gray-500 hover:text-red-400" aria-label="Remove">×</button>
          </div>
        ))}
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={field} data-testid="till-wastage-reason">
          <option value="">Why…</option>
          {REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={reason === 'other' ? 'What happened' : 'Note (optional)'} className={field} />
        {error && <p className="text-sm text-red-300">{error}</p>}
        {notice && <p className="text-sm text-action-300">{notice}</p>}
        <button disabled={busy} onClick={save} data-testid="till-wastage-save"
          className="rounded-lg bg-action-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-action-400 disabled:opacity-40">
          {busy ? 'Saving…' : 'Record wastage'}
        </button>
      </div>

      {pending.length > 0 && (
        <div className="rounded-lg border border-gray-700 p-3">
          <p className="text-sm text-amber-300">Waiting to go to the cloud ({pending.length})</p>
          {pending.map((p) => (
            <p key={p.client_id} className="mt-1 text-xs text-gray-400">{when(p.recorded_at)} · {reasonLabel(p.reason)} · {p.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} · {p.recorded_by_name}</p>
          ))}
        </div>
      )}
      {refused.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <p className="text-sm text-red-200">Not recorded — the cloud refused these</p>
          {refused.map((r) => (
            <div key={r.client_id} className="mt-1 flex items-start justify-between gap-2 text-xs">
              <span className="text-gray-300">{when(r.recorded_at)} · {r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} — <span className="text-red-300">{r.message}</span></span>
              <button onClick={async () => { await posApi.manage.dismissWastage(r.client_id); await loadState(); }} className="text-gray-400 hover:text-white">Dismiss</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
