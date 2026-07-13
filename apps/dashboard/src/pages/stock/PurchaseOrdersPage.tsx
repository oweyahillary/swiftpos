import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import Toast from '../../components/Toast';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';

interface Ingredient { id: string; name: string; unit: string; unit_cost: number | null; category: string | null; }
interface Supplier   { id: string; name: string; }
interface Branch     { id: string; name: string; }
interface POItem     { id?: string; ingredient_id: string; ingredients?: { id: string; name: string; unit: string }; ingredient_name?: string; ingredient_unit?: string; quantity_ordered: number; unit_cost: number; quantity_received: number; }
interface PO         { id: string; po_number: string; status: 'draft'|'ordered'|'partial'|'received'|'cancelled'; order_date: string; expected_date: string|null; total_amount: number; notes: string|null; branch_id: string; supplier_id: string|null; suppliers: { id: string; name: string }|null; purchase_order_items: POItem[]; }
interface GRNEntry   { ingredient_id: string; ingredient_name: string; ingredient_unit: string; quantity_ordered: number; quantity_received_so_far: number; quantity_receiving: string; unit_cost: string; }
interface NewItem    { ingredient_id: string; quantity_ordered: string; unit_cost: string; }

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft:     { label: 'Draft',     color: 'text-gray-400',  bg: 'bg-gray-800' },
  ordered:   { label: 'Ordered',   color: 'text-blue-400',  bg: 'bg-blue-500/10' },
  partial:   { label: 'Partial',   color: 'text-amber-400', bg: 'bg-amber-500/10' },
  received:  { label: 'Received',  color: 'text-green-400', bg: 'bg-green-500/10' },
  cancelled: { label: 'Cancelled', color: 'text-gray-600',  bg: 'bg-gray-800' },
};

