import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Movement {
  id: string;
  movement_type: 'sale' | 'restock' | 'write_off' | 'correction';
  quantity_change: number;
  quantity_after: number;
  notes: string | null;
  created_at: string;
}

interface Props {
  product: { id: string; name: string };
  branchId: string;
  onClose: () => void;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; sign: string }> = {
  sale:       { label: 'Sale',       color: 'text-red-400',   sign: '' },
  restock:    { label: 'Restock',    color: 'text-green-400', sign: '+' },
  write_off:  { label: 'Write-off',  color: 'text-amber-400', sign: '' },
  correction: { label: 'Correction', color: 'text-blue-400',  sign: '' },
};

export default function MovementsDrawer({ product, branchId, onClose }: Props) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Movement[]>(`/api/inventory/movements?product_id=${product.id}&branch_id=${branchId}&limit=100`)
      .then(data => { setMovements(data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [product.id]);

  const fmt = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-gray-950 border-l border-gray-800 z-50 flex flex-col">

        <div className="px-6 py-5 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-white font-semibold text-lg">Stock history</h2>
            <p className="text-gray-500 text-sm mt-0.5 truncate max-w-xs">{product.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors mt-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : movements.length === 0 ? (
            <div className="text-center py-16 text-gray-600 text-sm">No stock movements yet</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {movements.map(m => {
                const cfg = TYPE_CONFIG[m.movement_type] ?? { label: m.movement_type, color: 'text-gray-400', sign: '' };
                const isPositive = m.quantity_change > 0;
                return (
                  <div key={m.id} className="px-6 py-4 flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          m.movement_type === 'sale'       ? 'bg-red-500/10 text-red-400' :
                          m.movement_type === 'restock'    ? 'bg-green-500/10 text-green-400' :
                          m.movement_type === 'write_off'  ? 'bg-amber-500/10 text-amber-400' :
                                                             'bg-blue-500/10 text-blue-400'
                        }`}>{cfg.label}</span>
                      </div>
                      {m.notes && <p className="text-gray-500 text-xs mt-1 truncate">{m.notes}</p>}
                      <p className="text-gray-600 text-xs mt-1">{fmt(m.created_at)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`font-semibold text-sm ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {isPositive ? '+' : ''}{m.quantity_change}
                      </p>
                      <p className="text-gray-500 text-xs mt-0.5">→ {m.quantity_after} left</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
