import { useState } from 'react';
import type { HeldOrder } from '../lib/heldOrders';

// Held orders ("tabs") — recall a parked order back into the cart, or discard
// one that walked out. Local-only state until the order is actually charged.

interface Props {
  orders: HeldOrder[];
  currency: string;
  cartHasItems: boolean;
  onRecall: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (isNaN(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

export default function HeldOrdersModal({ orders, currency, cartHasItems, onRecall, onDelete, onClose }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">Held orders</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        {cartHasItems && (
          <p className="text-xs text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2">
            The current cart has items — hold or clear it before recalling a tab.
          </p>
        )}

        {orders.length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-10">No held orders</p>
        ) : (
          <div className="space-y-2">
            {orders.map(o => {
              const total = o.cart.reduce((s, i) => s + i.lineTotal, 0);
              const items = o.cart.reduce((s, i) => s + i.quantity, 0);
              const unsent = o.cart.filter(i => !i.kotSent).length;
              return (
                <div key={o.id} className="bg-gray-800/40 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{o.label}</p>
                    <p className="text-gray-500 text-xs">
                      {o.orderNumber} · {items} item{items === 1 ? '' : 's'} · {timeAgo(o.heldAt)}
                      {unsent > 0 && <span className="text-amber-400"> · {unsent} not sent</span>}
                    </p>
                  </div>
                  <span className="text-green-400 text-sm font-semibold flex-shrink-0">
                    {currency} {total.toLocaleString()}
                  </span>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => onRecall(o.id)}
                      disabled={cartHasItems}
                      className="bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 text-xs font-bold rounded-lg px-3 py-1.5 transition-colors"
                    >
                      Recall
                    </button>
                    {confirmDelete === o.id ? (
                      <button
                        onClick={() => { onDelete(o.id); setConfirmDelete(null); }}
                        className="bg-red-500 hover:bg-red-400 text-white text-xs font-bold rounded-lg px-3 py-1.5 transition-colors"
                      >
                        Sure?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(o.id)}
                        className="text-gray-600 hover:text-red-400 text-xs rounded-lg px-2 py-1.5 transition-colors"
                        title="Discard this order"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
