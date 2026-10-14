/**
 * testDataClear.ts — A404: when ZapTill clears a client's test data on the cloud (admin portal, A396), the till clears
 * the same period from its own database.
 *
 * Owner, 2026-10-04/05: the cloud clear removed test sales from the cloud, but every till still held them — its History,
 * shift reports and Z-reports showed them, and a test trading day left open on a till kept it locked ("Trading day
 * 2026-10-03 was never closed on this till"). On its sync the till now asks the cloud for clears it has not applied
 * (GET /api/pos/test-data-clears) and removes, for each period:
 *
 *   - sales made in it (and their items, payments, receipts, credit rows, kitchen voids, pending reversals), sent or not —
 *     an unsent test sale must not reach the cloud after the clear;
 *   - shifts opened in it, unless a sale AFTER the period belongs to one (that drawer was real — it stays);
 *   - trading days opened in it, unless a shift that stays belongs to one;
 *   - cash in / out and expenses in it, or on a removed shift; held orders and stock movements in it.
 *
 * Staff, settings and printers are never touched; the menu only when that clear deleted the whole menu (A482, below).
 * Stock levels come from the cloud on the next pull.
 *
 * Branch-wide on purpose: the cloud clear is for the whole business, so a branch node removes every terminal's rows of
 * the period, as the cloud did.
 */
import type Database from 'better-sqlite3';

/** `menu` (A482, migration 132): that clear also deleted the whole menu on the cloud — the till empties its own. */
export interface ClearPeriod { id: string; from_at: string; to_at: string; menu?: boolean }
export interface ClearCounts { sales: number; shifts: number; days: number; cash_moves: number; expenses: number; kept_shifts: number }

export function applyTestDataClear(db: Database.Database, p: ClearPeriod): ClearCounts {
  const from = p.from_at, to = p.to_at;
  const run = db.transaction((): ClearCounts => {
    // branch-wide: the cloud's clear covers the business — every terminal's rows of the period
    const orderIds = (db.prepare(`SELECT id FROM orders WHERE created_at >= ? AND created_at <= ?`).all(from, to) as Array<{ id: string }>).map((r) => r.id);
    // branch-wide: shifts of the period; one a later sale belongs to was real and stays
    const shifts = db.prepare(`
      SELECT s.id, s.business_day_id,
             EXISTS (SELECT 1 FROM orders o WHERE o.shift_id = s.id AND o.created_at > ?) AS used_after
        FROM shifts s WHERE s.opened_at >= ? AND s.opened_at <= ?`).all(to, from, to) as Array<{ id: string; business_day_id: string | null; used_after: number }>;
    const goShifts = shifts.filter((s) => !s.used_after).map((s) => s.id);
    const kept = shifts.length - goShifts.length;

    const inList = (ids: string[]) => ids.map(() => '?').join(',');
    let sales = 0;
    if (orderIds.length) {
      for (let i = 0; i < orderIds.length; i += 400) {
        const ids = orderIds.slice(i, i + 400); const q = inList(ids);
        db.prepare(`DELETE FROM order_item_variants  WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${q}))`).run(...ids);
        db.prepare(`DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${q}))`).run(...ids);
        db.prepare(`DELETE FROM order_items WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM payments WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM receipt_payloads WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM customer_credit_transactions WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM pending_reversals WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM kitchen_voids WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM sync_queue WHERE order_id IN (${q})`).run(...ids);
        // branch-wide: the period's sales, every terminal
        sales += db.prepare(`DELETE FROM orders WHERE id IN (${q})`).run(...ids).changes;
      }
    }

    let cash = 0, exp = 0;
    if (goShifts.length) {
      const q = inList(goShifts);
      // branch-wide: rows of the removed shifts
      cash += db.prepare(`DELETE FROM float_transactions WHERE shift_id IN (${q})`).run(...goShifts).changes;
      exp += db.prepare(`DELETE FROM expenses WHERE shift_id IN (${q})`).run(...goShifts).changes;
      db.prepare(`DELETE FROM kitchen_voids WHERE shift_id IN (${q})`).run(...goShifts);
      db.prepare(`DELETE FROM kitchen_lines WHERE shift_id IN (${q})`).run(...goShifts);
      db.prepare(`DELETE FROM shifts WHERE id IN (${q})`).run(...goShifts);
    }
    // branch-wide: the period's cash in / out and expenses not on any shift that stays
    cash += db.prepare(`DELETE FROM float_transactions WHERE created_at >= ? AND created_at <= ?
                          AND (shift_id IS NULL OR shift_id NOT IN (SELECT id FROM shifts))`).run(from, to).changes;
    exp += db.prepare(`DELETE FROM expenses WHERE created_at >= ? AND created_at <= ?
                         AND (shift_id IS NULL OR shift_id NOT IN (SELECT id FROM shifts))`).run(from, to).changes;
    // branch-wide: trading days of the period that no remaining shift belongs to
    const days = db.prepare(`DELETE FROM business_days WHERE opened_at >= ? AND opened_at <= ?
                               AND id NOT IN (SELECT business_day_id FROM shifts WHERE business_day_id IS NOT NULL)`).run(from, to).changes;
    db.prepare(`DELETE FROM held_orders WHERE held_at >= ? AND held_at <= ?`).run(from, to);
    db.prepare(`DELETE FROM stock_movements WHERE created_at >= ? AND created_at <= ?`).run(from, to);

    return { sales, shifts: goShifts.length, days, cash_moves: cash, expenses: exp, kept_shifts: kept };
  });
  return run();
}

