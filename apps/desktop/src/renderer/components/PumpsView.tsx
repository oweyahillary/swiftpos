import { useState } from 'react';
import type { Pump } from '../lib/posApi';

// Petrol pump grid — desktop port of the dashboard's pump picker.
//
// Pumps are synced reference data (SQLite), so the grid works offline. Each pump
// resolves its fuel product (name + price/litre) by join, so it can drive a fuel
// sale without another lookup. Tapping a pump opens the fuel-entry panel where the
// cashier types EITHER the amount (KES) OR the litres — the other is computed from
// the pump's price/litre. Kenyan fuel retail is amount-driven ("weka 2000"), so
// amount is the default field; litres is derived at full precision so the line
// total reconciles exactly to the amount on the server (which recomputes
// price/litre × litres for the catalogue fuel product).

interface Props {
  pumps: Pump[];
  currency: string;
  onAddFuel: (pump: Pump, litres: number, amount: number) => void;
  onShowProducts?: () => void;
}

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

export default function PumpsView({ pumps, currency, onAddFuel, onShowProducts }: Props) {
  const [active, setActive] = useState<Pump | null>(null);
  const [edited, setEdited] = useState<'amount' | 'litres'>('amount');
  const [amountStr, setAmountStr] = useState('');
  const [litresStr, setLitresStr] = useState('');

  const price = active?.price_per_litre ?? 0;

  // The field the cashier last touched is the source of truth; the other is derived.
  const amount = edited === 'amount'
    ? (parseFloat(amountStr) || 0)
    : (parseFloat(litresStr) || 0) * price;
  const litres = edited === 'litres'
    ? (parseFloat(litresStr) || 0)
    : (price > 0 ? (parseFloat(amountStr) || 0) / price : 0);

  function openPump(pump: Pump) {
    if (!pump.price_per_litre || pump.price_per_litre <= 0) return;
    setActive(pump);
    setEdited('amount');
    setAmountStr('');
    setLitresStr('');
  }

  function confirm() {
    if (!active || amount <= 0 || litres <= 0) return;
    onAddFuel(active, litres, amount);
    setActive(null);
  }

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">⛽ Pumps</h2>
        {onShowProducts && (
          <button
            onClick={onShowProducts}
            className="text-xs text-gray-400 hover:text-white bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-lg px-3 py-1.5 transition-colors"
            title="Sell shop items (oil, snacks, etc.)"
          >
            Shop items →
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {pumps.length === 0 ? (
          <div className="text-center text-gray-500 text-sm mt-12 px-6">
            No pumps configured. Add pumps in the dashboard (Settings → Pumps),
            then press Sync on the till.
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {pumps.map((pump) => {
              const priced = !!pump.price_per_litre && pump.price_per_litre > 0;
              return (
                <button
                  key={pump.id}
                  onClick={() => openPump(pump)}
                  disabled={!priced}
                  className={`text-left rounded-xl border p-4 transition-colors ${
                    priced
                      ? 'bg-gray-800 border-gray-700 hover:border-green-500'
                      : 'bg-gray-900 border-gray-800 opacity-60 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-base font-semibold text-white">{pump.name}</span>
                    <span className={`w-2.5 h-2.5 rounded-full ${pump.status === 'inactive' ? 'bg-gray-600' : 'bg-green-400'}`} />
                  </div>
                  <div className="mt-1 text-xs text-gray-400 truncate">
                    {pump.fuel_product_name ?? 'No fuel product'}
                  </div>
                  {priced ? (
                    <div className="mt-3 text-sm font-medium text-green-400">
                      {currency} {fmt(pump.price_per_litre!)}<span className="text-gray-500 font-normal">/L</span>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-amber-400">Map a fuel product in the dashboard</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Fuel-entry panel */}
      {active && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-white">{active.name}</h3>
              <button onClick={() => setActive(null)} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
            </div>
            <div className="text-xs text-gray-400 mb-4">
              {active.fuel_product_name ?? 'Fuel'} · {currency} {fmt(price)}/L
            </div>

            <label className="block text-xs text-gray-400 mb-1">Amount ({currency})</label>
            <input
              type="number"
              inputMode="decimal"
              autoFocus
              value={edited === 'amount' ? amountStr : (amount ? amount.toFixed(2) : '')}
              onChange={(e) => { setEdited('amount'); setAmountStr(e.target.value); }}
              placeholder="0.00"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-2xl text-white text-right focus:outline-none focus:border-green-500 mb-3"
            />

            <label className="block text-xs text-gray-400 mb-1">Litres</label>
            <input
              type="number"
              inputMode="decimal"
              value={edited === 'litres' ? litresStr : (litres ? litres.toFixed(2) : '')}
              onChange={(e) => { setEdited('litres'); setLitresStr(e.target.value); }}
              placeholder="0.00"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-2xl text-white text-right focus:outline-none focus:border-green-500 mb-4"
            />

            <div className="grid grid-cols-4 gap-2 mb-5">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  onClick={() => { setEdited('amount'); setAmountStr(String(q)); }}
                  className="bg-gray-800 border border-gray-700 hover:border-green-500 text-gray-200 text-sm rounded-lg py-2 transition-colors"
                >
                  {q.toLocaleString()}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between text-sm mb-4">
              <span className="text-gray-400">{litres ? litres.toFixed(2) : '0.00'} L</span>
              <span className="text-white font-semibold">{currency} {fmt(amount)}</span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setActive(null)}
                className="flex-1 bg-gray-800 border border-gray-700 hover:border-gray-600 text-gray-300 rounded-lg py-3 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirm}
                disabled={amount <= 0 || litres <= 0}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:hover:bg-green-500 text-gray-950 font-semibold rounded-lg py-3 transition-colors"
              >
                Add to sale
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
