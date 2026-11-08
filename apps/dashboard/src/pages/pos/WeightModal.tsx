import { useEffect, useState } from 'react';
import { weighedLine, formatWeight, type WeighedLine } from '@zaptill/core/scaleBarcode';

/**
 * WeightModal (web POS) — A577: an item sold by weight, tapped (or scanned by its own barcode), asks for the weight —
 * the till's (apps/desktop WeightModal) on the web: a keypad in kg, the amount = price per kg × weight rounded to the
 * cent (lib/scaleBarcode.ts weighedLine). Every mode — the shop (MinimartPOS / retail grid) and the restaurant's
 * nyama choma by the kilo (its kitchen ticket reads "0.750 kg   GOAT MEAT").
 */
interface Props {
  product: { name: string; unit_label?: string | null };
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
  const line = weighedLine(pricePerKg, Number(text) || 0);
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
    <div className="animate-fade-in" style={st.overlay} onClick={onClose}>
      <div className="animate-pop-in" style={st.card} onClick={(e) => e.stopPropagation()} data-testid="weight-modal">
        <div style={{ fontWeight: 600, color: '#f1f5f9' }}>Weight</div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>{product.name} · {currency} {pricePerKg.toLocaleString()}/kg</div>
        <div style={st.display}>
          <span style={{ fontSize: 30, color: '#fff', fontVariantNumeric: 'tabular-nums' }} data-testid="weight-value">{text || '0'}</span>
          <span style={{ color: '#94a3b8', marginLeft: 8 }}>kg</span>
          {product.unit_label === 'g' && ready && <div style={{ fontSize: 12, color: '#64748b' }}>{formatWeight(line.quantity, 'g')}</div>}
        </div>
        <div style={st.keys}>
          {KEYS.map((k) => (
            <button key={k} type="button" style={st.key} onClick={() => setText((t) => typeKey(t, k))}>{k}</button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, margin: '12px 0' }}>
          <span style={{ color: '#94a3b8' }}>Amount</span>
          <span style={{ color: '#fff', fontWeight: 600 }} data-testid="weight-amount">
            {currency} {line.lineTotal.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={st.plain} onClick={onClose}>Cancel</button>
          <button type="button" style={{ ...st.save, opacity: ready ? 1 : 0.4 }} disabled={!ready} onClick={confirm} data-testid="weight-add">
            Add {ready ? formatWeight(line.quantity, 'kg') : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { background: '#0f172a', border: '1px solid #334155', borderRadius: 14, width: '100%', maxWidth: 360, padding: 18 },
  display: { background: '#020617', border: '1px solid #334155', borderRadius: 10, padding: '10px 14px', textAlign: 'right', marginBottom: 12 },
  keys: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  key: { height: 48, borderRadius: 8, border: 'none', background: '#1e293b', color: '#fff', fontSize: 18, fontWeight: 500, cursor: 'pointer' },
  save: { flex: 1, background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: 'pointer' },
  plain: { flex: 1, background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '10px 14px', cursor: 'pointer' },
};
