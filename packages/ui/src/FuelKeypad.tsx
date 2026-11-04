/**
 * FuelKeypad — the fuel keypad on both POS (owner decision 2026-11-04, "6 yes": the web POS takes the desktop's forecourt;
 * docs/POS-SCREEN-COMPARISON.html). An amount (KES) or litres, the other worked out live (litres to 3 decimals), quick
 * amounts, "Full tank" (fill up, then enter the litres the pump shows), a number pad and the keyboard (a USB numpad on
 * the counter: digits, ".", Backspace, Enter, Escape). The rules are @zaptill/core/forecourt's (keyIn, fuelSale).
 *
 * The card only: each app puts it in its own overlay and passes its look (./paint.ts) — the desktop's classes, the web's
 * styles on its theme tokens (its phone layout: the card fits a phone's width).
 */
import { useCallback, useEffect, useState } from 'react';
import { QUICK_AMOUNTS, keyIn, fuelSale, litresText, moneyText, type FuelField } from '@zaptill/core/forecourt';
import { painted, type Paint } from './paint';

export interface FuelKeypadLook {
  card: Paint;
  body: Paint;
  head: Paint;
  title: Paint;
  subtitle: Paint;
  close: Paint;
  tabs: Paint;
  tab: (on: boolean) => Paint;
  display: Paint;
  entry: Paint;
  conversion: Paint;
  hint: Paint;
  quickRow: Paint;
  quick: Paint;
  fullTank: (on: boolean) => Paint;
  keys: Paint;
  key: Paint;
  actions: Paint;
  cancel: Paint;
  add: Paint;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

/** A quantity in the grade's unit, to 3 decimals ("10.840 L"). */
const qtyText = (n: number, unit: string) => (unit === 'L' ? litresText(n)
  : `${(Number.isFinite(n) ? n : 0).toLocaleString('en-KE', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${unit}`);

export default function FuelKeypad({ title, grade, colour, price, currency, unit = 'L', onAdd, onClose, look }: {
  /** The pump's name, or the grade's when no pump is chosen. */
  title: string;
  /** The fuel grade ("Diesel"). */
  grade: string;
  /** The grade's colour (a band on top, the grade's name). */
  colour: string;
  /** Price per litre (per `unit`). */
  price: number;
  currency: string;
  /** The grade's unit — litres unless the product says otherwise (the web's fuel_unit). */
  unit?: string;
  /** Add the line: litres at full precision and the amount as entered (or worked out). */
  onAdd: (litres: number, amount: number) => void;
  onClose: () => void;
  look: FuelKeypadLook;
}) {
  const [field, setField] = useState<FuelField>('amount');
  const [entry, setEntry] = useState('');
  const [fullTank, setFullTank] = useState(false);
  const sale = fuelSale(field, entry, price);
  const ready = sale.amount > 0 && sale.litres > 0;

  const press = useCallback((k: string) => setEntry((e) => keyIn(e, k, field)), [field]);
  const confirm = useCallback(() => { if (ready) onAdd(sale.litres, sale.amount); }, [ready, sale.litres, sale.amount, onAdd]);
  const switchField = (f: FuelField) => { if (f !== field) { setField(f); setEntry(''); } setFullTank(false); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key) || e.key === '.') { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
      else if (e.key === 'Enter') { confirm(); e.preventDefault(); }
      else if (e.key === 'Escape') { onClose(); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, confirm, onClose]);

  return (
    <div {...painted(look.card)} data-testid="fuel-keypad" onClick={(e) => e.stopPropagation()}>
      <div style={{ height: 6, background: colour }} />
      <div {...painted(look.body)}>
        <div {...painted(look.head)}>
          <div style={{ minWidth: 0 }}>
            <h3 {...painted(look.title)}>{title}</h3>
            <div {...painted(look.subtitle)}>
              <span style={{ color: colour, fontWeight: 600 }}>{grade}</span>
              {' · '}{currency} {moneyText(price)}/{unit}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" {...painted(look.close)}>×</button>
        </div>

        <div {...painted(look.tabs)} role="tablist">
          {(['amount', 'litres'] as FuelField[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={field === f} data-testid={`fuel-field-${f}`} onClick={() => switchField(f)}
              {...painted(look.tab(field === f))}>
              {f === 'amount' ? `Amount (${currency})` : unit === 'L' ? 'Litres' : unit}
            </button>
          ))}
        </div>

        {/* The display: what is typed, and what it comes to */}
        <div {...painted(look.display)}>
          <div {...painted(look.entry)} data-testid="fuel-entry">
            {field === 'amount' ? `${currency} ${entry || '0'}` : `${entry || '0'} ${unit}`}
          </div>
          <div {...painted(look.conversion)} data-testid="fuel-conversion">
            {field === 'amount' ? `= ${qtyText(sale.litres, unit)}` : `= ${currency} ${moneyText(sale.amount)}`}
          </div>
        </div>
        {fullTank && <p {...painted(look.hint)} data-testid="full-tank-hint">Full tank: fill up, then enter the {unit === 'L' ? 'litres' : unit} the pump shows.</p>}

        <div {...painted(look.quickRow)}>
          {QUICK_AMOUNTS.map((q) => (
            <button key={q} type="button" data-testid="fuel-quick" onClick={() => { setField('amount'); setEntry(String(q)); setFullTank(false); }}
              {...painted(look.quick)}>
              {q.toLocaleString('en-KE')}
            </button>
          ))}
          <button type="button" data-testid="fuel-full-tank" onClick={() => { setField('litres'); setEntry(''); setFullTank(true); }}
            {...painted(look.fullTank(fullTank))}>
            Full tank
          </button>
        </div>

        <div {...painted(look.keys)}>
          {KEYS.map((k) => (
            <button key={k} type="button" onClick={() => press(k)} data-testid={`fuel-key-${k}`} aria-label={k === 'back' ? 'Delete' : k}
              {...painted(look.key)}>
              {k === 'back' ? '⌫' : k}
            </button>
          ))}
        </div>

        <div {...painted(look.actions)}>
          <button type="button" onClick={onClose} {...painted(look.cancel)}>Cancel</button>
          <button type="button" onClick={confirm} disabled={!ready} data-testid="fuel-add" {...painted(look.add)}>
            Add to sale · {currency} {moneyText(sale.amount)}
          </button>
        </div>
      </div>
    </div>
  );
}
