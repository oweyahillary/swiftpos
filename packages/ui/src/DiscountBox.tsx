/**
 * DiscountBox — the cashier's own discount on both payment screens (owner decision 2026-11-04: the desktop's box, now on
 * the web POS too): an amount or a percentage, switched by the button beside it. The screen caps it at the role's
 * maximum (the cloud caps it the same way) and passes the words for a capped one ("Capped at 10% — … Ask a manager").
 * Shown only to a person who may give a discount (sales.discount).
 *
 * Each app passes its look (./paint.ts).
 */
import { painted, type Paint } from './paint';

export type DiscountMode = 'amount' | 'percent';

export interface DiscountBoxLook {
  box: Paint;
  label: Paint;
  row: Paint;
  input: Paint;
  mode: Paint;
  capped: Paint;
}

export default function DiscountBox({ value, mode, onValue, onMode, currency, capped, look }: {
  value: string;
  mode: DiscountMode;
  onValue: (v: string) => void;
  onMode: (m: DiscountMode) => void;
  currency: string;
  /** The words for a discount the role's maximum capped; null / '' = not capped. */
  capped?: string | null;
  look: DiscountBoxLook;
}) {
  return (
    <div {...painted(look.box)} data-testid="discount-box">
      <label {...painted(look.label)}>Discount</label>
      <div {...painted(look.row)}>
        <input type="number" min="0" inputMode="decimal" value={value} placeholder="0" aria-label="Discount"
          onChange={(e) => onValue(e.target.value)} {...painted(look.input)} />
        <button type="button" title="Toggle amount / percent" onClick={() => onMode(mode === 'amount' ? 'percent' : 'amount')}
          {...painted(look.mode)}>
          {mode === 'amount' ? currency : '%'}
        </button>
      </div>
      {/* The cloud caps this and stores the capped figure: saying so here lets the cashier correct the entry instead of a
          drawer that reads short at close. */}
      {capped && <p {...painted(look.capped)}>{capped}</p>}
    </div>
  );
}
