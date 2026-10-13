/**
 * TransfersTab — A197: send stock to another branch, and receive what another branch sent — on the till, under Stock.
 *
 * Owner, 2026-10-13: "A197 … add it yes but it's tied to the online licence just like stock and … inside the stock tab".
 * Shown only with the online licence and to people with inventory.transfer (managerNav). The cloud does the work
 * (routes/stock.ts): a transfer is created pending (no stock moves), despatched (stock leaves this branch), received at
 * the other branch (stock arrives — the quantities counted, a short receipt noted), or cancelled with a reason (stock that
 * left comes back). The same person may not despatch and receive one unless they say so (A203).
 */
import { useCallback, useEffect, useState } from 'react';
import { posApi, type StockTransfer } from '../lib/posApi';

type Row = StockTransfer;
type Line = { product_id: string; quantity: string };

const STATUS: Record<Row['status'], [string, string]> = {
  pending: ['not sent yet', 'bg-amber-600/20 text-amber-300 border-amber-600/40'],
  in_transit: ['on its way', 'bg-action-600/20 text-action-300 border-action-600/40'],
  received: ['received', 'bg-gray-600/30 text-gray-200 border-gray-500/50'],
  cancelled: ['cancelled', 'bg-gray-700/40 text-gray-400 border-gray-600/50'],
};

