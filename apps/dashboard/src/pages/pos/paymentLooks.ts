/**
 * paymentLooks.ts — how the web POS paints the payment screen's shared pieces (@zaptill/ui QuickCash, TipPicker,
 * DiscountBox, BillSplit). The class names live here, where this app's Tailwind build finds them
 * (docs/SHARED-COMPONENTS-PLAN.md: no class names in packages/ui). The same design as the desktop POS's (owner
 * decision 2026-11-04), a touch larger for a finger on a phone or tablet.
 */
import type { QuickCashLook } from '@zaptill/ui/QuickCash';
import type { TipPickerLook } from '@zaptill/ui/TipPicker';
import type { DiscountBoxLook } from '@zaptill/ui/DiscountBox';
import type { BillSplitLook } from '@zaptill/ui/BillSplit';

const CHIP = 'py-2 rounded-lg text-sm border transition-colors tabular-nums';
const CHIP_ON = `${CHIP} bg-action-500/10 border-action-500 text-action-400 font-semibold`;
const CHIP_OFF = `${CHIP} bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600`;
const INPUT = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-action-500';

export const QUICK_CASH_LOOK: QuickCashLook = {
  row: 'grid grid-cols-4 gap-2 mb-2',
  button: (on) => (on ? CHIP_ON : CHIP_OFF),
};

export const TIP_LOOK: TipPickerLook = {
  box: 'bg-gray-800/40 rounded-xl p-3 space-y-2',
  head: 'flex items-center justify-between',
  label: 'text-sm text-gray-400',
  amount: 'text-white text-sm font-medium tabular-nums',
  row: 'flex flex-wrap items-center gap-2',
  button: (on) => `${on ? CHIP_ON : CHIP_OFF} px-3`,
  input: 'w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600',
  clear: 'px-2 py-2 text-sm text-gray-400 hover:text-gray-200',
};

export const DISCOUNT_LOOK: DiscountBoxLook = {
  box: '',
  label: 'block text-sm text-gray-400 mb-1.5',
  row: 'flex',
  input: INPUT.replace('rounded-lg', 'rounded-l-lg'),
  mode: 'px-3 bg-gray-700 border border-l-0 border-gray-700 rounded-r-lg text-sm text-gray-300 hover:text-white',
  capped: 'text-xs text-amber-400 mt-1',
};

export const BILL_SPLIT_LOOK: BillSplitLook = {
  box: 'space-y-3',
  ways: 'grid grid-cols-2 gap-2',
  way: (on) => (on ? CHIP_ON : CHIP_OFF),
  stepRow: 'flex items-center justify-between',
  stepLabel: 'text-gray-400 text-sm',
  stepper: 'flex items-center gap-3',
  stepButton: 'w-9 h-9 rounded-lg bg-gray-800 text-white disabled:opacity-40',
  count: 'text-white font-semibold w-8 text-center tabular-nums',
  hint: 'text-xs text-gray-500',
  lines: 'space-y-2 max-h-56 overflow-y-auto',
  line: 'bg-gray-800/50 border border-gray-700 rounded-xl p-2.5',
  lineHead: 'flex items-center justify-between mb-1.5',
  lineName: 'text-sm text-gray-200 truncate',
  lineAmount: 'text-sm text-gray-400 flex-shrink-0 ml-2 tabular-nums',
  guests: 'flex flex-wrap gap-1.5',
  guest: (on) => `${on ? CHIP_ON : CHIP_OFF} px-2.5 py-1 text-xs`,
};
