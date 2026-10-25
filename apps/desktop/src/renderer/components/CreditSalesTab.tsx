/**
 * CreditSalesTab — A545: credit sales to confirm (Manager › Sales › Credit sales), and the Close Day / Close Branch notice.
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done." Every sale on account: customer, amount, cashier, time, who approved it at the sale; Confirm, or Dispute with
 * a reason. A manager signed in here decides as themselves; offline the decision is kept and sent later
 * (main/creditConfirm.ts). A disputed sale stays on the customer's balance until it is voided or refunded.
 */
import { useCallback, useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { CreditSaleView } from '../lib/posApi';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const money = (n: number, currency: string) => `${currency} ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CreditSalesTab({ currency }: { currency: string }) {
  const [rows, setRows] = useState<CreditSaleView[]>([]);
  const [online, setOnline] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refused, setRefused] = useState<Array<{ order_id: string; decision: string; by_name: string | null; refused_at: string; message: string }>>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await posApi.manage.creditSales();
      setRows(r.rows ?? []); setOnline(r.online); setSavedAt(r.saved_at); setRefused(r.refused ?? []); setError('');
    } catch (e: any) { setError(e?.message ?? 'Could not load the credit sales.'); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);

  const decide = async (orderId: string, decision: 'confirm' | 'dispute') => {
    if (decision === 'dispute' && !reason.trim()) { setError('Say why it is disputed.'); return; }
    setBusy(orderId); setError(''); setNotice('');
    try {
      const r = await posApi.manage.decideCredit(orderId, decision, decision === 'dispute' ? reason.trim() : undefined);
      setNotice(r.state === 'pending' ? r.message : decision === 'confirm' ? 'Confirmed.' : 'Disputed — it stays on the customer\'s balance until the sale is voided or refunded.');
      setDisputing(null); setReason('');
      await load();
    } catch (e: any) { setError(e?.message ?? 'Could not save that.'); }
    finally { setBusy(null); }
  };

  const awaiting = rows.filter((r) => r.state === 'awaiting');
  const disputed = rows.filter((r) => r.state === 'disputed');

  return (
    <div className="space-y-4" data-testid="credit-sales">
      <div>
        <h2 className="text-lg font-semibold text-white">Credit sales to confirm</h2>
        <p className="text-sm text-gray-300">Every sale on account is confirmed by a manager. Confirm the ones that were done; dispute one that was not right (it stays owed until the sale is voided or refunded).</p>
      </div>
      {!online && (
        <p className="text-xs text-amber-300" data-testid="credit-offline">
          No connection — the list saved {savedAt ? when(savedAt) : 'earlier'}. What you confirm or dispute now is kept on this POS and sent when the connection is back.
        </p>
      )}
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {notice && <p className="text-sm text-action-400">{notice}</p>}
      {refused.map((f) => (
        <div key={f.order_id} className="text-xs text-red-300 border border-red-900/60 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>Not taken by the cloud ({f.decision} by {f.by_name ?? 'a manager'}, {when(f.refused_at)}): {f.message}</span>
          <button className="text-gray-300 hover:text-white" onClick={() => { void posApi.manage.dismissCredit(f.order_id).then(load); }}>Dismiss</button>
        </div>
      ))}

      <section>
        <h3 className="text-sm font-semibold text-gray-200 mb-2">Awaiting confirmation ({awaiting.length})</h3>
        {awaiting.length === 0 ? <p className="text-sm text-gray-400">Nothing waiting.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-400 text-xs">
              <th className="py-1">Customer</th><th>Amount</th><th>Cashier</th><th>Time</th><th>Approved at sale</th><th></th>
            </tr></thead>
            <tbody>
              {awaiting.map((r) => (
                <tr key={r.order_id} className="border-t border-gray-800 align-top" data-testid="credit-row">
                  <td className="py-2 text-white">{r.customer_name ?? 'A customer'}<div className="text-xs text-gray-400">{r.order_number ?? ''}{r.branch_name ? ` · ${r.branch_name}` : ''}</div>
                    {r.over_limit && <div className="text-xs text-amber-300">Over the customer's credit limit (taken on a POS)</div>}</td>
                  <td className="py-2 text-white">{money(r.amount, currency)}</td>
                  <td className="py-2 text-gray-300">{r.cashier_name ?? '—'}</td>
                  <td className="py-2 text-gray-300">{when(r.sold_at)}</td>
                  <td className="py-2 text-gray-300">{r.approved_by_name ?? '—'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {disputing === r.order_id ? (
                      <span className="inline-flex items-center gap-2">
                        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why?"
                          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-48" />
                        <button disabled={busy === r.order_id} onClick={() => decide(r.order_id, 'dispute')}
                          className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-xs">Dispute</button>
                        <button onClick={() => { setDisputing(null); setReason(''); }} className="text-xs text-gray-300">Cancel</button>
                      </span>
                    ) : (
                      <span className="inline-flex gap-2">
                        <button disabled={busy === r.order_id} onClick={() => decide(r.order_id, 'confirm')} data-testid="credit-confirm"
                          className="px-2 py-1 rounded bg-action-500 hover:bg-action-400 text-gray-950 font-semibold text-xs">Confirm</button>
                        <button disabled={busy === r.order_id} onClick={() => { setDisputing(r.order_id); setReason(''); }} data-testid="credit-dispute"
                          className="px-2 py-1 rounded border border-red-700 text-red-300 hover:bg-red-900/30 text-xs">Dispute</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {disputed.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-200 mb-2">Disputed ({disputed.length}) — still owed until voided or refunded</h3>
          <ul className="space-y-1 text-sm">
            {disputed.map((r) => (
              <li key={r.order_id} className="text-gray-300">
                <span className="text-white">{r.customer_name ?? 'A customer'}</span> · {money(r.amount, currency)} · {r.order_number ?? ''} — disputed by {r.decided_by_name ?? 'a manager'}{r.decided_at ? `, ${when(r.decided_at)}` : ''}: {r.dispute_reason}
                {r.pending && <span className="text-xs text-amber-300"> (not on the cloud yet)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A545: the Close Day / Close Branch line — "N credit sales await a manager's confirmation". Never blocks the close. */
export function CreditAwaitingNotice() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    posApi.manage.creditAwaiting().then((r) => { if (live) setNotice(r?.notice ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!notice) return null;
  return (
    <p className="text-sm text-amber-300 border border-amber-800/60 rounded-lg px-3 py-2" data-testid="credit-awaiting-notice">
      {notice} (Manager › Sales › Credit sales). The day still closes.
    </p>
  );
}
