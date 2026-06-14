/**
 * CreditAccountsPage — manage customer credit ("on account") balances.
 *  - List customers with a limit or an outstanding balance (debtors first)
 *  - Open one to view its ledger, set the credit limit, record a repayment,
 *    or post a manual adjustment.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';

interface CreditCustomer {
  id: string; name: string; phone: string | null; email: string | null;
  credit_limit: number; credit_balance: number; available_credit: number; status: string;
}
interface LedgerRow {
  id: string; type: 'charge' | 'payment' | 'adjustment';
  amount: number; balance_after: number; method: string | null;
  reference: string | null; notes: string | null; order_id: string | null; created_at: string;
}

function fmt(n: number) {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CreditAccountsPage() {
  const [rows, setRows] = useState<CreditCustomer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CreditCustomer | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // form state for the detail drawer
  const [limit, setLimit] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjNotes, setAdjNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<CreditCustomer[]>(`/api/credit/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`);
      setRows(data ?? []);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Failed to load' });
    } finally { setLoading(false); }
  }, [search]);

  useEffect(() => { loadList(); }, [loadList]);

  const openCustomer = async (c: CreditCustomer) => {
    setSelected(c); setLimit(String(c.credit_limit)); setMsg(null);
    setPayAmount(''); setPayRef(''); setAdjAmount(''); setAdjNotes('');
    try {
      const { customer, ledger } = await api.get<{ customer: CreditCustomer; ledger: LedgerRow[] }>(`/api/credit/customer/${c.id}`);
      setSelected(customer); setLimit(String(customer.credit_limit)); setLedger(ledger ?? []);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Failed to load account' });
    }
  };

  const refreshSelected = async () => {
    if (!selected) return;
    const { customer, ledger } = await api.get<{ customer: CreditCustomer; ledger: LedgerRow[] }>(`/api/credit/customer/${selected.id}`);
    setSelected(customer); setLimit(String(customer.credit_limit)); setLedger(ledger ?? []);
    await loadList();
  };

  const saveLimit = async () => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/credit/customer/${selected.id}/limit`, { credit_limit: Number(limit) || 0 });
      setMsg({ kind: 'ok', text: 'Limit updated' });
      await refreshSelected();
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };

  const recordPayment = async () => {
    if (!selected) return;
    const amt = Number(payAmount);
    if (!(amt > 0)) { setMsg({ kind: 'err', text: 'Enter a positive amount' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.post(`/api/credit/customer/${selected.id}/payment`, { amount: amt, method: payMethod, reference: payRef.trim() || null });
      setMsg({ kind: 'ok', text: 'Payment recorded' });
      setPayAmount(''); setPayRef('');
      await refreshSelected();
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };

  const postAdjustment = async () => {
    if (!selected) return;
    const amt = Number(adjAmount);
    if (!amt) { setMsg({ kind: 'err', text: 'Enter a non-zero amount (use - to reduce balance)' }); return; }
    if (!adjNotes.trim()) { setMsg({ kind: 'err', text: 'A reason is required' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.post(`/api/credit/customer/${selected.id}/adjustment`, { amount: amt, notes: adjNotes.trim() });
      setMsg({ kind: 'ok', text: 'Adjustment posted' });
      setAdjAmount(''); setAdjNotes('');
      await refreshSelected();
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); }
    finally { setBusy(false); }
  };

  const totalOwed = rows.reduce((s, r) => s + Number(r.credit_balance), 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-white">Credit Accounts</h1>
        <div className="text-sm text-gray-400">Total outstanding: <span className="text-white font-semibold">{fmt(totalOwed)}</span></div>
      </div>
      <p className="text-sm text-gray-400 mb-5">Customers buying on account. Debtors shown first.</p>

      <input
        value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name…"
        className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 mb-4"
      />

      {msg && !selected && (
        <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>
      )}

      {loading ? <p className="text-gray-500">Loading…</p> : rows.length === 0 ? (
        <p className="text-gray-500">No credit customers yet. Set a credit limit on a customer to start.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                <th className="p-3">Customer</th><th className="p-3">Phone</th>
                <th className="p-3 text-right">Limit</th><th className="p-3 text-right">Owed</th>
                <th className="p-3 text-right">Available</th><th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="p-3 text-white">{c.name}</td>
                  <td className="p-3 text-gray-400">{c.phone ?? '—'}</td>
                  <td className="p-3 text-right text-gray-300">{fmt(c.credit_limit)}</td>
                  <td className={`p-3 text-right font-medium ${Number(c.credit_balance) > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>{fmt(c.credit_balance)}</td>
                  <td className="p-3 text-right text-gray-300">{fmt(c.available_credit)}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => openCustomer(c)} className="text-green-400 hover:text-green-300 text-xs">Manage →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">{selected.name}</h2>
                <p className="text-xs text-gray-500">{selected.phone ?? 'no phone'}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white">✕</button>
            </div>

            {msg && (
              <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>
            )}

            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Limit</p><p className="text-white font-semibold">{fmt(selected.credit_limit)}</p></div>
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Owed</p><p className="text-yellow-400 font-semibold">{fmt(selected.credit_balance)}</p></div>
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Available</p><p className="text-green-400 font-semibold">{fmt(selected.available_credit)}</p></div>
            </div>

            {/* Set limit */}
            <div className="flex items-end gap-2 mb-4">
              <div className="flex-1">
                <label className="block text-sm text-gray-400 mb-1.5">Credit limit</label>
                <input type="number" value={limit} onChange={e => setLimit(e.target.value)} min={0}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white" />
              </div>
              <button onClick={saveLimit} disabled={busy} className="px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm">Save</button>
            </div>

            {/* Record payment */}
            <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
              <p className="text-white font-medium text-sm mb-3">Record repayment</p>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <input type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="Amount" min={0}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                <select value={payMethod} onChange={e => setPayMethod(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white">
                  <option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option>
                </select>
                <input value={payRef} onChange={e => setPayRef(e.target.value)} placeholder="Ref (optional)"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
              </div>
              <button onClick={recordPayment} disabled={busy} className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm">Record payment</button>
            </div>

            {/* Adjustment */}
            <div className="bg-gray-800/50 rounded-lg p-4 mb-5">
              <p className="text-white font-medium text-sm mb-1">Manual adjustment</p>
              <p className="text-xs text-gray-500 mb-3">Use a negative amount to reduce the balance, positive to increase. Reason required.</p>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <input type="number" value={adjAmount} onChange={e => setAdjAmount(e.target.value)} placeholder="+/- amount"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                <input value={adjNotes} onChange={e => setAdjNotes(e.target.value)} placeholder="Reason"
                  className="col-span-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
              </div>
              <button onClick={postAdjustment} disabled={busy} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm">Post adjustment</button>
            </div>

            {/* Ledger */}
            <p className="text-white font-medium text-sm mb-2">Statement</p>
            {ledger.length === 0 ? <p className="text-gray-500 text-sm">No transactions.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-gray-500 text-left text-xs"><th className="pb-2">Date</th><th className="pb-2">Type</th><th className="pb-2 text-right">Amount</th><th className="pb-2 text-right">Balance</th><th className="pb-2">Note</th></tr></thead>
                <tbody>
                  {ledger.map(l => (
                    <tr key={l.id} className="border-t border-gray-800">
                      <td className="py-2 text-gray-500">{new Date(l.created_at).toLocaleDateString('en-KE')}</td>
                      <td className="py-2 capitalize text-gray-300">{l.type}</td>
                      <td className={`py-2 text-right ${Number(l.amount) > 0 ? 'text-yellow-400' : 'text-green-400'}`}>{Number(l.amount) > 0 ? '+' : ''}{fmt(l.amount)}</td>
                      <td className="py-2 text-right text-gray-300">{fmt(l.balance_after)}</td>
                      <td className="py-2 text-gray-500">{l.method ?? l.notes ?? (l.order_id ? 'sale' : '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
