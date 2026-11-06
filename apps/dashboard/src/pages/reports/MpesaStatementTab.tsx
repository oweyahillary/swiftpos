/**
 * MpesaStatementTab — Reports › M-Pesa statement (owner, 2026-11-05). The owner uploads the business's M-Pesa statement
 * (the M-PESA Org Portal's Excel/CSV, or the M-PESA business app's PDF); it is read in this browser and never uploaded
 * (lib/statementFile.ts). The statement's days decide which sales are fetched (GET /api/payments/mpesa-statement/sales,
 * the branch picked above), and @zaptill/core/mpesaStatement matches the two:
 *   sales with no money on the statement first (the loss), then amounts that differ, likely matches to look at, money in
 *   with no sale, and the matched ones folded away.
 * Loaded on demand (ReportsPage): SheetJS and pdf.js come with it.
 */
import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { matchStatement, type MpesaSale, type PosOnlyReason, type StatementCheck, type StatementRead } from '@zaptill/core/mpesaStatement';
import { readStatementFile, StatementPasswordError } from '../../lib/statementFile';

interface Props { branchId: string; currency: string }

const WHY: Record<PosOnlyReason, string> = {
  no_code: 'No M-Pesa code on the sale',
  unknown_code: 'Its code is not on the statement',
  code_used_twice: 'Its code is already on another sale',
};

type Stage =
  | { kind: 'idle' }
  | { kind: 'password'; file: File; wrong: boolean }
  | { kind: 'busy' }
  | { kind: 'done'; read: StatementRead; check: StatementCheck };

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
            {head.map((h) => <th key={h} className="py-2 pr-3 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const row = 'border-b border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200';
const cell = 'py-2 pr-3';

function Section({ title, count, note, children }: { title: string; count: number; note: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title} · {count}</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p>
      {count === 0 ? <p className="text-sm text-gray-500">None.</p> : children}
    </section>
  );
}

const saleCells = (s: MpesaSale, currency: string) => (
  <>
    <td className={`${cell} whitespace-nowrap`}>{dateTime(s.at)}</td>
    <td className={cell}>{s.order_number || '—'}</td>
    <td className={cell}>{s.cashier ?? '—'}{s.branch ? <span className="text-gray-400"> · {s.branch}</span> : null}</td>
    <td className={`${cell} font-semibold whitespace-nowrap`}>{money(s.amount, currency)}</td>
    <td className={`${cell} font-mono`}>{s.reference || '—'}</td>
  </>
);

export default function MpesaStatementTab({ branchId, currency }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const check = async (file: File, pw?: string) => {
    setError(''); setStage({ kind: 'busy' });
    try {
      const read = await readStatementFile(file, pw);
      if (!read.lines.length || !read.from || !read.to) {
        setError('No M-Pesa transactions were found in this file. Upload the M-Pesa statement itself (Excel, CSV or PDF).');
        setStage({ kind: 'idle' }); return;
      }
      const q = new URLSearchParams({ from: read.from, to: read.to });
      if (branchId) q.set('branch_id', branchId);
      const { sales } = await api.get<{ sales: MpesaSale[] }>(`/api/payments/mpesa-statement/sales?${q.toString()}`);
      setStage({ kind: 'done', read, check: matchStatement(read.lines, sales) });
      setPassword('');
    } catch (e: any) {
      if (e instanceof StatementPasswordError) { setStage({ kind: 'password', file, wrong: e.wrong }); return; }
      setError(e?.message ?? 'The statement could not be read.');
      setStage({ kind: 'idle' });
    }
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // the same file can be picked again
    if (file) void check(file);
  };

  return (
    <div className="space-y-5" data-testid="mpesa-statement">
      <div className="space-y-2">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Upload your M-Pesa statement — the Excel or CSV from the M-PESA Org Portal, or the PDF from the M-PESA business
          app — to see it against the sales your POS recorded as M-Pesa. The file is read on this computer and is not
          uploaded. Up to 31 days at a time.
        </p>
        {!branchId && <p className="text-xs text-amber-600">Each Till number or Paybill has its own statement: pick its branch above.</p>}
        <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:border-swift">
          <input type="file" accept=".xlsx,.xls,.csv,.pdf" className="hidden" onChange={pick} disabled={stage.kind === 'busy'} data-testid="statement-file" />
          {stage.kind === 'busy' ? 'Reading the statement…' : 'Choose the statement file'}
        </label>
        {stage.kind === 'password' && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void check(stage.file, password); }}>
            <span className="text-sm text-gray-700 dark:text-gray-200">
              {stage.wrong ? 'That password did not open it. Try again:' : 'This statement has a password (sent to you with it):'}
            </span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-sm" data-testid="statement-password" />
            <button type="submit" disabled={!password} className="rounded-lg bg-swift-strong px-3 py-1 text-sm text-white disabled:opacity-40">Open</button>
          </form>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {stage.kind === 'done' && <Result read={stage.read} check={stage.check} currency={currency} />}
    </div>
  );
}

