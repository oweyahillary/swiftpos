import { useEffect, useState } from 'react';
import { weighedLine, formatWeight, type WeighedLine } from '@zaptill/core/scaleBarcode';

/**
 * WeightModal — A577: an item sold by weight, tapped on the grid (or scanned by its own barcode), asks for the weight.
 *
 * Owner, 2026-10-23: "a sold-by-weight item tapped on the grid asks for the weight (keypad, kg)". The cashier reads the
 * scale and types the kilograms (0.452) on the keypad or the keyboard; the amount is price per kg × weight, rounded to
 * the cent (shared/scaleBarcode.ts weighedLine). Every mode: a shop's loose sugar, a butchery's beef, a restaurant's
 * nyama choma by the kilo (the kitchen ticket then reads "0.750 kg   GOAT MEAT"). No scale is read here — ZapTill has no
 * scale-cable driver; a label scale's barcode is scanned instead.
 */
interface Props {
  product: { name: string; unit_label?: string | null };
  /** The price per kg this till charges (the branch's price when it has one). */
  pricePerKg: number;
  currency: string;
  onConfirm: (line: WeighedLine) => void;
  onClose: () => void;
}

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'] as const;

/** The typed text with one more key: digits, one point, at most 3 decimals (the gram), at most 4 whole digits. */
export function typeKey(text: string, key: string): string {
  if (key === '⌫') return text.slice(0, -1);
  if (key === '.') return text.includes('.') ? text : (text || '0') + '.';
  if (!/^\d$/.test(key)) return text;
  const [whole, dec] = text.split('.');
  if (dec !== undefined) return dec.length >= 3 ? text : text + key;
  if (whole === '0') return key;
  return whole.length >= 4 ? text : text + key;
}

export default function WeightModal({ product, pricePerKg, currency, onConfirm, onClose }: Props) {
  const [text, setText] = useState('');
  const kg = Number(text) || 0;
  const line = weighedLine(pricePerKg, kg);
  const ready = line.quantity > 0;
  const confirm = () => { if (ready) onConfirm(line); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Enter') { e.preventDefault(); confirm(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); setText((t) => typeKey(t, '⌫')); return; }
      if (/^[\d.]$/.test(e.key)) { e.preventDefault(); setText((t) => typeKey(t, e.key)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center px-4 animate-fade-in" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-5 space-y-4 animate-pop-in"
           onClick={(e) => e.stopPropagation()} data-testid="weight-modal">
        <div>
          <h3 className="text-white font-semibold">Weight</h3>
          <p className="text-gray-400 text-sm truncate">{product.name} · {currency} {pricePerKg.toLocaleString()}/kg</p>
        </div>
        <div className="rounded-xl bg-gray-950 border border-gray-700 px-4 py-3 text-right">
          <span className="text-3xl text-white tabular-nums" data-testid="weight-value">{text || '0'}</span>
          <span className="text-gray-400 ml-2">kg</span>
          {product.unit_label === 'g' && ready && <p className="text-xs text-gray-500">{formatWeight(line.quantity, 'g')}</p>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button key={k} type="button" onClick={() => setText((t) => typeKey(t, k))}
                    className="h-12 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-lg font-medium">
              {k}
            </button>
          ))}
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Amount</span>
          <span className="text-white font-semibold tabular-nums" data-testid="weight-amount">{currency} {line.lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white">Cancel</button>
          <button type="button" onClick={confirm} disabled={!ready} data-testid="weight-add"
                  className="flex-1 py-2.5 rounded-lg bg-action-600 hover:bg-action-500 disabled:opacity-40 text-white font-semibold">
            Add {ready ? formatWeight(line.quantity, 'kg') : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
