import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { approvalWords, limitChangeWords } from '../lib/creditApprovers';

/**
 * CreditHistoryPanel — A585: on the customer's profile (Customers › a customer), who set or changed their credit limit
 * and when (old → new), and their recent sales on account with who sold and who approved each. The owner's backlog:
 * "who approved a credit limit is recorded but no screen shows it". GET /api/credit/customer/:id/history (read like the
 * account: customers.view or customers.credit). Nothing to show: the panel is not drawn.
 */
interface History {
  limits: Array<{ at: string; by_name: string | null; action: string; from: number; to: number; branch_name?: string | null }>;   // A585: branch = where a manager set it
  sales: Array<{ order_id: string; order_number: string | null; sold_at: string; amount: number; state: string; branch_name: string | null;
    cashier_name: string | null; approved_by_name: string | null; decided_by_name: string | null; over_limit: boolean }>;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function CreditHistoryList({ h, currency }: { h: History; currency: string }) {
  const fmt = (n: number) => money(n, currency);
  return (
    <div className="px-5 py-4 border-b border-gray-800/60" data-testid="customer-credit-history">
      <p className="text-xs text-gray-400 font-medium mb-2">Credit history</p>
      {h.limits.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Limit changes</p>
          <ul className="space-y-1">
            {h.limits.map((c, i) => (
              <li key={i} className="text-sm flex flex-wrap justify-between gap-x-3">
                <span className="text-white">{limitChangeWords(c, fmt)}</span>
                <span className="text-gray-400 text-xs">{c.by_name ?? 'Someone'}{c.branch_name ? ` at ${c.branch_name}` : ''} · {when(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {h.sales.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Sales on account</p>
          <ul className="space-y-1">
            {h.sales.map((s) => (
              <li key={s.order_id} className="text-sm flex flex-wrap justify-between gap-x-3">
                <span className="text-white">{fmt(s.amount)}{s.order_number ? <span className="text-gray-500"> · #{s.order_number}</span> : null}
                  {s.over_limit && <span className="text-red-400 text-xs"> · over the limit</span>}</span>
                <span className="text-gray-400 text-xs">{approvalWords(s)}{s.cashier_name ? ` · sold by ${s.cashier_name}` : ''}{s.branch_name ? ` · ${s.branch_name}` : ''} · {when(s.sold_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function CreditHistoryPanel({ customerId, currency }: { customerId: string; currency: string }) {
  const [h, setH] = useState<History | null>(null);
  useEffect(() => {
    let live = true;
    setH(null);
    api.get<History>(`/api/credit/customer/${encodeURIComponent(customerId)}/history`)
      .then((r) => { if (live) setH(r); }).catch(() => { if (live) setH(null); });
    return () => { live = false; };
  }, [customerId]);
  if (!h || (!h.limits.length && !h.sales.length)) return null;
  return <CreditHistoryList h={h} currency={currency} />;
}
