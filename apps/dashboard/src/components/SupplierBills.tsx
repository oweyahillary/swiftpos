import { useEffect, useState } from 'react';
import { money } from '../lib/format';
import SupplierAccount, { type SupplierClient } from './SupplierAccount';

/**
 * SupplierBills — A518: the manager portal's Supplier bills tab. What is owed to each supplier (GET /api/payables/summary)
 * and, on a supplier, its account (SupplierAccount). A holder of payables.view (the Accountant) reads; only payables.manage
 * records bills and payments, and the account's buttons follow it (the cloud refuses the writes anyway).
 */
interface Summary {
  owed: number; overdue: number; dueSoon: number;
  suppliers: Array<{ id: string; name: string; status: string; balance: number; overdue: number; openBills: number }>;
}

export default function SupplierBills({ client, currency, business, branches, canPay, canReturn }: {
  client: SupplierClient; currency: string; canPay: boolean; canReturn: boolean;
  business?: { name: string; address?: string | null; phone?: string | null } | null;
  branches: { id: string; name: string }[];
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try { setSummary(await client.get<Summary>('/api/payables/summary')); setError(''); }
    catch (e) { setError((e as Error)?.message || 'Could not load the supplier bills.'); }   // the cloud's refusal (lib/posError)
  };
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps — posApi is a new object every render

  if (account) {
    return <SupplierAccount supplierId={account} currency={currency} business={business} branches={branches}
      client={client} canPay={canPay} canReturn={canReturn} onClose={() => { setAccount(null); void load(); }} />;
  }
  const q = search.trim().toLowerCase();
  const rows = (summary?.suppliers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
  return (
    <div className="space-y-4" data-testid="supplier-bills">
      <div>
        <h2 className="text-xl font-bold text-white">Supplier bills</h2>
        <p className="text-gray-500 text-sm mt-0.5">{canPay ? 'What is owed to each supplier, their bills and payments' : 'What is owed to each supplier - read only'}</p>
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: 'Owed to suppliers', value: money(summary.owed, currency), cls: 'text-white' },
            { label: 'Overdue', value: money(summary.overdue, currency), cls: summary.overdue > 0 ? 'text-red-400' : 'text-gray-400' },
            { label: 'Due in 7 days', value: money(summary.dueSoon, currency), cls: summary.dueSoon > 0 ? 'text-amber-400' : 'text-gray-400' },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900 p-3">
              <div className="text-xs text-gray-500">{c.label}</div>
              <div className={`mt-1 text-lg font-semibold ${c.cls}`}>{c.value}</div>
            </div>
          ))}
        </div>
      )}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers"
        className="w-full sm:w-72 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none" />
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500"><tr>
            <th className="px-3 py-2">Supplier</th><th className="hidden px-3 py-2 text-right sm:table-cell">Open bills</th>
            <th className="px-3 py-2 text-right">Owed</th><th className="px-3 py-2" /></tr></thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 text-white">{s.name}{s.status !== 'active' && <span className="ml-2 text-xs text-gray-500">{s.status}</span>}</td>
                <td className="hidden px-3 py-2 text-right text-gray-400 sm:table-cell">{s.openBills}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <span className={s.balance > 0 ? 'text-white' : 'text-gray-500'}>{money(s.balance, currency)}</span>
                  {s.overdue > 0 && <div className="text-xs text-red-400">{money(s.overdue, currency)} overdue</div>}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setAccount(s.id)} className="rounded-lg px-2 py-1 text-xs text-swift-text hover:bg-gray-800">Account</button>
                </td>
              </tr>
            ))}
            {summary && !rows.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">No suppliers.</td></tr>}
            {!summary && !error && <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
