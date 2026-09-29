import MethodDot from '../components/MethodDot';
import { useEffect, useRef, useState } from 'react';
import { printShiftReport } from '../lib/printShiftReport';
import { posApi } from '../lib/posApi';
import { checkTypeName } from '../lib/expenseTypes';
import type { ZReport } from '../lib/posApi';
import ZReportView from '../components/ZReportView';
import ConfirmShiftModal from '../components/ConfirmShiftModal';
import { methodName, methodsToDeclare, readAmounts, confirmationLabel, type MethodOption } from '../../shared/shiftConfirm';

interface Props {
  business: { name: string; currency: string };
  canForceClose?: boolean;
  /** A341: may this person add an expense type (expenses.manage)? */
  canAddExpenseType?: boolean;
  onClose: () => void;
  onShiftChange: (report: ZReport | null) => void;
}

/** A334 + cross-sync stage 1: the web POS's part of a shared drawer — downloaded onto this till (webSales) plus what is
 *  still only in the cloud (foreign). Both are already inside the totals; this is only what the panel says about them. */
function webPart(report: { totals: { webSales?: { orders: number; cash_sales: number }; foreign?: { orders: number; cash_sales: number; float_in: number; float_out: number; expenses: number } | null } } | null) {
  const w = report?.totals.webSales, f = report?.totals.foreign;
  const sales = (w?.orders ?? 0) + (f?.orders ?? 0);
  const cash = Number(w?.cash_sales ?? 0) + Number(f?.cash_sales ?? 0);
  return { sales, cash, show: sales > 0 || !!(f && (f.float_in || f.float_out || f.expenses)) };
}

