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
// A218 stock picker: /api/inventory rows (per-branch stock joined with product).
interface InvRow { product_id: string; quantity: number; products?: { name: string } | null }
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

  const [target, setTarget]     = useState<PO | null>(null);
  const [lines, setLines]       = useState<Record<string, string>>({});
  const [grnBusy, setGrnBusy]   = useState(false);
  const [grnError, setGrnError] = useState('');

  // A221: transfer receipt — the recipient keys what actually arrived per line
  // (default = sent, editable down to 0), plus a note. Sent stays as the record.
  const [rxTarget, setRxTarget] = useState<Transfer | null>(null);
  const [rxLines, setRxLines]   = useState<Record<string, string>>({});
  const [rxNote, setRxNote]     = useState('');
  const [rxBusy, setRxBusy]     = useState(false);
  const [rxError, setRxError]   = useState('');

  // A218: manager initiates a transfer FROM their own branch to another branch.
  const [branchList, setBranchList] = useState<{ id: string; name: string }[]>([]);
  const [stockList, setStockList]   = useState<{ id: string; name: string; stock: number }[]>([]);
  const [showNew, setShowNew]       = useState(false);
  const [destId, setDestId]         = useState('');
  const [sendQty, setSendQty]       = useState<Record<string, string>>({});
  const [search, setSearch]         = useState('');
  const [sendBusy, setSendBusy]     = useState(false);
  const [sendError, setSendError]   = useState('');
  const [despatchBusy, setDespatchBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [t, p, br, pr] = await Promise.all([
        canTransfer ? posApi.get<Transfer[]>('/api/stock/transfers') : Promise.resolve([] as Transfer[]),
        canReceive  ? posApi.get<PO[]>(`/api/stock/purchase-orders${branchId ? `?branch_id=${branchId}` : ''}`) : Promise.resolve([] as PO[]),
        canTransfer ? posApi.get<{ id: string; name: string }[]>('/api/branches') : Promise.resolve([] as { id: string; name: string }[]),
        canTransfer ? posApi.get<InvRow[]>(`/api/inventory${branchId ? `?branch_id=${branchId}` : ''}`) : Promise.resolve([] as InvRow[]),
      ]);
      setTransfers(Array.isArray(t) ? t : []);
      setPos(Array.isArray(p) ? p : []);
      setBranchList(Array.isArray(br) ? br.filter(b => b.id !== branchId) : []);
      setStockList(Array.isArray(pr)
        ? pr.map(r => ({ id: r.product_id, name: r.products?.name ?? 'Item', stock: Number(r.quantity) || 0 }))
        : []);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load receiving');
    } finally {
      setLoading(false);
    }
  }, [posApi, branchId, canTransfer, canReceive]);
  useEffect(() => { void load(); }, [load]);

  const incoming = transfers.filter(t => t.to_branch_id === branchId && t.status === 'in_transit');
  const outgoing = transfers.filter(t => t.from_branch_id === branchId && (t.status === 'pending' || t.status === 'in_transit'));
  const openPOs  = pos.filter(p => p.status === 'ordered' || p.status === 'partial');

  const createTransfer = async () => {
    if (!destId) { setSendError('Choose a destination branch.'); return; }
    const items = stockList
      .map(p => ({ product_id: p.id, quantity: Number(sendQty[p.id] || 0), stock: p.stock, name: p.name }))
      .filter(i => i.quantity > 0);
    if (!items.length) { setSendError('Enter a quantity for at least one product.'); return; }
    const over = items.find(i => i.quantity > i.stock);
    if (over) { setSendError(`${over.name}: only ${over.stock} in stock at your branch.`); return; }
    setSendBusy(true); setSendError('');
    try {
      await posApi.post('/api/stock/transfers', {
        from_branch_id: branchId, to_branch_id: destId,
        items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
      });
      setShowNew(false); setDestId(''); setSendQty({}); setSearch('');
      await load();
    } catch (e: any) {
      setSendError(e?.message ?? 'Could not create the transfer');
    } finally { setSendBusy(false); }
  };

  const despatchTransfer = async (t: Transfer) => {
    setDespatchBusy(t.id); setError('');
    try {
      await posApi.patch(`/api/stock/transfers/${t.id}/status`, { status: 'in_transit' });
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not despatch the transfer');
    } finally { setDespatchBusy(null); }
  };

  const openTransfer = (t: Transfer) => {
    const seed: Record<string, string> = {};
    t.stock_transfer_items.forEach(it => { seed[it.product_id] = String(it.quantity); });
    setRxLines(seed); setRxNote(''); setRxError(''); setRxTarget(t);
  };

  const submitTransfer = async () => {
    if (!rxTarget) return;
    // Validate each received line is 0..sent before sending; the server enforces
    // the same, this is just a faster, clearer message.
    for (const it of rxTarget.stock_transfer_items) {
      const got = Number(rxLines[it.product_id]);
      if (!Number.isFinite(got) || got < 0 || got > Number(it.quantity)) {
        setRxError(`${it.products?.name ?? 'An item'}: received must be between 0 and ${it.quantity} (sent).`);
        return;
      }
    }
    const received_items = rxTarget.stock_transfer_items.map(it => ({
      product_id: it.product_id, quantity_received: Number(rxLines[it.product_id] || 0),
    }));
    setRxBusy(true); setRxError('');
    try {
      await posApi.patch(`/api/stock/transfers/${rxTarget.id}/status`, {
        status: 'received', received_items, receipt_note: rxNote.trim() || undefined,
      });
      setTransfers(prev => prev.filter(x => x.id !== rxTarget.id));
      setRxTarget(null);
    } catch (e: any) {
      setRxError(e?.message ?? 'Could not receive the transfer');
    } finally { setRxBusy(false); }
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
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Send stock to another branch</h3>
            <button onClick={() => { setShowNew(v => !v); setSendError(''); }}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
              {showNew ? 'Close' : 'New transfer'}
            </button>
          </div>

          {showNew && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 space-y-3">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">From</span>
                <span className="text-sm text-gray-300">{session?.branchName} <span className="text-gray-600">(your branch)</span></span>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">To</label>
                <select value={destId} onChange={e => setDestId(e.target.value)}
                  className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500">
                  <option value="">Choose a branch…</option>
                  {branchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {branchList.length === 0 && <p className="text-gray-600 text-xs">No other branches to transfer to.</p>}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Items</label>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
                  className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm mb-1 focus:outline-none focus:border-blue-500" />
                <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                  {stockList
                    .filter(p => p.name.toLowerCase().includes(search.trim().toLowerCase()))
                    .map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-gray-300 truncate">
                          {p.name}
                          <span className={`ml-2 text-xs ${p.stock <= 0 ? 'text-red-400' : 'text-gray-500'}`}>in stock: {p.stock}</span>
                        </span>
                        <input type="number" min={0} max={p.stock} step="any" value={sendQty[p.id] ?? ''}
                          onChange={e => setSendQty(prev => ({ ...prev, [p.id]: e.target.value }))}
                          placeholder="0" disabled={p.stock <= 0}
                          className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm text-right disabled:opacity-40 focus:outline-none focus:border-blue-500" />
                      </div>
                    ))}
                </div>
              </div>
              {sendError && <p className="text-red-400 text-xs">{sendError}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowNew(false); setSendError(''); }} disabled={sendBusy}
                  className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-white disabled:opacity-40 transition-colors">Cancel</button>
                <button onClick={() => void createTransfer()} disabled={sendBusy}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white transition-colors">
                  {sendBusy ? 'Creating…' : 'Create transfer'}
                </button>
              </div>
            </div>
          )}

          {outgoing.length > 0 && (
            <div className="space-y-2 mb-4">
              {outgoing.map(t => (
                <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{t.transfer_number} → {t.to_branch_name}</p>
                    <p className="text-gray-500 text-xs">
                      {t.stock_transfer_items.length} item(s) · {t.status === 'pending' ? 'not yet despatched' : 'in transit — awaiting receipt'}
                    </p>
                  </div>
                  {t.status === 'pending' && (
                    <button onClick={() => void despatchTransfer(t)} disabled={despatchBusy === t.id}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white transition-colors">
                      {despatchBusy === t.id ? 'Despatching…' : 'Despatch'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
                {incoming.map(t => {
                  const editing = rxTarget?.id === t.id;
                  return (
                  <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{t.transfer_number}</p>
                        <p className="text-gray-500 text-xs">From {t.from_branch_name}</p>
                      </div>
                      {!editing && (
                        <button onClick={() => openTransfer(t)}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors">
                          Receive
                        </button>
                      )}
                    </div>

                    {!editing ? (
                      <div className="mt-3 space-y-1">
                        {t.stock_transfer_items.map((it, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-gray-300">{it.products?.name ?? 'Item'}</span>
                            <span className="text-gray-400 tabular-nums">sent {it.quantity}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center text-[10px] uppercase tracking-wider text-gray-600">
                          <span>Item</span><span className="text-right">Sent</span><span className="text-right pr-1">Received</span>
                        </div>
                        {t.stock_transfer_items.map((it, i) => (
                          <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-center text-sm">
                            <span className="text-gray-300">{it.products?.name ?? 'Item'}</span>
                            <span className="text-gray-400 tabular-nums text-right w-14">{it.quantity}</span>
                            <input
                              type="number" min={0} max={it.quantity} step="any"
                              value={rxLines[it.product_id] ?? ''}
                              onChange={e => setRxLines(prev => ({ ...prev, [it.product_id]: e.target.value }))}
                              className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm text-right focus:outline-none focus:border-green-500" />
                          </div>
                        ))}
                        <textarea
                          value={rxNote} onChange={e => setRxNote(e.target.value)}
                          placeholder="Note (optional) — e.g. 2 units short, one carton damaged in transit"
                          rows={2}
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-green-500" />
                        {rxError && <p className="text-red-400 text-xs">{rxError}</p>}
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setRxTarget(null)} disabled={rxBusy}
                            className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-white disabled:opacity-40 transition-colors">
                            Cancel
                          </button>
                          <button onClick={() => void submitTransfer()} disabled={rxBusy}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white transition-colors">
                            {rxBusy ? 'Receiving…' : 'Confirm received'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
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
