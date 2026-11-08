/**
 * BillSplitPanel — the desktop payment screen's "Split the bill" (owner decision 2026-11-04): evenly per person or by
 * item per guest (@zaptill/ui BillSplit). "Use these parts" turns the shares into this screen's payments — one per
 * person, each any method (the M-Pesa prompt, On account, a reference) as a split payment always was.
 * Loaded when opened (the POS's main chunk budget, lazy-load-a517).
 */
import BillSplit, { type BillLine, type BillShare, type SplitWay } from '@zaptill/ui/BillSplit';
import { BILL_SPLIT_LOOK } from './paymentLooks';

export default function BillSplitPanel({ total, lines, format, onUse, onCancel }: {
  total: number;
  lines: BillLine[];
  format: (n: number) => string;
  /** The parts with something to pay, in order. */
  onUse: (shares: BillShare[], way: SplitWay) => void;
  onCancel: () => void;
}) {
  return (
    <BillSplit total={total} lines={lines} format={format} look={BILL_SPLIT_LOOK}>
      {(shares, ready, way) => (
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-lg py-2 text-sm">Cancel</button>
          <button type="button" disabled={!ready} data-testid="split-use"
            onClick={() => onUse(shares.filter((s) => s.amount > 0), way)}
            className="flex-[2] bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-semibold rounded-lg py-2 text-sm">
            {ready ? `Use these ${shares.filter((s) => s.amount > 0).length} parts` : 'Put items on at least 2 guests'}
          </button>
        </div>
      )}
    </BillSplit>
  );
}
