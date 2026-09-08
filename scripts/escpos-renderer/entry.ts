// Build input (NOT type-checked by the dashboard). esbuild bundles this + the
// shared/printing render/escpos/routing modules into one self-contained browser
// file. Output matches the desktop (shared/printing/test/sample.ts → SAMPLE-OUTPUT).
import { renderTicket, hasPrintableContent } from '../../shared/printing/src/render';
import { renderShiftReport } from '../../shared/printing/src/shiftReport';
import { toEscPos } from '../../shared/printing/src/escpos';
import { isExcludedFromKitchen, toUnits, stationsForCategory, idsByKind } from '../../shared/printing/src/routing';

const withDate = (order) => ({ ...order, soldAt: order.soldAt ? new Date(order.soldAt) : new Date() });

// A254 FIX: pass the station's cut/feed/drawer through to toEscPos. Without this
// the paper never cut (continuous receipts) and never fed clear of the head (no
// bottom margin) — the opts were being dropped on every render.
function emit(station, order, business, reprint) {
  const doc = renderTicket({ order: withDate(order), business, station, reprint });
  return toEscPos(doc, {
    cut:           station.cutPaper,
    feedBeforeCut: station.feedBeforeCut,
    openDrawer:    station.openCashDrawer,
  });
}

// ── Fixed-station renderers (customer receipt path in PaymentModal) ────────────
const receiptStation = (paperWidthMm) => ({
  id: 'web-receipt', name: 'Receipt', kind: 'receipt', paperWidthMm,
  includeUnits: 'all', showPrices: true, showUnchangedUnits: true, showOptionPrices: false,
  emphasizeParent: false, aggregateUnits: false, showFooterCount: false,
  attributeStyle: 'inline-when-simple', openCashDrawer: true, cutPaper: true, feedBeforeCut: 3,
});

export function renderReceiptEscPos(order, business, paperWidth, reprint) { return emit(receiptStation(paperWidth), order, business, reprint); }
export const renderEscPos = renderReceiptEscPos;   // back-compat name (PaymentModal)

// ── Routed station renderer (printRouted) ─────────────────────────────────────
// A254 FIX: config is derived from the printer TYPE, not a 3-way kind. Master KOT
// (kot) is a KITCHEN-header, ALL-items copy for the expediter — NOT a second
// dispatch ticket (the "2 dispatch, missing kitchen" bug). Kitchen/bar are routed
// stations (only their categories); expeditor is the all-items dispatch copy.
function stationConfigForType(type, id, paperWidthMm) {
  const common = { id, paperWidthMm, aggregateUnits: false, feedBeforeCut: 3, cutPaper: true };
  if (type === 'receipt')
    // A255: the routed receipt is a proforma / copy (Print Bill) — it must NOT kick
    // the cash drawer. The drawer opens only on the actual payment receipt, which
    // goes through renderReceiptEscPos (PaymentModal), not this path.
    return { ...common, name: 'Receipt', kind: 'receipt', includeUnits: 'all', showPrices: true,
      showUnchangedUnits: true, showOptionPrices: false, emphasizeParent: false, showFooterCount: false,
      attributeStyle: 'inline-when-simple', openCashDrawer: false };
  if (type === 'expeditor')
    return { ...common, name: 'Dispatch', kind: 'dispatch', includeUnits: 'all', showPrices: false,
      showUnchangedUnits: true, showOptionPrices: false, emphasizeParent: false, showFooterCount: true,
      attributeStyle: 'inline-when-simple', openCashDrawer: false };
  // kitchen | bar | kot  → kitchen header; kitchen/bar route by category, kot shows all.
  const routed = (type === 'kitchen' || type === 'bar');
  return { ...common, name: 'Kitchen', kind: 'kitchen', includeUnits: routed ? 'routed' : 'all',
    showPrices: false, showUnchangedUnits: true, showOptionPrices: false, emphasizeParent: true,
    showFooterCount: true, attributeStyle: 'always-sublines', openCashDrawer: false };
}

export function renderStationEscPos(order, business, station) {   // station = { id, type, paperWidthMm }
  return emit(stationConfigForType(station.type, station.id, station.paperWidthMm), order, business);
}

// Lets printRouted skip a routed station that has nothing routed to it (no blank
// kitchen/bar tickets when the order has none of that station's categories).
export function stationHasContent(order, business, station) {
  const cfg = stationConfigForType(station.type, station.id, station.paperWidthMm);
  return hasPrintableContent({ order: withDate(order), business, station: cfg });
}

// A262: shift / Z-report — same renderer the desktop uses.
export function renderShiftReportEscPos(data, paperWidthMm) {
  return toEscPos(renderShiftReport(data, paperWidthMm), { cut: true, feedBeforeCut: 3, openDrawer: false });
}

export { toUnits, stationsForCategory, idsByKind, isExcludedFromKitchen };
