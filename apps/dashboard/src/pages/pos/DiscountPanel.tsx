import { useState } from 'react';
import { api } from '../../lib/api';

interface Discount {
  id: string;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
  promo_code: string | null;
}

export interface DiscountState {
  discount: Discount;
  discount_amount: number;
}

interface Props {
  orderTotal: number;
  currency: string;
  discountState: DiscountState | null;
  onDiscountSet: (state: DiscountState | null) => void;
}

export default function DiscountPanel({ orderTotal, currency, discountState, onDiscountSet }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  async function applyCode() {
    if (!code.trim()) return;
    setError('');
    setApplying(true);
    try {
      const result = await api.post<DiscountState>('/api/discounts/apply', {
        code: code.trim(),
        order_total: orderTotal,
      });
      onDiscountSet(result);
      setExpanded(false);
      setCode('');
    } catch (err: any) {
      setError(err.message ?? 'Invalid code');
    } finally {
      setApplying(false);
    }
  }

  function remove() {
    onDiscountSet(null);
    setCode('');
    setError('');
  }

  // Applied state
  if (discountState) {
    return (
      <div className="flex items-center justify-between bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
        <div>
          <p className="text-green-400 text-xs font-semibold">🏷️ {discountState.discount.name}</p>
          {discountState.discount.promo_code && (
            <p className="text-green-500/70 text-xs font-mono">{discountState.discount.promo_code}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-green-400 text-sm font-bold">− {currency} {discountState.discount_amount.toLocaleString()}</span>
          <button onClick={remove} className="text-gray-500 hover:text-red-400 text-xs transition-colors">✕</button>
        </div>
      </div>
    );
  }

  // Collapsed state
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        disabled={orderTotal === 0}
        className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        🏷️ Apply discount or promo code
      </button>
    );
  }

  // Expanded input state
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && applyCode()}
          placeholder="Enter promo code"
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-green-500"
          autoFocus
        />
        <button
          onClick={applyCode}
          disabled={applying || !code.trim()}
          className="px-3 py-1.5 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-xs font-semibold rounded-lg transition-colors"
        >
          {applying ? '...' : 'Apply'}
        </button>
        <button onClick={() => { setExpanded(false); setError(''); setCode(''); }} className="text-gray-500 hover:text-white text-xs transition-colors px-1">
          ✕
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
