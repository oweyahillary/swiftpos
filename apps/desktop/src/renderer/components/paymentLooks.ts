/**
 * paymentLooks.ts — how the desktop POS paints the payment screen's shared pieces (@zaptill/ui QuickCash, TipPicker,
 * DiscountBox, BillSplit). The class names live here, where this app's Tailwind build finds them
 * (docs/SHARED-COMPONENTS-PLAN.md: no class names in packages/ui).
 */
import type { QuickCashLook } from '@zaptill/ui/QuickCash';
import type { TipPickerLook } from '@zaptill/ui/TipPicker';
import type { DiscountBoxLook } from '@zaptill/ui/DiscountBox';
import type { BillSplitLook } from '@zaptill/ui/BillSplit';

const CHIP = 'py-1.5 rounded-lg text-xs font-semibold border transition-colors tabular-nums';
const CHIP_ON = `${CHIP} bg-action-500/15 border-action-500 text-action-300`;
const CHIP_OFF = `${CHIP} bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600`;
const INPUT = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-action-500';

export const QUICK_CASH_LOOK: QuickCashLook = {
  row: 'grid grid-cols-4 gap-1.5',
  button: (on) => (on ? CHIP_ON : CHIP_OFF),
};

export const TIP_LOOK: TipPickerLook = {
  box: 'space-y-1.5',
  head: 'flex items-center justify-between',
  label: 'text-xs text-gray-400',
  amount: 'text-xs text-white font-medium tabular-nums',
  row: 'flex items-center gap-1.5',
  button: (on) => `${on ? CHIP_ON : CHIP_OFF} px-3`,
  input: 'w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-action-500',
  clear: 'text-xs text-gray-400 hover:text-white px-1',
};

export const DISCOUNT_LOOK: DiscountBoxLook = {
  box: '',
  label: 'block text-xs text-gray-400 mb-1',
  row: 'flex',
  input: INPUT.replace('rounded-lg', 'rounded-l-lg'),
  mode: 'px-3 bg-gray-700 border border-l-0 border-gray-700 rounded-r-lg text-sm text-gray-300 hover:text-white',
  capped: 'text-xs text-amber-400 mt-1',
};

export const BILL_SPLIT_LOOK: BillSplitLook = {
  box: 'bg-gray-800/40 border border-gray-800 rounded-xl p-3 space-y-3',
  ways: 'grid grid-cols-2 gap-1.5',
  way: (on) => (on ? CHIP_ON : CHIP_OFF),
  stepRow: 'flex items-center justify-between',
  stepLabel: 'text-sm text-gray-300',
  stepper: 'flex items-center gap-3',
  stepButton: 'w-8 h-8 rounded-lg bg-gray-800 border border-gray-700 text-white disabled:opacity-40',
  count: 'w-6 text-center text-white font-semibold tabular-nums',
  hint: 'text-xs text-gray-400',
  lines: 'space-y-1.5 max-h-52 overflow-y-auto',
  line: 'bg-gray-800/60 rounded-lg px-2.5 py-2',
  lineHead: 'flex justify-between gap-2 text-sm mb-1.5',
  lineName: 'text-gray-200 truncate',
  lineAmount: 'text-gray-400 tabular-nums flex-shrink-0',
  guests: 'flex flex-wrap gap-1.5',
  guest: (on) => `${on ? CHIP_ON : CHIP_OFF} px-2.5`,
};
