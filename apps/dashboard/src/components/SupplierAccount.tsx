import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { printDocument } from '../lib/printDocument';

/**
 * SupplierAccount — A395: one supplier's account (Stock › Suppliers › a supplier). What is owed, the bills, payments and
 * goods sent back, the statement, and deliveries not yet billed. The rules live on the cloud (lib/payables.ts).
 *
 * Owner, 2026-10-04: supplier bills and payables, with returns to supplier ("Yes proceed").
 */

type BillState = 'void' | 'paid' | 'part_paid' | 'overdue' | 'open';
interface Bill {
  id: string; ref: string; invoice_number: string | null; bill_date: string; due_date: string | null; amount: number | string;
  status: string; note: string | null; grn_id: string | null; paid: number; due: number; state: BillState; daysOverdue: number;
  void_reason: string | null; created_by_name: string | null;
}
interface Payment {
  id: string; bill_id: string | null; amount: number | string; method: string; reference: string | null; paid_on: string;
  voided_at: string | null; void_reason?: string | null; created_by_name: string | null;
}
interface Return {
  id: string; ref: string; return_date: string; credit_amount: number | string; reason: string | null; created_by_name: string | null;
  supplier_return_items?: Array<{ name: string; quantity: number | string; unit_cost: number | string | null }>;
}
interface Entry { id: string; date: string; kind: 'bill' | 'payment' | 'return'; ref: string; detail: string; debit: number; credit: number; balance: number }
interface Position { billed: number; paid: number; credits: number; balance: number; overdue: number; dueSoon: number; openBills: number;
  ageing: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number } }
interface Delivery { id: string; grn_number: string; received_date: string; branch_id: string; po_number: string | null; value: number }
interface Account {
  supplier: { id: string; name: string; phone: string | null; email: string | null };
  today: string; position: Position; bills: Bill[]; payments: Payment[]; returns: Return[]; statement: Entry[]; unbilled: Delivery[];
}

