/**
 * SplitPaymentPanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Split payment UI for SwiftPOS PaymentModal.
 * Inspired by: Square POS, Lightspeed, Toast, Stripe Terminal.
 *
 * FEATURES
 * ────────
 *  • Add up to 4 payment legs (Cash / M-Pesa / Card / Credit)
 *  • Live remainder tracker — shows exactly how much is still owed
 *  • Per-leg amount entry with quick-fill (exact, half, remainder)
 *  • M-Pesa reference field appears when M-Pesa leg is added
 *  • Validation: sum of all legs must equal order total before charge
 *  • Animated remainder bar
 *  • Fully keyboard-navigable
 *
 * USAGE INSIDE PaymentModal.tsx
 * ──────────────────────────────
 * Add a "Split" tab to the existing Cash / M-Pesa / Card tabs:
 *
 *   import SplitPaymentPanel from './SplitPaymentPanel';
 *
 *   {activeTab === 'split' && (
 *     <SplitPaymentPanel
 *       total={total}
 *       currency={currency}
 *       onConfirm={(legs) => handleSplitPayment(legs)}
 *     />
 *   )}
 *
 * The `legs` array passed to onConfirm matches the payments table shape:
 *   [{ method: 'cash'|'mpesa'|'card'|'credit', amount: number, reference?: string }]
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentMethod = 'cash' | 'mpesa' | 'card' | 'credit';

export interface PaymentLeg {
  id: string;
  method: PaymentMethod;
  amount: number;
  reference?: string;
}

interface Props {
  total: number;
  currency: string;
  onConfirm: (legs: PaymentLeg[]) => void;
  onCancel?: () => void;
  /** If false, hides M-Pesa option (e.g. no Daraja keys configured) */
  mpesaEnabled?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const METHOD_META: Record<PaymentMethod, { label: string; icon: string; colour: string }> = {
  cash:   { label: 'Cash',    icon: '💵', colour: '#22c55e' },
  mpesa:  { label: 'M-Pesa',  icon: '📱', colour: '#16a34a' },
  card:   { label: 'Card',    icon: '💳', colour: '#3b82f6' },
  credit: { label: 'Credit',  icon: '🗒', colour: '#f59e0b' },
};

