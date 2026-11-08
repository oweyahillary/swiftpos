/**
 * LineChips — a cart line's sizes and add-ons as small chips, on both POS (owner decision 2026-11-04: the desktop's
 * chips; the web POS showed the sizes as one line of text and no add-ons). "Size: Large", then "+Extra cheese".
 *
 * Each app passes its look (./paint.ts).
 */
import { painted, type Paint } from './paint';

export interface LineChipsLook {
  row: Paint;
  variant: Paint;
  addOn: Paint;
}

export default function LineChips({ variants, addOns, look }: {
  variants: ReadonlyArray<{ optionId?: string; groupName: string; optionName: string }>;
  addOns: ReadonlyArray<{ optionId?: string; optionName: string }>;
  look: LineChipsLook;
}) {
  if (variants.length === 0 && addOns.length === 0) return null;
  return (
    <div {...painted(look.row)} data-testid="line-chips">
      {variants.map((v, i) => <span key={v.optionId ?? `v${i}`} {...painted(look.variant)}>{v.groupName}: {v.optionName}</span>)}
      {addOns.map((m, i) => <span key={m.optionId ?? `m${i}`} {...painted(look.addOn)}>+{m.optionName}</span>)}
    </div>
  );
}
