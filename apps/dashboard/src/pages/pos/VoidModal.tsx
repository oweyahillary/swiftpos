import { useState, useEffect } from 'react';
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

interface Authorizer { id: string; name: string; role: string | null }

export default function VoidModal({ order, currency, onSuccess, onClose }: Props) {
  const isPaid = (order.payments ?? []).some(p => p.status === 'completed');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [authorizerId, setAuthorizerId] = useState('');
  const [authorizers, setAuthorizers] = useState<Authorizer[]>([]);
  const [authLoading, setAuthLoading] = useState(isPaid);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load the list of supervisors who can authorize an override (paid voids only).
  useEffect(() => {
    if (!isPaid) return;
    let live = true;
    api.get<Authorizer[]>('/api/staff/authorizers')
      .then(data => { if (live) setAuthorizers(data ?? []); })
      .catch(() => { if (live) setAuthorizers([]); })
      .finally(() => { if (live) setAuthLoading(false); });
    return () => { live = false; };
  }, [isPaid]);

  // No supervisors configured → fall back to a plain PIN field (legacy business PIN).
  const hasAuthorizers = authorizers.length > 0;

  const handleVoid = async () => {
    if (!reason.trim()) { setError('Please provide a reason'); return; }
    if (isPaid) {
      if (hasAuthorizers && !authorizerId) { setError('Select the supervisor authorizing this void'); return; }
      if (!pin.trim()) { setError('Override PIN is required'); return; }
    }

    setLoading(true);
    setError('');
    try {
      await api.post(`/api/orders/${order.id}/void`, {
        reason: reason.trim(),
        ...(isPaid ? { override_pin: pin, ...(authorizerId ? { authorizer_id: authorizerId } : {}) } : {}),
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
              ? <span className="text-yellow-400">Paid — supervisor approval required</span>
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

        {/* Supervisor approval — only shown if order is paid */}
        {isPaid && (
          <div className="space-y-3">
            {authLoading ? (
              <p className="text-gray-500 text-sm">Loading supervisors…</p>
            ) : (
              <>
                {hasAuthorizers && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Authorizing supervisor</label>
                    <select
                      value={authorizerId}
                      onChange={e => setAuthorizerId(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-red-500 transition-colors"
                    >
                      <option value="">Select supervisor…</option>
                      {authorizers.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.name}{a.role ? ` (${a.role})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    {hasAuthorizers ? 'Supervisor override PIN' : 'Supervisor PIN'}
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={e => setPin(e.target.value)}
                    placeholder="Enter PIN"
                    maxLength={6}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500 transition-colors tracking-widest"
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    {hasAuthorizers
                      ? 'The selected supervisor enters their own override PIN. The void is recorded against them.'
                      : 'No supervisor override PINs set yet — using the legacy business PIN. Add one per supervisor in Staff Management.'}
                  </p>
                </div>
              </>
            )}
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
