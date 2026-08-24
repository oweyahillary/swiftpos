/**
 * heldOrders — restaurant "tabs": park an in-progress order, recall it later.
 *
 * These are OPEN TABLES. Food is cooking against them and no bill exists yet,
 * so losing one silently is the worst failure this app has.
 *
 * STORAGE — changed 2026-08-08 (register D2)
 * -----------------------------------------
 * Was: a single JSON blob in renderer localStorage, read through
 * `catch { return [] }`. A truncated write — a power cut mid-persist, which a
 * restaurant till on unprotected mains meets eventually — made JSON.parse throw
 * and the app reported ZERO open tables. No error, no log, no recovery, and the
 * KOTs already on the pass.
 *
 * Now: one row per tab in the main process's SQLite. better-sqlite3 writes land
 * or throw, and a bad row costs one table rather than all of them.
 *
 * Still deliberately LOCAL-ONLY and out of the sync queue: a held order has no
 * payment, so it is not yet an order. It joins the queue when it is charged.
 * Cross-till recall is register D9 and needs server state — not this.
 *
 * The order number is generated when the tab is first created (the kitchen
 * needs it on the KOT before payment exists) and reused at charge time, so the
 * ticket on the pass and the receipt always match.
 *
 * EVERY FUNCTION IS ASYNC. SQLite lives in the main process, so this is IPC.
 * That is the whole cost of the change and it is worth it.
 */

import type { CartItem } from './cart';

export interface HeldOrder {
  id: string;                 // local key
  orderNumber: string;        // pre-assigned, reused at charge
  label: string;              // "Table 4" / "Amina — takeaway"
  orderType: 'dine_in' | 'takeaway' | 'retail' | 'delivery';
  tableNumber: string;
  // Rider, on a held delivery. Without this a recalled delivery loses the name
  // and the receipt prints "Delivery Boy: —".
  deliveryPerson?: string;
  cart: CartItem[];           // per-line kotSent flags travel with the items
  heldAt: string;             // ISO
  /**
   * Set when this tab's cart could not be read back. The tab is still returned —
   * with an empty cart — so the cashier can see the table exists and rebuild it
   * from the KOT. Losing one cart is recoverable; a table disappearing is not.
   */
  corrupt?: boolean;
}

const LEGACY_KEY = 'swiftpos_held_orders';

const bridge = () => (window as any).swiftpos?.held;

/**
 * Move any tabs still in the old localStorage blob into SQLite.
 *
 * Without this, installing the fix on a till with open tables destroys them —
 * the change would cause exactly the loss it exists to prevent.
 *
 * The legacy key is cleared ONLY after the main process confirms the import.
 * If anything fails the blob stays put and we try again next launch; a
 * duplicated tab is annoying, a deleted one is a bill nobody can produce.
 * The import is idempotent on the existing ids, so retrying is safe.
 */
export async function importLegacyHeldOrders(): Promise<number> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return 0;                       // no localStorage available at all
  }
  if (!raw) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // This is the exact corruption that caused D2. There is nothing to recover,
    // but the raw text is kept under a dated key rather than dropped — if a
    // cashier reports "my tables vanished", it is the only evidence there is.
    try {
      localStorage.setItem(`${LEGACY_KEY}_corrupt_${Date.now()}`, raw);
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* nothing further to try */ }
    return 0;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return 0;
  }

  try {
    const { imported } = await bridge().importLegacy(parsed);
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    return imported ?? 0;
  } catch {
    return 0;                       // leave the blob alone and retry next launch
  }
}

export async function listHeldOrders(): Promise<HeldOrder[]> {
  try {
    return (await bridge().list()) ?? [];
  } catch {
    // A failure here is now loud in the main process log rather than silent —
    // but the till must keep selling, so the floor sees an empty tab list
    // rather than a dead screen. The rows are still in SQLite.
    return [];
  }
}

export async function holdOrder(
  order: Omit<HeldOrder, 'id' | 'heldAt' | 'corrupt'>,
): Promise<HeldOrder> {
  return await bridge().hold(order);
}

// Recall removes the tab and hands it back, in one transaction in the main
// process. If the cashier abandons the recalled order, holding it again simply
// creates a new tab.
export async function recallHeldOrder(id: string): Promise<HeldOrder | null> {
  try {
    return (await bridge().recall(id)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteHeldOrder(id: string): Promise<void> {
  try {
    await bridge().remove(id);
  } catch { /* the list refresh that follows will show the truth */ }
}
