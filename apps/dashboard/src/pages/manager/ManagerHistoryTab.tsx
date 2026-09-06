/**
 * ManagerHistoryTab — a branch manager's record of stock movements at their branch:
 * deliveries received (GRNs) and transfers (in and out, all statuses). Read-only,
 * with a Print button on each row that reuses the shared document engine (A223/226).
 * The Receiving tab is for acting on OPEN items; this is the completed history.
 */
import { useEffect, useState, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { printDocument, DOC_ACCENT } from '../../lib/printDocument';

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

  const money = (n: number) => `${currency} ${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date  = (s: string) => new Date(s).toLocaleDateString('en-KE');

  const printGRN = (grn: GRNRow) => {
    let total = 0;
    const rows = (grn.grn_items ?? []).map(i => {
      const qty = Number(i.quantity_received) || 0; const cost = Number(i.unit_cost) || 0;
      const line = qty * cost; total += line;
      const nm = i.ingredients?.name ?? 'Item'; const u = i.ingredients?.unit ?? '';
      return [`${nm}${u ? ` (${u})` : ''}`, String(qty), money(cost), money(line)];
    });
    printDocument({
      docType: 'GOODS RECEIVED NOTE', number: grn.grn_number, dateLabel: date(grn.created_at),
      accent: DOC_ACCENT.grn, statusLabel: 'Received',
      business: business ?? { name: 'SwiftPOS' },
      meta: [
        { label: 'Against PO', value: grn.purchase_orders?.po_number ?? '—' },
        { label: 'Branch', value: session?.branchName ?? '—' },
      ],
      columns: [{ label: 'Ingredient' }, { label: 'Received', align: 'right' }, { label: 'Unit Cost', align: 'right' }, { label: 'Line Total', align: 'right' }],
      rows, totals: [{ label: 'Total received value', value: money(total) }],
      note: grn.notes, signatures: ['Received by', 'Checked by'],
    });
  };

  const printTransfer = (t: TRow) => {
    const received = t.status === 'received';
    printDocument({
      docType: received ? 'TRANSFER RECEIVED NOTE' : 'STOCK TRANSFER NOTE',
      number: t.transfer_number, dateLabel: date(t.created_at),
      accent: received ? DOC_ACCENT.received : (t.status === 'cancelled' ? DOC_ACCENT.cancelled : DOC_ACCENT.despatch),
      statusLabel: t.status,
      business: business ?? { name: 'SwiftPOS' },
      meta: [{ label: 'From', value: t.from_branch_name }, { label: 'To', value: t.to_branch_name }],
      columns: received
        ? [{ label: 'Product' }, { label: 'Sent', align: 'right' }, { label: 'Received', align: 'right' }, { label: 'Variance', align: 'right' }]
        : [{ label: 'Product' }, { label: 'Quantity sent', align: 'right' }],
      rows: t.stock_transfer_items.map(it => {
        const sent = Number(it.quantity) || 0;
        if (!received) return [it.products?.name ?? 'Item', String(sent)];
        const rec = it.quantity_received == null ? sent : Number(it.quantity_received);
        const v = rec - sent;
        return [it.products?.name ?? 'Item', String(sent), String(rec), v === 0 ? '—' : String(v)];
      }),
      note: t.receipt_note || t.notes || undefined,
      signatures: received ? ['Received by', 'Checked by'] : ['Despatched by', 'Received by'],
    });
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