// ── A482: the whole menu ─────────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-14: "can we add purge menu where we delete everything in the menu even the test data". The cloud's
// clear (migration 132, purge_test_menu) deleted every menu row of the business. The catalogue pull only UPSERTS
// products and categories (a product missing from the pull stays on the till), so an emptied cloud menu would never
// empty the till's: the till empties its own here, then pulls.
//
// The ids it removed are kept (maintenance_state `menu_purged_ids`) and every later pull drops them
// (dropPurgedMenu): a till fed by its branch server may pull from a branch server that has not applied the clear yet,
// and an upsert would bring the deleted menu straight back. A deleted product's id never comes back on the cloud (a new
// product gets a new id), so dropping those ids for good is safe.

export const MENU_PURGED_KEY = 'menu_purged_ids';
const MENU_PURGED_CAP = 50_000;

export interface MenuClearCounts { products: number; categories: number; variants: number; modifiers: number; combos: number; offers: number; stock: number }

export function applyMenuClear(db: Database.Database): MenuClearCounts {
  const run = db.transaction((): MenuClearCounts => {
    const ids = (sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => String(r.id));
    const gone = [
      ...ids(`SELECT id FROM products`), ...ids(`SELECT id FROM categories`), ...ids(`SELECT id FROM offers`),
      ...ids(`SELECT id FROM variant_groups`), ...ids(`SELECT id FROM variant_options`),
      ...ids(`SELECT id FROM modifier_groups`), ...ids(`SELECT id FROM modifier_options`),
    ];
    const before = purgedMenuIds(db);
    const all = [...new Set([...before, ...gone])].slice(-MENU_PURGED_CAP);
    db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(MENU_PURGED_KEY, JSON.stringify(all), new Date().toISOString());

    // the whole local menu — the till's caches of the cloud's, children first
    const variants = db.prepare(`DELETE FROM variant_options`).run().changes + db.prepare(`DELETE FROM variant_groups`).run().changes;
    const modifiers = db.prepare(`DELETE FROM modifier_options`).run().changes + db.prepare(`DELETE FROM modifier_groups`).run().changes;
    const combos = db.prepare(`DELETE FROM combo_items`).run().changes;
    const offers = db.prepare(`DELETE FROM offers`).run().changes;
    const stock = db.prepare(`DELETE FROM stock_levels`).run().changes;
    db.prepare(`DELETE FROM stock_movements`).run();
    db.prepare(`DELETE FROM local_price_edits`).run();   // branch prices of products that are gone
    db.prepare(`DELETE FROM category_stations`).run();   // station routing of categories that are gone (stations stay)
    // a menu change made on this till and not yet sent would re-create a product / category on the cloud
    db.prepare(`DELETE FROM local_changes WHERE entity IN ('product', 'category') AND state = 'pending'`).run();
    const products = db.prepare(`DELETE FROM products`).run().changes;
    const categories = db.prepare(`DELETE FROM categories`).run().changes;
    return { products, categories, variants, modifiers, combos, offers, stock };
  });
  return run();
}

/** The menu ids a cloud clear deleted (A482). */
export function purgedMenuIds(db: Database.Database): string[] {
  try {
    const raw = (db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(MENU_PURGED_KEY) as { value?: string } | undefined)?.value;
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/** The menu a pull brought, without what a cloud clear deleted (A482) — a branch server that has not applied the clear
 *  yet still serves it. Mutates nothing; returns the filtered lists. */
export function dropPurgedMenu<T extends {
  products: any[]; categories: any[]; comboItems?: Record<string, any[]>; offers: any[] | null;
  variantGroups: any[]; variantOptions: any[]; modifierGroups: any[]; modifierOptions: any[]; stockLevels: any[];
}>(db: Database.Database, r: T): T & { dropped: number } {
  const gone = new Set(purgedMenuIds(db));
  if (!gone.size) return { ...r, dropped: 0 };
  let dropped = 0;
  const keep = <X>(list: X[], key: (x: X) => unknown): X[] => (!Array.isArray(list) ? list : list.filter((x) => { const k = key(x); const out = k != null && gone.has(String(k)); if (out) dropped++; return !out; }));
  const anyKey = (x: any) => x?.id;
  const products = keep(r.products, anyKey);
  const categories = keep(r.categories, anyKey);
  const variantGroups = keep(r.variantGroups, (g: any) => (gone.has(String(g?.product_id)) ? g.product_id : g?.id));
  const variantOptions = keep(r.variantOptions, (o: any) => (gone.has(String(o?.variant_group_id)) ? o.variant_group_id : o?.id));
  const modifierGroups = keep(r.modifierGroups, (g: any) => (gone.has(String(g?.product_id)) ? g.product_id : g?.id));
  const modifierOptions = keep(r.modifierOptions, (o: any) => (gone.has(String(o?.modifier_group_id)) ? o.modifier_group_id : o?.id));
  const stockLevels = keep(r.stockLevels, (s: any) => s?.product_id);
  const offers = r.offers === null ? null : keep(r.offers, anyKey);
  let comboItems = r.comboItems;
  if (comboItems) {
    comboItems = {};
    for (const [combo, items] of Object.entries(r.comboItems ?? {})) {
      if (gone.has(String(combo))) { dropped++; continue; }
      comboItems[combo] = (items ?? []).filter((it: any) => !gone.has(String(it?.product_id)));
    }
  }
  return { ...r, products, categories, variantGroups, variantOptions, modifierGroups, modifierOptions, stockLevels, offers, comboItems, dropped };
}
