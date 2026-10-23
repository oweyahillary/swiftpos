/**
 * OtherBranchesPanel — A564: find an item in another branch's stock, and ask that branch for it (the web's half).
 *
 * Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
 * manager can request for them".
 *
 * Used by the dashboard's Stock › Other branches page (the owner, a partner, a manager) and by the web POS / manager
 * portal's Stock tab (POSInventoryTab — a cashier sees the stock, a manager also asks). The cloud does the work
 * (routes/stock.ts):
 *   - Find (inventory.view): each OTHER branch and how much it holds — "Westlands: 24 · Kilimani: 0". Quantities only,
 *     never a cost. Asked when someone searches (no polling).
 *   - Request (inventory.transfer): some of an item from one branch, for the asking branch, with a note.
 *   - Requests from other branches: Accept and send (a transfer is created and despatched — the asking branch receives
 *     it under Transfers) or Decline with a reason. The asking branch may cancel while it waits. The owner (all branches
 *     picked) sees every request and may act for any branch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { quantityProblem, askedSent } from '../lib/branchStock';   // the till's rules, the same text (apps/desktop/src/renderer/lib/branchStock.ts)

export interface PanelHttp {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
}

interface Spot { branch_id: string; branch_name: string; quantity: number | null; qty_pieces: number | null; updated_at: string | null; counting: boolean }
interface Found { product_id: string; name: string; sold_by: string | null; branches: Spot[] }
export interface StockRequestRow {
  id: string; from_branch_id: string; to_branch_id: string; from_branch_name: string; to_branch_name: string;
  product_id: string; product_name: string; quantity: number; sent_quantity: number | null; note: string | null;
  status: 'requested' | 'accepted' | 'declined' | 'cancelled'; requested_by_name: string | null; requested_at: string;
  decided_by_name: string | null; decided_at: string | null; decline_reason: string | null; transfer_id: string | null;
}

const qty = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Number(n)));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** "Westlands: 24 · Kilimani: 0" (an item being counted there says so). */
export function branchLine(spots: Spot[]): string {
  return spots.map((s) => `${s.branch_name}: ${s.counting ? 'being counted' : qty(s.quantity)}`).join(' · ');
}

const STATUS: Record<StockRequestRow['status'], [string, string]> = {
  requested: ['Waiting', 'bg-amber-500/10 text-amber-400'],
  accepted: ['Sent', 'bg-swift/10 text-swift-text'],
  declined: ['Declined', 'bg-gray-700 text-gray-300'],
  cancelled: ['Cancelled', 'bg-gray-800 text-gray-400'],
};

/**
 * `http` — the dashboard's api or the web POS's posApi. `canRequest` — inventory.transfer (asking, and the requests).
 * `branchId` — the asking branch when the caller has no branch of their own (the owner's picked branch); null: the
 * cloud uses the caller's own.
 */