export default function ShiftPanel({ business, canForceClose = false, canAddExpenseType = false, onClose, onShiftChange }: Props) {
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
  // A365: the cashier declares every other payment method too; a manager then confirms (now, or later from Close).
  const [methodOptions, setMethodOptions] = useState<MethodOption[]>([]);
  const [declaredInputs, setDeclaredInputs] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  // Forced close: a manager ending a shift nobody counted. Kept behind a second
  // click and a reason, because it writes an UNRECONCILED shift and that record
  // is permanent.
  const [showForce, setShowForce] = useState(false);
  const [forceReason, setForceReason] = useState('');
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
  // A341: adding an expense type from the picker.
  const [addingType, setAddingType]     = useState(false);
  const [newTypeName, setNewTypeName]   = useState('');
  const [typeBusy, setTypeBusy]         = useState(false);

  const saveNewType = async () => {
    const check = checkTypeName(newTypeName, categories);
    if (check.ok === false) { setExpError(check.error); return; }
    if (check.ok === 'exists') {           // already there: pick it, no duplicate
      setExpCatId(check.id); setAddingType(false); setNewTypeName(''); setExpError('');
      return;
    }
    setTypeBusy(true); setExpError('');
    try {
      const created = await posApi.expense.addCategory(check.name);
      const list = await posApi.expense.categories().catch(() => [] as { id: string; name: string }[]);
      setCategories(list.length ? list : [...categories, created]);
      setExpCatId(created.id);
      setAddingType(false); setNewTypeName('');
      setExpSuccess(`Expense type "${created.name}" added`);
    } catch (e: any) {
      setExpError(e?.message ?? 'Could not add the expense type.');
    } finally { setTypeBusy(false); }
  };

  const printRef = useRef<HTMLDivElement>(null);
  const currency = business.currency ?? 'KES';

  const refresh = async () => {
    const r = await posApi.shift.current({ includeForeign: true });   // A334: + the web POS's cash on this drawer
    setReport(r);
    onShiftChange(r);
  };

  useEffect(() => {
    (async () => { await refresh(); setLoading(false); })();
    // Load expense categories (online only — falls back to empty list offline)
    posApi.expense.categories().then(setCategories).catch(() => {});
    posApi.pos.paymentMethods().then(setMethodOptions).catch(() => {});   // A365
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
  // A365: every other method the business takes (or this shift took), declared from the slips / statement.
  const toDeclare = methodsToDeclare(methodOptions, report?.byMethod ?? []);
  const declaredRead = readAmounts(declaredInputs, toDeclare);

  const handleForceClose = async () => {
    if (!forceReason.trim()) return;
    setBusy(true);
    try {
      const z = await posApi.shift.forceClose(forceReason.trim());
      setFinalReport(z);
      onShiftChange?.(null);
    } catch (e: any) {
      setError(e?.message ?? 'Could not close the shift.');
    } finally { setBusy(false); }
  };

  const handleClose = async () => {
    if (!hasCount)    { setError('Enter the counted cash amount'); return; }
    if (noteRequired) { setError('A note is required to close with a variance'); return; }
    if (declaredRead.ok === false) {
      setError(`Enter the total for: ${declaredRead.missing.map((m) => methodName(m, methodOptions)).join(', ')} (0 if none).`);
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await posApi.shift.close(counted, closeNotes.trim() || undefined, declaredRead.map);
      setFinalReport(r);
      onShiftChange(null);
    } catch (e: any) { setError(e?.message ?? 'Could not close shift'); }
    finally { setBusy(false); }
  };

  const [printMsg, setPrintMsg] = useState('');

  const handlePrint = async () => {
    const r = finalReport ?? report;
    if (!r) return;
    setPrintMsg('');
    // Was window.open(...).print() — the browser's own dialog, which prompts,
    // spools through the driver and rasterises. Slow on a thermal roll and it
    // wrapped unpredictably. Same ESC/POS renderer as every other ticket now.
    const res = await printShiftReport(r);
    if (!res.ok) setPrintMsg(res.error ?? 'Could not print the Z-report.');
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-400 focus:outline-none focus:border-action-500 transition-colors';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center px-4 z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-white font-bold">
            {finalReport ? 'Shift closed' : report ? 'Current shift' : 'Open shift'}
          </h2>
          <button onClick={onClose} className="text-gray-300 hover:text-white transition-colors">✕</button>
        </div>

        {/* Tabs — only when a shift is open and not finalised */}
        {report && !finalReport && (
          <div className="flex border-b border-gray-800 flex-shrink-0">
            {(['shift', 'expenses'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors capitalize ${
                  activeTab === t
                    ? 'text-white border-b-2 border-action-500'
                    : 'text-gray-300 hover:text-white'
                }`}>
                {t === 'expenses' && expList.length > 0
                  ? `Expenses (${expList.length})`
                  : t === 'shift' ? 'Shift' : 'Expenses'}
              </button>
            ))}
          </div>
        )}

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {loading && <p className="text-gray-300 text-sm">Loading…</p>}

          {error && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>
          )}

          {/* ── Final closed report ── */}
          {finalReport && (
            <>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                <ZReportRows report={finalReport} money={money} />
              </div>
              {/* A365: a manager confirms now (recommended) — or later from Manager → Close. */}
              {finalReport.confirmation && (
                <div data-testid="shift-confirmation" className={`text-sm rounded-lg px-3 py-2 border ${finalReport.confirmation.status === 'awaiting' ? 'text-amber-300 bg-amber-400/10 border-amber-400/20' : 'text-gray-200 bg-gray-800 border-gray-700'}`}>
                  {confirmationLabel(finalReport.confirmation)}
                  {finalReport.confirmation.status === 'awaiting' && (
                    <button onClick={() => setConfirming(true)} data-testid="confirm-now"
                      className="block w-full mt-2 bg-action-500 hover:bg-action-400 text-gray-950 font-bold rounded-lg py-2 text-sm">
                      Manager: confirm now
                    </button>
                  )}
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={() => void handlePrint()} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">Print Z-report</button>
                <button onClick={onClose} className="flex-1 bg-action-500 hover:bg-action-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">Done</button>
              </div>
              {/* A print that silently does nothing is the worst outcome here —
                  the drawer is counted and the paper trail is what is left. */}
              {printMsg && <p className="text-amber-400 text-xs mt-2">⚠ {printMsg}</p>}
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
              <button onClick={handleOpen} disabled={busy} className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-3 transition-colors">
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
                      className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${floatType === t ? 'bg-action-500 text-gray-950' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
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
                  <label className="block text-xs text-gray-300 mb-1">Counted cash in drawer ({currency})</label>
                  <input type="number" inputMode="decimal" value={closingFloat} onChange={e => setClosingFloat(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                {/* A365: every other method, from the M-Pesa statement, the card machine's total, the delivery app. */}
                {toDeclare.map((m) => (
                  <div key={m}>
                    <label className="block text-xs text-gray-300 mb-1"><MethodDot method={m} />{methodName(m, methodOptions)} total ({currency})</label>
                    <input type="number" inputMode="decimal" value={declaredInputs[m] ?? ''} placeholder="0.00" className={inputCls}
                      data-testid={`declare-${m}`}
                      onChange={e => setDeclaredInputs({ ...declaredInputs, [m]: e.target.value })} />
                  </div>
                ))}
                {hasCount && (
                  <div className={`text-sm rounded-lg px-3 py-2 border ${variance === 0 ? 'text-green-400 bg-green-400/10 border-green-400/20' : 'text-amber-400 bg-amber-400/10 border-amber-400/20'}`}>
                    Expected {money(expected)} · {variance === 0 ? 'balances' : `${variance > 0 ? 'over' : 'short'} ${money(Math.abs(variance))}`}
                  </div>
                )}
                {/* A334 + cross-sync stage 1: a shared drawer — what the web POS rang into it is part of the count, whether
                    already downloaded onto this till (webSales) or still only in the cloud (foreign). */}
                {webPart(report).show ? (
                  <p className="text-xs text-gray-400" data-testid="foreign-cash">
                    Includes the web POS on this drawer: {webPart(report).sales} sale{webPart(report).sales === 1 ? '' : 's'}, {money(webPart(report).cash)} cash.
                  </p>
                ) : null}
                {(report?.totals.foreign?.siblings?.count ?? 0) > 0 && (
                  <p className="text-xs text-amber-300" data-testid="sibling-shifts">
                    {/* A342: one count covers both — the cloud closes the web's shift with this close. */}
                    Also counted in this drawer: the web POS's own shift on this till
                    ({report!.totals.foreign!.siblings!.shifts?.map(x => x.opened_by_name ?? 'another cashier').join(', ') || 'another cashier'}),
                    expected {money(report!.totals.foreign!.siblings!.expected)}. Closing here closes it too.
                  </p>
                )}
                {report && report.totals.foreign === null ? (
                  <p className="text-xs text-gray-500" data-testid="foreign-cash-unknown">
                    Web POS sales on this drawer could not be checked (offline) — the cloud reconciles them after sync.
                  </p>
                ) : null}
                {(noteRequired || closeNotes) && (
                  <textarea value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder={noteRequired ? 'Note required to explain the variance' : 'Notes (optional)'} rows={2} className={inputCls} />
                )}
                <button onClick={handleClose} disabled={busy || !hasCount || noteRequired || declaredRead.ok === false} className="w-full bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-white font-bold rounded-xl py-2.5 text-sm transition-colors">
                  {busy ? 'Closing…' : 'Close shift & print Z-report'}
                </button>

                {/* The escape hatch for a shift nobody counted — typically one
                    left open overnight. Kept below the real close, styled as a
                    plain link, because it must be available and must never look
                    like the normal way to end a day. Shown only to staff who can
                    actually force-close (A59): has('shifts.force_close') ||
                    has('settings.manage'), the same rule the server enforces —
                    so the button no longer 403s for cashiers who can't use it. */}
                {canForceClose && (!showForce ? (
                  <button
                    onClick={() => setShowForce(true)}
                    className="w-full text-xs text-gray-400 hover:text-amber-400 transition-colors pt-1"
                  >
                    Can't count the drawer?
                  </button>
                ) : (
                  <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-3 space-y-2">
                    <p className="text-xs text-amber-200">
                      This closes the shift <span className="font-semibold">without a cash count</span>.
                      The variance will be recorded as unknown, not zero, and the shift is marked
                      unreconciled permanently. Use it only when the drawer genuinely cannot be counted —
                      a till left open overnight, for example.
                    </p>
                    <textarea
                      value={forceReason}
                      onChange={e => setForceReason(e.target.value)}
                      placeholder="Why can the drawer not be counted?"
                      rows={2}
                      className={inputCls}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowForce(false); setForceReason(''); }}
                        className="flex-1 py-2 rounded-lg text-xs border border-gray-700 text-gray-200 hover:bg-gray-800 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleForceClose}
                        disabled={busy || !forceReason.trim()}
                        className="flex-1 py-2 rounded-lg text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white transition-colors"
                      >
                        {busy ? 'Closing…' : 'Close unreconciled'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Expenses tab ── */}
          {!loading && report && !finalReport && activeTab === 'expenses' && (
            <>
              {/* New expense form */}
              <div className="border border-gray-800 rounded-xl p-4 space-y-3">
                <p className="text-sm text-gray-300 font-medium">Record expense</p>

                {/* Category picker (+ A341: a manager adds a type) */}
                <div className="flex gap-2">
                  <select
                    value={expCatId}
                    onChange={e => setExpCatId(e.target.value)}
                    className={inputCls + ' appearance-none'}>
                    <option value="">— No category —</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {canAddExpenseType && !addingType && (
                    <button type="button" onClick={() => { setAddingType(true); setExpError(''); }}
                      className="flex-shrink-0 text-sm text-gray-200 hover:text-white border border-gray-600 hover:border-gray-400 rounded-lg px-3 transition-colors">
                      + Add type
                    </button>
                  )}
                </div>
                {canAddExpenseType && addingType && (
                  <div data-testid="add-expense-type" className="flex gap-2">
                    <input
                      type="text" autoFocus maxLength={60}
                      value={newTypeName}
                      onChange={e => setNewTypeName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void saveNewType(); if (e.key === 'Escape') setAddingType(false); }}
                      placeholder="New expense type (e.g. Gas refill)"
                      className={inputCls}
                    />
                    <button type="button" disabled={typeBusy} onClick={() => void saveNewType()}
                      className="flex-shrink-0 text-sm font-medium bg-action-500 hover:bg-action-400 disabled:opacity-50 text-gray-950 rounded-lg px-3 transition-colors">
                      {typeBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" disabled={typeBusy} onClick={() => { setAddingType(false); setNewTypeName(''); }}
                      className="flex-shrink-0 text-sm text-gray-300 hover:text-white px-2 transition-colors">
                      Cancel
                    </button>
                  </div>
                )}

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
                  className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-2.5 text-sm transition-colors">
                  {expBusy ? 'Saving…' : 'Save expense'}
                </button>
              </div>

              {/* List of expenses this shift */}
              {expList.length > 0 ? (
                <div className="border border-gray-800 rounded-xl overflow-hidden">
                  <p className="text-xs text-gray-300 px-4 py-2 border-b border-gray-800">This shift</p>
                  <div className="divide-y divide-gray-800">
                    {expList.map(e => (
                      <div key={e.id} className="flex items-center justify-between px-4 py-2.5 gap-2">
                        <div className="min-w-0">
                          <p className="text-white text-sm truncate">{e.description}</p>
                          <p className="text-gray-400 text-xs">
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
                <p className="text-gray-400 text-sm text-center py-4">No expenses recorded this shift.</p>
              )}
            </>
          )}
        </div>
      </div>

      {confirming && finalReport && (
        <ConfirmShiftModal
          shiftId={finalReport.shift.id}
          cashierName={finalReport.shift.cashier_name}
          methods={finalReport.confirmation?.lines.map((l) => l.method) ?? ['cash']}
          currency={currency}
          onClose={() => setConfirming(false)}
          onDone={async () => {
            setConfirming(false);
            try { setFinalReport(await posApi.shift.zreport(finalReport.shift.id)); } catch { /* keep the closed report */ }
          }}
        />
      )}

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
  const Line = ({ l, v, strong, dot }: { l: string; v: string; strong?: boolean; dot?: string }) => (
    <div className={`flex justify-between text-sm ${strong ? 'font-semibold text-white' : 'text-gray-400'}`}>
      <span>{dot && <MethodDot method={dot} />}{l}</span><span>{v}</span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      <Line l="Cashier" v={shift.cashier_name} />
      <Line l="Orders"  v={String(totals.orderCount)} />
      <Line l="Gross sales" v={money(totals.grossSales)} strong />
      <div className="border-t border-gray-800 my-2" />
      {byMethod.length === 0
        ? <p className="text-xs text-gray-400">No sales yet this shift</p>
        : byMethod.map(m => (
          <Line key={m.method} dot={m.method} l={`${m.method === 'mpesa' ? 'M-Pesa' : m.method[0].toUpperCase() + m.method.slice(1)} (${m.orders})`} v={money(m.amount)} />
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
