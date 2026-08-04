/**
 * VoidModal — reversing a sale, in either of the two ways that exist.
 *
 *   VOID    "this should not have happened" — within 30 minutes, the order
 *           leaves the sales figures entirely.
 *   REFUND  "it happened, the money is going back" — any time, the sale stands
 *           and the reversal is recorded against it (audit M3).
 *
 * One modal because it is one decision from the cashier's side, and because the
 * real workflow is discovering the void window has closed. A sale older than 30
 * minutes opens straight into refund mode rather than offering a button that
 * will certainly fail — the previous behaviour was to let them fill in a reason,
 * enter a PIN, and only then be told no.
 *
 * Both require a reason. Both require supervisor authorisation once money has
 * changed hands. The server enforces all of it; this collects it.
 */

import { useState } from 'react';
import { posApi } from '../lib/posApi';

interface Order {
  id: string;
  order_number: string;
  total: number;
  created_at: string;
  payments?: { method: string; amount: number }[];
}

interface Props {
  order: Order;
  currency: string;
  onSuccess: () => void;
  onClose: () => void;
}

const VOID_REASONS = [
  'Customer changed mind',
  'Wrong items ordered',
  'Duplicate order',
  'Test order',
  'Other',
];

// Deliberately different from the void list. A refund happens after the customer
// has had the food, so the reasons are about what went wrong with it — and the
// reason lands in the audit trail, where "customer changed mind" an hour later
// tells nobody anything.
const REFUND_REASONS = [
  'Item returned',
  'Wrong order given',
  'Quality complaint',
  'Charged twice',
  'Order not delivered',
  'Other',
];

export default function VoidModal({ order, currency, onSuccess, onClose }: Props) {
  const isPaid    = (order.payments ?? []).length > 0;
  const ageMin    = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000);
  const isExpired = ageMin > 30;

  // Past the window, void is not an option the server will honour — open in the
  // mode that can actually succeed.
  const [mode, setMode] = useState<'void' | 'refund'>(isExpired ? 'refund' : 'void');
  const isRefund = mode === 'refund';

  const [reason,      setReason]      = useState('');
  const [customReason,setCustomReason]= useState('');
  const [pin,         setPin]         = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');

  const finalReason = reason === 'Other' ? customReason : reason;

  const fmt = (n: number) =>
    `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const handleVoid = async () => {
    if (!finalReason.trim()) { setError('A reason is required'); return; }
    // A refund always moves money, so it always needs authorising — unlike a
    // void, which can be free on an unpaid order.
    if ((isPaid || isRefund) && !pin.trim()) {
      setError(isRefund ? 'Supervisor PIN is required to refund' : 'Supervisor PIN is required for paid orders');
      return;
    }
    setLoading(true); setError('');
    try {
      if (isRefund) {
        await posApi.order.refund(order.id, finalReason.trim(), pin.trim());
      } else {
        await posApi.order.void(order.id, finalReason.trim(), isPaid ? pin.trim() : undefined);
      }
      onSuccess();
    } catch (e: any) {
      const msg = e?.message ?? (isRefund ? 'Refund failed' : 'Void failed');
      if (msg.includes('30 minutes') || msg.includes('VOID_WINDOW')) {
        // Don't leave them stuck — switch to the thing that will work.
        setMode('refund');
        setError(`This order is ${ageMin} minutes old, past the 30-minute void window. Refund it instead.`);
      } else if (msg.includes('supervisor') || msg.includes('PIN')) {
        setError('Invalid supervisor PIN. Try again.');
        setPin('');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl max-h-[92vh] overflow-y-auto">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-800">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-white font-semibold text-lg">{isRefund ? 'Refund Order' : 'Void Order'}</h2>
              <p className="text-gray-400 text-sm mt-0.5">
                {order.order_number} · {fmt(order.total)}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-300 hover:text-white transition-colors text-lg leading-none">✕</button>
          </div>

          {/* Status badges */}
          <div className="flex gap-2 mt-3">
            {isPaid && (
              <span className="text-xs px-2.5 py-1 bg-amber-500/15 text-amber-400 rounded-full font-medium border border-amber-500/20">
                Paid — supervisor PIN needed
              </span>
            )}
            {isExpired && (
              <span className="text-xs px-2.5 py-1 bg-red-500/15 text-red-400 rounded-full font-medium border border-red-500/20">
                {ageMin}m old — past the 30-minute void window
              </span>
            )}
            {!isPaid && !isExpired && (
              <span className="text-xs px-2.5 py-1 bg-green-500/10 text-green-400 rounded-full font-medium border border-green-500/20">
                Unpaid · {ageMin}m ago
              </span>
            )}
          </div>

          {/* Void or refund. Void is disabled once the window has closed rather
              than hidden, so the cashier can see WHY it is not available. */}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => !isExpired && setMode('void')}
              disabled={isExpired}
              title={isExpired ? `Too old to void — ${ageMin} minutes` : undefined}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                !isRefund ? 'bg-red-500/15 border-red-500/40 text-red-300'
                          : 'border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:hover:bg-transparent'
              }`}>
              Void · cancels the sale
            </button>
            <button
              onClick={() => setMode('refund')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isRefund ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                         : 'border-gray-700 text-gray-300 hover:bg-gray-800'
              }`}>
              Refund · money back
            </button>
          </div>

          {isRefund && (
            <p className="text-xs text-gray-300 mt-2">
              The sale stays on the books and the tax on it still stands — only the money
              is returned. Hand back {fmt(order.total)} in the same tender it came in.
            </p>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {/* Reason selector */}
          <div>
            <label className="block text-sm text-gray-400 mb-2 font-medium">
              {isRefund ? 'Reason for refund' : 'Reason for void'}
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {(isRefund ? REFUND_REASONS : VOID_REASONS).map(r => (
                <button key={r} onClick={() => setReason(r)}
                  className={`text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                    reason === r
                      ? (isRefund ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                                  : 'bg-red-500/15 border-red-500/40 text-red-300')
                      : 'border-gray-700 text-gray-300 hover:bg-gray-800 hover:border-gray-600'
                  }`}>
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Custom reason */}
          {reason === 'Other' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Describe the reason</label>
              <input
                value={customReason}
                onChange={e => setCustomReason(e.target.value)}
                placeholder="Enter reason…"
                autoFocus
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-red-500/50"
              />
            </div>
          )}

          {/* Supervisor PIN — for any paid void, and for every refund. */}
          {(isPaid || isRefund) && (
            <div>
              <label className="block text-sm text-gray-400 mb-1.5 font-medium">Supervisor PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter supervisor PIN"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-amber-500/50 tracking-widest"
              />
              <p className="text-xs text-gray-400 mt-1">This is logged and audited on the server.</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} disabled={loading}
            className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleVoid}
            disabled={loading || !finalReason.trim() || ((isPaid || isRefund) && !pin.trim())}
            className={`flex-1 py-2.5 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-colors ${
              isRefund ? 'bg-amber-600 hover:bg-amber-500' : 'bg-red-600 hover:bg-red-500'
            }`}
          >
            {loading
              ? (isRefund ? 'Refunding…' : 'Voiding…')
              : (isRefund ? `Refund ${fmt(order.total)}` : 'Confirm Void')}
          </button>
        </div>
      </div>
    </div>
  );
}
