/**
 * MonthlyPackTab — A466: the web's Monthly pack (A455) on the till, under Manager › Sales.
 *
 * Owner, 2026-10-13: "desktop app does not have some reports I added yesterday, can you add them". The cloud builds the
 * pack from every till's records (apps/server/src/lib/monthlyPack.ts), so this screen is online only — it says so when
 * there is no connection. One branch at a time, as the books are kept: this till's branch. Three views as on the web —
 * Daily sales (by method, Expected / Counted / Variance, cashiers, remarks), Expenses (the daily book, by type, by how
 * paid) and the Cash & M-Pesa books — Download Excel (saved where the manager picks), and "Record for the books" (an
 * opening balance, other income, personal, a bank deposit, charges) for a manager with expenses.manage (`canRecord`).
 * The cloud checks the same permissions on every call (reports.financial to read, expenses.manage to record).
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { posApi, type MonthlyPack, type MoneyMovement, type MovementKind } from '../lib/posApi';
import { methodLabel } from '../../shared/paymentCatalogue';

const KINDS: { id: MovementKind; label: string }[] = [
  { id: 'opening', label: 'Opening balance' }, { id: 'other_income', label: 'Other income' },
  { id: 'drawing', label: 'Personal (drawing)' }, { id: 'bank_deposit', label: 'Bank deposit' }, { id: 'charges', label: 'Charges' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<MovementKind, string>;

/** This month, YYYY-MM, on the till's own clock (not UTC — the 1st at 01:00 is the new month here). */
export function thisMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
const money = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cell = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap';
const head = 'px-2 py-1.5 text-xs font-medium text-gray-400 whitespace-nowrap';
const box = 'bg-gray-800/80 border border-gray-700/70 rounded-2xl';
const input = 'bg-gray-900 border border-gray-600 rounded-md px-2 py-1.5 text-white text-sm';