export default function OtherBranchesPanel({ http, canRequest, branchId = null, onCount }: {
  http: PanelHttp; canRequest: boolean; branchId?: string | null; onCount?: (n: number) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Found[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [findErr, setFindErr] = useState('');
  const [finding, setFinding] = useState(false);
  const [asking, setAsking] = useState<{ p: Found; s: Spot } | null>(null);
  const [requests, setRequests] = useState<StockRequestRow[]>([]);
  const [own, setOwn] = useState<string | null>(null);
  const [reqErr, setReqErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<{ id: string; reason: string } | null>(null);

  const find = async () => {
    if (q.trim().length < 2) { setFindErr('Type at least 2 letters of the item.'); return; }
    setFinding(true); setFindErr('');
    try {
      const r = await http.get<{ products: Found[]; truncated: boolean }>(`/api/stock/other-branches?q=${encodeURIComponent(q.trim())}&limit=20`);
      setRows(r.products ?? []); setTruncated(!!r.truncated);
    } catch (e: any) { setRows(null); setFindErr(e?.message ?? 'Could not search.'); }
    finally { setFinding(false); }
  };

  // The web POS's client is a new object each render: read it (and onCount) through refs, so loading runs once.
  const httpRef = useRef(http); httpRef.current = http;
  const countRef = useRef(onCount); countRef.current = onCount;
  const load = useCallback(async () => {
    if (!canRequest) return;
    try {
      const r = await httpRef.current.get<{ branch_id: string | null; incoming_open: number; requests: StockRequestRow[] }>('/api/stock/requests?limit=100');
      setRequests(r.requests ?? []); setOwn(r.branch_id ?? null); setReqErr('');
      countRef.current?.(Number(r.incoming_open) || 0);
    } catch (e: any) { setReqErr(e?.message ?? 'Could not load the requests.'); }
  }, [canRequest]);
  useEffect(() => { void load(); }, [load, branchId]);

  const [accepting, setAccepting] = useState<{ id: string; qty: string; err: string } | null>(null);
  const decide = async (r: StockRequestRow, step: 'accept' | 'decline' | 'cancel', reason?: string, quantity?: number) => {
    setBusy(r.id); setReqErr(''); setMsg('');
    try {
      const a = await http.post<StockRequestRow & { transfer?: { transfer_number: string }; warning?: string }>(
        `/api/stock/requests/${r.id}/${step}`, reason ? { reason } : quantity !== undefined ? { quantity } : {});
      setDeclining(null); setAccepting(null);
      setMsg(step === 'accept'
        ? (a.warning ?? `Sent ${a.transfer?.transfer_number ?? ''} to ${r.to_branch_name} — they receive it under Transfers.`)
        : step === 'decline' ? `Declined — ${r.to_branch_name} sees why.` : 'Request cancelled.');
      await load();
    } catch (e: any) { setReqErr(e?.message ?? 'Could not save that.'); }
    finally { setBusy(null); }
  };

  // The owner with every branch (own null): every waiting request is theirs to answer or cancel.
  const incoming = requests.filter((r) => r.status === 'requested' && (!own || r.from_branch_id === own));
  const outgoing = requests.filter((r) => r.status === 'requested' && !!own && r.to_branch_id === own);
  const earlier = requests.filter((r) => r.status !== 'requested').slice(0, 30);
  const askFor = branchId ?? own;   // the branch the stock is for (the cloud falls back to the caller's own)

  return (
    <div className="space-y-5" data-testid="other-branches">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item in other branches" maxLength={60}
            data-testid="other-branches-q"
            className="flex-1 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-swift" />
          <button type="submit" disabled={finding} data-testid="other-branches-search"
            className="bg-swift hover:bg-swift-light disabled:opacity-50 text-black font-semibold text-sm px-4 py-2 rounded-lg">{finding ? 'Searching…' : 'Search'}</button>
        </form>
        {findErr && <p className="text-red-400 text-sm">{findErr}</p>}
        {rows && rows.length === 0 && <p className="text-gray-400 text-sm">No stock-tracked item matches “{q.trim()}”.</p>}
        {rows && rows.map((p) => (
          <div key={p.product_id} className="border-t border-gray-800 pt-3" data-testid={`other-branches-${p.product_id}`}>
            <p className="text-white text-sm font-medium">{p.name}</p>
            <p className="text-gray-300 text-sm" data-testid="other-branches-line">{p.branches.length ? branchLine(p.branches) : 'There is no other branch.'}</p>
            {canRequest && (
              <div className="flex flex-wrap gap-2 mt-2">
                {p.branches.filter((s) => !s.counting && Number(s.quantity) > 0).map((s) => (
                  <button key={s.branch_id} onClick={() => { setAsking({ p, s }); setMsg(''); }}
                    className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-swift-text hover:text-swift-text-hover hover:border-gray-600">
                    Request from {s.branch_name}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        {truncated && <p className="text-gray-500 text-xs">More items match — type more of the name.</p>}
      </div>

      {asking && <RequestForm http={http} p={asking.p} s={asking.s} toBranchId={askFor}
        onCancel={() => setAsking(null)} onSent={(m) => { setAsking(null); setMsg(m); void load(); }} />}
      {msg && <p className="text-gray-200 text-sm" data-testid="other-branches-msg">{msg}</p>}

      {canRequest && (
        <div className="space-y-4">
          {reqErr && <p className="text-red-400 text-sm">{reqErr}</p>}
          <Section title={`Requests from other branches${incoming.length ? ` (${incoming.length})` : ''}`} empty="No branch is asking for anything.">
            {incoming.map((r) => (
              <Row key={r.id} r={r} side={`${r.to_branch_name} asks ${r.from_branch_name} for`}>
                {declining?.id === r.id ? (
                  <div className="flex flex-wrap gap-2 mt-2">
                    <input autoFocus value={declining.reason} maxLength={300} placeholder="Why it is declined (required)"
                      onChange={(e) => setDeclining({ id: r.id, reason: e.target.value })}
                      className="flex-1 min-w-[12rem] bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white" />
                    <button disabled={busy === r.id || !declining.reason.trim()} onClick={() => void decide(r, 'decline', declining.reason.trim())}
                      className="text-xs px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-400 disabled:opacity-40 text-white font-semibold">Decline</button>
                    <button onClick={() => setDeclining(null)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400">Back</button>
                  </div>
                ) : accepting?.id === r.id ? (
                  <div className="flex flex-wrap items-center gap-2 mt-2" data-testid={`request-accept-form-${r.id}`}>
                    <span className="text-xs text-gray-400">Send</span>
                    <input type="number" min={0} autoFocus value={accepting.qty} data-testid="request-accept-qty"
                      onChange={(e) => setAccepting({ id: r.id, qty: e.target.value, err: '' })}
                      className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white text-right" />
                    <span className="text-xs text-gray-500">asked {qty(r.quantity)} — change it to send fewer or more</span>
                    <button disabled={busy === r.id} data-testid="request-accept-send"
                      onClick={() => { const why = quantityProblem(accepting.qty); if (why) { setAccepting({ ...accepting, err: why }); return; } void decide(r, 'accept', undefined, Number(accepting.qty)); }}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-swift-strong hover:bg-swift-deep disabled:opacity-40 text-white">
                      {busy === r.id ? 'Sending…' : 'Accept and send'}</button>
                    <button onClick={() => setAccepting(null)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400">Back</button>
                    {accepting.err && <p className="w-full text-red-400 text-xs">{accepting.err}</p>}
                  </div>
                ) : (
                  <div className="flex gap-2 mt-2">
                    <button disabled={busy === r.id} onClick={() => setAccepting({ id: r.id, qty: String(Number(r.quantity)), err: '' })} data-testid={`request-accept-${r.id}`}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-swift-strong hover:bg-swift-deep disabled:opacity-40 text-white">
                      {busy === r.id ? 'Sending…' : 'Accept and send'}</button>
                    <button disabled={busy === r.id} onClick={() => setDeclining({ id: r.id, reason: '' })} data-testid={`request-decline-${r.id}`}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200">Decline</button>
                    {!own && <button disabled={busy === r.id} onClick={() => void decide(r, 'cancel')}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200">Cancel request</button>}
                  </div>
                )}
              </Row>
            ))}
          </Section>
          {own && (
            <Section title="Asked by this branch" empty="Nothing asked for that is still waiting.">
              {outgoing.map((r) => (
                <Row key={r.id} r={r} side={`asked of ${r.from_branch_name}`}>
                  <button disabled={busy === r.id} onClick={() => void decide(r, 'cancel')} data-testid={`request-cancel-${r.id}`}
                    className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40">Cancel request</button>
                </Row>
              ))}
            </Section>
          )}
          {earlier.length > 0 && (
            <Section title="Earlier" empty="">
              {earlier.map((r) => <Row key={r.id} r={r} side={`${r.to_branch_name} asked ${r.from_branch_name} for`} />)}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
      {list.length === 0 && empty ? <p className="text-xs text-gray-500">{empty}</p> : children}
    </div>
  );
}

function Row({ r, side, children }: { r: StockRequestRow; side: string; children?: React.ReactNode }) {
  const [label, cls] = STATUS[r.status];
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3" data-testid={`request-${r.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>
        <span className="text-gray-400">{side}</span>
        <span className="text-white font-medium">{qty(r.quantity)} × {r.product_name}</span>
        <span className="text-gray-500 text-xs ml-auto">{when(r.requested_at)}</span>
      </div>
      <p className="text-gray-500 text-xs mt-1">
        Asked by {r.requested_by_name ?? 'someone'}
        {r.decided_by_name && r.status !== 'requested' ? ` · ${label.toLowerCase()} by ${r.decided_by_name} ${when(r.decided_at)}` : ''}
        {askedSent(r) ? ` · ${askedSent(r)}` : ''}
      </p>
      {r.note && <p className="text-gray-400 text-xs mt-1 italic">Note: {r.note}</p>}
      {r.decline_reason && <p className="text-amber-400/90 text-xs mt-1">Declined: {r.decline_reason}</p>}
      {children}
    </div>
  );
}

function RequestForm({ http, p, s, toBranchId, onCancel, onSent }: {
  http: PanelHttp; p: Found; s: Spot; toBranchId: string | null; onCancel: () => void; onSent: (m: string) => void;
}) {
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
      await http.post('/api/stock/requests', { from_branch_id: s.branch_id, product_id: p.product_id, quantity: v,
        note: note.trim() || undefined, ...(toBranchId ? { to_branch_id: toBranchId } : {}) });
      onSent(`Asked ${s.branch_name} for ${v} × ${p.name} — they see it now.`);
    } catch (e: any) { setErr(e?.message ?? 'Could not send the request.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3" data-testid="other-branches-request-form">
      <p className="text-white text-sm">Ask <span className="font-semibold">{s.branch_name}</span> for {p.name} <span className="text-gray-500">({qty(s.quantity)} there)</span></p>
      {!toBranchId && <p className="text-amber-400 text-xs">Pick the branch the stock is for (the branch picker at the top) first.</p>}
      <div className="flex gap-2">
        <input type="number" min={0} value={n} onChange={(e) => setN(e.target.value)} placeholder="How many" data-testid="other-branches-request-qty"
          className="w-24 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-2 text-right" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={300}
          className="flex-1 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2" />
      </div>
      {err && <p className="text-red-400 text-sm">{err}</p>}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2 rounded-lg">Cancel</button>
        <button onClick={() => void send()} disabled={busy} className="flex-1 bg-swift hover:bg-swift-light disabled:opacity-50 text-black font-semibold text-sm py-2 rounded-lg">
          {busy ? 'Asking…' : 'Send request'}</button>
      </div>
    </div>
  );
}
