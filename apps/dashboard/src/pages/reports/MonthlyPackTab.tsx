/**
 * MonthlyPackTab — A455: a branch's month as the clients' own workbook (Summary, Expenses, Cash / M-Pesa books).
 *
 * Owner, 2026-10-12: "I want to be able to generate such reports from the system" (a client's monthly daily-report workbook and
 * October expense books); "email and downloadable"; "manager can record". The cloud builds it (lib/monthlyPack.ts); here:
 * pick a month, see it, download the Excel, and record what no till records — an opening balance, other income (used oil
 * sold), the owner's personal use, bank deposits, charges.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { DESK, useRowMore, ViewMore, MoreRow } from '../../components/RowMore';   // A464
import { api, downloadFile } from '../../lib/api';
import { methodLabel } from '../../lib/paymentCatalogue';
import { num } from '../../lib/format';

type Kind = 'opening' | 'other_income' | 'drawing' | 'bank_deposit' | 'charges';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'opening', label: 'Opening balance' }, { id: 'other_income', label: 'Other income' },
  { id: 'drawing', label: 'Personal (drawing)' }, { id: 'bank_deposit', label: 'Bank deposit' }, { id: 'charges', label: 'Charges' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<Kind, string>;

interface SummaryRow { day: string; byMethod: Record<string, number>; total: number; expected: number | null; counted: number | null; variance: number | null; cashiers: string[]; remarks: string[] }
interface BookRow { day: string; sales: number; otherIn: number; expenses: number; paidOut: number; drawings: number; deposits: number; charges: number; balance: number }
interface Pack {
  title: string; methods: string[];
  summary: { rows: SummaryRow[]; byMethod: Record<string, number>; total: number; expected: number; counted: number; variance: number };
  expenses: { days: { day: string; lines: { type: string | null; description: string; amount: number; method: string; by: string | null }[]; total: number }[];
    byType: { type: string; amount: number }[]; byMethod: { method: string; amount: number }[]; total: number };
  books: { method: string; label: string; opening: number; rows: BookRow[]; totals: Omit<BookRow, 'day' | 'balance'>; closing: number }[];
}
interface Movement { id: string; movement_date: string; method: string; kind: Kind; amount: number; note: string | null; recorded_by_name: string | null }

const thisMonth = () => new Date().toISOString().slice(0, 7);
const cell = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap';
const head = 'px-2 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap';

export default function MonthlyPackTab({ branchId, currency, branches }: { branchId: string; currency: string; branches: { id: string; name: string }[] }) {
  const [month, setMonth] = useState(thisMonth());
  const [branch, setBranch] = useState(branchId || branches[0]?.id || '');
  const [pack, setPack] = useState<Pack | null>(null);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'summary' | 'expenses' | 'books'>('summary');
  const moreS = useRowMore();    // A464: Daily sales on a phone: Date, Total, Variance
  const moreE = useRowMore();    // A464: Expenses on a phone: Date, Item, Amount
  const moreBk = useRowMore();   // A464: the books on a phone: Date, Sales in, Balance
  // The books show figures without the currency code (as the Excel pack does) — lib/format's num to 2 dp.
  const money = (n: number | null | undefined) => (n == null ? '—' : num(n, 2));

  useEffect(() => { if (branchId) setBranch(branchId); }, [branchId]);

  const load = useCallback(async () => {
    if (!branch) { setPack(null); return; }
    setBusy(true); setErr('');
    try {
      const q = `month=${month}&branch_id=${encodeURIComponent(branch)}`;
      const [p, m] = await Promise.all([
        api.get<Pack>(`/api/reports/monthly?${q}`),
        api.get<Movement[]>(`/api/reports/monthly/movements?${q}`).catch(() => [] as Movement[]),
      ]);
      setPack(p); setMoves(m);
    } catch (e: any) { setErr(e?.message ?? 'Could not build the monthly pack.'); setPack(null); }
    finally { setBusy(false); }
  }, [month, branch]);
  useEffect(() => { void load(); }, [load]);

  const branchName = branches.find((b) => b.id === branch)?.name ?? 'branch';
  const download = () => void downloadFile(`/api/reports/monthly/export?month=${month}&branch_id=${encodeURIComponent(branch)}`,
    `zaptill-monthly-${branchName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${month}.xlsx`);

  return (
    <div className="space-y-4" data-testid="monthly-pack">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-600 dark:text-gray-300">Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="pack-month"
            className="block mt-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white" />
        </label>
        <label className="text-sm text-gray-600 dark:text-gray-300">Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="pack-branch"
            className="block mt-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white">
            {!branch && <option value="">Pick a branch</option>}
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <button onClick={download} disabled={!pack} data-testid="pack-download"
          className="px-4 py-2 rounded-lg bg-swift-strong hover:bg-swift-deep text-white text-sm font-semibold disabled:opacity-40">Download Excel</button>
        <p className="text-xs text-gray-500 dark:text-gray-400 basis-full">One branch at a time, as the books are kept. To have it emailed on the 1st of every month: Settings › Report Scheduler › "Email the monthly pack".</p>
      </div>

      {err && <p className="text-sm text-red-500">{err}</p>}
      {busy && !pack && <p className="text-sm text-gray-500">Loading…</p>}

      {pack && (<>
        <div className="flex gap-2">
          {(['summary', 'expenses', 'books'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded-lg text-sm ${view === v ? 'bg-swift-strong text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>
              {v === 'summary' ? 'Daily sales' : v === 'expenses' ? `Expenses (${money(pack.expenses.total)})` : 'Cash & M-Pesa books'}
            </button>
          ))}
        </div>

        {view === 'summary' && (
          <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl" data-testid="pack-summary">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                <th className={head}>Date</th>
                {pack.methods.map((m) => <th key={m} className={`${head} text-right ${DESK}`}>{methodLabel(m)}</th>)}
                <th className={`${head} text-right`}>Total</th><th className={`${head} text-right ${DESK}`}>Expected</th>
                <th className={`${head} text-right ${DESK}`}>Counted</th><th className={`${head} text-right`}>Variance</th>
                <th className={`${head} ${DESK}`}>Cashiers</th><th className={`${head} ${DESK}`}>Remarks</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-gray-800 dark:text-gray-200">
                {pack.summary.rows.filter((r) => r.total !== 0 || r.cashiers.length).map((r) => (
                  <Fragment key={r.day}>
                  <tr>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.day}
                      <ViewMore open={moreS.isOpen(String(r.day))} onClick={() => moreS.toggle(String(r.day))} />
                    </td>
                    {pack.methods.map((m) => <td key={m} className={`${cell} ${DESK}`}>{money(r.byMethod[m] ?? 0)}</td>)}
                    <td className={`${cell} font-medium`}>{money(r.total)}</td>
                    <td className={`${cell} ${DESK}`}>{money(r.expected)}</td><td className={`${cell} ${DESK}`}>{money(r.counted)}</td>
                    <td className={`${cell} ${r.variance != null && r.variance < 0 ? 'text-red-500' : r.variance ? 'text-amber-500' : ''}`}>{money(r.variance)}</td>
                    <td className={`px-2 py-1.5 text-xs ${DESK}`}>{r.cashiers.join(', ')}</td>
                    <td className={`px-2 py-1.5 text-xs text-gray-500 ${DESK}`}>{r.remarks.join('; ')}</td>
                  </tr>
                  <MoreRow open={moreS.isOpen(String(r.day))} colSpan={3} items={[
                    ...pack.methods.map((m): [string, React.ReactNode] => [methodLabel(m), money(r.byMethod[m] ?? 0)]),
                    ['Expected', money(r.expected)],
                    ['Counted', money(r.counted)],
                    ['Cashiers', r.cashiers.join(', ')],
                    ['Remarks', r.remarks.join('; ')],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-gray-300 dark:border-gray-600 font-semibold text-gray-900 dark:text-white">
                <td className="px-2 py-1.5">Total</td>
                {pack.methods.map((m) => <td key={m} className={`${cell} ${DESK}`}>{money(pack.summary.byMethod[m] ?? 0)}</td>)}
                <td className={cell}>{money(pack.summary.total)}</td><td className={`${cell} ${DESK}`}>{money(pack.summary.expected)}</td>
                <td className={`${cell} ${DESK}`}>{money(pack.summary.counted)}</td><td className={cell}>{money(pack.summary.variance)}</td><td className={DESK} /><td className={DESK} />
              </tr></tfoot>
            </table>
            <p className="text-xs text-gray-500 px-2 py-2">Expected and Counted come from the shifts a manager confirmed (Expected includes each drawer's float and pay-ins / pay-outs). Amounts in {currency}.</p>
          </div>
        )}

        {view === 'expenses' && (
          <div className="grid md:grid-cols-3 gap-4" data-testid="pack-expenses">
            <div className="md:col-span-2 border border-gray-200 dark:border-gray-700 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left border-b border-gray-200 dark:border-gray-700">
                  <th className={head}>Date</th><th className={`${head} ${DESK}`}>Type</th><th className={head}>Item</th><th className={`${head} ${DESK}`}>Paid with</th><th className={`${head} text-right`}>Amount</th>
                </tr></thead>
                <tbody className="text-gray-800 dark:text-gray-200">
                  {pack.expenses.days.map((d) => (<Fragment key={d.day}>
                    {d.lines.map((l, i) => (
                      <Fragment key={`${d.day}-${i}`}>
                      <tr className="border-b border-gray-50 dark:border-gray-800/50">
                        <td className="px-2 py-1 whitespace-nowrap text-xs">{i === 0 ? d.day : ''}</td>
                        <td className={`px-2 py-1 text-xs ${DESK}`}>{l.type ?? 'Uncategorised'}</td><td className="px-2 py-1">{l.description}
                          <ViewMore open={moreE.isOpen(`${d.day}-${i}`)} onClick={() => moreE.toggle(`${d.day}-${i}`)} />
                        </td>
                        <td className={`px-2 py-1 text-xs ${DESK}`}>{methodLabel(l.method)}</td><td className={cell}>{money(l.amount)}</td>
                      </tr>
                      <MoreRow open={moreE.isOpen(`${d.day}-${i}`)} colSpan={3} items={[
                        ['Type', l.type ?? 'Uncategorised'],
                        ['Paid with', methodLabel(l.method)],
                      ]} />
                      </Fragment>
                    ))}
                    <tr key={`${d.day}-t`} className="border-b border-gray-200 dark:border-gray-700 font-medium"><td /><td className={DESK} /><td className="px-2 py-1 text-xs">Total {d.day}</td><td className={DESK} /><td className={cell}>{money(d.total)}</td></tr>
                  </Fragment>))}
                  {pack.expenses.days.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-gray-500">No expenses recorded this month.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="space-y-3">
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3">
                <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">By type</p>
                {pack.expenses.byType.map((t) => <div key={t.type} className="flex justify-between text-sm text-gray-700 dark:text-gray-300"><span>{t.type}</span><span className="tabular-nums">{money(t.amount)}</span></div>)}
              </div>
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3">
                <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">Paid with</p>
                {pack.expenses.byMethod.map((t) => <div key={t.method} className="flex justify-between text-sm text-gray-700 dark:text-gray-300"><span>{methodLabel(t.method)}</span><span className="tabular-nums">{money(t.amount)}</span></div>)}
                <div className="flex justify-between text-sm font-semibold text-gray-900 dark:text-white border-t border-gray-200 dark:border-gray-700 mt-2 pt-2"><span>Total</span><span className="tabular-nums">{money(pack.expenses.total)}</span></div>
              </div>
            </div>
          </div>
        )}

        {view === 'books' && (
          <div className="space-y-4" data-testid="pack-books">
            {pack.books.map((b) => (
              <div key={b.method} className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-x-auto">
                <p className="px-3 pt-3 text-sm font-medium text-gray-900 dark:text-white">{b.label} — opening {money(b.opening)} · closing {money(b.closing)}</p>
                <table className="w-full text-sm">
                  <thead><tr className="text-left border-b border-gray-200 dark:border-gray-700">
                    <th className={head}>Date</th><th className={`${head} text-right`}>Sales in</th><th className={`${head} text-right ${DESK}`}>Other income</th>
                    <th className={`${head} text-right ${DESK}`}>Expenses</th>{b.method === 'cash' && <th className={`${head} text-right ${DESK}`}>Paid out</th>}
                    <th className={`${head} text-right ${DESK}`}>Personal</th><th className={`${head} text-right ${DESK}`}>Bank deposit</th><th className={`${head} text-right ${DESK}`}>Charges</th>
                    <th className={`${head} text-right`}>Balance</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-gray-800 dark:text-gray-200">
                    {b.rows.filter((r) => r.sales || r.otherIn || r.expenses || r.paidOut || r.drawings || r.deposits || r.charges).map((r) => (
                      <Fragment key={r.day}>
                      <tr>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.day}
                          <ViewMore open={moreBk.isOpen(`${b.method}-${r.day}`)} onClick={() => moreBk.toggle(`${b.method}-${r.day}`)} />
                        </td><td className={cell}>{money(r.sales)}</td><td className={`${cell} ${DESK}`}>{money(r.otherIn)}</td>
                        <td className={`${cell} ${DESK}`}>{money(r.expenses)}</td>{b.method === 'cash' && <td className={`${cell} ${DESK}`}>{money(r.paidOut)}</td>}
                        <td className={`${cell} ${DESK}`}>{money(r.drawings)}</td><td className={`${cell} ${DESK}`}>{money(r.deposits)}</td><td className={`${cell} ${DESK}`}>{money(r.charges)}</td>
                        <td className={`${cell} font-medium`}>{money(r.balance)}</td>
                      </tr>
                      <MoreRow open={moreBk.isOpen(`${b.method}-${r.day}`)} colSpan={3} items={[
                        ['Other income', money(r.otherIn)],
                        ['Expenses', money(r.expenses)],
                        ...(b.method === 'cash' ? [['Paid out', money(r.paidOut)] as [string, React.ReactNode]] : []),
                        ['Personal', money(r.drawings)],
                        ['Bank deposit', money(r.deposits)],
                        ['Charges', money(r.charges)],
                      ]} />
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <MovementsCard branch={branch} month={month} methods={[...new Set(['cash', 'mpesa', ...pack.methods])]} moves={moves} onChange={load} money={money} />
          </div>
        )}
      </>)}
    </div>
  );
}

/** A455: what a manager records for the books — opening balance, other income, personal, bank deposits, charges. */
function MovementsCard({ branch, month, methods, moves, onChange, money }: {
  branch: string; month: string; methods: string[]; moves: Movement[]; onChange: () => void; money: (n: number) => string;
}) {
  const firstDay = `${month}-01`;
  const [f, setF] = useState({ movement_date: firstDay, method: 'cash', kind: 'bank_deposit' as Kind, amount: '', note: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const more = useRowMore();   // A464: a phone shows Date, Amount, Remove
  useEffect(() => { setF((x) => ({ ...x, movement_date: x.movement_date.startsWith(month) ? x.movement_date : firstDay })); }, [month, firstDay]);
  const input = 'bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-900 dark:text-white';

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.post('/api/reports/monthly/movements', { branch_id: branch, ...f, amount: Number(f.amount) });
      setF((x) => ({ ...x, amount: '', note: '' }));
      onChange();
    } catch (e: any) { setErr(e?.message ?? 'Could not record it.'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!confirm('Remove this entry from the books?')) return;
    try { await api.delete(`/api/reports/monthly/movements/${id}`); onChange(); } catch (e: any) { setErr(e?.message ?? 'Could not remove it.'); }
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 space-y-3" data-testid="pack-movements">
      <p className="text-sm font-medium text-gray-900 dark:text-white">Record for the books</p>
      <p className="text-xs text-gray-500">What no till records: the balance carried in, money in that is not a sale (used oil sold), the owner's personal use, money banked, M-Pesa or bank charges. Sales and expenses come from the tills.</p>
      <div className="flex flex-wrap gap-2 items-end">
        <input type="date" value={f.movement_date} onChange={(e) => setF({ ...f, movement_date: e.target.value })} className={input} />
        <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className={input}>
          {methods.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
        </select>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })} className={input}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input type="number" inputMode="decimal" placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={`${input} w-28`} />
        <input type="text" maxLength={200} placeholder="Note (e.g. used oil sold)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={`${input} flex-1 min-w-[160px]`} />
        <button onClick={() => void save()} disabled={busy || !f.amount} className="px-3 py-1.5 rounded-lg bg-swift-strong text-white text-sm disabled:opacity-40">Record</button>
      </div>
      {err && <p className="text-sm text-red-500">{err}</p>}
      {moves.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-gray-700 dark:text-gray-300">
              {moves.map((m) => (
                <Fragment key={m.id}>
                <tr>
                  <td className="py-1 whitespace-nowrap">{m.movement_date}
                    <ViewMore open={more.isOpen(String(m.id))} onClick={() => more.toggle(String(m.id))} />
                  </td><td className={`py-1 ${DESK}`}>{methodLabel(m.method)}</td><td className={`py-1 ${DESK}`}>{KIND_LABEL[m.kind] ?? m.kind}</td>
                  <td className="py-1 text-right tabular-nums">{money(Number(m.amount))}</td><td className={`py-1 text-xs text-gray-500 ${DESK}`}>{m.note ?? ''}{m.recorded_by_name ? ` · ${m.recorded_by_name}` : ''}</td>
                  <td className="py-1 text-right"><button onClick={() => void remove(m.id)} className="text-xs text-red-500">Remove</button></td>
                </tr>
                <MoreRow open={more.isOpen(String(m.id))} colSpan={3} items={[
                  ['Method', methodLabel(m.method)],
                  ['Type', KIND_LABEL[m.kind] ?? m.kind],
                  ['Note', `${m.note ?? ''}${m.recorded_by_name ? ` · ${m.recorded_by_name}` : ''}`],
                ]} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
