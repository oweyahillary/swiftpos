/**
 * BranchStockTab — A564: find an item in another branch's stock, and ask that branch for it — on the till, under Stock.
 *
 * Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
 * manager can request for them".
 *
 * Find (inventory.view): type an item, see each other branch and how much it holds ("Westlands: 24 · Kilimani: 0") —
 * quantities only, never a cost; from the cloud each time (no connection: "Needs a connection", never an old figure).
 * Request (inventory.transfer): ask a branch for some of it, for THIS branch, with a note. The other branch sees it here
 * under "Requests from other branches": Accept and send (a transfer is created and despatched — it arrives under
 * Transfers to be received) or Decline with a reason. This branch may cancel what it asked while it still waits.
 */
import { useCallback, useEffect, useState } from 'react';
import { posApi, type BranchStockFind, type StockRequest } from '../lib/posApi';
import { quantityProblem, askedSent } from '../lib/branchStock';

type Found = BranchStockFind['products'][number];
type Spot = Found['branches'][number];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const qty = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Number(n)));

/** "Westlands: 24 · Kilimani: 0" — the one line a cashier reads (an item being counted there says so). */
export function branchLine(spots: Spot[]): string {
  return spots.map((s) => `${s.branch_name}: ${s.counting ? 'being counted' : qty(s.quantity)}`).join(' · ');
}

/** The search and what it finds. `onRequest` (a manager) adds a Request button on each branch that holds some.
 *  A566: `autoSearch` — opened from the selling screen with the item already named, it looks at once. */
