/**
 * KitchenVoidModal — 0.6.28: taking back items that were already sent to the kitchen.
 *
 * Owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash — "the cashier pockets the money".
 * Sent items now leave an order only through here: a reason, whether the food was already made, and — with the client's
 * 'kitchen_void_approval' switch — a manager (signed in as themselves, or their PIN; no grace period). The kitchen gets a
 * VOID ticket and the void is on the Z-report.
 */
import { useEffect, useState } from 'react';
import { posApi, type KitchenLinePayload } from '../lib/posApi';
import { KITCHEN_VOID_REASONS, KITCHEN_VOID_NOTE_MAX } from '../../shared/kitchenLines';

interface Props {
  orderNumber: string;
  orderType?: string;
  tableNumber?: string;
  lines: KitchenLinePayload[];
  /** The client's 'kitchen_void_approval' switch. */
  needsManager: boolean;
  currency: string;
  /** What the cashier is doing — "Remove 1 × Chicken", "Clear the order". */
  title: string;
  onDone: (r: { total: number; approvedBy: string | null; skipped: string[] }) => void;
  onClose: () => void;
}

export default function KitchenVoidModal({ orderNumber, orderType, tableNumber, lines, needsManager, currency, title, onDone, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [cooked, setCooked] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [signedInManager, setSignedInManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (needsManager) posApi.shift.canConfirm().then((v) => setSignedInManager(v === true)).catch(() => setSignedInManager(false));
  }, [needsManager]);

  const total = lines.reduce((s, l) => s + l.unit_price * l.qty, 0);
  const money = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const askPin = needsManager && !signedInManager;

  const submit = async () => {
    if (!reason) { setError('Choose why these items are being taken back.'); return; }
    if (cooked === null) { setError('Say whether the kitchen had already made them.'); return; }
    if (askPin && !pin.trim()) { setError('A manager must approve this. Enter a manager’s PIN.'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.kitchen.void({
        order_number: orderNumber, lines, reason, cooked, note: note.trim() || undefined,
        pin: askPin ? pin.trim() : undefined, order_type: orderType, table_number: tableNumber || undefined,
      });
      setPin('');
      onDone({ total: r.total, approvedBy: r.approvedBy, skipped: r.skipped ?? [] });
    } catch (e: any) {
      setError(e?.message ?? 'Could not void these items.');
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-action-500';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-[60]" data-testid="kitchen-void">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold">{title}</h2>
          <button onClick={onClose} className="text-gray-300 hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <p className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
            Already sent to the kitchen (order #{orderNumber}). Taking it back is a kitchen void: the kitchen gets a VOID
            ticket and it shows on the Z-report{needsManager ? ', approved by a manager' : ''}.
          </p>
          <ul className="text-sm text-gray-200 space-y-1" data-testid="kitchen-void-lines">
            {lines.map((l) => (
              <li key={l.line_id} className="flex justify-between">
                <span>{l.qty} × {l.product_name}</span><span className="text-gray-400">{money(l.unit_price * l.qty)}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-gray-800 pt-1 font-semibold">
              <span>Total</span><span>{money(total)}</span>
            </li>
          </ul>
          {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <p className="text-xs text-gray-300 mb-1">Why?</p>
            <div className="grid grid-cols-1 gap-1.5">
              {KITCHEN_VOID_REASONS.map((r) => (
                <button key={r.code} type="button" data-testid={`kv-reason-${r.code}`} onClick={() => setReason(r.code)}
                  className={`text-left text-sm rounded-lg px-3 py-2 border ${reason === r.code
                    ? 'border-action-500 bg-action-500/10 text-white' : 'border-gray-700 text-gray-300 hover:border-gray-500'}`}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-300 mb-1">Had the kitchen already made it?</p>
            <div className="flex gap-2">
              {[{ v: false, label: 'No — not made yet' }, { v: true, label: 'Yes — already made' }].map((o) => (
                <button key={String(o.v)} type="button" data-testid={`kv-cooked-${o.v}`} onClick={() => setCooked(o.v)}
                  className={`flex-1 text-sm rounded-lg px-3 py-2 border ${cooked === o.v
                    ? 'border-action-500 bg-action-500/10 text-white' : 'border-gray-700 text-gray-300 hover:border-gray-500'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <input type="text" maxLength={KITCHEN_VOID_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)" className={inputCls} />
          {askPin && (
            <div data-testid="kv-pin">
              <label className="block text-xs text-gray-300 mb-1">Manager PIN</label>
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
            </div>
          )}
          <button onClick={() => void submit()} disabled={busy}
            className="w-full bg-red-500 hover:bg-red-400 disabled:opacity-40 text-white font-bold rounded-xl py-2.5 text-sm">
            {busy ? 'Voiding…' : `Void ${money(total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
