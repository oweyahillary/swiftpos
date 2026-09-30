/**
 * ShiftModal
 * Handles three POS shift operations in one component:
 *   1. Open Shift  — cashier enters opening float before trading starts
 *   2. Close Shift — cashier counts cash drawer; shows variance vs expected
 *   3. Float In/Out — mid-shift cash drawer movements with a reason
 *
 * Usage:
 *   <ShiftModal
 *     mode="open" | "close" | "float"
 *     shiftId={string | null}          // required for close + float
 *     onShiftOpened={(shift) => void}
 *     onShiftClosed={(shift) => void}
 *     onFloatRecorded={() => void}
 *     onClose={() => void}
 *     currency="KES"
 *   />
 */

import { useState, useEffect } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { methodName, methodsToDeclare, methodsToCount, maySignedInConfirm, readAmounts, confirmationLabel, type MethodOption } from '../../lib/shiftConfirm';
import { getCoveredTerminal, setCoveredTerminal, tillName, openShiftLine, loadOpenDrawers, withOpenShifts, loadWebTill, WEB_TILL_VALUE, type CoveredTerminal, type WebTill } from '../../lib/posTerminal';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Shift {
  id: string;
  status: 'open' | 'closed';
  opening_float: number;
  closing_float?: number;
  expected_cash?: number;
  cash_variance?: number;
  opened_at: string;
  closed_at?: string;
  notes?: string;
  /** A365: the cashier's declaration of every payment method; the shift then awaits a manager. */
  declared_methods?: Record<string, number> | null;
  confirmed_at?: string | null;
}

/** A365: one method on a manager's confirmation (the cloud's confirmationLines). */
interface ConfirmLine { method: string; declared: number | null; expected: number | null; confirmed: number | null; variance: number | null; mismatch: boolean }

export type ShiftModalMode = 'open' | 'close' | 'float' | 'clockin' | 'expense';

interface Props {
  mode: ShiftModalMode;
  shiftId?: string | null;
  branchId?: string;
  onShiftOpened?: (shift: Shift) => void;
  onShiftClosed?: (shift: Shift) => void;
  onFloatRecorded?: () => void;
  onClockRecorded?: () => void;
  onClose: () => void;
  currency?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Component ─────────────────────────────────────────────────────────────────

export default function ShiftModal({
  mode,
  shiftId,
  branchId,
  onShiftOpened,
  onShiftClosed,
  onFloatRecorded,
  onClockRecorded,
  onClose,
  currency = 'KES',
}: Props) {
  const { posApi, session } = usePOSAuth();
  // 0.6.23: a manager signed in on the web POS confirms as themselves — no PIN.
  const signedInManager = maySignedInConfirm(session);

  // Shared
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Open shift
  const [openFloat, setOpenFloat] = useState('');
  // A273 — which till this web POS is covering (Option B). Web has no device_id
  // of its own; the cashier picks a till so its shift folds into that drawer.
  const [terminals, setTerminals]             = useState<CoveredTerminal[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [terminalsLoading, setTerminalsLoading] = useState(false);
  // A343: the branch's web till — where a cashier starts their OWN shift on the web instead of joining a till's.
  const [webTill, setWebTill] = useState<WebTill | null>(null);

  // Close shift
  const [closeFloat, setCloseFloat] = useState('');
  const [notes, setNotes]           = useState('');
  const [closeResult, setCloseResult] = useState<Shift | null>(null);
  // A365: every other payment method declared at close; then a manager confirms (PIN + blind recount), now or later.
  const [methodOptions, setMethodOptions] = useState<MethodOption[]>([]);
  const [declaredInputs, setDeclaredInputs] = useState<Record<string, string>>({});
  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmPin, setConfirmPin] = useState('');
  const [confirmInputs, setConfirmInputs] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<{ lines: ConfirmLine[]; confirmer_name: string | null; confirmed_at: string; confirm_self: boolean } | null>(null);

  // Float in/out
  const [floatType, setFloatType]   = useState<'float_in' | 'float_out'>('float_in');
  const [floatAmount, setFloatAmount] = useState('');
  const [floatReason, setFloatReason] = useState('');
  const [floatDone, setFloatDone]   = useState(false);

  // A362: petty-cash expense out of this drawer (the till's Shift → Expenses, on the web)
  const [expTypes, setExpTypes]   = useState<{ id: string; name: string }[]>([]);
  const [expTypeId, setExpTypeId] = useState('');
  const [expDesc, setExpDesc]     = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expDone, setExpDone]     = useState<{ description: string; amount: number } | null>(null);

