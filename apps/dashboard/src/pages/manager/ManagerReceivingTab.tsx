/**
 * ManagerReceivingTab — where a branch manager RECEIVES incoming stock.
 *
 * Managers can receive against a delivery but never adjust/edit stock (that stays
 * owner-only — defaultRolePermissions denies inventory.adjust / ingredients.manage).
 * This tab exposes the receive side they DO hold:
 *   • Incoming transfers  (inventory.transfer) — mark a branch-to-branch transfer
 *     in transit TO this branch as received.
 *   • Supplier deliveries (inventory.receive)  — receive against an open purchase
 *     order via a GRN (goods received note), entering the quantity that arrived.
 * Every mutation here is a RECEIVE (transfer /status or /grn) — there is no
 * adjust/set/threshold path.
 *
 * Note: the desktop till deliberately has no receive/adjust at all — a premium,
 * online-only capability (drives subscription), not a gap.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

interface TransferItem { product_id: string; quantity: number; products?: { name: string } | null }
interface Transfer {
  id: string; transfer_number: string;
  from_branch_id: string; from_branch_name: string;
  to_branch_id: string; to_branch_name: string;
  status: 'pending' | 'in_transit' | 'received' | 'cancelled';
  created_at: string; stock_transfer_items: TransferItem[];
}

interface POItem { id?: string; ingredient_id: string; ingredients?: { name: string; unit: string } | null; quantity_ordered: number; quantity_received: number; unit_cost: number }
interface PO {
  id: string; po_number: string;
  status: 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';
  branch_id: string; suppliers: { id: string; name: string } | null;
  purchase_order_items: POItem[];
}

export default function ManagerReceivingTab({ currency }: { currency: string }) {
  void currency;
  const { posApi, session, hasPermission } = usePOSAuth();
  const canTransfer = hasPermission('inventory.transfer');
  const canReceive  = hasPermission('inventory.receive');
  const branchId = session?.branchId;

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [pos, setPos]             = useState<PO[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [busyId, setBusyId]       = useState<string | null>(null);

  const [target, setTarget]     = useState<PO | null>(null);
  const [lines, setLines]       = useState<Record<string, string>>({});
  const [grnBusy, setGrnBusy]   = useState(false);
  const [grnError, setGrnError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [t, p] = await Promise.all([
        canTransfer ? posApi.get<Transfer[]>('/api/stock/transfers') : Promise.resolve([] as Transfer[]),
        canReceive  ? posApi.get<PO[]>(`/api/stock/purchase-orders${branchId ? `?branch_id=${branchId}` : ''}`) : Promise.resolve([] as PO[]),
      ]);
      setTransfers(Array.isArray(t) ? t : []);
      setPos(Array.isArray(p) ? p : []);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load receiving');
    } finally {
      setLoading(false);
    }
  }, [posApi, branchId, canTransfer, canReceive]);
  useEffect(() => { void load(); }, [load]);

  const incoming = transfers.filter(t => t.to_branch_id === branchId && t.status === 'in_transit');
  const openPOs  = pos.filter(p => p.status === 'ordered' || p.status === 'partial');

  const receiveTransfer = async (t: Transfer) => {
    setBusyId(t.id); setError('');
    try {
      await posApi.patch(`/api/stock/transfers/${t.id}/status`, { status: 'received' });
      setTransfers(prev => prev.filter(x => x.id !== t.id));
    } catch (e: any) {
      setError(e?.message ?? 'Could not receive the transfer');
    } finally { setBusyId(null); }
  };

  const openDelivery = (po: PO) => {
    const seed: Record<string, string> = {};
    po.purchase_order_items.forEach(i => {
      const remaining = Number(i.quantity_ordered) - Number(i.quantity_received);
      seed[i.ingredient_id] = remaining > 0 ? String(remaining) : '';
    });
    setLines(seed); setGrnError(''); setTarget(po);
  };

  const submitDelivery = async () => {
    if (!target) return;
    const items = target.purchase_order_items
      .map(i => ({ ingredient_id: i.ingredient_id, quantity_received: Number(lines[i.ingredient_id] || 0), unit_cost: Number(i.unit_cost) }))
      .filter(i => i.quantity_received > 0);
    if (!items.length) { setGrnError('Enter a received quantity for at least one item'); return; }
    setGrnBusy(true); setGrnError('');
    try {
      await posApi.post('/api/stock/grn', { branch_id: branchId, purchase_order_id: target.id, items });
      setTarget(null);
      await load();
    } catch (e: any) {
      setGrnError(e?.message ?? 'Could not record the delivery');
    } finally { setGrnBusy(false); }
  };

  if (!canTransfer && !canReceive) {
    return <p className="text-gray-500 text-sm p-6">You don’t have permission to receive stock.</p>;
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-white text-lg font-semibold">Receiving</h2>
        <p className="text-gray-500 text-sm">Mark stock arriving at your branch as received. You can receive stock but not adjust it.</p>
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {canTransfer && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Incoming transfers</h3>
          {loading ? <p className="text-gray-500 text-sm">Loading…</p>
            : incoming.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-800 p-6 text-center">
                <p className="text-gray-500 text-sm">No transfers in transit to your branch.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {incoming.map(t => (
                  <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{t.transfer_number}</p>
                        <p className="text-gray-500 text-xs">From {t.from_branch_name}</p>
                      </div>
                      <button onClick={() => void receiveTransfer(t)} disabled={busyId === t.id}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white transition-colors">
                        {busyId === t.id ? 'Receiving…' : 'Mark received'}
                      </button>
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
      )}

      {canReceive && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Supplier deliveries</h3>
          {loading ? <p className="text-gray-500 text-sm">Loading…</p>
            : openPOs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-800 p-6 text-center">
                <p className="text-gray-500 text-sm">No open purchase orders awaiting delivery.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {openPOs.map(po => (
                  <div key={po.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <p className="text-white text-sm font-medium">{po.po_number}</p>
                      <p className="text-gray-500 text-xs">{po.suppliers?.name ?? 'Supplier'} · {po.purchase_order_items.length} item(s){po.status === 'partial' ? ' · partially received' : ''}</p>
                    </div>
                    <button onClick={() => openDelivery(po)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors">
                      Receive delivery
                    </button>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {target && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto">
            <h3 className="text-white font-semibold">Receive {target.po_number}</h3>
            <p className="text-gray-500 text-xs mb-4">{target.suppliers?.name ?? 'Supplier'} — enter what actually arrived.</p>
            {grnError && <p className="text-red-400 text-sm mb-3">{grnError}</p>}
            <div className="space-y-2">
              {target.purchase_order_items.map(i => {
                const remaining = Number(i.quantity_ordered) - Number(i.quantity_received);
                return (
                  <div key={i.ingredient_id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-gray-200 text-sm truncate">{i.ingredients?.name ?? 'Item'}</p>
                      <p className="text-gray-500 text-xs">ordered {i.quantity_ordered}{i.ingredients?.unit ? ` ${i.ingredients.unit}` : ''} · received {i.quantity_received} · remaining {remaining > 0 ? remaining : 0}</p>
                    </div>
                    <input inputMode="decimal" value={lines[i.ingredient_id] ?? ''}
                      onChange={e => setLines(prev => ({ ...prev, [i.ingredient_id]: e.target.value }))}
                      className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-green-500" />
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setTarget(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2.5 rounded-lg transition-colors">Cancel</button>
              <button onClick={() => void submitDelivery()} disabled={grnBusy}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black font-semibold text-sm py-2.5 rounded-lg transition-colors">
                {grnBusy ? 'Receiving…' : 'Confirm received'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
