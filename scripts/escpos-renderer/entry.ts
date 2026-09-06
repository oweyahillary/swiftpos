// Build input (NOT type-checked by the dashboard). esbuild bundles this + the
// shared/printing render/escpos modules into one self-contained browser file.
import { renderTicket } from '../../shared/printing/src/render';
import { toEscPos } from '../../shared/printing/src/escpos';

const station = (paperWidthMm) => ({
  id: 'web-receipt', name: 'Receipt', kind: 'receipt', paperWidthMm,
  includeUnits: 'all', showPrices: true, showUnchangedUnits: false, showOptionPrices: true,
  emphasizeParent: false, aggregateUnits: false, showFooterCount: false,
  attributeStyle: 'inline-when-simple', openCashDrawer: true, cutPaper: true, feedBeforeCut: 3,
});

export function renderEscPos(order, business, paperWidth) {
  const ord = { ...order, soldAt: order.soldAt ? new Date(order.soldAt) : new Date() };
  return toEscPos(renderTicket({ order: ord, business, station: station(paperWidth) }));
}
