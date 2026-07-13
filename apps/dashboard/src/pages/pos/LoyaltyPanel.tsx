import { useState } from 'react';
import { api } from '../../lib/api';

interface Customer {
  id: string;
  name: string;
  phone: string;
  loyalty_points: number;
  total_spent: number;
  visit_count: number;
}

interface Tier {
  name: string;
  multiplier: number;
  next: number | null;
}

export interface LoyaltyState {
  customer: Customer;
  tier: Tier;
  pointsToRedeem: number;
  discountAmount: number;
}

interface Props {
  currency: string;
  orderTotal: number; // pre-loyalty total, used to cap redemption
  onCustomerSet: (state: LoyaltyState | null) => void;
  loyaltyState: LoyaltyState | null;
}

const TIER_COLORS: Record<string, string> = {
  Bronze: 'text-amber-600',
  Silver: 'text-gray-400',
  Gold:   'text-yellow-400',
};

const TIER_BG: Record<string, string> = {
  Bronze: 'bg-amber-600/10 border-amber-600/30',
  Silver: 'bg-gray-400/10 border-gray-400/30',
  Gold:   'bg-yellow-400/10 border-yellow-400/30',
};

export default function LoyaltyPanel({ currency, orderTotal, onCustomerSet, loyaltyState }: Props) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [redeemInput, setRedeemInput] = useState('');

  const customer = loyaltyState?.customer ?? null;
  const tier = loyaltyState?.tier ?? null;

  const handleSearch = async () => {
    if (!phone.trim()) return;
    setSearching(true);
    setNotFound(false);
    setError('');
    try {
      const { customer, tier } = await api.get<{ customer: Customer; tier: Tier }>(
        `/api/loyalty/customer?phone=${encodeURIComponent(phone.trim())}`
      );
      onCustomerSet({ customer, tier, pointsToRedeem: 0, discountAmount: 0 });
      setRedeemInput('');
    } catch {
      setNotFound(true);
    } finally {
      setSearching(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !phone.trim()) return;
    setCreating(true);
    setError('');
    try {
      const { customer, tier } = await api.post<{ customer: Customer; tier: Tier }>(
        '/api/loyalty/customer',
        { name: newName.trim(), phone: phone.trim() }
      );
      onCustomerSet({ customer, tier, pointsToRedeem: 0, discountAmount: 0 });
      setNotFound(false);
      setRedeemInput('');
    } catch (err: any) {
      setError(err.message ?? 'Failed to create customer');
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveCustomer = () => {
    onCustomerSet(null);
    setPhone('');
    setNotFound(false);
    setNewName('');
    setRedeemInput('');
  };

  const handleRedeemChange = (val: string) => {
    setRedeemInput(val);
    if (!loyaltyState) return;
    const pts = parseInt(val) || 0;
    const maxRedeemable = Math.min(loyaltyState.customer.loyalty_points, Math.floor(orderTotal));
    const clamped = Math.max(0, Math.min(pts, maxRedeemable));
    onCustomerSet({ ...loyaltyState, pointsToRedeem: clamped, discountAmount: clamped });
  };

  const handleRedeemAll = () => {
    if (!loyaltyState) return;
    const maxRedeemable = Math.min(loyaltyState.customer.loyalty_points, Math.floor(orderTotal));
    setRedeemInput(String(maxRedeemable));
    onCustomerSet({ ...loyaltyState, pointsToRedeem: maxRedeemable, discountAmount: maxRedeemable });
  };

  // ── Collapsed state ──────────────────────────────────────
  if (!open && !customer) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-2.5 border border-dashed border-gray-700 rounded-xl text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors text-sm"
      >
        <span>⭐</span>
        <span>Add loyalty customer</span>
      </button>
    );
  }

  // ── Customer attached ────────────────────────────────────
  if (customer && tier) {
    const maxRedeemable = Math.min(customer.loyalty_points, Math.floor(orderTotal));
    return (
      <div className={`rounded-xl border p-3 space-y-2.5 ${TIER_BG[tier.name]}`}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white text-sm font-medium">{customer.name}</p>
            <p className="text-gray-500 text-xs">{customer.phone}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${TIER_COLORS[tier.name]}`}>
              {tier.name} · {tier.multiplier}×
            </span>
            <button
              onClick={handleRemoveCustomer}
              className="text-gray-600 hover:text-red-400 text-xs transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between bg-gray-900/60 rounded-lg px-3 py-2">
          <span className="text-gray-400 text-xs">Points balance</span>
          <span className={`text-sm font-bold ${TIER_COLORS[tier.name]}`}>
            {customer.loyalty_points.toLocaleString()} pts
          </span>
        </div>

        {customer.loyalty_points > 0 && maxRedeemable > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-400">Redeem points ({currency} 1 per pt)</label>
              <button
                onClick={handleRedeemAll}
                className="text-xs text-green-500 hover:text-green-400 transition-colors"
              >
                Use all ({maxRedeemable})
              </button>
            </div>
            <input
              type="number"
              value={redeemInput}
              onChange={e => handleRedeemChange(e.target.value)}
              placeholder="0"
              min={0}
              max={maxRedeemable}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
            />
            {(loyaltyState?.discountAmount ?? 0) > 0 && (
              <p className="text-green-400 text-xs text-right">
                − {currency} {(loyaltyState?.discountAmount ?? 0).toLocaleString()} discount applied
              </p>
            )}
          </div>
        )}

        {tier.next && (
          <p className="text-gray-600 text-xs text-center">
            {(tier.next - customer.loyalty_points).toLocaleString()} pts to {tier.name === 'Bronze' ? 'Silver' : 'Gold'}
          </p>
        )}
      </div>
    );
  }

  // ── Search / create panel ────────────────────────────────
  return (
    <div className="border border-gray-800 rounded-xl p-3 space-y-3 bg-gray-900/40">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white font-medium">⭐ Loyalty customer</p>
        <button onClick={() => { setOpen(false); setNotFound(false); setPhone(''); }} className="text-gray-600 hover:text-gray-400 text-xs">
          Cancel
        </button>
      </div>

      <div className="flex gap-2">
        <input
          type="tel"
          value={phone}
          onChange={e => { setPhone(e.target.value); setNotFound(false); }}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Phone number"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors"
          autoFocus
        />
        <button
          onClick={handleSearch}
          disabled={searching || !phone.trim()}
          className="px-3 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 text-sm font-semibold rounded-lg transition-colors"
        >
          {searching ? '…' : 'Find'}
        </button>
      </div>

      {notFound && (
        <div className="space-y-2">
          <p className="text-yellow-500 text-xs">No customer found. Create new?</p>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="Customer name"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors"
            autoFocus
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="w-full py-2 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 text-sm font-bold rounded-lg transition-colors"
          >
            {creating ? 'Creating…' : 'Create & attach'}
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
