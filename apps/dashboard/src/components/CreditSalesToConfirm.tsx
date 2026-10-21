/**
 * CreditSalesToConfirm — A545: every sale on account, confirmed or disputed by a manager (web: the owner's Credit
 * Accounts and the manager portal's Credit tab), the count badge, the Close Day notice and the ledger's "disputed" mark.
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done." The owner sees every branch (or the one picked); a manager their own (the cloud scopes it). Confirm, or
 * Dispute with a reason — a disputed sale stays on the customer's balance until the sale is voided or refunded.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { money, dateTime } from '../lib/format';

export interface CreditClient {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
}
interface Row {
  order_id: string; order_number: string | null; branch_name: string | null; customer_name: string | null; amount: number;
  state: 'awaiting' | 'confirmed' | 'disputed'; source: string; over_limit: boolean; cashier_name: string | null;
  approved_by_name: string | null; decided_by_name: string | null; decided_at: string | null; dispute_reason: string | null; sold_at: string;
}
interface Counts { awaiting: number; awaiting_amount: number; disputed: number; disputed_amount: number }

/** The client object is made afresh on every render of its provider — keep the latest in a ref so effects run once. */
function useClient(client: CreditClient) {
  const ref = useRef(client);
  ref.current = client;
  return ref;
}

export default function CreditSalesToConfirm({ client, currency, canDecide, showBranch = false, onChanged }: {
  client: CreditClient; currency: string; canDecide: boolean; showBranch?: boolean; onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const c = useClient(client);

  const load = useCallback(async () => {
    try {
      const r = await c.current.get<{ rows: Row[]; counts: Counts }>('/api/credit/sales?state=open');
      setRows(r.rows ?? []); setCounts(r.counts ?? null); setErr('');
    } catch (e: any) { setErr(e?.message ?? 'Could not load the credit sales.'); }
  }, [c]);
  useEffect(() => { if (canDecide) void load(); }, [load, canDecide]);
  if (!canDecide) return null;

  const decide = async (id: string, decision: 'confirm' | 'dispute') => {
    if (decision === 'dispute' && !reason.trim()) { setErr('Say why it is disputed.'); return; }
    setBusy(id); setErr(''); setOk('');
    try {
      await c.current.post(`/api/credit/sales/${id}/${decision}`, decision === 'dispute' ? { reason: reason.trim() } : {});
      setOk(decision === 'confirm' ? 'Confirmed.' : "Disputed — it stays on the customer's balance until the sale is voided or refunded.");
      setDisputing(null); setReason('');
      await load(); onChanged?.();
    } catch (e: any) { setErr(e?.message ?? 'Could not save that.'); }
    finally { setBusy(null); }
  };

  const awaiting = rows.filter((r) => r.state === 'awaiting');
  const disputed = rows.filter((r) => r.state === 'disputed');
  if (!awaiting.length && !disputed.length && !err) return null;

  return (
    <div className="bg-gray-900 border border-amber-800/50 rounded-xl p-4 space-y-3 mb-5" data-testid="credit-sales-to-confirm">
      <div>
        <h2 className="text-white font-semibold">Credit sales to confirm{counts?.awaiting ? ` (${counts.awaiting})` : ''}</h2>
        <p className="text-gray-400 text-xs mt-0.5">Every sale on account is confirmed by a manager. Confirm the ones that were done; dispute one that was not right.</p>
      </div>
      {err && <p className="text-sm text-red-400" role="alert">{err}</p>}
      {ok && <p className="text-sm text-swift-text">{ok}</p>}
      {awaiting.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs">
            <th className="pb-2">Customer</th><th className="pb-2 text-right">Amount</th><th className="pb-2">Cashier</th><th className="pb-2">Time</th>
            <th className="pb-2">Approved at sale</th>{showBranch && <th className="pb-2">Branch</th>}<th className="pb-2"></th>
          </tr></thead>
          <tbody>
            {awaiting.map((r) => (
              <tr key={r.order_id} className="border-t border-gray-800 align-top">
                <td className="py-2 text-white">{r.customer_name ?? 'A customer'}<div className="text-xs text-gray-500">{r.order_number ?? ''}{r.source === 'till' ? ' · from a till' : ''}</div>
                  {r.over_limit && <div className="text-xs text-amber-400">Over the credit limit (taken on a till)</div>}</td>
                <td className="py-2 text-right text-white">{money(r.amount, currency)}</td>
                <td className="py-2 text-gray-300">{r.cashier_name ?? '—'}</td>
                <td className="py-2 text-gray-300">{dateTime(r.sold_at)}</td>
                <td className="py-2 text-gray-300">{r.approved_by_name ?? '—'}</td>
                {showBranch && <td className="py-2 text-gray-300">{r.branch_name ?? '—'}</td>}
                <td className="py-2 text-right whitespace-nowrap">
                  {disputing === r.order_id ? (
                    <span className="inline-flex items-center gap-2">
                      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why?"
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-44" />
                      <button disabled={busy === r.order_id} onClick={() => decide(r.order_id, 'dispute')} className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-xs">Dispute</button>
                      <button onClick={() => { setDisputing(null); setReason(''); }} className="text-xs text-gray-400">Cancel</button>
                    </span>
                  ) : (
                    <span className="inline-flex gap-2">
                      <button disabled={busy === r.order_id} onClick={() => decide(r.order_id, 'confirm')} className="px-2 py-1 rounded bg-swift-strong hover:bg-swift-deep text-white text-xs">Confirm</button>
                      <button disabled={busy === r.order_id} onClick={() => { setDisputing(r.order_id); setReason(''); }} className="px-2 py-1 rounded border border-red-700 text-red-300 hover:bg-red-900/30 text-xs">Dispute</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {disputed.length > 0 && (
        <div>
          <p className="text-sm text-amber-400 font-medium">Disputed ({disputed.length}) — still owed until voided or refunded</p>
          <ul className="mt-1 space-y-1 text-sm text-gray-300">
            {disputed.map((r) => (
              <li key={r.order_id}><span className="text-white">{r.customer_name ?? 'A customer'}</span> · {money(r.amount, currency)} · {r.order_number ?? ''}
                {showBranch && r.branch_name ? ` · ${r.branch_name}` : ''} — disputed by {r.decided_by_name ?? 'a manager'}{r.decided_at ? `, ${dateTime(r.decided_at)}` : ''}: {r.dispute_reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The count for a nav badge (0 when the person may not see it, or on any error). */
export function useCreditAwaiting(client: CreditClient, enabled: boolean): number {
  const [n, setN] = useState(0);
  const c = useClient(client);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => c.current.get<{ awaiting: number }>('/api/credit/sales/count').then((r) => { if (live) setN(Number(r?.awaiting) || 0); }).catch(() => {});
    void read();
    const t = setInterval(read, 120_000);
    return () => { live = false; clearInterval(t); };
  }, [c, enabled]);
  return n;
}

/** A545: "N credit sales await a manager's confirmation" on the Close Day screens — never a block on the close. */
export function CreditAwaitingNotice({ client }: { client: CreditClient }) {
  const [notice, setNotice] = useState('');
  const c = useClient(client);
  useEffect(() => {
    let live = true;
    c.current.get<{ notice?: string }>('/api/credit/sales/count').then((r) => { if (live) setNotice(r?.notice ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, [c]);
  if (!notice) return null;
  return (
    <p className="text-sm text-amber-400 border border-amber-800/50 rounded-lg px-3 py-2 mb-3" data-testid="credit-awaiting-notice">
      {notice} (Customers › Credit). The day still closes.
    </p>
  );
}

/** A545: the ledger's note for a line — a disputed sale on account is marked (it stays on the balance). */
export function ledgerNote(l: { method: string | null; notes: string | null; order_id: string | null; confirm_state?: string | null; dispute_reason?: string | null }): ReactNode {
  const base = l.method ?? l.notes ?? (l.order_id ? 'sale' : '');
  if (l.confirm_state === 'disputed') {
    return <>{base} <span className="ml-1 px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 text-[11px]" title={l.dispute_reason ?? ''}>Disputed{l.dispute_reason ? `: ${l.dispute_reason}` : ''}</span></>;
  }
  if (l.confirm_state === 'awaiting') return <>{base} <span className="ml-1 text-[11px] text-amber-400">awaiting a manager</span></>;
  return base;
}
