import { useState } from 'react';
import { api } from '../../lib/api';

interface Props {
  order: {
    id: string;
    order_number: string;
    total: number;
    payments?: { status: string }[];
  };
  currency: string;
  onSuccess: () => void;
  onClose: () => void;
}

export default function VoidModal({ order, currency, onSuccess, onClose }: Props) {
  const isPaid = (order.payments ?? []).some(p => p.status === 'completed');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleVoid = async () => {
    if (!reason.trim()) { setError('Please provide a reason'); return; }
    if (isPaid && !pin.trim()) { setError('Supervisor PIN is required'); return; }

    setLoading(true);
    setError('');
    try {
      await api.post(`/api/orders/${order.id}/void`, {
        reason: reason.trim(),
        ...(isPaid ? { supervisor_pin: pin } : {}),
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message ?? 'Failed to void order');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-5">

        {/* Header */}
        <div>
          <h2 className="text-white font-semibold text-lg">Void Order {order.order_number}</h2>
          <p className="text-gray-400 text-sm mt-1">
            {currency} {Number(order.total).toLocaleString()} •{' '}
            {isPaid
              ? <span className="text-yellow-400">Paid — supervisor PIN required</span>
              : <span className="text-gray-400">Unpaid — cashier can void</span>}
          </p>
        </div>

        {/* Reason */}
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Reason for void</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Customer changed mind, duplicate order…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500 transition-colors resize-none"
          />
        </div>

        {/* Supervisor PIN — only shown if order is paid */}
        {isPaid && (
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Supervisor PIN</label>
            <input
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="Enter supervisor PIN"
              maxLength={10}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500 transition-colors"
            />
            <p className="text-xs text-gray-600 mt-1">
              Set via SUPERVISOR_PIN environment variable on the server.
              {/* TODO (Step 12): Replace with role-based permission check */}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleVoid}
            disabled={loading}
            className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
          >
            {loading ? 'Voiding…' : 'Confirm Void'}
          </button>
        </div>
      </div>
    </div>
  );
}