export function FindInBranches({ onRequest, initial = '', autoSearch = false }: { onRequest?: (p: Found, s: Spot) => void; initial?: string; autoSearch?: boolean }) {
  const [q, setQ] = useState(initial);
  const [rows, setRows] = useState<Found[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const find = async () => {
    if (q.trim().length < 2) { setErr('Type at least 2 letters of the item.'); return; }
    setBusy(true); setErr(''); setOffline(false);
    try {
      const r = await posApi.branchStock.find(q.trim());
      if (!r.ok || !r.data) { setRows(null); setOffline(r.offline === true); setErr(r.error ?? 'Could not search.'); return; }
      setRows(r.data.products); setTruncated(r.data.truncated);
    } catch (e: any) { setErr(e?.message ?? 'Could not search.'); }
    finally { setBusy(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoSearch && initial.trim().length >= 2) void find(); }, []);
  return (
    <div className="space-y-2" data-testid="branch-stock-find">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item in other branches" maxLength={60} autoFocus
          data-testid="branch-stock-q" className="flex-1 bg-gray-900 border border-gray-600 rounded-md px-3 py-2 text-white text-sm" />
        <button type="submit" disabled={busy} data-testid="branch-stock-search"
          className="px-3 py-2 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {err && <p className={`text-sm ${offline ? 'text-amber-300' : 'text-red-300'}`} data-testid={offline ? 'branch-stock-offline' : 'branch-stock-error'}>{err}</p>}
      {rows && rows.length === 0 && <p className="text-sm text-gray-300">No stock-tracked item matches “{q.trim()}”.</p>}
      {rows && rows.map((p) => (
        <div key={p.product_id} className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-1" data-testid={`branch-stock-${p.product_id}`}>
          <p className="text-white font-medium text-sm">{p.name}</p>
          {p.branches.length === 0
            ? <p className="text-xs text-gray-400">There is no other branch.</p>
            : <p className="text-sm text-gray-200" data-testid="branch-stock-line">{branchLine(p.branches)}</p>}
          {onRequest && (
            <div className="flex flex-wrap gap-2 pt-1">
              {p.branches.filter((s) => !s.counting && Number(s.quantity) > 0).map((s) => (
                <button key={s.branch_id} onClick={() => onRequest(p, s)} data-testid={`branch-stock-request-${s.branch_id}`}
                  className="px-2.5 py-1 rounded-md border border-action-600/60 text-action-300 text-xs hover:bg-action-600/20">Request from {s.branch_name}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      {truncated && <p className="text-xs text-gray-400">More items match — type more of the name.</p>}
    </div>
  );
}

const STATUS: Record<StockRequest['status'], [string, string]> = {
  requested: ['waiting', 'bg-amber-600/20 text-amber-300 border-amber-600/40'],
  accepted: ['sent', 'bg-action-600/20 text-action-300 border-action-600/40'],
  declined: ['declined', 'bg-gray-700/40 text-gray-300 border-gray-600/50'],
  cancelled: ['cancelled', 'bg-gray-700/40 text-gray-400 border-gray-600/50'],
};

export default function BranchStockTab({ canRequest, onCount }: { canRequest: boolean; onCount?: (n: number) => void }) {
  const [asking, setAsking] = useState<{ p: Found; s: Spot } | null>(null);
  const [requests, setRequests] = useState<StockRequest[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [reqErr, setReqErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRequest) return;
    const r = await posApi.branchStock.requests().catch((e: any) => ({ ok: false, offline: true, error: e?.message ?? 'Could not load', code: null }) as Awaited<ReturnType<typeof posApi.branchStock.requests>>);
    if (!r.ok || !r.data) { setReqErr(r.error ?? 'Could not load the requests.'); return; }
    setReqErr(''); setRequests(r.data.requests ?? []); setBranch(r.data.branch_id);
    onCount?.(Number(r.data.incoming_open) || 0);
  }, [canRequest, onCount]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (r: StockRequest, step: 'accept' | 'decline' | 'cancel', extra?: { reason?: string; quantity?: number }) => {
    setBusy(r.id); setReqErr(''); setMsg('');
    try {
      const a = await posApi.branchStock.decide(r.id, step, extra);
      if (!a.ok || !a.data) { setReqErr(a.error ?? 'Could not save that.'); return; }
      setDeclining(null); setAccepting(null);
      setMsg(step === 'accept'
        ? (a.data.warning ?? `Sent ${a.data.transfer?.transfer_number ?? ''} to ${r.to_branch_name} — it is on its way; they receive it under Transfers.`)
        : step === 'decline' ? `Declined — ${r.to_branch_name} sees why.` : 'Request cancelled.');
      await load();
    } finally { setBusy(null); }
  };

  const incoming = requests.filter((r) => r.status === 'requested' && (!branch || r.from_branch_id === branch));
  const outgoing = requests.filter((r) => r.status === 'requested' && branch && r.to_branch_id === branch);
  const earlier = requests.filter((r) => r.status !== 'requested').slice(0, 20);

  return (
    <div className="space-y-4" data-testid="branch-stock">
      <div>
        <h2 className="text-lg font-bold text-white">Other branches</h2>
        <p className="text-gray-300 text-sm">See how much another branch holds of an item{canRequest ? ', and ask them to send some here' : ''}.</p>
      </div>
      <FindInBranches onRequest={canRequest ? (p, s) => { setAsking({ p, s }); setMsg(''); } : undefined} />
      {asking && <RequestForm p={asking.p} s={asking.s} onCancel={() => setAsking(null)}
        onSent={(m) => { setAsking(null); setMsg(m); void load(); }} />}
      {msg && <p className="text-sm text-gray-200" data-testid="branch-stock-msg">{msg}</p>}

      {canRequest && (
        <>
          {reqErr && <p className="text-sm text-amber-300">{reqErr}</p>}
          <Section title={`Requests from other branches${incoming.length ? ` (${incoming.length})` : ''}`} empty="No branch is asking this branch for anything.">
            {incoming.map((r) => (
              <Card key={r.id} r={r} side={`${r.to_branch_name} asks for`}>
                {declining === r.id
                  ? <DeclineForm busy={busy === r.id} onBack={() => setDeclining(null)} onDecline={(why) => decide(r, 'decline', { reason: why })} />
                  : accepting === r.id
                  ? <AcceptForm r={r} busy={busy === r.id} onBack={() => setAccepting(null)} onSend={(n) => decide(r, 'accept', { quantity: n })} />
                  : (
                    <div className="flex gap-2">
                      <button data-testid={`request-accept-${r.id}`} disabled={busy === r.id} onClick={() => setAccepting(r.id)}
                        className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
                        {busy === r.id ? 'Sending…' : 'Accept and send'}</button>
                      <button data-testid={`request-decline-${r.id}`} disabled={busy === r.id} onClick={() => setDeclining(r.id)}
                        className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Decline</button>
                    </div>
                  )}
              </Card>
            ))}
          </Section>
          <Section title="Asked by this branch" empty="Nothing asked for that is still waiting.">
            {outgoing.map((r) => (
              <Card key={r.id} r={r} side={`asked of ${r.from_branch_name}`}>
                <button data-testid={`request-cancel-${r.id}`} disabled={busy === r.id} onClick={() => decide(r, 'cancel')}
                  className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm disabled:opacity-40">Cancel request</button>
              </Card>
            ))}
          </Section>
          {earlier.length > 0 && (
            <Section title="Earlier" empty="">
              {earlier.map((r) => <Card key={r.id} r={r} side={r.to_branch_id === branch ? `asked of ${r.from_branch_name}` : `${r.to_branch_name} asked for`} />)}
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

function Card({ r, side, children }: { r: StockRequest; side: string; children?: React.ReactNode }) {
  const [text, cls] = STATUS[r.status];
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-2" data-testid={`request-${r.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-400">{side}</span>
        <span className="text-white font-medium">{qty(r.quantity)} × {r.product_name}</span>
        <span className={`text-xs px-2 py-0.5 rounded border ${cls}`}>{text}</span>
        <span className="text-xs text-gray-500 ml-auto">{when(r.requested_at)}</span>
      </div>
      <p className="text-xs text-gray-400">
        Asked by {r.requested_by_name ?? 'someone'}
        {r.decided_by_name && r.status !== 'requested' ? ` · ${text} by ${r.decided_by_name} ${when(r.decided_at)}` : ''}
        {askedSent(r) ? ` · ${askedSent(r)}` : ''}
      </p>
      {r.note && <p className="text-xs text-gray-300">Note: {r.note}</p>}
      {r.decline_reason && <p className="text-xs text-amber-300">Declined: {r.decline_reason}</p>}
      {children}
    </div>
  );
}

function DeclineForm({ busy, onBack, onDecline }: { busy: boolean; onBack: () => void; onDecline: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-wrap gap-2 border-t border-gray-700 pt-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is declined (required)" maxLength={300} autoFocus
        data-testid="request-decline-reason" className="flex-1 min-w-[12rem] bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
      <button disabled={busy || !reason.trim()} onClick={() => onDecline(reason.trim())}
        className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-sm disabled:opacity-40">{busy ? 'Declining…' : 'Decline'}</button>
      <button onClick={onBack} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Back</button>
    </div>
  );
}

/** Accept and send: what was asked, unless this branch sends fewer or more (owner, 2026-10-22) — both are kept. */
function AcceptForm({ r, busy, onBack, onSend }: { r: StockRequest; busy: boolean; onBack: () => void; onSend: (n: number) => void }) {
  const [n, setN] = useState(String(Number(r.quantity)));
  const [err, setErr] = useState('');
  const send = () => {
    const why = quantityProblem(n);
    if (why) { setErr(why); return; }
    setErr(''); onSend(Number(n));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-gray-700 pt-2" data-testid={`request-accept-form-${r.id}`}>
      <span className="text-xs text-gray-300">Send</span>
      <input type="number" min={0} value={n} onChange={(e) => setN(e.target.value)} autoFocus data-testid="request-accept-qty"
        className="w-24 bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
      <span className="text-xs text-gray-400">asked {qty(r.quantity)} — change it to send fewer or more</span>
      <button disabled={busy} onClick={send} data-testid="request-accept-send"
        className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">{busy ? 'Sending…' : 'Accept and send'}</button>
      <button onClick={onBack} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Back</button>
      {err && <p className="w-full text-xs text-red-300">{err}</p>}
    </div>
  );
}

/** Ask one branch for some of an item, for this branch: how many (at most what they hold) and a note. */
function RequestForm({ p, s, onCancel, onSent }: { p: Found; s: Spot; onCancel: () => void; onSent: (msg: string) => void }) {
  const [n, setN] = useState('');   // blank: the requester types how many (never a guessed 1)
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const why = quantityProblem(n, s.quantity, s.branch_name);
    if (why) { setErr(why); return; }
    const v = Number(n);
    setBusy(true); setErr('');
    try {
      const r = await posApi.branchStock.request(s.branch_id, p.product_id, v, note.trim() || undefined);
      if (!r.ok) { setErr(r.error ?? 'Could not send the request.'); return; }
      onSent(`Asked ${s.branch_name} for ${v} × ${p.name} — they see it now.`);
    } finally { setBusy(false); }
  };
  return (
    <div className="bg-gray-800 border border-action-600/40 rounded-xl p-3 space-y-2" data-testid="branch-stock-request-form">
      <p className="text-sm text-white">Ask <span className="font-semibold">{s.branch_name}</span> for {p.name} <span className="text-gray-400">({qty(s.quantity)} there)</span></p>
      <div className="flex gap-2">
        <input type="number" min={0} value={n} onChange={(e) => setN(e.target.value)} placeholder="How many" data-testid="branch-stock-request-qty"
          className="w-24 bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={300}
          className="flex-1 bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-white text-sm" />
      </div>
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="flex gap-2">
        <button onClick={() => void send()} disabled={busy} data-testid="branch-stock-request-send"
          className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">{busy ? 'Asking…' : 'Send request'}</button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Cancel</button>
      </div>
    </div>
  );
}
