/**
 * ManagerHistoryTab — a branch manager's record of stock movements at their branch:
 * deliveries received (GRNs) and transfers (in and out, all statuses). Read-only,
 * with a Print button on each row that reuses the shared document engine (A223/226).
 * The Receiving tab is for acting on OPEN items; this is the completed history.
 */
import { useEffect, useState, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { printDocument } from '../../lib/printDocument';
import { grnDocSpec, transferDocSpec } from '../../lib/documentSpecs';

interface GRNRow {
  id: string; grn_number: string; created_at: string; notes: string | null;
  purchase_orders: { po_number: string } | null;
  grn_items: { quantity_received: number; unit_cost: number | null; ingredients: { name: string; unit: string } | null }[];
}
interface TItem { product_id: string; quantity: number; quantity_received?: number | null; products?: { name: string } | null }
interface TRow {
  id: string; transfer_number: string; from_branch_id: string; from_branch_name: string;
  to_branch_id: string; to_branch_name: string;
  status: 'pending' | 'in_transit' | 'received' | 'cancelled';
  notes: string | null; receipt_note?: string | null; created_at: string;
  stock_transfer_items: TItem[];
}

const STATUS_CLS: Record<TRow['status'], string> = {
  pending:    'bg-gray-700/40 text-gray-300',
  in_transit: 'bg-amber-500/15 text-amber-400',
  received:   'bg-green-500/15 text-green-400',
  cancelled:  'bg-red-500/15 text-red-400',
};

export default function ManagerHistoryTab({ currency }: { currency: string }) {
  const { posApi, session } = usePOSAuth();
  const { business } = useBusiness();
  const branchId = session?.branchId;

  const [grns, setGrns]           = useState<GRNRow[]>([]);
  const [transfers, setTransfers] = useState<TRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<'deliveries' | 'transfers'>('deliveries');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, t] = await Promise.all([
        posApi.get<GRNRow[]>(`/api/stock/grn${branchId ? `?branch_id=${branchId}` : ''}`),
        posApi.get<TRow[]>('/api/stock/transfers'),
      ]);
      setGrns(Array.isArray(g) ? g : []);
      setTransfers((Array.isArray(t) ? t : []).filter(x => x.from_branch_id === branchId || x.to_branch_id === branchId));
    } catch { /* surfaced as empty */ }
    finally { setLoading(false); }
  }, [posApi, branchId]);
  useEffect(() => { void load(); }, [load]);

  const date  = (s: string) => new Date(s).toLocaleDateString('en-KE');

  const printGRN = (grn: GRNRow) => {
    printDocument(grnDocSpec({
      grnNumber: grn.grn_number, date: date(grn.created_at),
      poNumber: grn.purchase_orders?.po_number ?? null,
      secondMeta: { label: 'Branch', value: session?.branchName ?? '—' },
      business: business ?? { name: 'SwiftPOS' }, currency,
      lines: (grn.grn_items ?? []).map(i => ({
        name: i.ingredients?.name ?? 'Item', unit: i.ingredients?.unit ?? '',
        received: Number(i.quantity_received) || 0, unitCost: Number(i.unit_cost) || 0,
      })),
      note: grn.notes,
    }));
  };

  const printTransfer = (t: TRow) => {
    printDocument(transferDocSpec({
      number: t.transfer_number, date: date(t.created_at),
      from: t.from_branch_name, to: t.to_branch_name, status: t.status, received: t.status === 'received',
      business: business ?? { name: 'SwiftPOS' },
      lines: t.stock_transfer_items.map(it => ({
        name: it.products?.name ?? 'Item', sent: Number(it.quantity) || 0, received: it.quantity_received,
      })),
      note: t.receipt_note || t.notes || undefined,
    }));
  };

  const Tab = ({ id, label }: { id: 'deliveries' | 'transfers'; label: string }) => (
    <button onClick={() => setTab(id)}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
      {label}
    </button>
  );
  const PrintBtn = ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick} className="text-xs font-medium px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors">Print</button>
  );

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-4">
        <Tab id="deliveries" label={`Deliveries received${grns.length ? ` (${grns.length})` : ''}`} />
        <Tab id="transfers" label={`Transfers${transfers.length ? ` (${transfers.length})` : ''}`} />
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm py-10 text-center">Loading history…</p>
      ) : tab === 'deliveries' ? (
        grns.length === 0
          ? <p className="text-gray-500 text-sm py-10 text-center">No deliveries received yet.</p>
          : <div className="space-y-2">
              {grns.map(g => (
                <div key={g.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium">{g.grn_number}
                      {g.purchase_orders?.po_number && <span className="text-gray-500 font-normal"> · {g.purchase_orders.po_number}</span>}
                    </p>
                    <p className="text-gray-500 text-xs mt-0.5">{date(g.created_at)} · {g.grn_items?.length ?? 0} item{(g.grn_items?.length ?? 0) !== 1 ? 's' : ''}</p>
                  </div>
                  <PrintBtn onClick={() => printGRN(g)} />
                </div>
              ))}
            </div>
      ) : (
        transfers.length === 0
          ? <p className="text-gray-500 text-sm py-10 text-center">No transfers yet.</p>
          : <div className="space-y-2">
              {transfers.map(t => {
                const out = t.from_branch_id === branchId;
                return (
                  <div key={t.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${STATUS_CLS[t.status]}`}>{t.status.replace('_', ' ')}</span>
                      <div className="min-w-0">
                        <p className="text-white text-sm font-medium">{t.transfer_number}
                          <span className="text-gray-500 font-normal"> · {out ? 'to' : 'from'} {out ? t.to_branch_name : t.from_branch_name}</span>
                        </p>
                        <p className="text-gray-500 text-xs mt-0.5">{date(t.created_at)} · {out ? 'sent' : 'received'} · {t.stock_transfer_items.length} item{t.stock_transfer_items.length !== 1 ? 's' : ''}</p>
                      </div>
                    </div>
                    <PrintBtn onClick={() => printTransfer(t)} />
                  </div>
                );
              })}
            </div>
      )}
    </div>
  );
}
