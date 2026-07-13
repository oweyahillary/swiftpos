/**
 * MpesaStkPanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the existing manual M-Pesa reference flow with full Daraja STK push.
 * Falls back gracefully to manual reference if STK push fails or isn't configured.
 *
 * USAGE in PaymentModal.tsx:
 *
 *   import MpesaStkPanel from './MpesaStkPanel';
 *
 *   // Replace the existing M-Pesa tab content:
 *   {method === 'mpesa' && (
 *     <MpesaStkPanel
 *       total={total}
 *       currency={currency}
 *       orderId={pendingOrderId}   // create the order first, pass its id
 *       onSuccess={(ref) => handlePaymentSuccess('mpesa', ref)}
 *       onCancel={() => setMethod('cash')}
 *     />
 *   )}
 */

import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';

type Mode = 'input' | 'waiting' | 'success' | 'failed' | 'manual';

interface Props {
  total: number;
  currency: string;
  orderId: string;
  onSuccess: (mpesaRef: string) => void;
  onCancel: () => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_SECS    = 60;

export default function MpesaStkPanel({ total, currency, orderId, onSuccess, onCancel }: Props) {
  const [mode, setMode]         = useState<Mode>('input');
  const [phone, setPhone]       = useState('');
  const [manualRef, setManualRef] = useState('');
  const [checkoutId, setCheckoutId] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(MAX_WAIT_SECS);
  const [error, setError]       = useState('');
  const [mpesaConfigured, setMpesaConfigured] = useState<boolean | null>(null);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check if M-Pesa STK push is configured for this business
  useEffect(() => {
    api.get<{ configured: boolean }>('/api/mpesa/config')
      .then(d => setMpesaConfigured(d.configured))
      .catch(() => setMpesaConfigured(false));
  }, []);

  function cleanup() {
    if (pollRef.current)  clearInterval(pollRef.current);
    if (countRef.current) clearInterval(countRef.current);
  }

  useEffect(() => () => cleanup(), []);

  async function initiatePush() {
    if (!phone.trim()) { setError('Enter the customer phone number'); return; }
    setError('');
    setMode('waiting');
    setSecondsLeft(MAX_WAIT_SECS);

    try {
      const res = await api.post<{ checkoutRequestId: string }>('/api/mpesa/stk-push', {
        phone:    phone.trim(),
        amount:   Math.ceil(total),
        order_id: orderId,
        account_reference: orderId.slice(-12),
        description: 'SwiftPOS payment',
      });

      setCheckoutId(res.checkoutRequestId);

      // Countdown
      countRef.current = setInterval(() => {
        setSecondsLeft(s => {
          if (s <= 1) { cleanup(); setMode('failed'); setError('Timed out — customer did not respond'); return 0; }
          return s - 1;
        });
      }, 1000);

      // Poll status
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.get<{ status: string; mpesaRef?: string; error?: string }>(
            `/api/mpesa/status/${res.checkoutRequestId}`
          );

          if (status.status === 'completed') {
            cleanup();
            setMode('success');
            setTimeout(() => onSuccess(status.mpesaRef ?? ''), 1500);
          } else if (status.status === 'failed' || status.status === 'cancelled') {
            cleanup();
            setMode('failed');
            setError(status.error ?? 'Payment failed or cancelled');
          }
        } catch { /* poll errors are transient — keep polling */ }
      }, POLL_INTERVAL_MS);

    } catch (err: any) {
      setMode('failed');
      setError(err.message ?? 'Failed to initiate M-Pesa payment');
    }
  }

  function fmt(n: number) {
    return `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────

  // Loading config
  if (mpesaConfigured === null) {
    return <div style={s.center}><div style={s.spinner} /></div>;
  }

  // STK not configured — show manual ref only
  if (!mpesaConfigured || mode === 'manual') {
    return (
      <div style={s.root}>
        <div style={s.manualHeader}>
          <div style={s.icon}>📱</div>
          <div style={s.methodTitle}>M-Pesa — manual reference</div>
          {mpesaConfigured && (
            <button style={s.linkBtn} onClick={() => setMode('input')}>← Use STK push instead</button>
          )}
        </div>
        <p style={s.hint}>
          Ask the customer to send <strong>{fmt(total)}</strong> to your till/paybill,
          then enter the M-Pesa confirmation code below.
        </p>
        <div style={s.field}>
          <label style={s.fieldLabel}>M-Pesa code</label>
          <input
            style={s.input}
            placeholder="e.g. QJK7XT3L5P"
            value={manualRef}
            onChange={e => setManualRef(e.target.value.toUpperCase())}
            maxLength={12}
            autoFocus
          />
        </div>
        <div style={s.actions}>
          <button style={s.btnCancel} onClick={onCancel}>Cancel</button>
          <button
            style={{ ...s.btnConfirm, opacity: manualRef.length >= 8 ? 1 : 0.4 }}
            disabled={manualRef.length < 8}
            onClick={() => onSuccess(manualRef)}
          >
            Confirm payment
          </button>
        </div>
      </div>
    );
  }

  // ── STK push input ─────────────────────────────────────────────────────────
  if (mode === 'input') {
    return (
      <div style={s.root}>
        <div style={s.header}>
          <div style={s.icon}>📲</div>
          <div style={s.methodTitle}>M-Pesa STK push</div>
          <div style={s.amountBig}>{fmt(total)}</div>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel}>Customer phone number</label>
          <div style={s.phoneWrap}>
            <span style={s.phonePrefix}>+254</span>
            <input
              style={s.phoneInput}
              placeholder="7XX XXX XXX"
              value={phone.replace(/^(\+?254|0)/, '')}
              onChange={e => setPhone('0' + e.target.value.replace(/\D/g, '').slice(0, 9))}
              maxLength={9}
              autoFocus
              onKeyDown={e => e.key === 'Enter' && initiatePush()}
            />
          </div>
          <div style={s.fieldHint}>Customer will receive a payment prompt on their phone</div>
        </div>

        {error && <div style={s.errorBox}>{error}</div>}

        <div style={s.actions}>
          <button style={s.btnCancel} onClick={onCancel}>Cancel</button>
          <button style={s.btnConfirm} onClick={initiatePush}>
            Send payment request
          </button>
        </div>

        <button style={s.manualLink} onClick={() => setMode('manual')}>
          Enter M-Pesa code manually instead
        </button>
      </div>
    );
  }

  // ── Waiting for customer ───────────────────────────────────────────────────
  if (mode === 'waiting') {
    return (
      <div style={s.root}>
        <div style={s.waitingCenter}>
          <div style={s.pulseRing}>
            <div style={s.pulseInner}>📱</div>
          </div>
          <div style={s.waitingTitle}>Waiting for payment</div>
          <div style={s.waitingAmount}>{fmt(total)}</div>
          <div style={s.waitingPhone}>Prompt sent to {phone}</div>

          {/* Countdown bar */}
          <div style={s.countdownBar}>
            <div style={{
              ...s.countdownFill,
              width: `${(secondsLeft / MAX_WAIT_SECS) * 100}%`,
              background: secondsLeft < 15 ? '#ef4444' : '#22c55e',
            }} />
          </div>
          <div style={s.countdownLabel}>{secondsLeft}s remaining</div>
        </div>

        <div style={s.actions}>
          <button style={s.btnCancel} onClick={() => { cleanup(); setMode('input'); }}>
            Cancel
          </button>
          <button style={{ ...s.btnCancel, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}
            onClick={() => { cleanup(); setMode('manual'); }}>
            Enter code manually
          </button>
        </div>
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (mode === 'success') {
    return (
      <div style={s.root}>
        <div style={s.successCenter}>
          <div style={s.successIcon}>✓</div>
          <div style={s.successTitle}>Payment received</div>
          <div style={s.successAmount}>{fmt(total)}</div>
          <div style={s.successSub}>M-Pesa payment confirmed</div>
        </div>
      </div>
    );
  }

  // ── Failed ─────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <div style={s.failedCenter}>
        <div style={s.failedIcon}>✕</div>
        <div style={s.failedTitle}>Payment failed</div>
        <div style={s.failedReason}>{error}</div>
      </div>
      <div style={s.actions}>
        <button style={s.btnCancel} onClick={onCancel}>Cancel</button>
        <button style={s.btnConfirm} onClick={() => { setMode('input'); setError(''); }}>
          Try again
        </button>
        <button style={{ ...s.btnCancel, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}
          onClick={() => setMode('manual')}>
          Manual code
        </button>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0', fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  center: { display: 'flex', justifyContent: 'center', padding: 32 },
  spinner: { width: 28, height: 28, border: '3px solid #334155', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  header: { textAlign: 'center', paddingBottom: 8 },
  icon: { fontSize: 32, marginBottom: 8 },
  methodTitle: { fontSize: 13, color: '#64748b', marginBottom: 4 },
  amountBig: { fontSize: 28, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' },
  fieldHint: { fontSize: 11, color: '#475569', marginTop: 2 },
  phoneWrap: { display: 'flex', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' },
  phonePrefix: { padding: '11px 12px', fontSize: 14, color: '#64748b', background: '#1e293b', borderRight: '1px solid #334155', flexShrink: 0 },
  phoneInput: { flex: 1, background: 'transparent', border: 'none', outline: 'none', padding: '11px 14px', color: '#f1f5f9', fontSize: 16, fontWeight: 700, fontFamily: "'DM Sans','Segoe UI',sans-serif", letterSpacing: '0.05em' },
  input: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '11px 14px', color: '#f1f5f9', fontSize: 16, outline: 'none', fontFamily: "'DM Sans','Segoe UI',sans-serif", letterSpacing: '0.08em', textTransform: 'uppercase' },
  errorBox: { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#fca5a5' },
  actions: { display: 'flex', gap: 10 },
  btnCancel: { flex: 1, padding: '12px', background: 'transparent', border: '1px solid #334155', borderRadius: 10, color: '#94a3b8', fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  btnConfirm: { flex: 2, padding: '12px', background: 'linear-gradient(135deg,#16a34a,#22c55e)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  manualLink: { background: 'transparent', border: 'none', color: '#475569', fontSize: 12, cursor: 'pointer', textAlign: 'center', textDecoration: 'underline', padding: '4px', fontFamily: "'DM Sans','Segoe UI',sans-serif" },

  // Manual
  manualHeader: { textAlign: 'center' },
  hint: { fontSize: 13, color: '#64748b', lineHeight: 1.6, textAlign: 'center' },
  linkBtn: { background: 'transparent', border: 'none', color: '#60a5fa', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif" },

  // Waiting
  waitingCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 10 },
  pulseRing: { width: 80, height: 80, borderRadius: '50%', background: 'rgba(34,197,94,0.1)', border: '2px solid rgba(34,197,94,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1.5s ease-in-out infinite' },
  pulseInner: { fontSize: 32 },
  waitingTitle: { fontSize: 16, fontWeight: 700, color: '#f1f5f9' },
  waitingAmount: { fontSize: 24, fontWeight: 700, color: '#22c55e', fontVariantNumeric: 'tabular-nums' },
  waitingPhone: { fontSize: 12, color: '#64748b' },
  countdownBar: { width: '100%', height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' },
  countdownFill: { height: '100%', borderRadius: 2, transition: 'width 1s linear, background 0.3s' },
  countdownLabel: { fontSize: 12, color: '#64748b', fontVariantNumeric: 'tabular-nums' },

  // Success
  successCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 10 },
  successIcon: { width: 64, height: 64, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', border: '2px solid rgba(34,197,94,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: '#22c55e', fontWeight: 700 },
  successTitle: { fontSize: 18, fontWeight: 700, color: '#22c55e' },
  successAmount: { fontSize: 28, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },
  successSub: { fontSize: 13, color: '#64748b' },

  // Failed
  failedCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 10 },
  failedIcon: { width: 56, height: 56, borderRadius: '50%', background: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: '#ef4444', fontWeight: 700 },
  failedTitle: { fontSize: 16, fontWeight: 700, color: '#ef4444' },
  failedReason: { fontSize: 13, color: '#64748b', textAlign: 'center', maxWidth: 280 },
};
