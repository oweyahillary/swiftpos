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
}

export type ShiftModalMode = 'open' | 'close' | 'float' | 'clockin';

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
  const { posApi } = usePOSAuth();

  // Shared
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Open shift
  const [openFloat, setOpenFloat] = useState('');

  // Close shift
  const [closeFloat, setCloseFloat] = useState('');
  const [notes, setNotes]           = useState('');
  const [closeResult, setCloseResult] = useState<Shift | null>(null);

  // Float in/out
  const [floatType, setFloatType]   = useState<'float_in' | 'float_out'>('float_in');
  const [floatAmount, setFloatAmount] = useState('');
  const [floatReason, setFloatReason] = useState('');
  const [floatDone, setFloatDone]   = useState(false);

  // Clock in/out
  const [clockPin, setClockPin]       = useState('');
  const [clockType, setClockType]     = useState<'in' | 'out'>('in');
  const [clockDone, setClockDone]     = useState(false);
  const [clockTime, setClockTime]     = useState('');

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleOpen = async () => {
    if (!branchId) { setError('Branch not found'); return; }
    const amount = parseFloat(openFloat);
    if (isNaN(amount) || amount < 0) { setError('Enter a valid opening float (0 or more)'); return; }

    setLoading(true);
    setError('');
    try {
      const shift = await posApi.post<Shift>('/api/shifts/open', {
        branch_id: branchId,
        opening_float: amount,
      });
      onShiftOpened?.(shift);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to open shift');
    } finally {
      setLoading(false);
    }
  };


  const handleClose = async () => {
    if (!shiftId) return;
    const amount = parseFloat(closeFloat);
    if (isNaN(amount) || amount < 0) { setError('Enter the cash counted in the drawer'); return; }

    setLoading(true);
    setError('');
    try {
      const shift = await posApi.post<Shift>(`/api/shifts/${shiftId}/close`, {
        closing_float: amount,
        notes: notes || null,
      });
      setCloseResult(shift);
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
            <h2 style={s.title}>Open Shift</h2>
            <p style={s.subtitle}>Count the cash in the drawer and enter the opening float below.</p>

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

            {error && <p style={s.error}>{error}</p>}

            <div style={s.actions}>
              <button style={s.cancelBtn} onClick={onClose} disabled={loading}>Cancel</button>
              <button style={s.primaryBtn} onClick={handleOpen} disabled={loading}>
                {loading ? 'Opening…' : 'Open Shift'}
              </button>
            </div>
          </>
        )}

        {/* ── CLOSE SHIFT ────────────────────────────────────── */}
        {mode === 'close' && !closeResult && (
          <>
            <div style={s.iconRow}><span style={s.icon}>🔒</span></div>
            <h2 style={s.title}>Close Shift</h2>
            <p style={s.subtitle}>Count the cash in the drawer. We'll calculate the variance for you.</p>

            <label style={s.label}>Cash Counted ({currency})</label>
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
    flex: 1, padding: '11px 0', background: '#3b82f6', border: 'none',
    borderRadius: 10, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
  },
  toggle: { display: 'flex', gap: 8, marginBottom: 16 },
  toggleBtn: {
    flex: 1, padding: '10px 0', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#64748b', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  toggleActive: {
    background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6', color: '#93c5fd',
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
