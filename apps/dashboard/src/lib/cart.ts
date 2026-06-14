import type { Product, SelectedVariant, SelectedModifier } from '../types';

export interface CartItem {
  product: Product;
  quantity: number;
  selectedVariants: SelectedVariant[];   // one per required variant group
  selectedModifiers: SelectedModifier[]; // zero or more modifier options

  // Derived — computed once at add-to-cart time, stored for display + order save
  unitPrice: number;   // base_price + sum of variant price_adjustments
  lineTotal: number;   // unitPrice * quantity + modifier prices * quantity

  // Restaurant course firing (optional). course is a free-text course name the
  // cashier assigns; fire_status 'held' keeps it off the kitchen until fired.
  course?: string | null;

  // Petrol: a fuel line whose quantity is litres (priced per litre). Drives
  // litre-aware display and suppresses the qty stepper.
  isFuel?: boolean;
  fire_status?: 'held' | 'fired';
}

export function computeUnitPrice(
  product: Product,
  selectedVariants: SelectedVariant[],
): number {
  const variantAdjustment = selectedVariants.reduce((sum, v) => sum + Number(v.priceAdjustment), 0);
  return Number(product.base_price) + variantAdjustment;
}

export function computeLineTotal(
  unitPrice: number,
  quantity: number,
  selectedModifiers: SelectedModifier[],
): number {
  const modifierTotal = selectedModifiers.reduce((sum, m) => sum + Number(m.price), 0);
  return (Number(unitPrice) + modifierTotal) * quantity;
}

export function cartSubtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.lineTotal, 0);
}

// Prices are VAT-inclusive — extract VAT portion from total
export function extractVat(total: number, vatRate: number): number {
  return total - total / (1 + vatRate / 100);
}

export function generateOrderNumber(): string {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `ORD-${ts}-${rand}`;
}
