/**
 * heldOrders — restaurant "tabs": park an in-progress order, recall it later.
 *
 * Stored in localStorage per device. This is deliberately LOCAL-ONLY state:
 * a held order has no payment yet, so nothing belongs in the sync queue —
 * it only becomes an order (and syncs) when it's charged. Surviving an app
 * restart matters (lunch rush + a crash shouldn't lose 6 open tables), and
 * localStorage in the Electron renderer persists to disk, so it does.
 *
 * The order number is generated when the tab is first created (the kitchen
 * needs it on the KOT before payment exists) and reused at charge time, so
 * the ticket on the pass and the receipt always match.
 */

import type { CartItem } from './cart';

export interface HeldOrder {
  id: string;                 // local key
  orderNumber: string;        // pre-assigned, reused at charge
  label: string;              // "Table 4" / "Amina — takeaway"
  orderType: 'dine_in' | 'takeaway' | 'retail';
  tableNumber: string;
  cart: CartItem[];           // per-line kotSent flags travel with the items
  heldAt: string;             // ISO
}

const STORAGE_KEY = 'swiftpos_held_orders';

function load(): HeldOrder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HeldOrder[]) : [];
  } catch {
    return [];
  }
}

function persist(orders: HeldOrder[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

export function listHeldOrders(): HeldOrder[] {
  return load().sort((a, b) => a.heldAt.localeCompare(b.heldAt));
}

export function holdOrder(order: Omit<HeldOrder, 'id' | 'heldAt'>): HeldOrder {
  const orders = load();
  const held: HeldOrder = {
    ...order,
    id: `held_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    heldAt: new Date().toISOString(),
  };
  orders.push(held);
  persist(orders);
  return held;
}

// Recall removes the tab from storage and hands it back. If the cashier
// abandons the recalled order, holding it again simply creates a new tab.
export function recallHeldOrder(id: string): HeldOrder | null {
  const orders = load();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return null;
  const [held] = orders.splice(idx, 1);
  persist(orders);
  return held;
}

export function deleteHeldOrder(id: string): void {
  persist(load().filter(o => o.id !== id));
}

export function heldOrderCount(): number {
  return load().length;
}
