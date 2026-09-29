/**
 * ShiftReportsPage — the owner's view of every cashier's shift and its confirmation (0.6.23, A365).
 *
 * Owner, 2026-09-29: "a table like cashier name, shift date, confirmed (if its still running or not), view — when they
 * click view now they get such a table … you can improve on my suggestion".
 *
 * The list: Cashier · Till · Shift (opened–closed) · Status (Running / Awaiting manager check / Confirmed by … /
 * Self-confirmed / Force-closed / before confirmation) · Difference (what is over or short, so a problem shows without
 * opening it) · View. Filters: dates, status, "problems only". CSV of the list.
 * View: the per-method table — Cashier said · Manager counted · Till recorded · Variance — with the shift's float, times,
 * who confirmed and when, and the notes. "Print report" builds an A4 document from the data (lib/documentSpecs shiftDocSpec /
 * shiftListDocSpec, the same printer as purchase orders) — never a picture of the page.
 *
 * Reads only existing routes: GET /api/shifts (the list, with the confirmation columns) and GET /api/shifts/:id (what the
 * cloud recorded per method). The rules are shared/shiftConfirm.ts, the same file the till and the web POS use.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { localDateStr } from '../lib/localDate';
import { useBusiness } from '../context/BusinessContext';
import { printDocument } from '../lib/printDocument';
import { shiftDocSpec, shiftListDocSpec } from '../lib/documentSpecs';
import {
  methodName, shiftReportStatus, shiftStatusLabel, shiftReportLines, shiftDifference, type ShiftReportStatus,
} from '../lib/shiftConfirm';

interface ShiftRow {
  id: string;
  cashier_name: string;
  terminal_code: string | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  closing_float: number | null;
  expected_cash: number | null;
  cash_variance: number | null;
  notes: string | null;
  declared_methods: Record<string, number> | null;
  expected_methods: Record<string, number> | null;
  confirmed_methods: Record<string, number> | null;
  confirmed_at: string | null;
  confirmer_name: string | null;
  confirm_self: boolean | null;
  expected_cash_live: number | null;
}

type StatusFilter = 'all' | 'running' | 'awaiting' | 'confirmed' | 'problems';

const fmtNum = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '…');

/** A shift the owner should look at: over/short, the manager's count differs, still awaiting, or never counted. */
export function isProblem(s: ShiftRow): boolean {
  const st = shiftReportStatus(s);
  if (st === 'awaiting' || st === 'force_closed') return true;
  if (st === 'running' || st === 'not_required') return Math.round(Number(s.cash_variance ?? 0) * 100) !== 0;
  return shiftReportLines(s).some((l) => l.mismatch || Math.round((l.variance ?? 0) * 100) !== 0);
}

