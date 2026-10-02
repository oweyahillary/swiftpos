export interface SelectedVariant {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  priceAdjustment: number;
}

export interface SelectedModifier {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  price: number;
}

export interface CartItem {
  product: any;
  quantity: number;
  selectedVariants: SelectedVariant[];
  selectedModifiers: SelectedModifier[];
  unitPrice: number;
  lineTotal: number;
  // Restaurant mode: is ALL of this line on a kitchen ticket? 0.6.28: derived from sentQty (kept for held tabs saved
  // before it, where it meant "all sent").
  kotSent?: boolean;
  // 0.6.28: how many of this line are already on a kitchen ticket. A send prints only quantity − sentQty; taking a
  // sent item back is a kitchen void (shared/kitchenLines.ts). Until 0.6.28 any change cleared kotSent and the whole
  // line went out again — a line of 2 that became 3 was cooked as 2 + 3.
  sentQty?: number;
  // 0.6.28: a stable id for the line — the kitchen ledger (kitchen_lines) and kitchen voids key on it.
  lineId?: string;
  // Petrol mode: a fuel line (quantity is litres). Drives litre-aware display
  // and suppresses the +/- stepper (fuel is re-entered, not incremented).
  isFuel?: boolean;
  // Which physical pump dispensed a fuel line. On the order header (first fuel
  // line wins — one fill-up per order in practice), it is what per-pump fuel
  // reports and tank deduction key on.
  pumpId?: string;
  // A367: the cashier's note on this line ("3 normal, 2 spicy", "No salt"). Free — never changes the price. Travels
  // to the kitchen ticket, the receipt, the till's order_items.notes and the cloud's.
  notes?: string | null;
}

// The price this till charges for a product: the per-branch override if one was
// synced down for the bound branch, otherwise the catalogue default. Keeping this
// in one place means every price read (cart math, display) resolves identically.
// See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6.
export function effectivePrice(product: any): number {
  const branch = product?.branch_price;
  return branch !== null && branch !== undefined ? Number(branch) : Number(product?.base_price ?? 0);
}

export function computeUnitPrice(product: any, selectedVariants: SelectedVariant[]): number {
  const adj = selectedVariants.reduce((s, v) => s + v.priceAdjustment, 0);
  return effectivePrice(product) + adj;
}

export function computeLineTotal(unitPrice: number, quantity: number, selectedModifiers: SelectedModifier[]): number {
  const modTotal = selectedModifiers.reduce((s, m) => s + m.price, 0);
  return (unitPrice + modTotal) * quantity;
}

export function cartSubtotal(items: CartItem[]): number {
  return items.reduce((s, i) => s + i.lineTotal, 0);
}

export function extractVat(total: number, vatRate: number): number {
  return total - total / (1 + vatRate / 100);
}

// Splits a tax-inclusive total into net, VAT and Catering/Tourism Levy.
// The net is backed out with the COMBINED rate, then each tax is charged on that
// net — VAT on the net, not on net-plus-CTL. ctlRate 0 makes this identical to
// extractVat above. Must stay in step with recomputeOrderTotals on the server,
// which is authoritative; divergence means the receipt contradicts the books.
export function extractTaxes(total: number, vatRate: number, ctlRate = 0) {
  const net = total / (1 + (vatRate + ctlRate) / 100);
  return { net, vat: net * (vatRate / 100), ctl: net * (ctlRate / 100) };
}

export function generateOrderNumber(): string {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `ORD-${ts}-${rand}`;
}