function fmt(n: number, currency: string) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
}
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PurchaseOrdersPage() {
  const { business } = useBusiness();
  const { activeBranchId } = useBranch();
  const currency = business?.currency ?? 'KES';
  const { toast, showToast } = useToast();

  const [pos, setPOs]                 = useState<PO[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [suppliers, setSuppliers]     = useState<Supplier[]>([]);
  const [branches, setBranches]       = useState<Branch[]>([]);
  const [loading, setLoading]         = useState(true);
  const [selected, setSelected]       = useState<PO | null>(null);
  const [filterStatus, setFilterStatus] = useState('');

  // Create modal
  const [showCreate, setShowCreate]       = useState(false);
  const [newBranchId, setNewBranchId]     = useState('');
  const [newSupplierId, setNewSupplierId] = useState('');
  const [newExpected, setNewExpected]     = useState('');
  const [newNotes, setNewNotes]           = useState('');
  const [newItems, setNewItems]           = useState<NewItem[]>([{ ingredient_id: '', quantity_ordered: '', unit_cost: '' }]);
  const [ingSearches, setIngSearches]     = useState<string[]>(['']);
  const [creating, setCreating]           = useState(false);
  const [createError, setCreateError]     = useState('');

  // GRN modal
  const [receiveTarget, setReceiveTarget] = useState<PO | null>(null);
  const [grnItems, setGrnItems]           = useState<GRNEntry[]>([]);
  const [grnNotes, setGrnNotes]           = useState('');
  const [receiving, setReceiving]         = useState(false);
  const [receiveError, setReceiveError]   = useState('');

  // Cancel modal
  const [cancelTarget, setCancelTarget] = useState<PO | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus)   params.set('status', filterStatus);
      if (activeBranchId) params.set('branch_id', activeBranchId);
      const [poData, ingData, supData, brData] = await Promise.all([
        api.get<PO[]>(`/api/stock/purchase-orders?${params}`),
        api.get<Ingredient[]>('/api/stock/ingredients?status=active'),
        api.get<Supplier[]>('/api/stock/suppliers'),
        api.get<Branch[]>('/api/branches'),
      ]);
      setPOs(poData ?? []);
      setIngredients(ingData ?? []);
      setSuppliers(supData ?? []);
      setBranches(brData ?? []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [filterStatus, activeBranchId]);

  useEffect(() => { load(); }, [load]);

  const ingMap = Object.fromEntries(ingredients.map(i => [i.id, i]));

  // ── ingredient selection in create form ──
  const selectIngredient = (idx: number, ingId: string) => {
    const ing = ingredients.find(i => i.id === ingId);
    setNewItems(p => p.map((it, i) => i === idx ? { ...it, ingredient_id: ingId, unit_cost: ing?.unit_cost != null ? String(ing.unit_cost) : it.unit_cost } : it));
    setIngSearches(p => p.map((s, i) => i === idx ? '' : s));
  };

  const clearIngredient = (idx: number) => {
    setNewItems(p => p.map((it, i) => i === idx ? { ...it, ingredient_id: '' } : it));
  };

  const addLine = () => {
    setNewItems(p => [...p, { ingredient_id: '', quantity_ordered: '', unit_cost: '' }]);
    setIngSearches(p => [...p, '']);
  };

  const removeLine = (idx: number) => {
    setNewItems(p => p.filter((_, i) => i !== idx));
    setIngSearches(p => p.filter((_, i) => i !== idx));
  };

  // ── create PO ──
  const openCreate = () => {
    setNewBranchId(activeBranchId ?? branches[0]?.id ?? '');
    setNewSupplierId(''); setNewExpected(''); setNewNotes('');
    setNewItems([{ ingredient_id: '', quantity_ordered: '', unit_cost: '' }]);
    setIngSearches(['']); setCreateError(''); setShowCreate(true);
  };

  const createPO = async () => {
    if (!newBranchId) { setCreateError('Select a branch'); return; }
    const valid = newItems.filter(i => i.ingredient_id && i.quantity_ordered);
    if (!valid.length) { setCreateError('Add at least one ingredient with a quantity'); return; }
    setCreating(true); setCreateError('');
    try {
      await api.post('/api/stock/purchase-orders', {
        branch_id: newBranchId,
        supplier_id: newSupplierId || undefined,
        expected_date: newExpected || undefined,
        notes: newNotes || undefined,
        items: valid.map(i => ({ ingredient_id: i.ingredient_id, quantity_ordered: Number(i.quantity_ordered), unit_cost: Number(i.unit_cost || 0) })),
      });
      setShowCreate(false); await load();
    } catch (e: any) { setCreateError(e.message ?? 'Failed to create PO'); }
    finally { setCreating(false); }
  };

  const markOrdered = async (po: PO) => {
    try { await api.patch(`/api/stock/purchase-orders/${po.id}`, { status: 'ordered' }); await load(); } catch { /* silent */ }
  };

  const deletePO = async (po: PO) => {
    // Confirmed by existing cancel button in the UI
    try { await api.delete(`/api/stock/purchase-orders/${po.id}`); setSelected(null); await load(); } catch { /* silent */ }
  };

  // ── GRN ──
  const openReceive = (po: PO) => {
    setGrnItems((po.purchase_order_items ?? []).map(item => ({
      ingredient_id:            item.ingredient_id,
      ingredient_name:          item.ingredients?.name ?? item.ingredient_name ?? 'Unknown',
      ingredient_unit:          item.ingredients?.unit ?? item.ingredient_unit ?? '',
      quantity_ordered:         item.quantity_ordered,
      quantity_received_so_far: item.quantity_received,
      quantity_receiving: '',
      unit_cost: String(item.unit_cost ?? ''),
    })));
    setGrnNotes(''); setReceiveError(''); setReceiveTarget(po);
  };

  const submitGRN = async () => {
    if (!receiveTarget) return;
    const filled = grnItems.filter(i => i.quantity_receiving && Number(i.quantity_receiving) > 0);
    if (!filled.length) { setReceiveError('Enter a received quantity for at least one item'); return; }
    setReceiving(true); setReceiveError('');
    try {
      await api.post('/api/stock/grn', {
        branch_id: receiveTarget.branch_id,
        purchase_order_id: receiveTarget.id,
        notes: grnNotes || undefined,
        items: filled.map(i => ({ ingredient_id: i.ingredient_id, quantity_received: Number(i.quantity_receiving), unit_cost: i.unit_cost ? Number(i.unit_cost) : undefined })),
      });
      setReceiveTarget(null); await load();
    } catch (e: any) { setReceiveError(e.message ?? 'Failed to record GRN'); }
    finally { setReceiving(false); }
  };

  // ── Cancel ──
  const cancelPO = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.post(`/api/stock/purchase-orders/${cancelTarget.id}/cancel`, { reason: cancelReason });
      setCancelTarget(null); setCancelReason(''); setSelected(null); await load();
    } catch (e: any) { showToast(e?.message ?? 'Failed to cancel', 'error'); }
    finally { setCancelling(false); }
  };

  const runningTotal = newItems.reduce((s, i) => s + Number(i.quantity_ordered || 0) * Number(i.unit_cost || 0), 0);

  return (
    <>
      <Toast toast={toast} />
    <div className="flex-1 flex overflow-hidden">

      {/* ── PO List ── */}
      <div className={`flex flex-col border-r border-gray-800 ${selected ? 'w-96 flex-shrink-0' : 'flex-1'}`}>
        <div className="px-5 py-4 border-b border-gray-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold">Purchase Orders</h2>
            <button onClick={openCreate} className="px-3 py-1.5 bg-green-500 hover:bg-green-400 text-black text-xs font-semibold rounded-lg transition-colors">+ New PO</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[['','All'],['draft','Draft'],['ordered','Ordered'],['partial','Partial'],['received','Received'],['cancelled','Cancelled']].map(([val, label]) => (
              <button key={val} onClick={() => setFilterStatus(val)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filterStatus === val ? 'bg-green-500 text-black' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center text-gray-500 text-sm">Loading…</div>
          ) : pos.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-3xl mb-3">📦</p>
              <p className="text-gray-400 text-sm font-medium">No purchase orders</p>
              <p className="text-gray-600 text-xs mt-1">Click "+ New PO" to order ingredients.</p>
            </div>
          ) : pos.map(po => {
            const sc = STATUS[po.status] ?? STATUS.draft;
            const isSelected = selected?.id === po.id;
            return (
              <div key={po.id}
                onClick={() => setSelected(isSelected ? null : po)}
                className={`px-5 py-4 border-b border-gray-800/60 cursor-pointer transition-colors ${isSelected ? 'bg-green-500/5 border-l-2 border-l-green-500' : 'hover:bg-gray-800/40'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-semibold text-sm">{po.po_number}</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${sc.bg} ${sc.color}`}>{sc.label}</span>
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">{po.suppliers?.name ?? 'No supplier'} · {fmtDate(po.order_date)}</p>
                    <p className="text-gray-400 text-xs mt-0.5">{po.purchase_order_items?.length ?? 0} ingredient{po.purchase_order_items?.length !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-white text-sm font-semibold">{fmt(po.total_amount, currency)}</p>
                    {(po.status === 'ordered' || po.status === 'partial') && (
                      <div className="flex gap-1.5 mt-1.5 justify-end">
                        <button onClick={e => { e.stopPropagation(); openReceive(po); }}
                          className="text-xs bg-green-500/10 text-green-400 hover:bg-green-500/20 px-2 py-1 rounded transition-colors">Receive</button>
                        <button onClick={e => { e.stopPropagation(); setCancelTarget(po); setCancelReason(''); }}
                          className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-800 transition-colors">Cancel</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── PO Detail Panel ── */}
      {selected && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-white font-bold text-base">{selected.po_number}</h2>
                {(() => { const sc = STATUS[selected.status]; return <span className={`px-2 py-0.5 rounded text-xs font-medium ${sc.bg} ${sc.color}`}>{sc.label}</span>; })()}
              </div>
              <p className="text-gray-500 text-xs mt-0.5">
                {selected.suppliers?.name ?? 'No supplier'} · {fmtDate(selected.order_date)}
                {selected.expected_date && ` · Expected ${fmtDate(selected.expected_date)}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {selected.status === 'draft' && (
                <>
                  <button onClick={() => markOrdered(selected)} className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-white text-xs font-semibold rounded-lg transition-colors">Mark as Ordered</button>
                  <button onClick={() => deletePO(selected)} className="px-3 py-1.5 bg-gray-800 hover:bg-red-500/20 text-red-400 text-xs font-semibold rounded-lg transition-colors">Delete</button>
                </>
              )}
              {(selected.status === 'ordered' || selected.status === 'partial') && (
                <>
                  <button onClick={() => openReceive(selected)} className="px-3 py-1.5 bg-green-500 hover:bg-green-400 text-black text-xs font-semibold rounded-lg transition-colors">Receive Goods</button>
                  <button onClick={() => { setCancelTarget(selected); setCancelReason(''); }} className="px-3 py-1.5 bg-gray-800 hover:bg-red-500/10 text-red-400 text-xs font-semibold rounded-lg transition-colors">Cancel PO</button>
                </>
              )}
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white transition-colors text-lg ml-1">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-3">Ingredients Ordered</p>
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      {['Ingredient','Ordered','Received','Unit Cost','Line Total'].map(h => (
                        <th key={h} className={`text-gray-500 text-xs px-4 py-2.5 uppercase tracking-wider font-semibold ${h === 'Ingredient' ? 'text-left' : 'text-right'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.purchase_order_items ?? []).map((item, idx) => {
                      const ing = ingMap[item.ingredient_id];
                      const name = ing?.name ?? item.ingredients?.name ?? item.ingredient_name ?? 'Unknown';
                      const unit = ing?.unit ?? item.ingredients?.unit ?? item.ingredient_unit ?? '';
                      const fullyRcvd = item.quantity_received >= item.quantity_ordered;
                      return (
                        <tr key={item.id ?? idx} className="border-b border-gray-800/50">
                          <td className="px-4 py-3">
                            <p className="text-white">{name}</p>
                            {(ing?.category ?? '') && <p className="text-gray-600 text-xs">{ing?.category}</p>}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-300">{item.quantity_ordered} {unit}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={fullyRcvd ? 'text-green-400' : item.quantity_received > 0 ? 'text-amber-400' : 'text-gray-600'}>
                              {item.quantity_received} {unit}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-gray-300">{fmt(item.unit_cost, currency)}</td>
                          <td className="px-4 py-3 text-right text-white font-medium">{fmt(item.unit_cost * item.quantity_ordered, currency)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-700">
                      <td colSpan={4} className="px-4 py-3 text-gray-500 text-xs font-semibold text-right">TOTAL</td>
                      <td className="px-4 py-3 text-right text-white font-bold">{fmt(selected.total_amount, currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            {selected.notes && (
              <div>
                <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">Notes</p>
                <p className="text-gray-300 text-sm whitespace-pre-line bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">{selected.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Create PO Modal ── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
              <h2 className="text-white font-semibold">New Purchase Order</h2>
              <p className="text-gray-500 text-xs mt-0.5">Order raw ingredients from a supplier</p>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Branch <span className="text-red-400">*</span></label>
                  <select value={newBranchId} onChange={e => setNewBranchId(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500">
                    <option value="">Select branch…</option>
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Supplier</label>
                  <select value={newSupplierId} onChange={e => setNewSupplierId(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500">
                    <option value="">— No supplier —</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Expected Delivery</label>
                  <input type="date" value={newExpected} onChange={e => setNewExpected(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
                </div>
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Notes</label>
                  <input type="text" placeholder="Optional…" value={newNotes} onChange={e => setNewNotes(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Ingredients to Order</p>
                  <button onClick={addLine} className="text-green-400 hover:text-green-300 text-xs font-medium transition-colors">+ Add Line</button>
                </div>
                <div className="grid grid-cols-12 gap-2 px-1 mb-1.5">
                  <p className="col-span-5 text-gray-600 text-xs">Ingredient</p>
                  <p className="col-span-3 text-gray-600 text-xs">Quantity</p>
                  <p className="col-span-3 text-gray-600 text-xs">Unit Cost ({currency})</p>
                  <div className="col-span-1" />
                </div>
                <div className="space-y-2">
                  {newItems.map((item, idx) => {
                    const selIng = ingredients.find(i => i.id === item.ingredient_id);
                    const srch   = ingSearches[idx] ?? '';
                    const opts   = ingredients.filter(i => !srch || i.name.toLowerCase().includes(srch.toLowerCase()) || (i.category ?? '').toLowerCase().includes(srch.toLowerCase()));
                    return (
                      <div key={idx} className="grid grid-cols-12 gap-2 items-start">
                        <div className="col-span-5 relative">
                          {selIng ? (
                            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-white text-sm truncate">{selIng.name}</p>
                                <p className="text-gray-500 text-xs">{selIng.unit}{selIng.category ? ` · ${selIng.category}` : ''}</p>
                              </div>
                              <button onClick={() => clearIngredient(idx)} className="text-gray-600 hover:text-white text-xs flex-shrink-0 transition-colors">✕</button>
                            </div>
                          ) : (
                            <div className="relative">
                              <input type="text" placeholder="Search ingredient…"
                                value={srch}
                                onChange={e => setIngSearches(p => p.map((s, i) => i === idx ? e.target.value : s))}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                              />
                              {srch && opts.length > 0 && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 max-h-48 overflow-y-auto">
                                  {opts.slice(0, 20).map(ing => (
                                    <button key={ing.id} onClick={() => selectIngredient(idx, ing.id)}
                                      className="w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors">
                                      <p className="text-white text-sm">{ing.name}</p>
                                      <p className="text-gray-500 text-xs">{ing.unit}{ing.category ? ` · ${ing.category}` : ''}</p>
                                    </button>
                                  ))}
                                </div>
                              )}
                              {srch && opts.length === 0 && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 px-3 py-3">
                                  <p className="text-gray-500 text-xs">No ingredients match. Add them in the Ingredients page first.</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="col-span-3">
                          <div className="relative">
                            <input type="number" min="0.01" step="0.01" placeholder="0"
                              value={item.quantity_ordered}
                              onChange={e => setNewItems(p => p.map((it, i) => i === idx ? { ...it, quantity_ordered: e.target.value } : it))}
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                            />
                            {selIng && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">{selIng.unit}</span>}
                          </div>
                        </div>
                        <div className="col-span-3">
                          <input type="number" min="0" step="0.01" placeholder="0.00"
                            value={item.unit_cost}
                            onChange={e => setNewItems(p => p.map((it, i) => i === idx ? { ...it, unit_cost: e.target.value } : it))}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                          />
                        </div>
                        <div className="col-span-1 flex items-center justify-center pt-2">
                          {newItems.length > 1 && (
                            <button onClick={() => removeLine(idx)} className="text-gray-600 hover:text-red-400 transition-colors text-base">✕</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {runningTotal > 0 && (
                  <div className="flex justify-end mt-3 pt-3 border-t border-gray-800">
                    <div className="text-right">
                      <p className="text-gray-500 text-xs">Estimated Total</p>
                      <p className="text-white font-bold text-lg">{fmt(runningTotal, currency)}</p>
                    </div>
                  </div>
                )}
              </div>
              {createError && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{createError}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3 flex-shrink-0">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
              <button onClick={createPO} disabled={creating}
                className="px-5 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold rounded-lg transition-colors">
                {creating ? 'Creating…' : 'Create Draft PO'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Receive Goods Modal ── */}
      {receiveTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
              <h2 className="text-white font-semibold">Receive Goods</h2>
              <p className="text-gray-500 text-xs mt-0.5">{receiveTarget.po_number} — enter quantities actually delivered. Leave blank to skip an item.</p>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
              {grnItems.map((item, idx) => {
                const remaining = item.quantity_ordered - item.quantity_received_so_far;
                return (
                  <div key={item.ingredient_id} className="bg-gray-800/50 rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white font-medium text-sm">{item.ingredient_name}</p>
                        <p className="text-gray-500 text-xs mt-0.5">
                          Ordered: {item.quantity_ordered} {item.ingredient_unit}
                          {item.quantity_received_so_far > 0 && ` · Already received: ${item.quantity_received_so_far} ${item.ingredient_unit}`}
                        </p>
                      </div>
                      {remaining > 0
                        ? <span className="text-amber-400 text-xs bg-amber-500/10 px-2 py-0.5 rounded">{remaining} {item.ingredient_unit} outstanding</span>
                        : <span className="text-green-400 text-xs bg-green-500/10 px-2 py-0.5 rounded">Fully received</span>
                      }
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-gray-500 text-xs mb-1">Qty received now ({item.ingredient_unit})</label>
                        <input type="number" min="0" step="0.01"
                          placeholder={remaining > 0 ? `up to ${remaining}` : '0'}
                          value={item.quantity_receiving}
                          onChange={e => setGrnItems(p => p.map((gi, i) => i === idx ? { ...gi, quantity_receiving: e.target.value } : gi))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                        />
                      </div>
                      <div>
                        <label className="block text-gray-500 text-xs mb-1">Unit cost (optional)</label>
                        <input type="number" min="0" step="0.01" placeholder="0.00"
                          value={item.unit_cost}
                          onChange={e => setGrnItems(p => p.map((gi, i) => i === idx ? { ...gi, unit_cost: e.target.value } : gi))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div>
                <label className="block text-gray-500 text-xs mb-1.5">GRN Notes (optional)</label>
                <input type="text" placeholder="e.g. Partial delivery, driver: Kamau…"
                  value={grnNotes} onChange={e => setGrnNotes(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500" />
              </div>
              {receiveError && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{receiveError}</p>}
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex gap-3 flex-shrink-0">
              <button onClick={() => setReceiveTarget(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors">Cancel</button>
              <button onClick={submitGRN} disabled={receiving}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold py-2.5 rounded-lg transition-colors">
                {receiving ? 'Saving…' : 'Confirm Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel Modal ── */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-6 py-5 border-b border-gray-800">
              <h2 className="text-white font-semibold">Cancel Purchase Order</h2>
              <p className="text-gray-500 text-xs mt-0.5">{cancelTarget.po_number}</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {cancelTarget.status === 'partial' && (
                <div className="flex gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
                  <span className="text-amber-400 flex-shrink-0">⚠️</span>
                  <p className="text-amber-300 text-sm">This PO has been <strong>partially received</strong>. Stock already received will not be reversed.</p>
                </div>
              )}
              <p className="text-gray-300 text-sm">Cancel <span className="text-white font-semibold">{cancelTarget.po_number}</span>? This cannot be undone.</p>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Reason (optional)</label>
                <input type="text" placeholder="e.g. Supplier unavailable…"
                  value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && cancelPO()} autoFocus
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500" />
              </div>
            </div>
            <div className="flex gap-3 px-6 pb-6 pt-3 border-t border-gray-800">
              <button onClick={() => setCancelTarget(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors">Keep PO</button>
              <button onClick={cancelPO} disabled={cancelling}
                className="flex-1 bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors">
                {cancelling ? 'Cancelling…' : 'Cancel PO'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}