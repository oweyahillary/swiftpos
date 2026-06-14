import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { ZReport } from '../lib/posApi';
import ZReportView from '../components/ZReportView';

interface Props {
  business: { name: string; currency: string };
  onClose: () => void;
  onShiftChange: (report: ZReport | null) => void;
}

export default function ShiftPanel({ business, onClose, onShiftChange }: Props) {
  const [report, setReport] = useState<ZReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'shift' | 'expenses'>('shift');

  // Open form
  const [openingFloat, setOpeningFloat] = useState('');

  // Float form
  const [floatType, setFloatType] = useState<'float_in' | 'float_out'>('float_out');
  const [floatAmount, setFloatAmount] = useState('');
  const [floatReason, setFloatReason] = useState('');

  // Close form
  const [closingFloat, setClosingFloat] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [finalReport, setFinalReport] = useState<ZReport | null>(null);

  // Expense form
  const [categories, setCategories]     = useState<{ id: string; name: string }[]>([]);
  const [expAmount, setExpAmount]       = useState('');
  const [expDesc, setExpDesc]           = useState('');
  const [expCatId, setExpCatId]         = useState('');
  const [expList, setExpList]           = useState<any[]>([]);
  const [expBusy, setExpBusy]           = useState(false);
  const [expError, setExpError]         = useState('');
  const [expSuccess, setExpSuccess]     = useState('');

  const printRef = useRef<HTMLDivElement>(null);
  const currency = business.currency ?? 'KES';

  const refresh = async () => {
    const r = await posApi.shift.current();
    setReport(r);
    onShiftChange(r);
  };

  useEffect(() => {
    (async () => { await refresh(); setLoading(false); })();
    // Load expense categories (online only — falls back to empty list offline)
    posApi.expense.categories().then(setCategories).catch(() => {});
  }, []);

  // Reload expense list whenever the expenses tab is opened
  useEffect(() => {
    if (activeTab === 'expenses') {
      posApi.expense.list().then(setExpList).catch(() => {});
    }
  }, [activeTab]);

  const money = (n: number) =>
    `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const handleOpen = async () => {
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.open(Number(openingFloat) || 0);
      setReport(r); onShiftChange(r); setOpeningFloat('');
    } catch (e: any) { setError(e?.message ?? 'Could not open shift'); }
    finally { setBusy(false); }
  };

  const handleFloat = async () => {
    if (!(Number(floatAmount) > 0)) { setError('Enter an amount greater than zero'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.float(floatType, Number(floatAmount), floatReason.trim() || undefined);
      setReport(r); onShiftChange(r); setFloatAmount(''); setFloatReason('');
    } catch (e: any) { setError(e?.message ?? 'Could not record float'); }
    finally { setBusy(false); }
  };

  const handleExpense = async () => {
    if (!expDesc.trim())           { setExpError('Description is required'); return; }
    if (!(Number(expAmount) > 0))  { setExpError('Enter a valid amount'); return; }
    setExpBusy(true); setExpError(''); setExpSuccess('');
    try {
      await posApi.expense.create({
        description: expDesc.trim(),
        amount: Number(expAmount),
        expense_category_id: expCatId || undefined,
      });
      setExpDesc(''); setExpAmount(''); setExpCatId('');
      setExpSuccess('Expense saved — will sync on next connection');
      const list = await posApi.expense.list();
      setExpList(list);
    } catch (e: any) { setExpError(e?.message ?? 'Could not save expense'); }
    finally { setExpBusy(false); }
  };

  const expected   = report?.totals.expectedCash ?? 0;
  const counted    = Number(closingFloat);
  const hasCount   = closingFloat.trim() !== '' && !Number.isNaN(counted);
  const variance   = hasCount ? counted - expected : 0;
  const noteRequired = hasCount && Math.round(variance * 100) !== 0 && !closeNotes.trim();

  const handleClose = async () => {
    if (!hasCount)    { setError('Enter the counted cash amount'); return; }
    if (noteRequired) { setError('A note is required to close with a variance'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.close(counted, closeNotes.trim() || undefined);
      setFinalReport(r);
      onShiftChange(null);
    } catch (e: any) { setError(e?.message ?? 'Could not close shift'); }
    finally { setBusy(false); }
  };

  const handlePrint = () => {
    const content = printRef.current;
    if (!content) return;
    const win = window.open('', '_blank', 'width=400,height=700');
    if (!win) return;
    win.document.write(`<html><head><title>Z-Report</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Courier New',monospace;font-size:12px;padding:16px}</style></head><body>${content.innerHTML}</body></html>`);
    win.document.close(); win.focus(); win.print(); win.close();
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center px-4 z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-white font-bold">
            {finalReport ? 'Shift closed' : report ? 'Current shift' : 'Open shift'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* Tabs — only when a shift is open and not finalised */}
        {report && !finalReport && (
          <div className="flex border-b border-gray-800 flex-shrink-0">
            {(['shift', 'expenses'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors capitalize ${
                  activeTab === t
                    ? 'text-white border-b-2 border-green-500'
                    : 'text-gray-500 hover:text-gray-300'
                }`}>
                {t === 'expenses' && expList.length > 0
                  ? `Expenses (${expList.length})`
                  : t === 'shift' ? 'Shift' : 'Expenses'}
              </button>
            ))}
          </div>
        )}

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {loading && <p className="text-gray-500 text-sm">Loading…</p>}

          {error && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>
          )}

          {/* ── Final closed report ── */}
          {finalReport && (
            <>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                <ZReportRows report={finalReport} money={money} />
              </div>
              <div className="flex gap-3">
                <button onClick={handlePrint} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">Print Z-report</button>
                <button onClick={onClose} className="flex-1 bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">Done</button>
              </div>
            </>
          )}

          {/* ── No open shift ── */}
          {!loading && !report && !finalReport && (
            <>
              <p className="text-gray-400 text-sm">No shift is open. Open one to start tracking the drawer.</p>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Opening float ({currency})</label>
                <input type="number" inputMode="decimal" value={openingFloat} onChange={e => setOpeningFloat(e.target.value)} placeholder="0.00" autoFocus className={inputCls} />
              </div>
              <button onClick={handleOpen} disabled={busy} className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-3 transition-colors">
                {busy ? 'Opening…' : 'Open shift'}
              </button>
            </>
          )}

          {/* ── Shift tab ── */}
          {!loading && report && !finalReport && activeTab === 'shift' && (
            <>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                <ZReportRows report={report} money={money} />
              </div>

              {/* Float movement */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Cash movement</p>
                <div className="flex gap-2">
                  {(['float_out', 'float_in'] as const).map(t => (
                    <button key={t} onClick={() => setFloatType(t)}
                      className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${floatType === t ? 'bg-green-500 text-gray-950' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                      {t === 'float_out' ? 'Pay out' : 'Pay in'}
                    </button>
                  ))}
                </div>
                <input type="number" inputMode="decimal" value={floatAmount} onChange={e => setFloatAmount(e.target.value)} placeholder={`Amount (${currency})`} className={inputCls} />
                <input type="text" value={floatReason} onChange={e => setFloatReason(e.target.value)} placeholder="Reason (optional)" className={inputCls} />
                <button onClick={handleFloat} disabled={busy} className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                  Record {floatType === 'float_out' ? 'pay out' : 'pay in'}
                </button>
              </div>

              {/* Close shift */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Close shift</p>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Counted cash in drawer ({currency})</label>
                  <input type="number" inputMode="decimal" value={closingFloat} onChange={e => setClosingFloat(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                {hasCount && (
                  <div className={`text-sm rounded-lg px-3 py-2 border ${variance === 0 ? 'text-green-400 bg-green-400/10 border-green-400/20' : 'text-amber-400 bg-amber-400/10 border-amber-400/20'}`}>
                    Expected {money(expected)} · {variance === 0 ? 'balances' : `${variance > 0 ? 'over' : 'short'} ${money(Math.abs(variance))}`}
                  </div>
                )}
                {(noteRequired || closeNotes) && (
                  <textarea value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder={noteRequired ? 'Note required to explain the variance' : 'Notes (optional)'} rows={2} className={inputCls} />
                )}
                <button onClick={handleClose} disabled={busy || !hasCount || noteRequired} className="w-full bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-white font-bold rounded-xl py-2.5 text-sm transition-colors">
                  {busy ? 'Closing…' : 'Close shift & print Z-report'}
                </button>
              </div>
            </>
          )}

          {/* ── Expenses tab ── */}
          {!loading && report && !finalReport && activeTab === 'expenses' && (
            <>
              {/* New expense form */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Record expense</p>

                {/* Category picker */}
                <select
                  value={expCatId}
                  onChange={e => setExpCatId(e.target.value)}
                  className={inputCls + ' appearance-none'}>
                  <option value="">— No category —</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>

                <input
                  type="text"
                  value={expDesc}
                  onChange={e => setExpDesc(e.target.value)}
                  placeholder="Description (e.g. Airtime, Cleaning supplies)"
                  className={inputCls}
                />
                <input
                  type="number"
                  inputMode="decimal"
                  value={expAmount}
                  onChange={e => setExpAmount(e.target.value)}
                  placeholder={`Amount (${currency})`}
                  className={inputCls}
                />

                {expError   && <p className="text-red-400 text-xs">{expError}</p>}
                {expSuccess && <p className="text-green-400 text-xs">{expSuccess}</p>}

                <button
                  onClick={handleExpense}
                  disabled={expBusy}
                  className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">
                  {expBusy ? 'Saving…' : 'Save expense'}
                </button>
              </div>

              {/* List of expenses this shift */}
              {expList.length > 0 ? (
                <div className="border border-gray-800 rounded-xl overflow-hidden">
                  <p className="text-xs text-gray-500 px-4 py-2 border-b border-gray-800">This shift</p>
                  <div className="divide-y divide-gray-800">
                    {expList.map(e => (
                      <div key={e.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                        <div className="min-w-0">
                          <p className="text-white text-sm truncate">{e.description}</p>
                          <p className="text-gray-600 text-xs">
                            {new Date(e.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}
                            {e.sync_status === 'pending' && <span className="ml-1.5 text-amber-500">● not synced</span>}
                          </p>
                        </div>
                        <span className="text-white font-semibold tabular-nums text-sm flex-shrink-0">
                          {money(Number(e.amount))}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between px-4 py-2.5 text-sm font-semibold border-t border-gray-700">
                      <span className="text-gray-400">Total</span>
                      <span className="text-white">{money(expList.reduce((s, e) => s + Number(e.amount), 0))}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-gray-600 text-sm text-center py-4">No expenses recorded this shift.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Hidden printable Z-report */}
      <div style={{ position: 'fixed', left: '-9999px', top: 0 }}>
        {(finalReport ?? report) && <ZReportView ref={printRef} report={(finalReport ?? report)!} />}
      </div>
    </div>
  );
}

// Compact on-screen rows (the printable version is ZReportView).
function ZReportRows({ report, money }: { report: ZReport; money: (n: number) => string }) {
  const { shift, byMethod, totals } = report;
  const Line = ({ l, v, strong }: { l: string; v: string; strong?: boolean }) => (
    <div className={`flex justify-between text-sm ${strong ? 'font-semibold text-white' : 'text-gray-400'}`}>
      <span>{l}</span><span>{v}</span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      <Line l="Cashier" v={shift.cashier_name} />
      <Line l="Orders"  v={String(totals.orderCount)} />
      <Line l="Gross sales" v={money(totals.grossSales)} strong />
      <div className="border-t border-gray-800 my-2" />
      {byMethod.length === 0
        ? <p className="text-xs text-gray-600">No sales yet this shift</p>
        : byMethod.map(m => (
          <Line key={m.method} l={`${m.method === 'mpesa' ? 'M-Pesa' : m.method[0].toUpperCase() + m.method.slice(1)} (${m.orders})`} v={money(m.amount)} />
        ))}
      <div className="border-t border-gray-800 my-2" />
      <Line l="Opening float" v={money(shift.opening_float)} />
      <Line l="Cash sales"    v={money(totals.cashSales)} />
      <Line l="Float in / out" v={`${money(totals.floatIn)} / ${money(totals.floatOut)}`} />
      <Line l="Expected cash" v={money(shift.expected_cash)} strong />
      {totals.voidCount > 0 && <Line l="Voids" v={String(totals.voidCount)} />}
    </div>
  );
}

interface Props {
  business: { name: string; currency: string };
  onClose: () => void;
  // Notifies POSPage so the top-bar shift pill can refresh.
  onShiftChange: (report: ZReport | null) => void;
}

export default function ShiftPanel({ business, onClose, onShiftChange }: Props) {
  const [report, setReport] = useState<ZReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Open form
  const [openingFloat, setOpeningFloat] = useState('');

  // Float form
  const [floatType, setFloatType] = useState<'float_in' | 'float_out'>('float_out');
  const [floatAmount, setFloatAmount] = useState('');
  const [floatReason, setFloatReason] = useState('');

  // Close form
  const [closingFloat, setClosingFloat] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [finalReport, setFinalReport] = useState<ZReport | null>(null);

  const printRef = useRef<HTMLDivElement>(null);
  const currency = business.currency ?? 'KES';

  const refresh = async () => {
    const r = await posApi.shift.current();
    setReport(r);
    onShiftChange(r);
  };

  useEffect(() => { (async () => { await refresh(); setLoading(false); })(); }, []);

  const money = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const handleOpen = async () => {
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.open(Number(openingFloat) || 0);
      setReport(r); onShiftChange(r); setOpeningFloat('');
    } catch (e: any) { setError(e?.message ?? 'Could not open shift'); }
    finally { setBusy(false); }
  };

  const handleFloat = async () => {
    if (!(Number(floatAmount) > 0)) { setError('Enter an amount greater than zero'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.float(floatType, Number(floatAmount), floatReason.trim() || undefined);
      setReport(r); onShiftChange(r); setFloatAmount(''); setFloatReason('');
    } catch (e: any) { setError(e?.message ?? 'Could not record float'); }
    finally { setBusy(false); }
  };

  // Client-side variance preview so we can require a note before calling close.
  const expected = report?.totals.expectedCash ?? 0;
  const counted = Number(closingFloat);
  const hasCount = closingFloat.trim() !== '' && !Number.isNaN(counted);
  const variance = hasCount ? counted - expected : 0;
  const noteRequired = hasCount && Math.round(variance * 100) !== 0 && !closeNotes.trim();

  const handleClose = async () => {
    if (!hasCount) { setError('Enter the counted cash amount'); return; }
    if (noteRequired) { setError('A note is required to close with a variance'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.close(counted, closeNotes.trim() || undefined);
      setFinalReport(r);
      onShiftChange(null);
    } catch (e: any) { setError(e?.message ?? 'Could not close shift'); }
    finally { setBusy(false); }
  };

  const handlePrint = () => {
    const content = printRef.current;
    if (!content) return;
    const win = window.open('', '_blank', 'width=400,height=700');
    if (!win) return;
    win.document.write(`<html><head><title>Z-Report</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Courier New',monospace;font-size:12px;padding:16px}</style></head><body>${content.innerHTML}</body></html>`);
    win.document.close();
    win.focus();
    win.print();
    win.close();
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center px-4 z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">

        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 sticky top-0 bg-gray-900">
          <h2 className="text-white font-bold">
            {finalReport ? 'Shift closed' : report ? 'Current shift' : 'Open shift'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {loading && <p className="text-gray-500 text-sm">Loading…</p>}

          {error && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>
          )}

          {/* ── Final closed report ── */}
          {finalReport && (
            <>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                <ZReportRows report={finalReport} money={money} />
              </div>
              <div className="flex gap-3">
                <button onClick={handlePrint} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">🖨 Print Z-report</button>
                <button onClick={onClose} className="flex-1 bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">Done</button>
              </div>
            </>
          )}

          {/* ── No open shift -> open form ── */}
          {!loading && !report && !finalReport && (
            <>
              <p className="text-gray-400 text-sm">No shift is open. Open one to start tracking the drawer.</p>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Opening float ({currency})</label>
                <input type="number" inputMode="decimal" value={openingFloat} onChange={e => setOpeningFloat(e.target.value)} placeholder="0.00" autoFocus className={inputCls} />
              </div>
              <button onClick={handleOpen} disabled={busy} className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-3 transition-colors">
                {busy ? 'Opening…' : 'Open shift'}
              </button>
            </>
          )}

          {/* ── Open shift -> live report + float + close ── */}
          {!loading && report && !finalReport && (
            <>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                <ZReportRows report={report} money={money} />
              </div>

              {/* Float movement */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Cash movement</p>
                <div className="flex gap-2">
                  {(['float_out', 'float_in'] as const).map(t => (
                    <button key={t} onClick={() => setFloatType(t)}
                      className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${floatType === t ? 'bg-green-500 text-gray-950' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                      {t === 'float_out' ? 'Pay out' : 'Pay in'}
                    </button>
                  ))}
                </div>
                <input type="number" inputMode="decimal" value={floatAmount} onChange={e => setFloatAmount(e.target.value)} placeholder={`Amount (${currency})`} className={inputCls} />
                <input type="text" value={floatReason} onChange={e => setFloatReason(e.target.value)} placeholder="Reason (optional)" className={inputCls} />
                <button onClick={handleFloat} disabled={busy} className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-medium transition-colors">
                  Record {floatType === 'float_out' ? 'pay out' : 'pay in'}
                </button>
              </div>

              {/* Close shift */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Close shift</p>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Counted cash in drawer ({currency})</label>
                  <input type="number" inputMode="decimal" value={closingFloat} onChange={e => setClosingFloat(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                {hasCount && (
                  <div className={`text-sm rounded-lg px-3 py-2 border ${variance === 0 ? 'text-green-400 bg-green-400/10 border-green-400/20' : 'text-amber-400 bg-amber-400/10 border-amber-400/20'}`}>
                    Expected {money(expected)} · {variance === 0 ? 'balances' : `${variance > 0 ? 'over' : 'short'} ${money(Math.abs(variance))}`}
                  </div>
                )}
                {(noteRequired || closeNotes) && (
                  <textarea value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder={noteRequired ? 'Note required to explain the variance' : 'Notes (optional)'} rows={2} className={inputCls} />
                )}
                <button onClick={handleClose} disabled={busy || !hasCount || noteRequired} className="w-full bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-white font-bold rounded-xl py-2.5 text-sm transition-colors">
                  {busy ? 'Closing…' : 'Close shift & print Z-report'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Hidden printable Z-report */}
      <div style={{ position: 'fixed', left: '-9999px', top: 0 }}>
        {(finalReport ?? report) && <ZReportView ref={printRef} report={(finalReport ?? report)!} />}
      </div>
    </div>
  );
}

// Compact on-screen rows (the printable version is ZReportView).
function ZReportRows({ report, money }: { report: ZReport; money: (n: number) => string }) {
  const { shift, byMethod, totals } = report;
  const Line = ({ l, v, strong }: { l: string; v: string; strong?: boolean }) => (
    <div className={`flex justify-between text-sm ${strong ? 'font-semibold text-white' : 'text-gray-400'}`}>
      <span>{l}</span><span>{v}</span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      <Line l="Cashier" v={shift.cashier_name} />
      <Line l="Orders" v={String(totals.orderCount)} />
      <Line l="Gross sales" v={money(totals.grossSales)} strong />
      <div className="border-t border-gray-800 my-2" />
      {byMethod.length === 0
        ? <p className="text-xs text-gray-600">No sales yet this shift</p>
        : byMethod.map(m => (
          <Line key={m.method} l={`${m.method === 'mpesa' ? 'M-Pesa' : m.method[0].toUpperCase() + m.method.slice(1)} (${m.orders})`} v={money(m.amount)} />
        ))}
      <div className="border-t border-gray-800 my-2" />
      <Line l="Opening float" v={money(shift.opening_float)} />
      <Line l="Cash sales" v={money(totals.cashSales)} />
      <Line l="Float in / out" v={`${money(totals.floatIn)} / ${money(totals.floatOut)}`} />
      <Line l="Expected cash" v={money(shift.expected_cash)} strong />
      {totals.voidCount > 0 && <Line l="Voids" v={String(totals.voidCount)} />}
    </div>
  );
}
