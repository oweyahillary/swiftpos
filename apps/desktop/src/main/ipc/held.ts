// IPC: held (parked) orders, kept in this till's SQLite. Registered from ipcHandlers.ts (D10).
import { getLocalDb } from '../localDb';
import { noteActivity } from '../activityTracker';
import { logLine } from '../logFile';
import { signedIn as sessionPerson } from '../tillAccess';
import { cleanNote, ORDER_NOTE_MAX } from '../orderNotes';
import { cleanDeliveryFee } from '../delivery';
import { openKitchenOrders } from '../kitchenService';
import { anySent } from '../kitchenLines';
import { sellRefusal, isOpenBill } from '../sellGate';
import { openBills, type IpcShared } from './shared';

/** Held (parked) orders — SQLite on this till. */
export function registerHeldHandlers(ctx: IpcShared) {
  const { handle } = ctx;

  // ── Held orders (restaurant tabs) ───────────────────────
  //
  // Moved out of the renderer's localStorage on 2026-08-08. These are open
  // tables: food is cooking against them and no bill exists yet, so losing one
  // silently is the worst failure this app has. See localDb.ts held_orders.
  //
  // Every handler is synchronous SQLite behind an async channel — better-sqlite3
  // writes land or throw, so a crash cannot leave a half-written tab.

  type HeldRow = {
    id: string; order_number: string; label: string; order_type: string;
    table_number: string; delivery_person: string | null; cart: string; held_at: string;
    order_note?: string | null;   // A367 (58)
    delivery_fee?: number | null; // 0.6.27 (59)
    delivery_free?: number | null; // 0.6.33 (63)
  };

  // A tab whose cart JSON will not parse is returned with an EMPTY cart rather
  // than dropped. The cashier can then see "Table 4" exists, recall it and
  // rebuild it from the KOT — which beats the table vanishing and the food
  // going out unbilled. One bad row must never take the others with it.
  const toHeld = (r: HeldRow) => {
    let cart: unknown[] = [];
    let corrupt = false;
    try {
      const parsed = JSON.parse(r.cart);
      if (Array.isArray(parsed)) cart = parsed; else corrupt = true;
    } catch { corrupt = true; }
    if (corrupt) logLine('held', `unreadable cart on tab ${r.id} (${r.label}) — returned empty`);
    return {
      id: r.id,
      orderNumber: r.order_number,
      label: r.label,
      orderType: r.order_type,
      tableNumber: r.table_number,
      deliveryPerson: r.delivery_person ?? undefined,
      orderNote: r.order_note ?? undefined,   // A367
      deliveryFee: r.delivery_fee ? Number(r.delivery_fee) : undefined,   // 0.6.27
      deliveryFree: r.delivery_free ? true : undefined,   // 0.6.33
      cart,
      heldAt: r.held_at,
      corrupt: corrupt || undefined,
    };
  };

  const listHeld = () => {
    const db = getLocalDb();
    const rows = db.prepare(`SELECT * FROM held_orders ORDER BY held_at ASC`).all() as HeldRow[];
    return rows.map(toHeld);
  };

  handle('held:list', async () => listHeld());

  handle('held:hold', async (_event, order: any) => {
    noteActivity('held');   // A508: a bill held — the till is in use
    const db = getLocalDb();
    // A519: holding a bill already open is never refused (the cart is never lost); a new one needs "Sell".
    const refusedHold = sellRefusal('hold', sessionPerson(), isOpenBill(db, order?.orderNumber, openBills));
    if (refusedHold) throw new Error(refusedHold);
    const held = {
      id: `held_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      heldAt: new Date().toISOString(),
      ...order,
    };
    db.prepare(`
      INSERT INTO held_orders (id, order_number, label, order_type, table_number, delivery_person, cart, held_at, order_note, delivery_fee, delivery_free)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      held.id, held.orderNumber, held.label, held.orderType,
      held.tableNumber ?? '', held.deliveryPerson ?? null,
      JSON.stringify(held.cart ?? []), held.heldAt,
      cleanNote(held.orderNote, ORDER_NOTE_MAX),   // A367: the order's note survives a hold (the lines' notes ride in the cart)
      cleanDeliveryFee(held.deliveryFee) || null,  // 0.6.27: a held delivery keeps its fee with its rider
      held.deliveryFree ? 1 : null,                // 0.6.33: …and whether it is free
    );
    return { ...held, cart: held.cart ?? [] };
  });

  // Recall hands the tab back AND removes it, in one transaction. Read-then-
  // delete as two statements can hand the same tab to two recalls if the second
  // lands between them — two carts, one order number, one of them unbilled.
  handle('held:recall', async (_event, { id }: { id: string }) => {
    const db = getLocalDb();
    const take = db.transaction((tabId: string) => {
      const row = db.prepare(`SELECT * FROM held_orders WHERE id = ?`).get(tabId) as HeldRow | undefined;
      if (!row) return null;
      db.prepare(`DELETE FROM held_orders WHERE id = ?`).run(tabId);
      return toHeld(row);
    });
    const recalled = take(id);
    if (recalled) openBills.note(recalled.orderNumber);   // A519: a recalled bill stays open — it can be paid or held again
    return recalled;
  });

  handle('held:delete', async (_event, { id }: { id: string }) => {
    // 0.6.28: a tab with items on a kitchen ticket is not deleted — it is recalled and its items voided (with a manager
    // where the client requires one). Deleting it was the quiet way to make a sent order disappear.
    const db = getLocalDb();
    const row = db.prepare(`SELECT order_number, cart FROM held_orders WHERE id = ?`).get(id) as { order_number: string; cart: string } | undefined;
    if (row) {
      let cart: unknown = [];
      try { cart = JSON.parse(row.cart); } catch { cart = []; }
      const ledgerOpen = openKitchenOrders().some((o) => o.order_number === row.order_number);
      if (ledgerOpen || anySent(Array.isArray(cart) ? cart : [])) {
        throw new Error('This tab has items already sent to the kitchen. Recall it, then remove the items (a kitchen void).');
      }
    }
    db.prepare(`DELETE FROM held_orders WHERE id = ?`).run(id);
    return true;
  });

  /**
   * One-time import of tabs still sitting in the old localStorage blob.
   *
   * Without this, installing the fix on a till with open tables destroys them —
   * the change would cause exactly the loss it exists to prevent. Runs once on
   * renderer start, is idempotent (INSERT OR IGNORE on the existing ids), and
   * reports what it took so the renderer knows whether to clear the old key.
   */
  handle('held:import', async (_event, { orders }: { orders: any[] }) => {
    if (!Array.isArray(orders) || orders.length === 0) return { imported: 0 };
    const db = getLocalDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO held_orders
        (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let imported = 0;
    const run = db.transaction((rows: any[]) => {
      for (const o of rows) {
        if (!o?.id || !o?.orderNumber) continue;   // skip anything unusable, keep the rest
        const r = insert.run(
          String(o.id), String(o.orderNumber), String(o.label ?? ''), String(o.orderType ?? 'dine_in'),
          String(o.tableNumber ?? ''), o.deliveryPerson ? String(o.deliveryPerson) : null,
          JSON.stringify(Array.isArray(o.cart) ? o.cart : []), String(o.heldAt ?? new Date().toISOString()),
        );
        if (r.changes) imported++;
      }
    });
    run(orders);
    if (imported) logLine('held', `imported ${imported} tab(s) from legacy localStorage`);
    return { imported };
  });
}
