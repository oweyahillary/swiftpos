/**
 * ExpectedCashBreakdown — A594: how a drawer's expected cash is made up, on the web's Shift Reports.
 *
 * Owner, 2026-10-26: two "Cash in" entries 21 seconds apart (the day's cash sales, then float + cash sales — a cashier
 * typing the drawer counts into Cash in) lifted Expected cash far above what the drawer held, and nothing on the page said
 * why. Now: opening float + cash sales + cash in − cash out − expenses (= expected), and every cash in, cash out and cash
 * expense with its time, reason, who recorded it and who approved it — a cash in with no approver stands out.
 *
 * The cloud sends `expected_breakdown` (GET /api/shifts/:id) only to someone who may see drawer figures (A494); without it
 * nothing is drawn. Pure render (no fetching), so tests/cash-movements-a594.test.mjs renders it.
 */
import { money, time } from '../lib/format';

export interface CashMovementLine {
  kind: 'cash_in' | 'cash_out' | 'expense';
  amount: number;
  at: string | null;
  reason: string | null;
  by: string | null;
  approved_by: string | null;
}
export interface ExpectedBreakdown {
  opening_float: number; cash_sales: number; cash_in: number; cash_out: number; expenses: number; expected: number;
  movements: CashMovementLine[];
}

const KIND_LABEL: Record<CashMovementLine['kind'], string> = { cash_in: 'Cash in', cash_out: 'Cash out', expense: 'Expense' };

export default function ExpectedCashBreakdown({ b, currency }: Readonly<{ b: ExpectedBreakdown | null | undefined; currency: string }>) {
  if (!b) return null;
  const rows: Array<[string, number, string]> = [
    ['Opening float', b.opening_float, ''],
    ['Cash sales', b.cash_sales, '+'],
    ['Cash in', b.cash_in, '+'],
    ['Cash out', b.cash_out, '−'],
    ['Expenses (cash)', b.expenses, '−'],
  ];
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="expected-breakdown">
      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">How expected cash is made up</p>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, amount, sign]) => (
            <tr key={label} className="text-gray-700 dark:text-gray-300">
              <td className="py-0.5">{sign && <span className="inline-block w-4 text-gray-400">{sign}</span>}{label}</td>
              <td className="py-0.5 text-right tabular-nums">{money(amount, currency)}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-200 dark:border-gray-700 font-semibold text-gray-900 dark:text-white">
            <td className="py-1"><span className="inline-block w-4 text-gray-400">=</span>Expected cash</td>
            <td className="py-1 text-right tabular-nums" data-testid="expected-breakdown-total">{money(b.expected, currency)}</td>
          </tr>
        </tbody>
      </table>
      {b.movements.length > 0 ? (
        <div className="space-y-1" data-testid="expected-breakdown-movements">
          <p className="text-xs text-gray-500">Each cash in, cash out and cash expense</p>
          {b.movements.map((m, i) => (
            <div key={`${m.kind}-${m.at ?? ''}-${i}`} className={`text-xs rounded px-2 py-1 ${m.kind === 'cash_in' && !m.approved_by ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-gray-50 dark:bg-gray-800/60'}`}>
              <div className="flex justify-between gap-2 text-gray-800 dark:text-gray-200">
                <span>{m.at ? time(m.at) : '—'} · {KIND_LABEL[m.kind]}</span>
                <span className="tabular-nums font-medium">{m.kind === 'cash_in' ? '+' : '−'}{money(m.amount, currency)}</span>
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {m.reason ? m.reason : <span className="text-amber-700 dark:text-amber-300">no reason given</span>}
                {' · by '}{m.by ?? 'unknown'}
                {' · '}{m.approved_by ? `approved by ${m.approved_by}` : <span className={m.kind === 'cash_in' ? 'text-amber-700 dark:text-amber-300' : ''}>no approver</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">No cash in, cash out or cash expense on this shift.</p>
      )}
    </div>
  );
}
