/**
 * The public surface of the printing package.
 *
 * Everything below the presets is flags. The presets exist so a new business
 * has working stations on day one, not because the three shapes are special —
 * a client who wants prices on the dispatch sheet flips one boolean, and a
 * client with five stations copies a preset five times.
 *
 * DEFAULTS BELOW ARE STATED, NOT GUESSED. Where the design discussion has not
 * settled a question, the preset picks the option that matches the approved
 * mockups and the flag stays available. Marked (UNSETTLED) so they are easy to
 * find and change.
 */

export * from './types';
export * from './document';
export { renderTicket } from './render';
export { toEscPos } from './escpos';
export { toPreview } from './preview';
export { splitTax, netOf, formatCents } from './money';
export { columnsFor } from './layout';

import type { StationConfig } from './types';

export function kitchenPreset(id: string, name: string, paperWidthMm: 58 | 80 = 80): StationConfig {
  return {
    id, name, kind: 'kitchen', paperWidthMm,
    includeUnits: 'routed',
    showPrices: false,
    showUnchangedUnits: true,
    showOptionPrices: false,
    emphasizeParent: true,        // (UNSETTLED) double-height dish names
    aggregateUnits: false,        // (UNSETTLED) per-parent, not multiplied out
    showFooterCount: true,        // (UNSETTLED) "5 items to cook"
    attributeStyle: 'always-sublines',
    openCashDrawer: false,
    cutPaper: true,
    feedBeforeCut: 3,
  };
}

export function dispatchPreset(id: string, name: string, paperWidthMm: 58 | 80 = 80): StationConfig {
  return {
    id, name, kind: 'dispatch', paperWidthMm,
    includeUnits: 'all',
    showPrices: false,
    showUnchangedUnits: true,
    showOptionPrices: false,
    emphasizeParent: false,
    aggregateUnits: false,
    showFooterCount: true,        // (UNSETTLED) "3 bags"
    attributeStyle: 'inline-when-simple',
    openCashDrawer: false,
    cutPaper: true,
    feedBeforeCut: 3,
  };
}

export function receiptPreset(id: string, name: string, paperWidthMm: 58 | 80 = 80): StationConfig {
  return {
    id, name, kind: 'receipt', paperWidthMm,
    includeUnits: 'all',
    showPrices: true,
    showUnchangedUnits: false,    // included components do not print
    showOptionPrices: true,       // (UNSETTLED) net deltas beneath the line
    emphasizeParent: false,
    aggregateUnits: false,
    showFooterCount: false,
    attributeStyle: 'inline-when-simple',
    openCashDrawer: true,
    cutPaper: true,
    feedBeforeCut: 3,
  };
}
export * from './transport';
export * from './spool';
export * from './spoolStore.memory';
export { business as sampleBusiness, order as sampleOrder } from './sampleTicket';
export { KITCHEN as SAMPLE_KITCHEN, DISPATCH as SAMPLE_DISPATCH } from './sampleTicket';
export { renderShiftReport } from './shiftReport';
export type { ShiftReportData, ShiftReportMethodLine } from './shiftReport';
export { hasPrintableContent } from './render';