const STATUS_TONE: Record<ShiftReportStatus, string> = {
  running:      'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  awaiting:     'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  confirmed:    'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  self:         'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  force_closed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  not_required: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

export default function ShiftReportsPage() {
  const { business } = useBusiness();
  const currency = business?.currency ?? 'KES';
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${currency} ${fmtNum(n)}`);
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return localDateStr(d); });
  const [to, setTo] = useState(() => localDateStr());
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<ShiftRow | null>(null);
  const [viewByMethod, setViewByMethod] = useState<{ method: string; amount: number }[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${to}T23:59:59.999`).toISOString(),
        limit: '200',
      });
      setRows(await api.get<ShiftRow[]>(`/api/shifts?${qs}`));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load shifts');   // never an empty list that reads as "no shifts"
    } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => rows.filter((s) => {
    const st = shiftReportStatus(s);
    if (filter === 'running') return st === 'running';
    if (filter === 'awaiting') return st === 'awaiting';
    if (filter === 'confirmed') return st === 'confirmed' || st === 'self';
    if (filter === 'problems') return isProblem(s);
    return true;
  }), [rows, filter]);

  const counts = useMemo(() => ({
    running: rows.filter((s) => shiftReportStatus(s) === 'running').length,
    awaiting: rows.filter((s) => shiftReportStatus(s) === 'awaiting').length,
    problems: rows.filter(isProblem).length,
  }), [rows]);

  const openView = async (s: ShiftRow) => {
    setView(s); setViewByMethod([]);
    try {
      const d = await api.get<{ by_method?: { method: string; amount: number }[] }>(`/api/shifts/${s.id}`);
      setViewByMethod(Array.isArray(d?.by_method) ? d.by_method : []);
    } catch { /* the table still shows what the shift row holds */ }
  };

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Cashier', 'Till', 'Opened', 'Closed', 'Status', 'Difference', 'Opening float', 'Cash counted', 'Expected cash'];
    const lines = shown.map((s) => [
      s.cashier_name, s.terminal_code ?? 'Web', s.opened_at, s.closed_at ?? '',
      shiftStatusLabel(shiftReportStatus(s), s.confirmer_name), shiftDifference(s, fmtNum),
      s.opening_float, s.confirmed_methods?.cash ?? s.closing_float ?? '', s.expected_methods?.cash ?? s.expected_cash ?? '',
    ].map(esc).join(','));
    const blob = new Blob([[head.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `shift-reports-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };

  // Owner: the printout "should not be the page screenshot but a report" — an A4 document built from the data.
  const biz = business ?? { name: 'SwiftPOS' };
  const filterLabel = ({ all: 'All shifts', running: 'Running', awaiting: 'Awaiting a manager', confirmed: 'Confirmed', problems: 'Need a look' } as const)[filter];
  const printList = () => printDocument(shiftListDocSpec({
    business: biz, from, to, filterLabel,
    rows: shown.map((s) => ({
      cashier: s.cashier_name, till: s.terminal_code ?? 'Web', opened: when(s.opened_at), closed: s.closed_at ? when(s.closed_at) : 'running',
      status: shiftStatusLabel(shiftReportStatus(s), s.confirmer_name), difference: shiftDifference(s, fmtNum),
    })),
    awaiting: shown.filter((s) => shiftReportStatus(s) === 'awaiting').length,
    problems: shown.filter(isProblem).length,
  }));
  const printShift = (s: ShiftRow, byMethod: { method: string; amount: number }[]) => {
    const st = shiftReportStatus(s);
    printDocument(shiftDocSpec({
      business: biz, currency,
      cashier: s.cashier_name, till: s.terminal_code ?? 'Web', opened: when(s.opened_at), closed: s.closed_at ? when(s.closed_at) : 'still running',
      openingFloat: Number(s.opening_float) || 0, status: shiftStatusLabel(st, s.confirmer_name),
      confirmedAt: s.confirmed_at ? when(s.confirmed_at) : null, self: st === 'self',
      confirmed: st === 'confirmed' || st === 'self', running: st === 'running',
      lines: shiftReportLines(s, byMethod), methodName: (m) => methodName(m), notes: s.notes,
    }));
  };

  const inputCls = 'rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-1.5 text-sm text-gray-900 dark:text-white';

  return (
    <div className="p-6 space-y-4" data-testid="shift-reports">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Shift Reports</h1>
          <p className="text-sm text-gray-500">Every cashier's shift — whether it is still running, awaiting a manager's check or confirmed, and what was over or short.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={printList} disabled={!shown.length} data-testid="print-list" className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-40">
            Print report
          </button>
          <button onClick={exportCsv} disabled={!shown.length} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-40">
            Export CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-gray-600 dark:text-gray-400">From</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        <label className="text-sm text-gray-600 dark:text-gray-400">to</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        <div className="flex gap-1 ml-2">
          {([['all', 'All'], ['running', `Running (${counts.running})`], ['awaiting', `Awaiting check (${counts.awaiting})`],
             ['confirmed', 'Confirmed'], ['problems', `Problems (${counts.problems})`]] as [StatusFilter, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} data-testid={`filter-${k}`}
              className={`px-2.5 py-1 text-xs rounded-full border ${filter === k
                ? 'border-gray-900 dark:border-white bg-gray-900 dark:bg-white text-white dark:text-gray-900'
                : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>{l}</button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : !error && (
        shown.length === 0 ? <p className="text-sm text-gray-500">No shifts for these dates{filter !== 'all' ? ' and this filter' : ''}.</p> : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs text-gray-500">
                <tr><th className="px-3 py-2">Cashier</th><th>Till</th><th>Shift</th><th>Status</th><th>Difference</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const st = shiftReportStatus(s);
                  const diff = shiftDifference(s, fmtNum);
                  const bad = /[−+]/.test(diff) || /differed|Not counted/.test(diff);
                  return (
                    <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200">
                      <td className="px-3 py-2 font-medium">{s.cashier_name}</td>
                      <td>{s.terminal_code ?? 'Web'}</td>
                      <td>{when(s.opened_at)} – {s.closed_at ? hm(s.closed_at) : 'now'}</td>
                      <td><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_TONE[st]}`} data-testid="shift-status">{shiftStatusLabel(st, s.confirmer_name)}</span></td>
                      <td className={bad ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500'}>{diff || '—'}</td>
                      <td className="pr-3 text-right">
                        <button onClick={() => void openView(s)} data-testid={`view-${s.id}`}
                          className="px-3 py-1 rounded bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-medium">View</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {view && (() => {
        const st = shiftReportStatus(view);
        const lines = shiftReportLines(view, viewByMethod);
        const confirmed = st === 'confirmed' || st === 'self';
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl w-full max-w-2xl border border-gray-200 dark:border-gray-700 p-5 space-y-4" data-testid="shift-view">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">{view.cashier_name} · {view.terminal_code ?? 'Web'}</h2>
                  <p className="text-sm text-gray-500">{when(view.opened_at)} – {view.closed_at ? when(view.closed_at) : 'still running'} · opening float {money(Number(view.opening_float))}</p>
                  <p className="text-sm mt-1"><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_TONE[st]}`}>{shiftStatusLabel(st, view.confirmer_name)}</span>
                    {view.confirmed_at && <span className="ml-2 text-xs text-gray-500">{when(view.confirmed_at)}</span>}</p>
                </div>
                <button onClick={() => setView(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-white print:hidden">✕</button>
              </div>

              {st === 'running' ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Still running. Expected cash in the drawer now: <strong>{money(view.expected_cash_live)}</strong>. The table appears once the cashier closes the shift.
                </p>
              ) : (
                <table className="w-full text-sm" data-testid="shift-view-table">
                  <thead className="text-left text-xs text-gray-500">
                    <tr><th className="py-1">Method</th><th className="text-right">Cashier said</th><th className="text-right">Manager counted</th><th className="text-right">Till recorded</th><th className="text-right">Variance</th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const v = l.variance ?? 0;
                      return (
                        <tr key={l.method} className={`border-t border-gray-100 dark:border-gray-800 ${l.mismatch ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`}>
                          <td className="py-1.5 font-medium text-gray-800 dark:text-gray-200">{methodName(l.method)}</td>
                          <td className="text-right">{money(l.cashier)}</td>
                          <td className="text-right">{confirmed ? money(l.manager) : '—'}</td>
                          <td className="text-right">{money(l.recorded)}</td>
                          <td className={`text-right font-medium ${Math.round(v * 100) === 0 ? 'text-gray-500' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600'}`}>
                            {l.variance === null ? '—' : Math.round(v * 100) === 0 ? '0' : `${v > 0 ? '+' : '−'}${fmtNum(Math.abs(v))}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              <div className="text-xs text-gray-500 space-y-1">
                {st !== 'running' && <p>Variance = {confirmed ? 'the manager\'s count' : 'the cashier\'s figure (not yet confirmed)'} − what the till recorded. Cash “till recorded” is the expected cash in the drawer (float + cash sales + pay-ins − pay-outs − expenses).</p>}
                {lines.some((l) => l.mismatch) && <p className="text-amber-700 dark:text-amber-300">Highlighted: the manager's count differs from what the cashier said.</p>}
                {st === 'self' && <p className="text-amber-700 dark:text-amber-300">Self-confirmed: the manager who confirmed this shift also worked it.</p>}
                {view.notes && <p className="whitespace-pre-wrap">Notes: {view.notes}</p>}
              </div>

              <div className="flex justify-end gap-2 print:hidden">
                <button onClick={() => printShift(view, viewByMethod)} data-testid="print-shift" className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200">Print report</button>
                <button onClick={() => setView(null)} className="px-4 py-1.5 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-medium">Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
