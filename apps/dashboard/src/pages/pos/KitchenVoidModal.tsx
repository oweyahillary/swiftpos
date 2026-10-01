import { useState } from 'react';
import { KITCHEN_VOID_REASONS, KITCHEN_VOID_NOTE_MAX } from '../../lib/kitchenLines';

/**
 * KitchenVoidModal (web POS) — 0.6.28: taking back items already sent to the kitchen (an open order on the cloud).
 *
 * Owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash — "the cashier pockets the money".
 * The same rule as the till's: a reason, whether the kitchen had already made it, and — with the client's
 * 'kitchen_void_approval' switch — a manager (signed in as themselves, or their PIN; no grace period). The cloud
 * recomputes the order and records the void (POST /api/orders/:id/kitchen-void); the kitchen gets a VOID ticket.
 */
export interface KitchenVoidLine { order_item_id: string; name: string; qty: number; amount: number }

interface Props {
  title: string;
  orderNumber: string;
  lines: KitchenVoidLine[];
  needsManager: boolean;
  /** The signed-in person may approve themselves (a manager) — no PIN asked. */
  signedInManager: boolean;
  currency: string;
  onSubmit: (v: { reason: string; cooked: boolean; note: string | null; pin?: string }) => Promise<void>;
  onClose: () => void;
}

export default function KitchenVoidModal({ title, orderNumber, lines, needsManager, signedInManager, currency, onSubmit, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [cooked, setCooked] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const askPin = needsManager && !signedInManager;
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const money = (n: number) => `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const submit = async () => {
    if (!reason) { setError('Choose why these items are being taken back.'); return; }
    if (cooked === null) { setError('Say whether the kitchen had already made them.'); return; }
    if (askPin && !pin.trim()) { setError('A manager must approve this. Enter a manager’s PIN.'); return; }
    setBusy(true); setError('');
    try {
      await onSubmit({ reason, cooked, note: note.trim() || null, pin: askPin ? pin.trim() : undefined });
    } catch (e: any) {
      setError(e?.message ?? 'Could not void these items.');
      setBusy(false);
    }
  };

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.card} onClick={(e) => e.stopPropagation()} data-testid="kitchen-void">
        <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>{title}</div>
        <div style={st.warn}>
          Already sent to the kitchen (order #{orderNumber}). Taking it back is a kitchen void: the kitchen gets a VOID
          ticket and it shows on the Z-report{needsManager ? ', approved by a manager' : ''}.
        </div>
        {lines.map((l) => (
          <div key={l.order_item_id} style={st.row}><span>{l.qty} × {l.name}</span><span>{money(l.amount)}</span></div>
        ))}
        <div style={{ ...st.row, fontWeight: 600, borderTop: '1px solid #334155', paddingTop: 4 }}><span>Total</span><span>{money(total)}</span></div>
        {error && <div style={st.err}>{error}</div>}
        <div style={st.label}>Why?</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {KITCHEN_VOID_REASONS.map((r) => (
            <button key={r.code} type="button" onClick={() => setReason(r.code)} data-testid={`kv-reason-${r.code}`}
                    style={{ ...st.opt, ...(reason === r.code ? st.optOn : {}) }}>{r.label}</button>
          ))}
        </div>
        <div style={st.label}>Had the kitchen already made it?</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[{ v: false, label: 'No — not made yet' }, { v: true, label: 'Yes — already made' }].map((o) => (
            <button key={String(o.v)} type="button" onClick={() => setCooked(o.v)} data-testid={`kv-cooked-${o.v}`}
                    style={{ ...st.opt, flex: 1, ...(cooked === o.v ? st.optOn : {}) }}>{o.label}</button>
          ))}
        </div>
        <input value={note} maxLength={KITCHEN_VOID_NOTE_MAX} onChange={(e) => setNote(e.target.value)}
               placeholder="Note (optional)" style={{ ...st.input, marginTop: 10 }} />
        {askPin && (
          <>
            <div style={st.label}>Manager PIN</div>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} style={st.input} data-testid="kv-pin" />
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button style={st.danger} disabled={busy} onClick={() => void submit()}>{busy ? 'Voiding…' : `Void ${money(total)}`}</button>
          <button style={st.plain} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { background: '#0f172a', border: '1px solid #334155', borderRadius: 14, width: '100%', maxWidth: 440, padding: 18, maxHeight: '90vh', overflowY: 'auto' },
  warn: { fontSize: 12, color: '#fcd34d', background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '8px 10px', marginBottom: 10 },
  row: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#e2e8f0', padding: '2px 0' },
  err: { fontSize: 13, color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, padding: '6px 10px', marginTop: 10 },
  label: { fontSize: 12, color: '#cbd5e1', margin: '12px 0 6px' },
  opt: { textAlign: 'left', fontSize: 13, color: '#cbd5e1', background: 'transparent', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', cursor: 'pointer' },
  optOn: { borderColor: 'rgb(var(--act-strong, 59 130 246))', color: '#fff', background: 'rgb(var(--act-fill, 59 130 246) / 0.12)' },
  input: { width: '100%', background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', color: '#f1f5f9', fontSize: 13, boxSizing: 'border-box' },
  danger: { flex: 1, background: '#ef4444', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 700, padding: '10px 0', cursor: 'pointer' },
  plain: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#cbd5e1', padding: '10px 14px', cursor: 'pointer' },
};
