/**
 * QuickCash — the quick cash buttons on both payment screens (owner decision 2026-11-04, docs/POS-SCREEN-COMPARISON.html):
 * Exact, the next notes up (50, 100, 200, 500, 1,000) and the next round 100 / 1,000 (@zaptill/core/tender quickTenders).
 * A tap fills the cash given; the change shows where each screen shows it. The typed field stays for odd amounts.
 *
 * Each app passes its look (./paint.ts): the desktop under a cash payment's "Tendered", the web under "Amount tendered".
 */
import { isExactTender, quickTenders } from '@zaptill/core/tender';
import { painted, type Paint } from './paint';

export interface QuickCashLook {
  row: Paint;
  button: (chosen: boolean) => Paint;
}

export default function QuickCash({ due, given, onPick, format, look }: {
  /** The cash part to cover. */
  due: number;
  /** The cash given now (a button matching it shows chosen); null = none typed. */
  given: number | null;
  onPick: (amount: number) => void;
  /** The money as this screen writes it ("KES 1,000" / "1,000"). */
  format: (n: number) => string;
  look: QuickCashLook;
}) {
  const amounts = quickTenders(due);
  if (amounts.length === 0) return null;
  return (
    <div {...painted(look.row)} data-testid="quick-cash">
      {amounts.map((v) => (
        <button key={v} type="button" onClick={() => onPick(v)} aria-pressed={given === v} {...painted(look.button(given === v))}>
          {isExactTender(v, due) ? 'Exact' : format(v)}
        </button>
      ))}
    </div>
  );
}
