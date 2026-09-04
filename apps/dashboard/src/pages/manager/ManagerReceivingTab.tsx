/**
 * ManagerReceivingTab — where a branch manager RECEIVES incoming stock.
 *
 * Managers can receive against a delivery but never adjust/edit stock (that stays
 * owner-only — defaultRolePermissions: managers are denied inventory.adjust /
 * ingredients.manage). This tab exposes the receive side they DO hold:
 *   • Incoming transfers (inventory.transfer) — mark a branch-to-branch transfer
 *     that is in transit TO this branch as received. [built here]
 *   • Supplier deliveries / GRN (inventory.receive) — [next slice]
 *
 * Note: the desktop till deliberately has no receive/adjust at all — that is a
 * premium, online-only capability (drives subscription), not a gap.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

interface TransferItem { product_id: string; quantity: number; products?: { name: string } | null }
interface Transfer {
  id: string;
  transfer_number: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  status: 'pending' | 'in_transit' | 'received' | 'cancelled';
  created_at: string;
  stock_transfer_items: TransferItem[];
}

export default function ManagerReceivingTab({ currency }: { currency: string }) {
  void currency;
  const { posApi, session, hasPermission } = usePOSAuth();
  const canTransfer = hasPermission('inventory.transfer');
  const branchId = session?.branchId;

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [busyId, setBusyId]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await posApi.get<Transfer[]>('/api/stock/transfers');
      setTransfers(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load transfers');
    } finally {
      setLoading(false);
    }
  }, [posApi]);
  useEffect(() => { void load(); }, [load]);

  // Only transfers heading to THIS branch that are actually in transit (despatched
  // and en route) — those are the ones a manager can receive. Pending ones haven't
  // left the source yet; received/cancelled are done.
  const incoming = transfers.filter(t => t.to_branch_id === branchId && t.status === 'in_transit');

  const receive = async (t: Transfer) => {
    setBusyId(t.id); setError('');
    try {
      await posApi.patch(`/api/stock/transfers/${t.id}/status`, { status: 'received' });
      setTransfers(prev => prev.filter(x => x.id !== t.id));
    } catch (e: any) {
      setError(e?.message ?? 'Could not receive the transfer');
    } finally {
      setBusyId(null);
    }
  };

  if (!canTransfer) {
    return <p className="text-gray-500 text-sm p-6">You don’t have permission to receive transfers.</p>;
  }

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-white text-lg font-semibold">Receiving</h2>
        <p className="text-gray-500 text-sm">Mark stock arriving at {incoming[0]?.to_branch_name ?? 'your branch'} as received. You can receive stock but not adjust it.</p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Incoming transfers</h3>
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : incoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center">
            <p className="text-gray-500 text-sm">No transfers in transit to your branch. When a transfer is despatched to you, it appears here to receive.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {incoming.map(t => (
              <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{t.transfer_number}</p>
                    <p className="text-gray-500 text-xs">From {t.from_branch_name} · {new Date(t.created_at).toLocaleDateString('en-KE', { dateStyle: 'medium' })}</p>
                  </div>
                  <button
                    onClick={() => void receive(t)}
                    disabled={busyId === t.id}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white transition-colors"
                  >{busyId === t.id ? 'Receiving…' : 'Mark received'}</button>
                </div>
                <div className="mt-3 space-y-1">
                  {t.stock_transfer_items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">{it.products?.name ?? 'Item'}</span>
                      <span className="text-gray-400 tabular-nums">{it.quantity}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Supplier deliveries (GRN) — next slice */}
    </div>
  );
}