function Result({ read, check, currency }: { read: StatementRead; check: StatementCheck; currency: string }) {
  const t = check.totals;
  const tile = (label: string, value: string, tone = 'text-gray-900 dark:text-gray-100') => (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-base font-semibold ${tone}`}>{value}</p>
    </div>
  );
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-700 dark:text-gray-200">
        Statement {read.from} to {read.to} · {read.lines.length} transactions
        {read.skipped ? <span className="text-gray-400"> · {read.skipped} rows were not transactions</span> : null}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tile('Money in on the statement', money(t.statementIn, currency))}
        {tile('Sales recorded as M-Pesa', money(t.posMpesa, currency))}
        {tile('Matched', `${check.matched.length} · ${money(t.matched, currency)}`)}
        {tile('Sales with no money', `${check.posOnly.length} · ${money(t.posOnly, currency)}`, check.posOnly.length ? 'text-red-600' : undefined)}
        {tile('To look at', String(check.amountDiffers.length + check.likely.length), check.amountDiffers.length + check.likely.length ? 'text-amber-600' : undefined)}
        {tile('Money in with no sale', `${check.statementOnly.length} · ${money(t.statementOnly, currency)}`)}
      </div>

      <Section title="Sales with no money on the statement" count={check.posOnly.length}
        note="Recorded as M-Pesa on the POS, but no payment on the statement matches — a mistyped code, or no payment was made.">
        <Table head={['Sale time', 'Sale', 'Cashier', 'Amount', 'Code on the sale', 'Why']}>
          {check.posOnly.map((p, i) => (
            <tr key={`${p.sale.order_number}-${i}`} className={row}>{saleCells(p.sale, currency)}<td className={cell}>{WHY[p.reason]}</td></tr>
          ))}
        </Table>
      </Section>

      <Section title="Amount differs" count={check.amountDiffers.length}
        note="The statement's code is on a sale, but the sale's M-Pesa amount is not what was paid.">
        <Table head={['Sale time', 'Sale', 'Cashier', 'Sale amount', 'Code', 'Paid (statement)']}>
          {check.amountDiffers.map(({ sale, line }) => (
            <tr key={line.code} className={row}>{saleCells(sale, currency)}<td className={`${cell} font-semibold`}>{money(line.paidIn, currency)}</td></tr>
          ))}
        </Table>
      </Section>

      <Section title="Likely the same payment" count={check.likely.length}
        note={`The sale has no code or a code not on the statement, and the same amount came in within 15 minutes — check the code.`}>
        <Table head={['Sale time', 'Sale', 'Cashier', 'Amount', 'Code on the sale', 'Statement code', 'Paid at', 'From']}>
          {check.likely.map(({ sale, line }) => (
            <tr key={line.code} className={row}>
              {saleCells(sale, currency)}
              <td className={`${cell} font-mono`}>{line.code}</td>
              <td className={`${cell} whitespace-nowrap`}>{line.at ? dateTime(line.at) : '—'}</td>
              <td className={cell}>{line.party || line.details || '—'}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Money in with no sale" count={check.statementOnly.length}
        note="On the statement, but on no sale for these days — a sale not rung, or money that was not a sale (a deposit, a transfer).">
        <Table head={['Paid at', 'Code', 'Amount', 'From']}>
          {check.statementOnly.map((l) => (
            <tr key={l.code} className={row}>
              <td className={`${cell} whitespace-nowrap`}>{l.at ? dateTime(l.at) : '—'}</td>
              <td className={`${cell} font-mono`}>{l.code}</td>
              <td className={`${cell} font-semibold whitespace-nowrap`}>{money(l.paidIn, currency)}</td>
              <td className={cell}>{l.party || l.details || '—'}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-gray-800 dark:text-gray-100">Matched · {check.matched.length}</summary>
        <div className="mt-2">
          <Table head={['Sale time', 'Sale', 'Cashier', 'Amount', 'Code']}>
            {check.matched.map(({ sale, line }) => <tr key={line.code} className={row}>{saleCells(sale, currency)}</tr>)}
          </Table>
        </div>
      </details>
    </div>
  );
}
