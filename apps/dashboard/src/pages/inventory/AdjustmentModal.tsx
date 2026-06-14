import { useState } from 'react';
import { api } from '../../lib/api';

type AdjustType = 'restock' | 'write_off' | 'correction';

interface Props {
  product: {
    id: string;
    name: string;
    currentQty: number;
  };
  branchId: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}

const TYPES: { value: AdjustType; label: string; description: string; color: string }[] = [
  { value: 'restock',    label: 'Restock',    description: 'Add stock received from supplier', color: 'green' },
  { value: 'write_off',  label: 'Write-off',  description: 'Remove damaged, expired, or lost items', color: 'red' },
  { value: 'correction', label: 'Correction', description: 'Set exact count after a stock take', color: 'blue' },
];

export default function AdjustmentModal({ product, branchId, currency: _currency, onClose, onSaved }: Props) {
  const [type, setType] = useState<AdjustType>('restock');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const qty = parseInt(quantity) || 0;

  const preview = () => {
    if (!qty) return null;
    if (type === 'correction') return qty;
    if (type === 'restock') return product.currentQty + qty;
    if (type === 'write_off') return Math.max(0, product.currentQty - qty);
    return null;
  };

  const handleSave = async () => {
    if (!qty || qty <= 0) { setError('Enter a valid quantity'); return; }
    setSaving(true);
    setError('');

    try {
      await api.post('/api/inventory/adjust', {
        product_id: product.id,
        branch_id: branchId,
        type,
        quantity: qty,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  const newQty = preview();

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md space-y-5">

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-white font-semibold text-lg">Adjust stock</h2>
            <p className="text-gray-500 text-sm mt-0.5 truncate max-w-xs">{product.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* Current stock */}
        <div className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-gray-400 text-sm">Current stock</span>
          <span className="text-white font-bold text-xl">{product.currentQty} units</span>
        </div>

        {/* Type selector */}
        <div className="space-y-2">
          {TYPES.map(t => (
            <button
              key={t.value}
              onClick={() => setType(t.value)}
              className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
                type === t.value
                  ? t.color === 'green'
                    ? 'border-green-500 bg-green-500/10'
                    : t.color === 'red'
                    ? 'border-red-500 bg-red-500/10'
                    : 'border-blue-500 bg-blue-500/10'
                  : 'border-gray-700 bg-gray-800 hover:border-gray-600'
              }`}
            >
              <p className={`text-sm font-medium ${
                type === t.value
                  ? t.color === 'green' ? 'text-green-400' : t.color === 'red' ? 'text-red-400' : 'text-blue-400'
                  : 'text-gray-300'
              }`}>{t.label}</p>
              <p className="text-gray-500 text-xs mt-0.5">{t.description}</p>
            </button>
          ))}
        </div>

        {/* Quantity */}
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">
            {type === 'correction' ? 'New stock count' : 'Quantity'}
          </label>
          <input
            type="number"
            min="1"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            placeholder={type === 'correction' ? `Current: ${product.currentQty}` : 'Enter quantity'}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors text-lg font-semibold"
          />
        </div>

        {/* Preview */}
        {newQty !== null && (
          <div className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-gray-400 text-sm">Stock after adjustment</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-sm line-through">{product.currentQty}</span>
              <span className="text-white font-bold text-lg">→ {newQty}</span>
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Reason <span className="text-gray-600">(optional)</span></label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Supplier delivery, damaged goods..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !qty || qty <= 0}
            className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors"
          >
            {saving ? 'Saving…' : 'Save adjustment'}
          </button>
        </div>
      </div>
    </div>
  );
}