  // Clock in/out
  const [clockPin, setClockPin]       = useState('');
  const [clockType, setClockType]     = useState<'in' | 'out'>('in');
  const [clockDone, setClockDone]     = useState(false);
  const [clockTime, setClockTime]     = useState('');

  // ── Handlers ────────────────────────────────────────────────────────────────

  // A273 — load the branch's tills so the cashier can pick which one this web POS
  // is covering. Pre-select the already-covered till, or the only one if there's
  // just one.
  useEffect(() => {
    if (mode !== 'open' || !branchId) return;
    setTerminalsLoading(true);
    Promise.all([
      posApi.get<CoveredTerminal[]>(`/api/shifts/terminals?branch_id=${encodeURIComponent(branchId)}`),
      loadOpenDrawers((path) => posApi.get(path), branchId),   // A273 follow-up: which drawers are open
      loadWebTill((path) => posApi.get(path), branchId),       // A343: the branch's web till
    ])
      .then(([tills, open, web]) => { setWebTill(web); return withOpenShifts(tills ?? [], open); })
      .then((rows) => {
        const list = rows ?? [];
        setTerminals(list);
        const covered = getCoveredTerminal();
        if (covered && list.some(r => r.device_id === covered.device_id)) setSelectedDeviceId(covered.device_id);
        else if (list.length === 1 && !list[0].open_shift) setSelectedDeviceId(list[0].device_id);
      })
      .catch(() => setTerminals([]))
      .finally(() => setTerminalsLoading(false));
  }, [mode, branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A273 follow-up: the chosen till's drawer is ALREADY open (on the desktop or another
  // web tab) — join it. No opening float: the drawer's float was counted when it opened
  // (the 2026-09-15 target finding). Adopt the till's identity, then /current returns
  // that drawer's shift.
  // A343: the web till as a pickable row. device_id '' → covering no till, so setCoveredTerminal() clears the identity and
  // every request keys to the branch's web:<branch> drawer.
  const webTillRow: CoveredTerminal | null = webTill
    ? { device_id: '', terminal_code: null, device_label: webTill.name, open_shift: webTill.open_shift } : null;
  const pick = (id: string) => (id === WEB_TILL_VALUE ? webTillRow : terminals.find(t => t.device_id === id)) ?? undefined;
  // Another cashier's shift is running → spell out the choice (owner, 2026-09-27: join it or create your own).
  const othersOpen = terminals.filter(t => t.open_shift);
  const selectedTill = pick(selectedDeviceId);
  const joining = !!selectedTill?.open_shift;
  const handleJoin = async (till: CoveredTerminal) => {
    setLoading(true);
    setError('');
    setCoveredTerminal(till);
    try {
      const existing = await posApi.get<Shift | null>('/api/shifts/current');
      if (existing) { onShiftOpened?.(existing); return; }
      setCoveredTerminal(null);
      setError('That drawer has just been closed. Pick the till again to open a new shift.');
    } catch (e: any) {
      setCoveredTerminal(null);
      setError(e?.message ?? 'Could not join the drawer');
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = async () => {
    if (!branchId) { setError('Branch not found'); return; }
    const till = pick(selectedDeviceId);
    if (!till) { setError('Choose a till — or your own shift on the web till'); return; }
    if (till.open_shift) { await handleJoin(till); return; }
    const amount = parseFloat(openFloat);
    if (isNaN(amount) || amount < 0) { setError('Enter a valid opening float (0 or more)'); return; }

    setLoading(true);
    setError('');
    // A273: adopt the till's identity BEFORE the call so /open — and every request
    // after it — keys to that till's drawer, not the shared web:<branch> one.
    setCoveredTerminal(till);
    try {
      const shift = await posApi.post<Shift>('/api/shifts/open', {
        branch_id: branchId,
        opening_float: amount,
      });
      onShiftOpened?.(shift);
    } catch (e: any) {
      // The till already has an open drawer (one-open-per-terminal). Fold into it
      // rather than erroring — the web sells into the till's existing session.
      // With the identity now adopted, /current resolves to that till's shift.
      try {
        const existing = await posApi.get<Shift | null>('/api/shifts/current');
        if (existing) { onShiftOpened?.(existing); return; }
      } catch { /* fall through to the error */ }
      setCoveredTerminal(null); // open failed and no existing shift — don't keep a stale identity
      setError(e?.message ?? 'Failed to open shift');
    } finally {
      setLoading(false);
    }
  };


  // 0.6.23: only the methods this shift recorded money on are asked (owner: a method at 0 does not appear).
  const [taken, setTaken] = useState<{ method: string; amount: number }[]>([]);
  // A366: only the shift's owner or a manager may close it; null = not known yet.
  const [shiftOwner, setShiftOwner] = useState<{ ids: string[]; name: string | null } | null>(null);
  useEffect(() => {
    if (mode !== 'close') return;
    posApi.get<{ code: string; name: string; is_active?: boolean }[]>('/api/payment-methods')
      .then((rows) => setMethodOptions((Array.isArray(rows) ? rows : []).filter((r) => r.is_active !== false)))
      .catch(() => setMethodOptions([]));
    if (shiftId) {
      posApi.get<{ by_method?: { method: string; amount: number }[]; cashier_id?: string | null; opened_by?: string | null; cashier_name?: string | null }>(`/api/shifts/${shiftId}`)
        .then((r) => {
          setTaken(Array.isArray(r?.by_method) ? r.by_method : []);
          setShiftOwner({ ids: [r?.cashier_id, r?.opened_by].filter(Boolean) as string[], name: r?.cashier_name ?? null });
        })
        .catch(() => setTaken([]));
    }
  }, [mode, posApi, shiftId]);
  const toDeclare = methodsToDeclare(taken);
  const mayClose = !shiftOwner || signedInManager || (!!session?.staffId && shiftOwner.ids.includes(session.staffId));

  const handleConfirm = async () => {
    if (!closeResult) return;
    const codes = methodsToCount(closeResult.declared_methods, taken);
    const r = readAmounts(confirmInputs, codes);
    if (r.ok === false) { setError(`Enter the counted amount for: ${r.missing.map((m) => methodName(m, methodOptions)).join(', ')}.`); return; }
    if (!signedInManager && !confirmPin.trim()) { setError('Enter the manager\'s PIN.'); return; }
    setLoading(true); setError('');
    try {
      const res = await posApi.post<any>(`/api/shifts/${closeResult.id}/confirm`,
        signedInManager ? { confirmed_methods: r.map } : { confirmed_methods: r.map, pin: confirmPin.trim() });
      setConfirmed({ lines: res.lines ?? [], confirmer_name: res.confirmer_name ?? null, confirmed_at: res.confirmed_at, confirm_self: !!res.confirm_self });
      setConfirmPin('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not confirm the shift');
    } finally { setLoading(false); }
  };

  const handleClose = async () => {
    if (!shiftId) return;
    const amount = parseFloat(closeFloat);
    if (isNaN(amount) || amount < 0) { setError('Enter the cash counted in the drawer'); return; }
    const declared = readAmounts(declaredInputs, toDeclare);
    if (declared.ok === false) {
      setError(`Enter the total for: ${declared.missing.map((m) => methodName(m, methodOptions)).join(', ')} (0 if none).`);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const shift = await posApi.post<Shift>(`/api/shifts/${shiftId}/close`, {
        closing_float: amount,
        notes: notes || null,
        declared_methods: declared.map,   // A365
      });
      setCloseResult(shift);
      // A273: drawer closed — drop the covered-till identity so the next open
      // re-picks. (While a shift is open the identity must persist across reloads
      // so /current keeps resolving to this till.)
      setCoveredTerminal(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to close shift');
    } finally {
      setLoading(false);
    }
  };

  const handleFloat = async () => {
    if (!shiftId) return;
    const amount = parseFloat(floatAmount);
    if (isNaN(amount) || amount <= 0) { setError('Enter an amount greater than zero'); return; }

    setLoading(true);
    setError('');
    try {
      await posApi.post(`/api/shifts/${shiftId}/float`, {
        type: floatType,
        amount,
        reason: floatReason || null,
      });
      setFloatDone(true);
      onFloatRecorded?.();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record float transaction');
    } finally {
      setLoading(false);
    }
  };

  // A362: the types list is readable by any signed-in account (A360); an empty list still lets the expense through untyped.
  useEffect(() => {
    if (mode !== 'expense') return;
    posApi.get<{ id: string; name: string }[]>('/api/expenses/categories')
      .then((rows) => setExpTypes(Array.isArray(rows) ? rows : []))
      .catch(() => setExpTypes([]));
  }, [mode, posApi]);

  const handleExpense = async () => {
    if (!shiftId) return;
    const description = expDesc.trim();
    const amount = parseFloat(expAmount);
    if (!description) { setError('Say what the money was for'); return; }
    if (isNaN(amount) || amount <= 0) { setError('Enter an amount greater than zero'); return; }

    setLoading(true);
    setError('');
    try {
      await posApi.post(`/api/shifts/${shiftId}/expense`, {
        description,
        amount,
        expense_category_id: expTypeId || undefined,
      });
      setExpDone({ description, amount });
    } catch (e: any) {
      setError(e?.message ?? 'Could not record the expense');
    } finally {
      setLoading(false);
    }
  };

  const anotherExpense = () => { setExpDone(null); setExpDesc(''); setExpAmount(''); setExpTypeId(''); setError(''); };

  // ── Clock in/out handler ────────────────────────────────────────────────────

  const handleClock = async () => {
    if (clockPin.length < 4) { setError('Enter your 4-digit PIN'); return; }
    setLoading(true); setError('');
    try {
      const result = await posApi.post<{ type: string; time: string; staff_name: string }>(
        '/api/staff/clock',
        { pin: clockPin, type: clockType, branch_id: branchId }
      );
      setClockTime(result.time);
      setClockDone(true);
      onClockRecorded?.();
    } catch (e: any) {
      setError(e?.message ?? 'Clock failed — check PIN');
    } finally {
      setLoading(false);
    }
  };

    // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={s.overlay}>
      <div style={s.modal}>

        {/* ── OPEN SHIFT ─────────────────────────────────────── */}
        {mode === 'open' && (
          <>
            <div style={s.iconRow}>
              <span style={s.icon}>🏦</span>
            </div>
            <h2 style={s.title}>{joining ? 'Join Shift' : 'Open Shift'}</h2>
            <p style={s.subtitle}>{joining
              ? 'This till\'s drawer is already open — you will sell into it. No float to count.'
              : 'Count the cash in the drawer and enter the opening float below.'}</p>

            {/* A273 — pick the till this web POS is covering so the shift folds
                into that till's drawer, not the shared web session. */}
            {othersOpen.length > 0 && webTill && (
              <p style={s.subtitle} data-testid="join-or-own">
                {othersOpen.map(t => `${t.open_shift?.opened_by_name ?? 'Another cashier'}'s shift is running on ${tillName(t)}`).join(' · ')}.
                {' '}Join it, or start your own shift on <b>{webTill.name}</b>.
              </p>
            )}
            <label style={s.label}>Which till are you selling on?</label>
            <select
              style={s.input}
              value={selectedDeviceId}
              onChange={e => setSelectedDeviceId(e.target.value)}
            >
              <option value="">{terminalsLoading ? 'Loading tills…' : 'Select a till…'}</option>
              {webTill && (
                <option value={WEB_TILL_VALUE}>
                  {webTill.name}{webTill.open_shift ? ` · ${openShiftLine({ device_id: '', terminal_code: null, device_label: webTill.name, open_shift: webTill.open_shift })}` : ' · your own shift'}
                </option>
              )}
              {terminals.map(t => (
                <option key={t.device_id} value={t.device_id}>
                  {tillName(t)}{t.open_shift ? ` · ${openShiftLine(t)}` : ''}
                </option>
              ))}
            </select>
            {!terminalsLoading && terminals.length === 0 && (
              <p style={s.subtitle}>No tills are enrolled for this branch yet. Open the desktop till once to register it.</p>
            )}

            {!joining && (<>
            <label style={s.label}>Opening Float ({currency})</label>
            <input
              style={s.input}
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 5000"
              value={openFloat}
              onChange={e => setOpenFloat(e.target.value)}
              autoFocus
            />
            </>)}

            {error && <p style={s.error}>{error}</p>}

            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose} disabled={loading}>Cancel</button>
              <button style={s.primaryBtn} onClick={handleOpen} disabled={loading}>
                {loading ? (joining ? 'Joining…' : 'Opening…') : (joining ? 'Join this drawer' : 'Open Shift')}
              </button>
            </div>
          </>
        )}

        {/* ── CLOSE SHIFT ────────────────────────────────────── */}
        {/* A366: another cashier cannot count out this drawer — its owner or a manager does (the cloud refuses too). */}
        {mode === 'close' && !closeResult && !mayClose && (
          <div data-testid="close-not-yours">
            <div style={s.iconRow}><span style={s.icon}>🔒</span></div>
            <h2 style={s.title}>Close Shift</h2>
            <p style={s.subtitle}>
              This shift belongs to {shiftOwner?.name ?? 'another cashier'}. Only {shiftOwner?.name ?? 'they'} or a manager can close it — ask them to sign in.
            </p>
            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose}>Back</button>
            </div>
          </div>
        )}
        {mode === 'close' && !closeResult && mayClose && (
          <>
            <div style={s.iconRow}><span style={s.icon}>🔒</span></div>
            <h2 style={s.title}>Close Shift</h2>
            <p style={s.subtitle}>Count the cash in the drawer. We'll calculate the variance for you.</p>

            <label style={s.label}>Cash Counted ({currency}) — include the opening float</label>
            <input
              style={s.input}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              placeholder="e.g. 12500"
              value={closeFloat}
              onChange={e => setCloseFloat(e.target.value)}
              autoFocus
            />

            {/* A365: every other method, from the M-Pesa statement, the card machine's total, the delivery app. */}
            {toDeclare.map((m) => (
              <div key={m}>
                <label style={s.label}>{methodName(m, methodOptions)} total ({currency})</label>
                <input style={s.input} type="number" min="0" step="any" inputMode="decimal" placeholder="0"
                  data-testid={`declare-${m}`}
                  value={declaredInputs[m] ?? ''} onChange={e => setDeclaredInputs({ ...declaredInputs, [m]: e.target.value })} />
              </div>
            ))}

            <label style={s.label}>Notes (required if cash doesn't match)</label>
            <textarea
              style={s.textarea}
              placeholder="Any discrepancies, handover notes…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
            />

            {error && <p style={s.error}>{error}</p>}

            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose} disabled={loading}>Cancel</button>
              <button style={{ ...s.primaryBtn, background: '#ef4444' }} onClick={handleClose} disabled={loading}>
                {loading ? 'Closing…' : 'Close Shift'}
              </button>
            </div>
          </>
        )}

        {/* ── CLOSE RESULT (reconciliation summary) ──────────── */}
        {mode === 'close' && closeResult && (
          <>
            <div style={s.iconRow}><span style={s.icon}>✅</span></div>
            <h2 style={s.title}>Shift Closed</h2>

            <div style={s.summaryBox}>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>Opening Float</span>
                <span style={s.summaryValue}>{fmt(closeResult.opening_float, currency)}</span>
              </div>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>Expected Cash</span>
                <span style={s.summaryValue}>{fmt(closeResult.expected_cash ?? 0, currency)}</span>
              </div>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>Cash Counted</span>
                <span style={s.summaryValue}>{fmt(closeResult.closing_float ?? 0, currency)}</span>
              </div>
              <div style={{ ...s.summaryDivider }} />
              <div style={s.summaryRow}>
                <span style={{ ...s.summaryLabel, fontWeight: 700 }}>Variance</span>
                <span
                  style={{
                    ...s.summaryValue,
                    fontWeight: 700,
                    color: (closeResult.cash_variance ?? 0) === 0
                      ? '#22c55e'
                      : (closeResult.cash_variance ?? 0) > 0
                        ? '#22c55e'
                        : '#ef4444',
                  }}
                >
                  {(closeResult.cash_variance ?? 0) >= 0 ? '+' : ''}
                  {fmt(closeResult.cash_variance ?? 0, currency)}
                </span>
              </div>
            </div>

            {(closeResult.cash_variance ?? 0) < 0 && (
              <p style={{ ...s.subtitle, color: '#fca5a5', marginTop: 8 }}>
                ⚠️ Cash is short. Investigate before handing over.
              </p>
            )}
            {(closeResult.cash_variance ?? 0) > 0 && (
              <p style={{ ...s.subtitle, color: '#86efac', marginTop: 8 }}>
                Cash is over — check for any unrecorded float transactions.
              </p>
            )}

            {/* A365: a manager confirms now (recommended) — or later from the dashboard's Shifts. */}
            {closeResult.declared_methods && !confirmed && !confirmStep && (
              <div data-testid="shift-awaiting" style={{ ...s.subtitle, marginTop: 12 }}>
                Awaiting manager check.
                <button style={{ ...s.primaryBtn, width: '100%', marginTop: 8 }} data-testid="confirm-now"
                  onClick={() => { setConfirmStep(true); setError(''); }}>Manager: confirm now</button>
              </div>
            )}
            {confirmStep && !confirmed && (
              <div data-testid="confirm-shift" style={{ marginTop: 12 }}>
                <p style={s.subtitle}>
                  Manager: count every payment method yourself — the drawer, the M-Pesa statement, the card machine's
                  total — and enter what you find. The cashier's figures are shown after you save.
                </p>
                {methodsToCount(closeResult.declared_methods, taken).map((m) => (
                  <div key={m}>
                    <label style={s.label}>{methodName(m, methodOptions)} counted ({currency})</label>
                    <input style={s.input} type="number" min="0" step="any" inputMode="decimal" placeholder="0"
                      data-testid={`confirm-${m}`}
                      value={confirmInputs[m] ?? ''} onChange={e => setConfirmInputs({ ...confirmInputs, [m]: e.target.value })} />
                  </div>
                ))}
                {!signedInManager && (
                  <>
                    <label style={s.label}>Manager PIN</label>
                    <input style={s.input} type="password" inputMode="numeric" value={confirmPin} onChange={e => setConfirmPin(e.target.value)} data-testid="confirm-pin" />
                  </>
                )}
                {error && <p style={s.error}>{error}</p>}
                <button style={{ ...s.primaryBtn, width: '100%', marginTop: 8 }} onClick={handleConfirm} disabled={loading}>
                  {loading ? 'Confirming…' : 'Confirm shift'}
                </button>
              </div>
            )}
            {confirmed && (
              <div data-testid="shift-confirmed" style={{ ...s.summaryBox, marginTop: 12 }}>
                <p style={{ ...s.subtitle, fontWeight: 700 }}>
                  {confirmationLabel({ status: 'confirmed', confirmed_by_name: confirmed.confirmer_name, confirmed_at: confirmed.confirmed_at, self: confirmed.confirm_self })}
                </p>
                {confirmed.lines.map((l) => (
                  <div key={l.method} style={s.summaryRow}>
                    <span style={{ ...s.summaryLabel, fontWeight: l.mismatch ? 700 : undefined }}>
                      {methodName(l.method, methodOptions)}{l.mismatch ? ` (cashier ${fmt(l.declared ?? 0, currency)})` : ''}
                    </span>
                    <span style={s.summaryValue}>
                      {fmt(l.confirmed ?? 0, currency)} / {fmt(l.expected ?? 0, currency)}
                      {Math.round((l.variance ?? 0) * 100) !== 0 ? ` (${(l.variance ?? 0) > 0 ? 'over' : 'short'} ${fmt(Math.abs(l.variance ?? 0), currency)})` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button
              style={{ ...s.primaryBtn, width: '100%', marginTop: 16 }}
              onClick={() => onShiftClosed?.(closeResult)}
            >
              Done
            </button>
          </>
        )}

        {/* ── FLOAT IN / OUT ─────────────────────────────────── */}
        {mode === 'float' && !floatDone && (
          <>
            <div style={s.iconRow}><span style={s.icon}>💵</span></div>
            <h2 style={s.title}>Cash Drawer Movement</h2>
            <p style={s.subtitle}>Record cash added to or taken from the drawer.</p>

            {/* Float type toggle */}
            <div style={s.toggle}>
              <button
                style={{ ...s.toggleBtn, ...(floatType === 'float_in' ? s.toggleActive : {}) }}
                onClick={() => setFloatType('float_in')}
              >
                ↓ Float In
              </button>
              <button
                style={{ ...s.toggleBtn, ...(floatType === 'float_out' ? s.toggleActive : {}) }}
                onClick={() => setFloatType('float_out')}
              >
                ↑ Float Out
              </button>
            </div>

            <label style={s.label}>Amount ({currency})</label>
            <input
              style={s.input}
              type="number"
              min="1"
              step="any"
              placeholder="e.g. 500"
              value={floatAmount}
              onChange={e => setFloatAmount(e.target.value)}
              autoFocus
            />

            <label style={s.label}>Reason (optional)</label>
            <input
              style={s.input}
              type="text"
              placeholder={floatType === 'float_in' ? 'e.g. Change top-up' : 'e.g. Banking run'}
              value={floatReason}
              onChange={e => setFloatReason(e.target.value)}
            />

            {error && <p style={s.error}>{error}</p>}

            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose} disabled={loading}>Cancel</button>
              <button style={s.primaryBtn} onClick={handleFloat} disabled={loading}>
                {loading ? 'Saving…' : 'Record'}
              </button>
            </div>
          </>
        )}

        {/* ── EXPENSE (A362) ──────────────────────────────────── */}
        {mode === 'expense' && !expDone && (
          <>
            <div style={s.iconRow}><span style={s.icon}>🧾</span></div>
            <h2 style={s.title}>Record an Expense</h2>
            <p style={s.subtitle}>Cash paid out of this drawer — it comes off the shift's expected cash.</p>

            <label style={s.label}>Expense type</label>
            <select
              style={s.input}
              value={expTypeId}
              onChange={e => setExpTypeId(e.target.value)}
              data-testid="expense-type"
            >
              <option value="">{expTypes.length ? '— Select a type —' : 'No types yet (a manager adds them)'}</option>
              {expTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>

            <label style={s.label}>What was it for?</label>
            <input
              style={s.input}
              type="text"
              maxLength={255}
              placeholder="e.g. Gas refill"
              value={expDesc}
              onChange={e => setExpDesc(e.target.value)}
              autoFocus
            />

            <label style={s.label}>Amount ({currency})</label>
            <input
              style={s.input}
              type="number"
              min="1"
              step="any"
              placeholder="e.g. 500"
              value={expAmount}
              onChange={e => setExpAmount(e.target.value)}
            />

            {error && <p style={s.error}>{error}</p>}

            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose} disabled={loading}>Cancel</button>
              <button style={s.primaryBtn} onClick={handleExpense} disabled={loading}>
                {loading ? 'Saving…' : 'Record'}
              </button>
            </div>
          </>
        )}

        {mode === 'expense' && expDone && (
          <>
            <div style={s.iconRow}><span style={s.icon}>✅</span></div>
            <h2 style={s.title}>Expense recorded</h2>
            <p style={s.subtitle}>{expDone.description} — {fmt(expDone.amount, currency)}, recorded under your name.</p>
            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={anotherExpense}>Record another</button>
              <button style={s.primaryBtn} onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {/* ── FLOAT DONE ─────────────────────────────────────── */}
        {mode === 'float' && floatDone && (
          <>
            <div style={s.iconRow}><span style={s.icon}>✅</span></div>
            <h2 style={s.title}>Recorded</h2>
            <p style={s.subtitle}>Cash drawer movement saved successfully.</p>
            <button style={{ ...s.primaryBtn, width: '100%', marginTop: 8 }} onClick={onClose}>
              Close
            </button>
          </>
        )}

      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
  },
  modal: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 16,
    padding: '28px 28px 24px', width: 340, maxWidth: '92vw',
    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
  },
  iconRow: { textAlign: 'center', marginBottom: 10 },
  icon:    { fontSize: 36 },
  title:   { margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: '#f1f5f9', textAlign: 'center' },
  subtitle:{ margin: '0 0 20px', fontSize: 13, color: '#94a3b8', textAlign: 'center', lineHeight: 1.5 },
  label:   { display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: {
    width: '100%', padding: '11px 13px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#f1f5f9', fontSize: 15, marginBottom: 14,
    boxSizing: 'border-box', outline: 'none',
  },
  textarea: {
    width: '100%', padding: '10px 13px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#f1f5f9', fontSize: 13, marginBottom: 14, resize: 'none',
    boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  },
  error:  { margin: '0 0 12px', fontSize: 13, color: '#fca5a5', textAlign: 'center' },
  actions:{ display: 'flex', gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1, padding: '11px 0', background: '#334155', border: 'none',
    borderRadius: 10, color: '#94a3b8', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  },
  primaryBtn: {
    flex: 1, padding: '11px 0', background: 'rgb(var(--act-strong, 59 130 246))', border: 'none',
    borderRadius: 10, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
  },
  toggle: { display: 'flex', gap: 8, marginBottom: 16 },
  toggleBtn: {
    flex: 1, padding: '10px 0', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#64748b', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  toggleActive: {
    background: 'rgb(var(--act-fill, 59 130 246) / 0.15)', border: '1px solid rgb(var(--act-fill, 59 130 246))', color: '#93c5fd',
  },
  summaryBox: {
    background: '#0f172a', border: '1px solid #334155', borderRadius: 10,
    padding: '14px 16px', margin: '0 0 4px',
  },
  summaryRow: { display: 'flex', justifyContent: 'space-between', padding: '5px 0' },
  summaryLabel: { fontSize: 13, color: '#94a3b8' },
  summaryValue: { fontSize: 13, color: '#f1f5f9' },
  summaryDivider: { borderTop: '1px solid #334155', margin: '8px 0' },
};