const ALL_METHODS: PaymentMethod[] = ['cash', 'mpesa', 'card', 'credit'];

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SplitPaymentPanel({
  total, currency, onConfirm, onCancel, mpesaEnabled = true,
}: Props) {

  const [legs, setLegs] = useState<PaymentLeg[]>([
    { id: uid(), method: 'cash', amount: 0 },
  ]);

  const lastInputRef = useRef<HTMLInputElement>(null);

  const allocated = legs.reduce((s, l) => s + l.amount, 0);
  const remainder = Math.max(0, total - allocated);
  const overage   = allocated > total ? allocated - total : 0;
  const pct       = Math.min(100, (allocated / total) * 100);
  const canCharge = Math.abs(allocated - total) < 0.01 && legs.every(l => l.amount > 0);

  // Auto-focus last added leg's amount input
  useEffect(() => {
    lastInputRef.current?.focus();
  }, [legs.length]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const updateLeg = useCallback((id: string, patch: Partial<PaymentLeg>) => {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  }, []);

  const removeLeg = useCallback((id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  function addLeg(method: PaymentMethod) {
    // Default amount = remainder
    setLegs(prev => [...prev, {
      id: uid(),
      method,
      amount: Math.max(0, total - prev.reduce((s, l) => s + l.amount, 0)),
    }]);
  }

  function quickFill(id: string, mode: 'exact' | 'half' | 'remainder') {
    const others = legs.filter(l => l.id !== id).reduce((s, l) => s + l.amount, 0);
    let amount = 0;
    if (mode === 'exact')     amount = total;
    if (mode === 'half')      amount = Math.ceil(total / 2);
    if (mode === 'remainder') amount = Math.max(0, total - others);
    updateLeg(id, { amount: parseFloat(amount.toFixed(2)) });
  }

  const usedMethods = new Set(legs.map(l => l.method));
  const availableMethods = ALL_METHODS.filter(m => {
    if (m === 'mpesa' && !mpesaEnabled) return false;
    return !usedMethods.has(m);
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>

      {/* ── Order total ───────────────────────────────────────────────────── */}
      <div style={s.totalRow}>
        <span style={s.totalLabel}>Order total</span>
        <span style={s.totalValue}>{fmt(total, currency)}</span>
      </div>

      {/* ── Allocation progress bar ───────────────────────────────────────── */}
      <div style={s.progressWrap}>
        <div style={s.progressTrack}>
          <div style={{
            ...s.progressFill,
            width: `${pct}%`,
            background: canCharge ? '#22c55e' : overage > 0 ? '#ef4444' : '#3b82f6',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            Allocated: {fmt(allocated, currency)}
          </span>
          {remainder > 0.01 && (
            <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>
              Still owed: {fmt(remainder, currency)}
            </span>
          )}
          {overage > 0.01 && (
            <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>
              Over by: {fmt(overage, currency)}
            </span>
          )}
          {canCharge && (
            <span style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
              ✓ Balanced
            </span>
          )}
        </div>
      </div>

      {/* ── Payment legs ─────────────────────────────────────────────────── */}
      <div style={s.legs}>
        {legs.map((leg, idx) => {
          const meta = METHOD_META[leg.method];
          const isLast = idx === legs.length - 1;
          return (
            <div key={leg.id} style={s.legCard}>
              {/* Leg header */}
              <div style={s.legHeader}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{meta.icon}</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                      {meta.label}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>
                      Payment leg {idx + 1}
                    </div>
                  </div>
                </div>
                {legs.length > 1 && (
                  <button style={s.removeLeg} onClick={() => removeLeg(leg.id)} title="Remove">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                )}
              </div>

              {/* Amount row */}
              <div style={s.amountRow}>
                <div style={s.currencyPrefix}>{currency}</div>
                <input
                  ref={isLast ? lastInputRef : undefined}
                  style={s.amountInput}
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="0.00"
                  value={leg.amount || ''}
                  onChange={e => updateLeg(leg.id, { amount: parseFloat(e.target.value) || 0 })}
                />
              </div>

              {/* Quick-fill chips */}
              <div style={s.quickFill}>
                <button style={s.qfChip} onClick={() => quickFill(leg.id, 'remainder')}>
                  Remainder ({fmt(Math.max(0, total - legs.filter(l => l.id !== leg.id).reduce((s, l) => s + l.amount, 0)), currency)})
                </button>
                <button style={s.qfChip} onClick={() => quickFill(leg.id, 'half')}>
                  Half
                </button>
                <button style={s.qfChip} onClick={() => quickFill(leg.id, 'exact')}>
                  Full total
                </button>
              </div>

              {/* M-Pesa reference field */}
              {leg.method === 'mpesa' && (
                <div style={s.referenceWrap}>
                  <label style={s.refLabel}>M-Pesa reference code</label>
                  <input
                    style={s.refInput}
                    placeholder="e.g. QJK7XT3L5P"
                    value={leg.reference ?? ''}
                    onChange={e => updateLeg(leg.id, { reference: e.target.value.toUpperCase() })}
                    maxLength={12}
                  />
                </div>
              )}

              {/* Card reference */}
              {leg.method === 'card' && (
                <div style={s.referenceWrap}>
                  <label style={s.refLabel}>Card approval code (optional)</label>
                  <input
                    style={s.refInput}
                    placeholder="e.g. 123456"
                    value={leg.reference ?? ''}
                    onChange={e => updateLeg(leg.id, { reference: e.target.value })}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Add another payment method ───────────────────────────────────── */}
      {availableMethods.length > 0 && legs.length < 4 && (
        <div style={s.addMethodRow}>
          <span style={s.addMethodLabel}>+ Add payment method</span>
          <div style={s.addMethodBtns}>
            {availableMethods.map(m => (
              <button
                key={m}
                style={s.addMethodBtn}
                onClick={() => addLeg(m)}
              >
                {METHOD_META[m].icon} {METHOD_META[m].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div style={s.actions}>
        {onCancel && (
          <button style={s.btnCancel} onClick={onCancel}>Cancel</button>
        )}
        <button
          style={{
            ...s.btnCharge,
            opacity: canCharge ? 1 : 0.4,
            cursor: canCharge ? 'pointer' : 'not-allowed',
          }}
          disabled={!canCharge}
          onClick={() => onConfirm(legs)}
        >
          {canCharge
            ? `Charge ${fmt(total, currency)}`
            : remainder > 0.01
              ? `Still owed ${fmt(remainder, currency)}`
              : `Over by ${fmt(overage, currency)}`
          }
        </button>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 16,
    fontFamily: "'DM Sans','Segoe UI',sans-serif", color: '#f1f5f9',
  },

  totalRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 16px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 10,
  },
  totalLabel: { fontSize: 13, color: '#64748b' },
  totalValue: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },

  progressWrap: { padding: '0 2px' },
  progressTrack: { height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s ease, background 0.2s' },

  legs: { display: 'flex', flexDirection: 'column', gap: 10 },

  legCard: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '14px',
  },
  legHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12,
  },
  removeLeg: {
    background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
    color: '#64748b', cursor: 'pointer', padding: '5px',
    display: 'flex', alignItems: 'center',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  amountRow: {
    display: 'flex', alignItems: 'center', gap: 0,
    background: '#0f172a', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden',
    marginBottom: 10,
  },
  currencyPrefix: {
    padding: '10px 12px', fontSize: 13, color: '#64748b',
    background: '#0f172a', borderRight: '1px solid #334155', flexShrink: 0,
  },
  amountInput: {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    padding: '10px 14px', color: '#f1f5f9', fontSize: 18, fontWeight: 700,
    fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  quickFill: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 },
  qfChip: {
    padding: '4px 10px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 20, color: '#64748b', fontSize: 11, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  referenceWrap: { marginTop: 10 },
  refLabel: { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' },
  refInput: {
    width: '100%', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, padding: '9px 12px', color: '#f1f5f9', fontSize: 14,
    outline: 'none', boxSizing: 'border-box', letterSpacing: '0.08em',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  addMethodRow: {
    padding: '12px', background: 'rgba(59,130,246,0.04)',
    border: '1px dashed rgba(59,130,246,0.2)', borderRadius: 10,
  },
  addMethodLabel: { fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  addMethodBtns: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  addMethodBtn: {
    padding: '7px 14px', background: '#1e293b', border: '1px solid #334155',
    borderRadius: 8, color: '#94a3b8', fontSize: 13, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  actions: { display: 'flex', gap: 10 },
  btnCancel: {
    flex: 1, padding: '13px', background: 'transparent',
    border: '1px solid #334155', borderRadius: 10, color: '#94a3b8',
    fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  btnCharge: {
    flex: 2, padding: '13px',
    background: 'linear-gradient(135deg,#1d4ed8,#2563eb)',
    border: 'none', borderRadius: 10, color: '#fff',
    fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans','Segoe UI',sans-serif",
    transition: 'opacity 0.2s',
  },
};
