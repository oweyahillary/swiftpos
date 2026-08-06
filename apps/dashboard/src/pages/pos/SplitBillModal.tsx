/**
 * SplitBillModal — divide a dine-in check two ways:
 *   • Even split: divide the total into N equal shares (with remainder handling).
 *   • By item: assign each line to a numbered sub-bill; shows each sub-bill total.
 *
 * For by-item, the assignment is persisted via PATCH /api/orders/:id/split so the
 * kitchen/records reflect it. Even split is informational (amounts to collect)
 * and doesn't need persistence.
 */

import { useState } from 'react';
import { api } from '../../lib/api';

export interface SplitItem {
  id: string;          // order_item_id
  name: string;
  quantity: number;
  subtotal: number;
  sub_bill?: number | null;
}

interface Props {
  orderId: string;
  items: SplitItem[];
  total: number;
  currency: string;
  onClose: () => void;
  onSaved?: () => void;
}

function fmt(n: number) {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function SplitBillModal({ orderId, items, total, currency, onClose, onSaved }: Props) {
  const [mode, setMode] = useState<'even' | 'item'>('even');

  // Even split
  const [people, setPeople] = useState(2);
  const share = people > 0 ? Math.floor((total / people) * 100) / 100 : total;
  const remainder = Math.round((total - share * people) * 100) / 100; // goes onto bill 1

  // By item
  const [assign, setAssign] = useState<Record<string, number>>(
    Object.fromEntries(items.map(i => [i.id, i.sub_bill ?? 1])),
  );
  const [numBills, setNumBills] = useState(
    Math.max(2, ...items.map(i => i.sub_bill ?? 1)),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const billTotals: Record<number, number> = {};
  items.forEach(i => { const b = assign[i.id] ?? 1; billTotals[b] = (billTotals[b] ?? 0) + Number(i.subtotal); });

  const saveItemSplit = async () => {
    setSaving(true); setMsg(null);
    try {
      await api.patch(`/api/orders/${orderId}/split`, {
        assignments: items.map(i => ({ order_item_id: i.id, sub_bill: assign[i.id] ?? 1 })),
      });
      setMsg('Split saved');
      onSaved?.();
    } catch (e: any) {
      setMsg(e?.message ?? 'Failed to save split');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Split bill — {currency} {fmt(total)}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
        </div>

        <div className="flex gap-2 mb-5">
          <button onClick={() => setMode('even')}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === 'even' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
            Even split
          </button>
          <button onClick={() => setMode('item')}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === 'item' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
            By item
          </button>
        </div>

        {msg && <div className="mb-4 px-4 py-2.5 rounded-lg text-sm bg-green-500/10 text-green-400">{msg}</div>}

        {mode === 'even' ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-gray-400 text-sm">Split between</span>
              <button onClick={() => setPeople(p => Math.max(1, p - 1))} className="w-8 h-8 bg-gray-800 rounded-lg text-white">−</button>
              <span className="text-white font-semibold w-8 text-center">{people}</span>
              <button onClick={() => setPeople(p => p + 1)} className="w-8 h-8 bg-gray-800 rounded-lg text-white">+</button>
              <span className="text-gray-400 text-sm">people</span>
            </div>
            <div className="bg-gray-800 rounded-xl p-4 space-y-2">
              {Array.from({ length: people }, (_, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-400">Person {i + 1}</span>
                  <span className="text-white font-semibold">{currency} {fmt(i === 0 ? share + remainder : share)}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500">Even split shows what to collect per person. Any rounding remainder is added to Person 1.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-gray-400 text-sm">Number of bills</span>
              <button onClick={() => setNumBills(n => Math.max(2, n - 1))} className="w-8 h-8 bg-gray-800 rounded-lg text-white">−</button>
              <span className="text-white font-semibold w-8 text-center">{numBills}</span>
              <button onClick={() => setNumBills(n => n + 1)} className="w-8 h-8 bg-gray-800 rounded-lg text-white">+</button>
            </div>

            <div className="space-y-2">
              {items.map(i => (
                <div key={i.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-white text-sm truncate">{i.quantity}× {i.name}</p>
                    <p className="text-gray-500 text-xs">{currency} {fmt(i.subtotal)}</p>
                  </div>
                  <select value={assign[i.id] ?? 1}
                    onChange={e => setAssign(prev => ({ ...prev, [i.id]: Number(e.target.value) }))}
                    className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-white text-sm">
                    {Array.from({ length: numBills }, (_, b) => <option key={b + 1} value={b + 1}>Bill {b + 1}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <div className="bg-gray-800 rounded-xl p-4 space-y-2">
              {Array.from({ length: numBills }, (_, b) => (
                <div key={b + 1} className="flex justify-between text-sm">
                  <span className="text-gray-400">Bill {b + 1}</span>
                  <span className="text-white font-semibold">{currency} {fmt(billTotals[b + 1] ?? 0)}</span>
                </div>
              ))}
            </div>

            <button onClick={saveItemSplit} disabled={saving}
              className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {saving ? 'Saving…' : 'Save split'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
