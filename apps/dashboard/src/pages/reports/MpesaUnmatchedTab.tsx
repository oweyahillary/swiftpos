/**
 * MpesaUnmatchedTab — A621: Reports › M-Pesa unmatched. The M-Pesa payments customers made to a branch's Till number or
 * Paybill (payment notifications) that no sale used — so the owner sees money nobody put on a bill.
 *
 * "Waiting": no cashier tapped it. "Held by a POS": a cashier tapped it, but the sale has not reached the cloud yet (a POS
 * offline since) or the payment screen closed without giving it back. A payment leaves this list when an order carrying
 * its code reaches the cloud — tapped or typed by hand. GET /api/payments/c2b/unmatched (routes/c2b.ts).
 * The owner can Release a held payment, so it shows on every POS again (owner, 2026-11-03).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';

interface Unmatched {
  trans_id: string; amount: number; first_name: string | null; phone_masked: string | null; bill_ref: string | null;
  paid_at: string; status: string; held_by: string | null; held_at: string | null;
}
interface Answer { from: string; to: string; payments: Unmatched[]; total: number; licensed: boolean }


interface Props { range: { from: string; to: string }; branchId: string; currency: string; canRelease: boolean }

export default function MpesaUnmatchedTab({ range, branchId, currency, canRelease }: Props) {
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null); setError('');
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (branchId) q.set('branch_id', branchId);
    api.get<Answer>(`/api/payments/c2b/unmatched?${q.toString()}`)
      .then((d) => { if (live) setData(d); })
      .catch((e: any) => { if (live) setError(e?.message ?? 'Could not load the M-Pesa payments'); });
    return () => { live = false; };
  }, [range.from, range.to, branchId, reload]);

  const release = async (transId: string) => {
    setReleasing(transId); setReleaseError('');
    try {
      await api.post(`/api/mpesa/c2b-settings/payments/${encodeURIComponent(transId)}/release`, {});
      setReload((n) => n + 1);
    } catch (e: any) {
      setReleaseError(e?.message ?? 'The payment could not be released');
    } finally {
      setReleasing(null);
    }
  };

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-3" data-testid="mpesa-unmatched">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Payments customers made to the Till number or Paybill that no sale used. Set up under Settings › Business ›
        Integrations › M-Pesa (payment notifications).
      </p>
      {!data.licensed && <p className="text-sm text-amber-600">Payment notifications are part of the ZapTill online licence.</p>}
      {releaseError && <p className="text-sm text-red-500">{releaseError}</p>}
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{data.payments.length} unmatched · {money(data.total, currency)}</p>
      {data.payments.length === 0 ? (
        <p className="text-sm text-gray-500">None — every payment received was put on a sale.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">Paid</th><th className="py-2 pr-3">Amount</th><th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Code</th><th className="py-2 pr-3">Account</th><th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.trans_id} className="border-b border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200">
                  <td className="py-2 pr-3 whitespace-nowrap">{dateTime(p.paid_at)}</td>
                  <td className="py-2 pr-3 font-semibold whitespace-nowrap">{money(p.amount, currency)}</td>
                  <td className="py-2 pr-3">{p.first_name ?? '—'}{p.phone_masked ? <span className="text-gray-400"> · {p.phone_masked}</span> : null}</td>
                  <td className="py-2 pr-3 font-mono">{p.trans_id}</td>
                  <td className="py-2 pr-3">{p.bill_ref ?? '—'}</td>
                  <td className="py-2">
                    {p.status === 'held' ? `Held by a POS${p.held_at ? ` since ${dateTime(p.held_at)}` : ''}` : 'Waiting'}
                    {p.status === 'held' && canRelease && (
                      <button type="button" onClick={() => void release(p.trans_id)} disabled={releasing !== null} data-testid="c2b-release"
                        className="ml-2 text-xs text-swift hover:underline disabled:opacity-40">
                        {releasing === p.trans_id ? 'Releasing…' : 'Release'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