export default function TransfersTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await posApi.transfers.list().catch((e: any) => ({ ok: false, error: e?.message ?? 'Could not load' } as const));
    setLoading(false);
    if (!r.ok) { setErr(r.error ?? 'Could not load the transfers.'); return; }
    setErr(''); setRows(r.data ?? []); setBranch((r as any).branch_id ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const step = async (t: Row, body: Parameters<typeof posApi.transfers.status>[0], done: string) => {
    setBusy(t.id); setErr(''); setMsg('');
    try {
      let r = await posApi.transfers.status(body);
      if (!r.ok && r.code === 'same_user_receipt'
        && window.confirm('You despatched this transfer yourself. Receive it anyway? (It is noted on the transfer.)')) {
        r = await posApi.transfers.status({ ...body, allow_same_user: true });
      }
      if (!r.ok) { setErr(r.error ?? 'Could not save that step.'); return; }
      setMsg(done); setReceiving(null); setCancelling(null);
      await load();
    } finally { setBusy(null); }
  };

  const incoming = rows.filter((t) => t.to_branch_id === branch && t.status === 'in_transit');
  const outgoing = rows.filter((t) => t.from_branch_id === branch && (t.status === 'pending' || t.status === 'in_transit'));
  const history = rows.filter((t) => !incoming.includes(t) && !outgoing.includes(t)).slice(0, 30);
  const label = (t: Row) => t.transfer_number ?? t.id.slice(0, 8);
  const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4" data-testid="transfers">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Transfers</h2>
          <p className="text-gray-300 text-sm">Send stock to another branch, and receive what another branch sent you.</p>
        </div>
        {!creating && (
          <button data-testid="transfer-new" onClick={() => { setCreating(true); setMsg(''); }}
            className="shrink-0 px-3 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">+ New transfer</button>
        )}
      </div>
      {err && <p className="text-sm text-red-300">{err}</p>}
      {msg && <p className="text-sm text-gray-200" data-testid="transfer-msg">{msg}</p>}
      {creating && <NewTransfer onCancel={() => setCreating(false)} onSent={(m) => { setCreating(false); setMsg(m); void load(); }} />}

      {loading ? <p className="text-gray-300 text-sm">Loading…</p> : (
        <>
          <Section title="Coming to this branch" empty="Nothing on its way here.">
            {incoming.map((t) => (
              <Card key={t.id} t={t} label={label(t)} when={when} side={`from ${t.from_branch_name ?? 'another branch'}`}>
                {receiving === t.id
                  ? <Receive t={t} busy={busy === t.id} onCancel={() => setReceiving(null)}
                      onReceive={(items, note) => step(t, { id: t.id, status: 'received', received_items: items, receipt_note: note || undefined },
                        `Received ${label(t)} — the stock is in this branch now.`)} />
                  : <button data-testid={`transfer-receive-${t.id}`} onClick={() => setReceiving(t.id)}
                      className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">Receive</button>}
              </Card>
            ))}
          </Section>

          <Section title="Sent from this branch" empty="Nothing waiting to go out.">
            {outgoing.map((t) => (
              <Card key={t.id} t={t} label={label(t)} when={when} side={`to ${t.to_branch_name ?? 'another branch'}`}>
                {cancelling === t.id
                  ? <CancelForm busy={busy === t.id} onBack={() => setCancelling(null)}
                      onCancel={(reason) => step(t, { id: t.id, status: 'cancelled', reason },
                        t.status === 'in_transit' ? `Cancelled ${label(t)} — the stock is back in this branch.` : `Cancelled ${label(t)}.`)} />
                  : (
                    <div className="flex gap-2">
                      {t.status === 'pending' && (
                        <button data-testid={`transfer-despatch-${t.id}`} disabled={busy === t.id}
                          onClick={() => step(t, { id: t.id, status: 'in_transit' }, `${label(t)} is on its way — the stock has left this branch.`)}
                          className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">Despatch</button>
                      )}
                      <button onClick={() => setCancelling(t.id)} disabled={busy === t.id}
                        className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Cancel</button>
                    </div>
                  )}
              </Card>
            ))}
          </Section>

          {history.length > 0 && (
            <Section title="Earlier" empty="">
              {history.map((t) => (
                <Card key={t.id} t={t} label={label(t)} when={when}
                  side={t.from_branch_id === branch ? `to ${t.to_branch_name ?? 'another branch'}` : `from ${t.from_branch_name ?? 'another branch'}`} />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
      {list.length === 0 && empty ? <p className="text-xs text-gray-400">{empty}</p> : children}
    </div>
  );
}

function Card({ t, label, when, side, children }: { t: Row; label: string; when: (iso: string) => string; side: string; children?: React.ReactNode }) {
  const [text, cls] = STATUS[t.status];
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2" data-testid={`transfer-${t.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-white font-medium">{label}</span>
        <span className="text-gray-400">{side}</span>
        <span className={`text-xs px-2 py-0.5 rounded border ${cls}`}>{text}</span>
        <span className="text-xs text-gray-500 ml-auto">{when(t.created_at)}</span>
      </div>
      <ul className="text-sm text-gray-300 space-y-0.5">
        {t.stock_transfer_items.map((i) => (
          <li key={i.id}>
            {Number(i.quantity)} × {i.products?.name ?? 'item'}
            {t.status === 'received' && i.quantity_received !== null && Number(i.quantity_received) !== Number(i.quantity) && (
              <span className="text-amber-300"> · {Number(i.quantity_received)} arrived</span>
            )}
          </li>
        ))}
      </ul>
      {t.notes && <p className="text-xs text-gray-400">Note: {t.notes}</p>}
      {t.receipt_note && <p className="text-xs text-gray-400">On receipt: {t.receipt_note}</p>}
      {children}
    </div>
  );
}

/** What arrived, line by line (what was sent by default; less when some is short) and a note. */
function Receive({ t, busy, onCancel, onReceive }: { t: Row; busy: boolean; onCancel: () => void;
  onReceive: (items: Array<{ product_id: string; quantity_received: number }>, note: string) => void }) {
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(t.stock_transfer_items.map((i) => [i.product_id, String(Number(i.quantity))])));
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const submit = () => {
    const items: Array<{ product_id: string; quantity_received: number }> = [];
    for (const i of t.stock_transfer_items) {
      const v = Number(got[i.product_id]);
      if (!Number.isFinite(v) || v < 0 || v > Number(i.quantity)) { setErr(`${i.products?.name ?? 'An item'}: between 0 and ${Number(i.quantity)}.`); return; }
      items.push({ product_id: i.product_id, quantity_received: v });
    }
    const short = items.some((x, n) => x.quantity_received < Number(t.stock_transfer_items[n].quantity));
    if (short && !note.trim()) { setErr('Some arrived short — say what happened in the note.'); return; }
    setErr(''); onReceive(items, note.trim());
  };
  return (
    <div className="space-y-2 border-t border-gray-700 pt-2" data-testid={`transfer-receive-form-${t.id}`}>
      <p className="text-xs text-gray-300">Count what arrived. Less than was sent is recorded as short.</p>
      {t.stock_transfer_items.map((i) => (
        <div key={i.id} className="flex items-center gap-2 text-sm">
          <span className="text-gray-200 flex-1">{i.products?.name ?? 'item'} <span className="text-gray-500">(sent {Number(i.quantity)})</span></span>
          <input type="number" min={0} max={Number(i.quantity)} value={got[i.product_id] ?? ''} onChange={(e) => setGot({ ...got, [i.product_id]: e.target.value })}
            className="w-24 bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
        </div>
      ))}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed when something is short)" maxLength={300}
        className="w-full bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
          {busy ? 'Saving…' : 'Receive into this branch'}</button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Back</button>
      </div>
    </div>
  );
}

function CancelForm({ busy, onBack, onCancel }: { busy: boolean; onBack: () => void; onCancel: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-wrap gap-2 border-t border-gray-700 pt-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is cancelled (required)" maxLength={200} autoFocus
        className="flex-1 min-w-[12rem] bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
      <button disabled={busy || !reason.trim()} onClick={() => onCancel(reason.trim())}
        className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-sm disabled:opacity-40">{busy ? 'Cancelling…' : 'Cancel transfer'}</button>
      <button onClick={onBack} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Back</button>
    </div>
  );
}

/** A new transfer from this branch: where to, what (from this branch's stock), a note. Created "not sent yet". */
function NewTransfer({ onCancel, onSent }: { onCancel: () => void; onSent: (msg: string) => void }) {
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [stock, setStock] = useState<Array<{ product_id: string; product_name: string; quantity: number }>>([]);
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<Line[]>([{ product_id: '', quantity: '' }]);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    posApi.transfers.branches().then((r) => { if (r.ok) setBranches(r.data ?? []); else setErr(r.error ?? 'Could not load the branches.'); }).catch(() => {});
    posApi.manager.stockLevels().then((r) => setStock(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);
  const send = async () => {
    if (!to) { setErr('Choose the branch it goes to.'); return; }
    const items = lines.filter((l) => l.product_id && Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }));
    if (!items.length) { setErr('Add at least one item with a quantity.'); return; }
    const over = items.find((i) => i.quantity > Number(stock.find((s) => s.product_id === i.product_id)?.quantity ?? 0));
    if (over) { setErr(`${stock.find((s) => s.product_id === over.product_id)?.product_name ?? 'An item'}: more than this branch holds.`); return; }
    setBusy(true); setErr('');
    try {
      const r = await posApi.transfers.create(to, items, notes);
      if (!r.ok) { setErr(r.error ?? 'Could not create the transfer.'); return; }
      onSent(`Transfer ${r.data?.transfer_number ?? ''} created — Despatch it when it leaves.`);
    } finally { setBusy(false); }
  };
  const sel = 'bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm';
  return (
    <div className="bg-gray-800 border border-action-600/40 rounded-xl p-3 space-y-2" data-testid="transfer-new-form">
      <select value={to} onChange={(e) => setTo(e.target.value)} className={sel + ' w-full'}>
        <option value="">Send to which branch?</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {lines.map((l, n) => (
        <div key={n} className="flex gap-2">
          <select value={l.product_id} onChange={(e) => setLines(lines.map((x, i) => (i === n ? { ...x, product_id: e.target.value } : x)))} className={sel + ' flex-1'}>
            <option value="">Item…</option>
            {stock.filter((s) => Number(s.quantity) > 0).map((s) => <option key={s.product_id} value={s.product_id}>{s.product_name} ({Number(s.quantity)} here)</option>)}
          </select>
          <input type="number" min={0} placeholder="Qty" value={l.quantity}
            onChange={(e) => setLines(lines.map((x, i) => (i === n ? { ...x, quantity: e.target.value } : x)))} className={sel + ' w-24'} />
        </div>
      ))}
      <button onClick={() => setLines([...lines, { product_id: '', quantity: '' }])} className="text-xs text-gray-300 underline">+ Another item</button>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" maxLength={300} className={sel + ' w-full'} />
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="flex gap-2">
        <button onClick={() => void send()} disabled={busy} className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
          {busy ? 'Creating…' : 'Create transfer'}</button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Cancel</button>
      </div>
    </div>
  );
}
