// Build input (NOT type-checked by the dashboard). esbuild bundles this + the
// shared/printing render/escpos modules into one self-contained browser file.
// Exposes the THREE station renderers the web needs — customer receipt, kitchen,
// dispatch — all from shared/printing so the printed output matches the desktop
// (see shared/printing/test/sample.ts → SAMPLE-OUTPUT.txt, the golden format).
import { renderTicket } from '../../shared/printing/src/render';
import { toEscPos } from '../../shared/printing/src/escpos';

// Station configs copied from shared/printing/src/index.ts (receipt/kitchen/
// dispatch presets) rather than imported, so the browser bundle does not pull in
// index.ts's Node-only re-exports (transport/spool). KITCHEN is overridden to
// includeUnits:'all' — the web's "Full order printers" always print every item
// (no per-unit routing on the flat web cart), unlike the desktop combo model.
const receiptStation = (paperWidthMm) => ({
  id: 'web-receipt', name: 'Receipt', kind: 'receipt', paperWidthMm,
  // Web adaptation: the flat web cart has no combo base/delta split, so we show
  // variant/modifier sub-items as NAMES (showUnchangedUnits) and DON'T print
  // per-upgrade prices (the line's Amt is the true lineTotal — totals stay exact).
  includeUnits: 'all', showPrices: true, showUnchangedUnits: true, showOptionPrices: false,
  emphasizeParent: false, aggregateUnits: false, showFooterCount: false,
  attributeStyle: 'inline-when-simple', openCashDrawer: true, cutPaper: true, feedBeforeCut: 3,
});
const kitchenStation = (paperWidthMm) => ({
  id: 'web-kitchen', name: 'Kitchen', kind: 'kitchen', paperWidthMm,
  includeUnits: 'all', showPrices: false, showUnchangedUnits: true, showOptionPrices: false,
  emphasizeParent: true, aggregateUnits: false, showFooterCount: true,
  attributeStyle: 'always-sublines', openCashDrawer: false, cutPaper: true, feedBeforeCut: 3,
});
const dispatchStation = (paperWidthMm) => ({
  id: 'web-dispatch', name: 'Dispatch', kind: 'dispatch', paperWidthMm,
  includeUnits: 'all', showPrices: false, showUnchangedUnits: true, showOptionPrices: false,
  emphasizeParent: false, aggregateUnits: false, showFooterCount: true,
  attributeStyle: 'inline-when-simple', openCashDrawer: false, cutPaper: true, feedBeforeCut: 3,
});

const withDate = (order) => ({ ...order, soldAt: order.soldAt ? new Date(order.soldAt) : new Date() });

export function renderReceiptEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: receiptStation(paperWidth) }));
}
export function renderKitchenEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: kitchenStation(paperWidth) }));
}
export function renderDispatchEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: dispatchStation(paperWidth) }));
}
// Back-compat: the customer-receipt renderer keeps its old name (PaymentModal).
export const renderEscPos = renderReceiptEscPos;
