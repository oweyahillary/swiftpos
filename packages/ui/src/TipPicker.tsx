/**
 * TipPicker — the tip on both payment screens (owner decision 2026-11-04, docs/POS-SCREEN-COMPARISON.html): 5 %, 10 %,
 * 15 % of the bill, a typed amount, and Clear. A tip is added on top of the bill (never in it, never taxed). The screens
 * hide it while a payment is On account (as the web POS always has).
 *
 * Each app passes its look (./paint.ts).
 */
import { TIP_PERCENTS, tipAt, tipPercentOf } from '@zaptill/core/tender';
import { painted, type Paint } from './paint';

export interface TipPickerLook {
  box: Paint;
  head: Paint;
  label: Paint;
  amount: Paint;
  row: Paint;
  button: (chosen: boolean) => Paint;
  input: Paint;
  clear: Paint;
}

export default function TipPicker({ base, tip, onTip, currency, format, look }: {
  /** The bill the percentages are of (after discounts, before the tip). */
  base: number;
  tip: number;
  onTip: (tip: number) => void;
  currency: string;
  format: (n: number) => string;
  look: TipPickerLook;
}) {
  const chosenPct = tipPercentOf(tip, base);
  const typed = tip > 0 && chosenPct === null ? String(tip) : '';
  return (
    <div {...painted(look.box)} data-testid="tip-picker">
      <div {...painted(look.head)}>
        <span {...painted(look.label)}>Tip</span>
        {tip > 0 && <span {...painted(look.amount)}>+ {format(tip)}</span>}
      </div>
      <div {...painted(look.row)}>
        {TIP_PERCENTS.map((pct) => (
          <button key={pct} type="button" aria-pressed={chosenPct === pct} data-testid={`tip-${pct}`}
            onClick={() => onTip(chosenPct === pct ? 0 : tipAt(base, pct))} {...painted(look.button(chosenPct === pct))}>
            {pct}%
          </button>
        ))}
        <input type="number" min="0" inputMode="decimal" value={typed} placeholder={currency} aria-label={`Tip (${currency})`}
          data-testid="tip-custom" onChange={(e) => onTip(Math.max(0, parseFloat(e.target.value) || 0))} {...painted(look.input)} />
        {tip > 0 && (
          <button type="button" onClick={() => onTip(0)} data-testid="tip-clear" {...painted(look.clear)}>Clear</button>
        )}
      </div>
    </div>
  );
}