const STATE: Record<BillState, { label: string; cls: string }> = {
  open:      { label: 'Open',      cls: 'bg-gray-700 text-gray-200' },
  part_paid: { label: 'Part paid', cls: 'bg-amber-500/10 text-amber-400' },
  overdue:   { label: 'Overdue',   cls: 'bg-red-500/10 text-red-400' },
  paid:      { label: 'Paid',      cls: 'bg-swift/15 text-swift-text' },
  void:      { label: 'Void',      cls: 'bg-gray-800 text-gray-500 line-through' },
};
const METHODS = [['mpesa', 'M-Pesa'], ['bank', 'Bank'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['other', 'Other']] as const;
const methodLabel = (m: string) => METHODS.find(([k]) => k === m)?.[1] ?? m;
const dmy = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const errText = (e: unknown, f: string) => (e as { message?: string })?.message || f;
const input = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:border-swift focus:outline-none';

export default function SupplierAccount({ supplierId, currency, business, branches, onClose }: {
  supplierId: string; currency: string; onClose: () => void;
  business?: { name: string; address?: string | null; phone?: string | null } | null;
  branches: { id: string; name: string }[];
}) {
  const [acc, setAcc] = useState<Account | null>(null);
  const [tab, setTab] = useState<'bills' | 'statement' | 'payments' | 'returns'>('bills');
  const [form, setForm] = useState<null | { kind: 'bill'; grn?: Delivery } | { kind: 'pay'; bill?: Bill } | { kind: 'return' }>(null);
  const [error, setError] = useState('');
  const money = useCallback((n: number | string | null | undefined) =>
    `${currency} ${Number(n ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`, [currency]);

  const load = useCallback(async () => {
    try { setAcc(await api.get<Account>(`/api/payables/suppliers/${supplierId}`)); setError(''); }
    catch (e) { setError(errText(e, 'Could not load the account.')); }
  }, [supplierId]);
  useEffect(() => { void load(); }, [load]);

  const voidIt = async (what: 'bills' | 'payments', id: string, label: string) => {
    const reason = window.prompt(`Why is ${label} voided?`);
    if (!reason?.trim()) return;
    try { await api.post(`/api/payables/${what}/${id}/void`, { reason }); await load(); }
    catch (e) { setError(errText(e, 'Could not void it.')); }
  };

  if (!acc) {
    return <div className="space-y-3"><button onClick={onClose} className="text-sm text-gray-400 hover:text-white">← Suppliers</button>
      {error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-sm text-gray-500">Loading…</p>}</div>;
  }
  const p = acc.position;

  const printStatement = () => printDocument({
    docType: 'SUPPLIER STATEMENT', number: acc.supplier.name, dateLabel: dmy(acc.today), accent: '#475569',
    business: business ?? { name: 'ZapTill' },
    meta: [{ label: 'Supplier', value: acc.supplier.name }, ...(acc.supplier.phone ? [{ label: 'Phone', value: acc.supplier.phone }] : []),
      { label: 'As at', value: dmy(acc.today) }],
    columns: [{ label: 'Date' }, { label: 'Ref' }, { label: 'Detail' }, { label: 'Billed', align: 'right' }, { label: 'Paid / credit', align: 'right' }, { label: 'Balance', align: 'right' }],
    rows: acc.statement.map((e) => [dmy(e.date), e.ref, e.detail, e.debit ? money(e.debit) : '', e.credit ? money(e.credit) : '', money(e.balance)]),
    totals: [{ label: 'Owed', value: money(p.balance) }, { label: 'Overdue', value: money(p.overdue) }],
    signatures: ['Prepared by', 'Supplier'],
  });

  return (
    <div className="space-y-5" data-testid="supplier-account">
      <button onClick={onClose} className="text-sm text-gray-400 hover:text-white">← Suppliers</button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{acc.supplier.name}</h1>
          <p className="mt-0.5 text-sm text-gray-400">{[acc.supplier.phone, acc.supplier.email].filter(Boolean).join(' · ') || 'No contact saved'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={printStatement} className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:text-white">Print statement</button>
          <button onClick={() => setForm({ kind: 'return' })} className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:text-white">Return goods</button>
          <button onClick={() => setForm({ kind: 'bill' })} className="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:text-white">Add bill</button>
          <button onClick={() => setForm({ kind: 'pay' })} data-testid="record-payment"
            className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950">Record payment</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: p.balance < 0 ? 'Supplier owes you' : 'You owe', value: money(Math.abs(p.balance)), cls: p.balance > 0 ? 'text-white' : 'text-swift-text' },
          { label: 'Overdue', value: money(p.overdue), cls: p.overdue > 0 ? 'text-red-400' : 'text-gray-400' },
          { label: 'Due in 7 days', value: money(p.dueSoon), cls: p.dueSoon > 0 ? 'text-amber-400' : 'text-gray-400' },
          { label: 'Open bills', value: String(p.openBills), cls: 'text-white' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900 p-3">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`mt-1 text-lg font-semibold ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>
      {(p.ageing.d1_30 + p.ageing.d31_60 + p.ageing.d61_90 + p.ageing.d90plus) > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400" data-testid="ageing">
          <span>Not yet due {money(p.ageing.current)}</span><span>1–30 days late {money(p.ageing.d1_30)}</span>
          <span>31–60 {money(p.ageing.d31_60)}</span><span>61–90 {money(p.ageing.d61_90)}</span>
          <span className={p.ageing.d90plus > 0 ? 'text-red-400' : ''}>Over 90 {money(p.ageing.d90plus)}</span>
        </div>
      )}

      {acc.unbilled.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" data-testid="unbilled">
          <div className="text-sm font-semibold text-amber-300">Deliveries not billed yet</div>
          <div className="mt-2 divide-y divide-gray-800">
            {acc.unbilled.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-gray-200">{d.grn_number}{d.po_number ? ` · ${d.po_number}` : ''} · {dmy(d.received_date)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-gray-300">{money(d.value)}</span>
                  <button onClick={() => setForm({ kind: 'bill', grn: d })} className="rounded-lg border border-gray-700 px-3 py-1 text-xs text-gray-200 hover:text-white">Bill it</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-800">
        {([['bills', 'Bills'], ['statement', 'Statement'], ['payments', 'Payments'], ['returns', 'Returns']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === k ? 'border-swift text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>{l}</button>
        ))}
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          {tab === 'bills' && <>
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500"><tr>
              <th className="px-3 py-2">Bill</th><th className="px-3 py-2">Dated</th><th className="hidden px-3 py-2 sm:table-cell">Due</th>
              <th className="px-3 py-2 text-right">Amount</th><th className="hidden px-3 py-2 text-right md:table-cell">Paid</th>
              <th className="px-3 py-2 text-right">Owed</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-gray-800">
              {acc.bills.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2"><div className="text-white">{b.ref}</div>
                    <div className="text-xs text-gray-500">{b.invoice_number ? `Invoice ${b.invoice_number}` : ''}{b.status === 'void' && b.void_reason ? ` · voided: ${b.void_reason}` : ''}</div></td>
                  <td className="px-3 py-2 text-gray-400">{dmy(b.bill_date)}</td>
                  <td className="hidden px-3 py-2 text-gray-400 sm:table-cell">{dmy(b.due_date)}{b.daysOverdue > 0 ? <div className="text-xs text-red-400">{b.daysOverdue} days late</div> : null}</td>
                  <td className="px-3 py-2 text-right text-gray-200">{money(b.amount)}</td>
                  <td className="hidden px-3 py-2 text-right text-gray-400 md:table-cell">{money(b.paid)}</td>
                  <td className="px-3 py-2 text-right"><span className={`rounded-full px-2 py-0.5 text-xs ${STATE[b.state].cls}`}>{b.state === 'paid' || b.state === 'void' ? STATE[b.state].label : money(b.due)}</span></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {b.due > 0 && <button onClick={() => setForm({ kind: 'pay', bill: b })} className="rounded-lg px-2 py-1 text-xs text-swift-text hover:bg-gray-800">Pay</button>}
                    {b.status !== 'void' && b.paid === 0 && <button onClick={() => voidIt('bills', b.id, b.ref)} className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400">Void</button>}
                  </td>
                </tr>
              ))}
              {!acc.bills.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">No bills yet.</td></tr>}
            </tbody>
          </>}
          {tab === 'statement' && <>
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500"><tr>
              <th className="px-3 py-2">Date</th><th className="px-3 py-2">Detail</th><th className="px-3 py-2 text-right">Billed</th>
              <th className="px-3 py-2 text-right">Paid / credit</th><th className="px-3 py-2 text-right">Balance</th></tr></thead>
            <tbody className="divide-y divide-gray-800">
              {acc.statement.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td className="px-3 py-2 text-gray-400">{dmy(e.date)}</td>
                  <td className="px-3 py-2"><div className="text-white">{e.detail}</div><div className="text-xs text-gray-500">{e.ref}</div></td>
                  <td className="px-3 py-2 text-right text-gray-200">{e.debit ? money(e.debit) : ''}</td>
                  <td className="px-3 py-2 text-right text-gray-200">{e.credit ? money(e.credit) : ''}</td>
                  <td className="px-3 py-2 text-right font-medium text-white">{money(e.balance)}</td>
                </tr>
              ))}
              {!acc.statement.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">Nothing yet.</td></tr>}
            </tbody>
          </>}
          {tab === 'payments' && <>
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500"><tr>
              <th className="px-3 py-2">Paid on</th><th className="px-3 py-2">How</th><th className="px-3 py-2">For</th>
              <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-gray-800">
              {acc.payments.map((x) => (
                <tr key={x.id} className={x.voided_at ? 'opacity-50' : ''}>
                  <td className="px-3 py-2 text-gray-400">{dmy(x.paid_on)}</td>
                  <td className="px-3 py-2 text-gray-200">{methodLabel(x.method)}{x.reference ? <div className="text-xs text-gray-500">{x.reference}</div> : null}</td>
                  <td className="px-3 py-2 text-gray-400">{x.bill_id ? acc.bills.find((b) => b.id === x.bill_id)?.ref ?? 'A bill' : 'On account'}
                    {x.voided_at ? <div className="text-xs text-red-400">Voided{x.void_reason ? `: ${x.void_reason}` : ''}</div> : null}</td>
                  <td className="px-3 py-2 text-right text-gray-200">{money(x.amount)}</td>
                  <td className="px-3 py-2 text-right">{!x.voided_at && <button onClick={() => voidIt('payments', x.id, 'this payment')} className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400">Void</button>}</td>
                </tr>
              ))}
              {!acc.payments.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">No payments yet.</td></tr>}
            </tbody>
          </>}
          {tab === 'returns' && <>
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500"><tr>
              <th className="px-3 py-2">Return</th><th className="px-3 py-2">Items</th><th className="px-3 py-2 text-right">Credit</th></tr></thead>
            <tbody className="divide-y divide-gray-800">
              {acc.returns.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2"><div className="text-white">{r.ref}</div><div className="text-xs text-gray-500">{dmy(r.return_date)} · {r.reason}</div></td>
                  <td className="px-3 py-2 text-gray-300">{(r.supplier_return_items ?? []).map((i) => `${Number(i.quantity)} × ${i.name}`).join(', ')}</td>
                  <td className="px-3 py-2 text-right text-gray-200">{money(r.credit_amount)}</td>
                </tr>
              ))}
              {!acc.returns.length && <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-500">Nothing sent back.</td></tr>}
            </tbody>
          </>}
        </table>
      </div>
      <p className="text-xs text-gray-500">A payment recorded here is not an expense and does not come out of a till drawer. Pay a supplier from a drawer as a pay-out, or record it here — not both.</p>

      {form?.kind === 'bill' && <BillForm supplierId={supplierId} grn={form.grn} money={money} onClose={() => setForm(null)} onDone={() => { setForm(null); void load(); }} />}
      {form?.kind === 'pay' && <PayForm supplierId={supplierId} bills={acc.bills.filter((b) => b.due > 0)} bill={form.bill} money={money}
        onClose={() => setForm(null)} onDone={() => { setForm(null); void load(); }} />}
      {form?.kind === 'return' && <ReturnForm supplierId={supplierId} branches={branches} money={money} onClose={() => setForm(null)} onDone={() => { setForm(null); void load(); }} />}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-900 p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Actions({ busy, label, onClose, onSave, error }: { busy: boolean; label: string; onClose: () => void; onSave: () => void; error: string }) {
  return (<>
    {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
      <button disabled={busy} onClick={onSave} className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Saving…' : label}</button>
    </div>
  </>);
}

const field = (label: string, el: React.ReactNode) => (
  <label className="block"><span className="mb-1 block text-xs font-medium text-gray-400">{label}</span>{el}</label>
);

function BillForm({ supplierId, grn, money, onClose, onDone }: { supplierId: string; grn?: Delivery; money: (n: number) => string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ invoice_number: '', amount: grn ? String(grn.value || '') : '', bill_date: new Date().toISOString().slice(0, 10), terms_days: '30', note: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await api.post('/api/payables/bills', { supplier_id: supplierId, grn_id: grn?.id, ...f }); onDone(); }
    catch (e) { setError(errText(e, 'Could not save the bill.')); } finally { setBusy(false); }
  };
  return (
    <Sheet title={grn ? `Bill for ${grn.grn_number}` : 'Add a bill'} onClose={onClose}>
      {grn && <p className="mb-3 text-xs text-gray-400">Delivery value at cost: {money(grn.value)} — change the amount if the invoice differs.</p>}
      <div className="grid grid-cols-2 gap-3">
        {field('Supplier invoice no.', <input className={input} value={f.invoice_number} onChange={(e) => setF({ ...f, invoice_number: e.target.value })} placeholder="e.g. INV-2231" />)}
        {field('Amount', <input className={input} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') })} />)}
        {field('Invoice date', <input type="date" className={input} value={f.bill_date} onChange={(e) => setF({ ...f, bill_date: e.target.value })} />)}
        {field('Pay within', <select className={input} value={f.terms_days} onChange={(e) => setF({ ...f, terms_days: e.target.value })}>
          {[['0', 'On receipt'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>)}
      </div>
      <div className="mt-3">{field('Note (optional)', <input className={input} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />)}</div>
      <Actions busy={busy} label="Save bill" onClose={onClose} onSave={save} error={error} />
    </Sheet>
  );
}

function PayForm({ supplierId, bills, bill, money, onClose, onDone }: { supplierId: string; bills: Bill[]; bill?: Bill; money: (n: number) => string; onClose: () => void; onDone: () => void }) {
  // Oldest bill first — the one a supplier expects paid first.
  const ordered = useMemo(() => [...bills].sort((a, b) => (a.due_date || a.bill_date).localeCompare(b.due_date || b.bill_date)), [bills]);
  const first = bill ?? ordered[0];
  const [f, setF] = useState({ bill_id: first?.id ?? '', amount: first ? String(first.due) : '', method: 'mpesa', reference: '', paid_on: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const chosen = bills.find((b) => b.id === f.bill_id);
  const save = async () => {
    setBusy(true); setError('');
    try { await api.post('/api/payables/payments', { supplier_id: supplierId, ...f, bill_id: f.bill_id || null }); onDone(); }
    catch (e) { setError(errText(e, 'Could not record the payment.')); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Record a payment" onClose={onClose}>
      <div className="space-y-3">
        {field('For', <select className={input} value={f.bill_id} onChange={(e) => {
          const b = bills.find((x) => x.id === e.target.value);
          setF({ ...f, bill_id: e.target.value, amount: b ? String(b.due) : f.amount });
        }}>
          {ordered.map((b) => <option key={b.id} value={b.id}>{b.ref}{b.invoice_number ? ` (${b.invoice_number})` : ''} — owes {money(b.due)}</option>)}
          <option value="">On account (no particular bill)</option>
        </select>)}
        <div className="grid grid-cols-2 gap-3">
          {field('Amount', <input className={input} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') })} />)}
          {field('Paid on', <input type="date" className={input} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />)}
          {field('How', <select className={input} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>)}
          {field('Reference', <input className={input} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="M-Pesa code, cheque no." />)}
        </div>
        {chosen && Number(f.amount) > chosen.due && <p className="text-xs text-amber-400">More than this bill owes ({money(chosen.due)}) — pay the rest on account.</p>}
      </div>
      <Actions busy={busy} label="Record payment" onClose={onClose} onSave={save} error={error} />
    </Sheet>
  );
}

interface Pick { kind: 'product' | 'ingredient'; id: string; name: string; held: number | null; cost: number | null; unit: string | null }

function ReturnForm({ supplierId, branches, money, onClose, onDone }: { supplierId: string; branches: { id: string; name: string }[]; money: (n: number) => string; onClose: () => void; onDone: () => void }) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [items, setItems] = useState<Pick[]>([]);
  const [lines, setLines] = useState<Array<Pick & { qty: string; costTyped: string }>>([]);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!branchId) return;
    Promise.all([
      api.get<any[]>(`/api/inventory?branch_id=${branchId}`).catch(() => []),
      api.get<any[]>(`/api/stock/ingredients?status=active&branch_id=${branchId}`).catch(() => []),
    ]).then(([inv, ing]) => setItems([
      ...(inv ?? []).filter((r) => r.products?.track_stock).map((r) => ({ kind: 'product' as const, id: r.product_id, name: r.products?.name ?? 'Item',
        held: r.quantity === null ? null : Number(r.quantity), cost: null, unit: null })),
      ...(ing ?? []).map((g) => ({ kind: 'ingredient' as const, id: g.id, name: g.name, held: g.current_stock === null ? null : Number(g.current_stock),
        cost: g.unit_cost === null || g.unit_cost === undefined ? null : Number(g.unit_cost), unit: g.unit ?? null })),
    ]));
  }, [branchId]);
  const q = search.trim().toLowerCase();
  const matches = q ? items.filter((i) => i.name.toLowerCase().includes(q) && !lines.some((l) => l.id === i.id)).slice(0, 8) : [];
  const credit = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.costTyped || l.cost) || 0), 0);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/api/payables/returns', { supplier_id: supplierId, branch_id: branchId, reason,
        items: lines.map((l) => ({ kind: l.kind, id: l.id, quantity: l.qty, unit_cost: l.costTyped === '' ? undefined : l.costTyped })) });
      onDone();
    } catch (e) { setError(errText(e, 'Could not record the return.')); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Return goods to this supplier" onClose={onClose}>
      <div className="space-y-3">
        {branches.length > 1 && field('From branch', <select className={input} value={branchId} onChange={(e) => { setBranchId(e.target.value); setLines([]); }}>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>)}
        <div className="relative">
          {field('Add an item', <input className={input} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products and ingredients" />)}
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-950">
              {matches.map((m) => (
                <button key={m.id} onClick={() => { setLines([...lines, { ...m, qty: '', costTyped: '' }]); setSearch(''); }}
                  className="flex w-full justify-between px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800">
                  <span>{m.name}<span className="ml-1 text-xs text-gray-500">{m.kind === 'ingredient' ? 'ingredient' : ''}</span></span>
                  <span className="text-xs text-gray-500">{m.held === null ? 'being counted' : `${m.held}${m.unit ? ` ${m.unit}` : ''} here`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {lines.map((l, i) => (
          <div key={l.id} className="grid grid-cols-[1fr_80px_100px_24px] items-center gap-2 text-sm">
            <span className="truncate text-gray-200">{l.name}</span>
            <input className={input} inputMode="decimal" placeholder="Qty" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x))} />
            <input className={input} inputMode="decimal" placeholder={l.cost !== null ? `Cost ${l.cost}` : 'Unit cost'} value={l.costTyped} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, costTyped: e.target.value.replace(/[^\d.]/g, '') } : x))} />
            <button aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400">✕</button>
          </div>
        ))}
        {field('Why are they going back?', <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged, expired, wrong item…" />)}
        <p className="text-xs text-gray-400">The stock leaves the branch now. Credit from the supplier: <span className="text-white">{money(Math.round(credit * 100) / 100)}</span> (at cost; blank cost = the item's saved cost).</p>
      </div>
      <Actions busy={busy} label="Send back" onClose={onClose} onSave={save} error={error} />
    </Sheet>
  );
}
