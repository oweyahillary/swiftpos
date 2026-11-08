import type { DiningTable } from '../lib/posApi';
import type { HeldOrder } from '../lib/heldOrders';

/**
 * TransferTableModal — owner, 2026-11-04 (online licence, restaurants): move the open dine-in order to another table, as
 * the web POS's Transfer. Only a table with no open order is offered — on this POS a table's open order is a held tab
 * (TablesView) — and never the order's own table. The order keeps its number, its lines and what the kitchen already has.
 * Loaded on demand (the POS's main chunk budget, lazy-load-a517).
 */
export function freeTables(tables: DiningTable[], heldOrders: HeldOrder[], current: string): DiningTable[] {
  const taken = new Set(heldOrders.filter((o) => o.orderType === 'dine_in' && o.tableNumber).map((o) => o.tableNumber));
  return tables.filter((t) => t.name !== current && !taken.has(t.name));
}

export default function TransferTableModal({ tables, heldOrders, current, onPick, onClose }: {
  tables: DiningTable[]; heldOrders: HeldOrder[]; current: string;
  onPick: (table: DiningTable) => void; onClose: () => void;
}) {
  const free = freeTables(tables, heldOrders, current);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="transfer-table">
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-gray-700 bg-gray-900 p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-semibold text-white">Move Table {current} to</p>
        {free.length === 0 ? (
          <p className="text-sm text-gray-400">Every other table has an open order.</p>
        ) : (
          <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
            {free.map((t) => (
              <button key={t.id} type="button" onClick={() => onPick(t)}
                className="truncate rounded-lg border border-gray-700 bg-gray-800 px-2 py-3 text-sm font-medium text-white hover:border-gray-500">
                {t.name}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={onClose} className="w-full rounded-lg border border-gray-700 py-2 text-sm text-gray-300 hover:border-gray-600">
          Cancel
        </button>
      </div>
    </div>
  );
}