export default function MonthlyPackTab({ currency, canRecord }: { currency: string; canRecord: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const [pack, setPack] = useState<MonthlyPack | null>(null);
  const [moves, setMoves] = useState<MoneyMovement[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'summary' | 'expenses' | 'books'>('summary');

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const [p, m] = await Promise.all([posApi.monthly.get(month), posApi.monthly.movements.list(month)]);
      if (!p.ok || !p.data) { setErr(p.error ?? 'Could not build the monthly pack.'); setPack(null); setMoves([]); return; }
      setPack(p.data); setMoves(m.ok ? (m.data ?? []) : []);
    } catch (e: any) { setErr(e?.message ?? 'Could not build the monthly pack.'); setPack(null); }
    finally { setBusy(false); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  const download = async () => {
    setSaving(true); setMsg(''); setErr('');
    try {
      const r = await posApi.monthly.export(month);
      if (r.ok && r.path) setMsg(`Saved: ${r.path}`);
      else if (!r.canceled) setErr(r.error ?? 'Could not download the monthly pack.');
    } catch (e: any) { setErr(e?.message ?? 'Could not download the monthly pack.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4" data-testid="monthly-pack">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-300">Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="pack-month"
            className={`block mt-1 ${input} px-3 py-2`} />
        </label>
        <button onClick={() => void download()} disabled={!pack || saving} data-testid="pack-download"
          className="px-4 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
          {saving ? 'Saving…' : 'Download Excel'}
        </button>
        <button onClick={() => void load()} disabled={busy} className="px-3 py-2 rounded-lg border border-gray-600 text-gray-200 text-sm disabled:opacity-40">Refresh</button>
        <p className="text-xs text-gray-400 basis-full">This branch, one month at a time, as the books are kept — built on the cloud from every till's records.</p>
      </div>

      {err && <p className="text-sm text-red-300" data-testid="pack-error">{err}</p>}
      {msg && <p className="text-sm text-gray-200">{msg}</p>}
      {busy && !pack && !err && <p className="text-sm text-gray-300">Loading…</p>}

      {pack && (<>
        <div className="flex gap-2">
          {(['summary', 'expenses', 'books'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 rounded-lg text-sm ${view === v ? 'bg-action-500 text-gray-950 font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
              {v === 'summary' ? 'Daily sales' : v === 'expenses' ? `Expenses (${money(pack.expenses.total)})` : 'Cash & M-Pesa books'}
            </button>
          ))}
        </div>

        {view === 'summary' && (
          <div className={`${box} overflow-x-auto`} data-testid="pack-summary">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-700 text-left">
                <th className={head}>Date</th>
                {pack.methods.map((m) => <th key={m} className={`${head} text-right`}>{methodLabel(m)}</th>)}
                <th className={`${head} text-right`}>Total</th><th className={`${head} text-right`}>Expected</th>
                <th className={`${head} text-right`}>Counted</th><th className={`${head} text-right`}>Variance</th>
                <th className={head}>Cashiers</th><th className={head}>Remarks</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-700/60 text-gray-200">
                {pack.summary.rows.filter((r) => r.total !== 0 || r.cashiers.length).map((r) => (
                  <tr key={r.day}>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.day}</td>
                    {pack.methods.map((m) => <td key={m} className={cell}>{money(r.byMethod[m] ?? 0)}</td>)}
                    <td className={`${cell} font-medium text-white`}>{money(r.total)}</td>
                    <td className={cell}>{money(r.expected)}</td><td className={cell}>{money(r.counted)}</td>
                    <td className={`${cell} ${r.variance != null && r.variance < 0 ? 'text-red-300' : r.variance ? 'text-amber-300' : ''}`}>{money(r.variance)}</td>
                    <td className="px-2 py-1.5 text-xs">{r.cashiers.join(', ')}</td>
                    <td className="px-2 py-1.5 text-xs text-gray-400">{r.remarks.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-gray-600 font-semibold text-white">
                <td className="px-2 py-1.5">Total</td>
                {pack.methods.map((m) => <td key={m} className={cell}>{money(pack.summary.byMethod[m] ?? 0)}</td>)}
                <td className={cell}>{money(pack.summary.total)}</td><td className={cell}>{money(pack.summary.expected)}</td>
                <td className={cell}>{money(pack.summary.counted)}</td><td className={cell}>{money(pack.summary.variance)}</td><td /><td />
              </tr></tfoot>
            </table>
            <p className="text-xs text-gray-400 px-2 py-2">Expected and Counted come from the shifts a manager confirmed (Expected includes each drawer's float and pay-ins / pay-outs). Amounts in {currency}.</p>
          </div>
        )}

        {view === 'expenses' && (
          <div className="grid lg:grid-cols-3 gap-4" data-testid="pack-expenses">
            <div className={`lg:col-span-2 ${box} overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead><tr className="text-left border-b border-gray-700">
                  <th className={head}>Date</th><th className={head}>Type</th><th className={head}>Item</th><th className={head}>Paid with</th><th className={`${head} text-right`}>Amount</th>
                </tr></thead>
                <tbody className="text-gray-200">
                  {pack.expenses.days.map((d) => (<Fragment key={d.day}>
                    {d.lines.map((l, i) => (
                      <tr key={`${d.day}-${i}`} className="border-b border-gray-700/40">
                        <td className="px-2 py-1 whitespace-nowrap text-xs">{i === 0 ? d.day : ''}</td>
                        <td className="px-2 py-1 text-xs">{l.type ?? 'Uncategorised'}</td><td className="px-2 py-1">{l.description}</td>
                        <td className="px-2 py-1 text-xs">{methodLabel(l.method)}</td><td className={cell}>{money(l.amount)}</td>
                      </tr>
                    ))}
                    <tr className="border-b border-gray-700 font-medium text-white"><td /><td /><td className="px-2 py-1 text-xs">Total {d.day}</td><td /><td className={cell}>{money(d.total)}</td></tr>
                  </Fragment>))}
                  {pack.expenses.days.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-gray-400">No expenses recorded this month.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="space-y-3">
              <div className={`${box} p-3`}>
                <p className="text-sm font-semibold text-white mb-2">By type</p>
                {pack.expenses.byType.map((t) => <div key={t.type} className="flex justify-between text-sm text-gray-300"><span>{t.type}</span><span className="tabular-nums">{money(t.amount)}</span></div>)}
              </div>
              <div className={`${box} p-3`}>
                <p className="text-sm font-semibold text-white mb-2">Paid with</p>
                {pack.expenses.byMethod.map((t) => <div key={t.method} className="flex justify-between text-sm text-gray-300"><span>{methodLabel(t.method)}</span><span className="tabular-nums">{money(t.amount)}</span></div>)}
                <div className="flex justify-between text-sm font-semibold text-white border-t border-gray-700 mt-2 pt-2"><span>Total</span><span className="tabular-nums">{money(pack.expenses.total)}</span></div>
              </div>
            </div>
          </div>
        )}

        {view === 'books' && (
          <div className="space-y-4" data-testid="pack-books">
            {pack.books.map((b) => (
              <div key={b.method} className={`${box} overflow-x-auto`}>
                <p className="px-3 pt-3 text-sm font-semibold text-white">{b.label} — opening {money(b.opening)} · closing {money(b.closing)}</p>
                <table className="w-full text-sm">
                  <thead><tr className="text-left border-b border-gray-700">
                    <th className={head}>Date</th><th className={`${head} text-right`}>Sales in</th><th className={`${head} text-right`}>Other income</th>
                    <th className={`${head} text-right`}>Expenses</th>{b.method === 'cash' && <th className={`${head} text-right`}>Paid out</th>}
                    <th className={`${head} text-right`}>Personal</th><th className={`${head} text-right`}>Bank deposit</th><th className={`${head} text-right`}>Charges</th>
                    <th className={`${head} text-right`}>Balance</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-700/60 text-gray-200">
                    {b.rows.filter((r) => r.sales || r.otherIn || r.expenses || r.paidOut || r.drawings || r.deposits || r.charges).map((r) => (
                      <tr key={r.day}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.day}</td><td className={cell}>{money(r.sales)}</td><td className={cell}>{money(r.otherIn)}</td>
                        <td className={cell}>{money(r.expenses)}</td>{b.method === 'cash' && <td className={cell}>{money(r.paidOut)}</td>}
                        <td className={cell}>{money(r.drawings)}</td><td className={cell}>{money(r.deposits)}</td><td className={cell}>{money(r.charges)}</td>
                        <td className={`${cell} font-medium text-white`}>{money(r.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <MovementsCard month={month} methods={[...new Set(['cash', 'mpesa', ...pack.methods])]} moves={moves} onChange={load} canRecord={canRecord} />
          </div>
        )}
      </>)}
    </div>
  );
}

/** What a manager records for the books — what no till records. Recording and removing only with `canRecord`. */
function MovementsCard({ month, methods, moves, onChange, canRecord }: {
  month: string; methods: string[]; moves: MoneyMovement[]; onChange: () => void; canRecord: boolean;
}) {
  const firstDay = `${month}-01`;
  const [f, setF] = useState({ movement_date: firstDay, method: 'cash', kind: 'bank_deposit' as MovementKind, amount: '', note: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => { setF((x) => ({ ...x, movement_date: x.movement_date.startsWith(month) ? x.movement_date : firstDay })); }, [month, firstDay]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await posApi.monthly.movements.add({ movement_date: f.movement_date, method: f.method, kind: f.kind, amount: Number(f.amount), note: f.note || undefined });
      if (!r.ok) { setErr(r.error ?? 'Could not record it.'); return; }
      setF((x) => ({ ...x, amount: '', note: '' }));
      onChange();
    } catch (e: any) { setErr(e?.message ?? 'Could not record it.'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setConfirming(null); setErr('');
    try {
      const r = await posApi.monthly.movements.remove(id);
      if (!r.ok) { setErr(r.error ?? 'Could not remove it.'); return; }
      onChange();
    } catch (e: any) { setErr(e?.message ?? 'Could not remove it.'); }
  };

  return (
    <div className="bg-gray-800/80 border border-gray-700/70 rounded-2xl p-3 space-y-3" data-testid="pack-movements">
      <p className="text-sm font-semibold text-white">{canRecord ? 'Record for the books' : 'Recorded for the books'}</p>
      <p className="text-xs text-gray-400">What no till records: the balance carried in, money in that is not a sale (used oil sold), the owner's personal use, money banked, M-Pesa or bank charges. Sales and expenses come from the tills.</p>
      {canRecord && (
        <div className="flex flex-wrap gap-2 items-end" data-testid="pack-record-form">
          <input type="date" value={f.movement_date} onChange={(e) => setF({ ...f, movement_date: e.target.value })} className={input} />
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className={input}>
            {methods.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
          </select>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MovementKind })} className={input}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input type="number" inputMode="decimal" placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={`${input} w-28`} />
          <input type="text" maxLength={200} placeholder="Note (e.g. used oil sold)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={`${input} flex-1 min-w-[160px]`} />
          <button onClick={() => void save()} disabled={busy || !f.amount}
            className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">Record</button>
        </div>
      )}
      {err && <p className="text-sm text-red-300">{err}</p>}
      {moves.length === 0 && <p className="text-xs text-gray-400">Nothing recorded for this month.</p>}
      {moves.length > 0 && (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-700/60 text-gray-300">
            {moves.map((m) => (
              <tr key={m.id}>
                <td className="py-1 whitespace-nowrap">{m.movement_date}</td><td className="py-1">{methodLabel(m.method)}</td><td className="py-1">{KIND_LABEL[m.kind] ?? m.kind}</td>
                <td className="py-1 text-right tabular-nums">{money(Number(m.amount))}</td>
                <td className="py-1 pl-3 text-xs text-gray-400">{m.note ?? ''}{m.recorded_by_name ? ` · ${m.recorded_by_name}` : ''}</td>
                <td className="py-1 text-right whitespace-nowrap">
                  {canRecord && (confirming === m.id
                    ? <><button onClick={() => void remove(m.id)} className="text-xs text-red-300 font-semibold mr-2">Remove it</button>
                        <button onClick={() => setConfirming(null)} className="text-xs text-gray-300">Keep</button></>
                    : <button onClick={() => setConfirming(m.id)} className="text-xs text-red-300">Remove</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
