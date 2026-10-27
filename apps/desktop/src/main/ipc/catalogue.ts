// IPC: the sale screen's data from SQLite (products, categories, variants, modifiers, tables, pumps).
// Registered from ipcHandlers.ts (D10).
import { getLocalDb, effectiveReceiptFooter } from '../localDb';
import { getDeviceConfig, getPosFeatures, getStockCountFreeze, getScaleSettings } from '../deviceConfig';
import { parseNotePicks } from '../orderNotes';
import { cleanShowDays } from '@zaptill/core/productDays';
import { tillStockView } from '../stockGateLocal';   // A563
import { forecourtSales, forecourtTanks } from '../forecourt';   // A588
import { type IpcShared } from './shared';

/** The sale screen's data: products, categories, variants, modifiers, tables, pumps, payment methods. */
export function registerCatalogueHandlers(ctx: IpcShared) {
  const { handle, tillFetch, withinMs } = ctx;

  // ── POS data ────────────────────────────────────────────

  // Dining tables for the restaurant table map — synced reference data,
  // served from SQLite so the floor plan works fully offline.
  handle('pos:getTables', async () => {
    const db = getLocalDb();
    return db.prepare(`
      SELECT * FROM tables WHERE slot_type = 'dining' ORDER BY sort_order, name
    `).all();
  });

  // Fuel pumps for the petrol grid, each joined to its fuel product so the
  // renderer has the name + price/litre without a second lookup.
  handle('pos:paymentMethods', async () => {
    // Custom tenders cached from the last pull (A96). Available offline.
    return getLocalDb().prepare(
      `SELECT code, name FROM payment_methods ORDER BY sort_order, name`
    ).all();
  });

  handle('pos:getPumps', async () => {
    const db = getLocalDb();
    return db.prepare(`
      SELECT pu.id, pu.name, pu.status, pu.sort_order, pu.fuel_product_id,
             p.name       AS fuel_product_name,
             COALESCE(p.branch_price, p.base_price) AS price_per_litre
      FROM pumps pu
      LEFT JOIN products p ON p.id = pu.fuel_product_id
      ORDER BY pu.sort_order, pu.name
    `).all();
  });

  // A588: the pumps screen's gauges and counters — this POS's own fuel sales, and the tanks' levels when the cloud can
  // say (online licence, at most once a minute, 2 s); never a number this POS does not hold.
  handle('pos:forecourt', async () => {
    const tanks = await forecourtTanks(async () => {
      const res = await withinMs(tillFetch('/api/fuel-tanks', {}, 2_000), 2_000);
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    });
    return { ...forecourtSales(), ...tanks };
  });

  handle('pos:init', async () => {
    const db = getLocalDb();

    const products = db.prepare(`
      SELECT p.*, c.name as category_name, c.color as category_color
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.status = 'active'
      ORDER BY p.name
    `).all();

    const categories = db.prepare(`
      SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order
    `).all();

    // The till operates on its BOUND branch (device_config); the is_main row
    // is only the pre-binding fallback.
    const bound = getDeviceConfig()?.branch_id ?? null;
    const branch = bound
      ? { id: bound }
      : db.prepare(`SELECT id FROM branches WHERE is_main=1 LIMIT 1`).get() as any;
    // The receipt's header line 2 ("Juja — Till 1") wants the branch by NAME.
    const branchName = branch?.id
      ? ((db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branch.id) as any)?.name ?? null)
      : null;

    const shaped = products.map((p: any) => ({
      ...p,
      has_variants: p.has_variants === 1,
      has_modifiers: p.has_modifiers === 1,
      track_stock: p.track_stock === 1,
      show_days: cleanShowDays(p.show_days) ?? null,   // 0.6.31: the grid shows it only on these days (search: any day)
      categories: p.category_name ? { name: p.category_name, color: p.category_color } : null,
    }));

    // A537: the business's menus (Food, Soft drinks …) — on, in order; the panel's tabs (none = the plain list).
    let menus: unknown[] = [];
    try {
      // A578: each menu's hours (JSON text → the object; NULL = always) — the sale screen decides what is open by its clock.
      menus = (db.prepare(`SELECT id, name, sort_order, color, icon, availability FROM menus WHERE active = 1 ORDER BY sort_order, name`).all() as any[])
        .map((m) => { let availability: unknown = null; try { availability = m.availability ? JSON.parse(m.availability) : null; } catch { availability = null; } return { ...m, availability }; });
    }
    catch { menus = []; }   // a database before local schema 73

    return {
      products: shaped,
      branchName,
      categories,
      menus,
      branchId: branch?.id ?? null,
      // A578: when the business day ends (minutes after midnight) — a menu's hours past midnight belong to the night before.
      businessDayCutoff: getDeviceConfig()?.business_day_cutoff ?? 0,
      // Real business rate, refreshed by every catalogue pull. Null until the
      // first successful sync — POSPage falls back to 16 in that window only.
      vatRate: getDeviceConfig()?.vat_rate ?? null,
      ctlRate: getDeviceConfig()?.ctl_rate ?? 0,
      // Null until the first sync — POSPage falls back to the shared default,
      // which is the server's own, so an unsynced till cannot over-discount.
      maxDiscountPct: getDeviceConfig()?.max_discount_pct ?? null,
      receiptHeader: getDeviceConfig()?.receipt_header ?? '',
      receiptFooter: effectiveReceiptFooter(getDeviceConfig()?.receipt_footer),   // A544: the branch's own when set
      // A577: how this business's scales print their labels (the default until the cloud says) — the sale screen reads
      // scale labels with it, offline too.
      scaleBarcodes: getScaleSettings(),
      // combo_id -> components, for dispatcher/kitchen ticket expansion. Sent
      // whole because a busy till should never hit SQLite mid-print.
      comboItems: (() => {
        // category_id joined in so a COMPONENT can be routed the same way a
        // top-level line is. Without it, station routing would work for a plain
        // product and silently fall back to is_kitchen inside every combo — which
        // is most of the menu.
        const rows = db.prepare(
          `SELECT ci.combo_id, ci.product_id, ci.name, ci.quantity, ci.is_kitchen,
                  p.category_id
             FROM combo_items ci
             LEFT JOIN products p ON p.id = ci.product_id
            ORDER BY ci.combo_id, ci.sort_order`
        ).all() as any[];
        const out: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean; category_id: string | null }>> = {};
        for (const r of rows) {
          (out[r.combo_id] ??= []).push({
            product_id:  r.product_id,
            name:        r.name,
            quantity:    Number(r.quantity) || 1,
            is_kitchen:  r.is_kitchen === 1,
            category_id: r.category_id ?? null,
          });
        }
        return out;
      })(),
      // category_id -> is_kitchen. Still sent, and still used as the FALLBACK
      // when no stations are configured — see stationRouting below.
      kitchenCategories: (() => {
        const rows = db.prepare(`SELECT id FROM categories WHERE is_kitchen = 1`).all() as any[];
        return rows.map(r => r.id as string);
      })(),
      /**
       * Station routing, sent whole with the rest of the catalogue.
       *
       * `stations` empty means routing is NOT configured, and every caller must
       * fall back to the old is_kitchen behaviour. That fallback is the single
       * most important property here: a till that upgrades before anyone has set
       * up stations must keep printing exactly as it did yesterday, or the first
       * symptom is a kitchen receiving nothing during service.
       */
      stationRouting: (() => {
        const stations = db.prepare(
          `SELECT id, name, kind, sort_order FROM print_stations WHERE active = 1
            ORDER BY sort_order, name`
        ).all() as any[];
        const links = db.prepare(`SELECT category_id, station_id FROM category_stations`).all() as any[];
        const byCategory: Record<string, string[]> = {};
        for (const l of links) (byCategory[l.category_id] ??= []).push(l.station_id);
        return { stations, byCategory };
      })(),
    };
  });

  /** A529: this till holds its catalogue (the products table is written only by a catalogue pull). */
  const catalogueHeld = (): boolean => !!getLocalDb().prepare(`SELECT 1 FROM products LIMIT 1`).get();

  handle('pos:getVariants', async (_event, productId: string) => {
    const db = getLocalDb();
    const groups = db.prepare(`
      SELECT * FROM variant_groups WHERE product_id=? ORDER BY sort_order
    `).all(productId) as any[];

    if (groups.length === 0) {
      // A529 (the owner's System page, 2026-10-19: /api/variants 557 calls in 36 min across ~4 tills): an empty local list
      // after a catalogue pull MEANS no options — the pull brings every product's choices. Before, every tap of a product
      // without options (most of them) asked the cloud, and a slow or down cloud held the item up to 15 s before the cart.
      // Only a till that has never pulled its catalogue asks, bounded to 2 s; another server's page is no connection
      // (cloudFetch throws) — empty.
      if (catalogueHeld()) return [];
      try {
        const res = await withinMs(tillFetch(`/api/variants/groups?product_id=${productId}`, {}, 2_000), 2_000);
        if (res.ok) return await res.json();
      } catch { /* offline, slow, signed out or not the cloud — return empty */ }
      return [];
    }

    return groups.map(g => ({
      ...g,
      required: g.required === 1,
      variant_options: db.prepare(
        `SELECT * FROM variant_options WHERE variant_group_id=? ORDER BY sort_order`
      ).all(g.id),
    }));
  });

  // A367: the quick picks for order notes — the owner's list cached by the catalogue pull, else the defaults.
  handle('pos:notePicks', async () => parseNotePicks(getDeviceConfig()?.order_note_picks ?? null));

  // 0.6.27: the per-client POS switches (admin portal), as the till last heard them — all off until told.
  handle('pos:features', async () => getPosFeatures());
  // A394: the items a stock count freezes at this branch (the sale screen refuses them).
  handle('pos:stockCountFreeze', async () => getStockCountFreeze());
  // A563: the owner's "When an item's stock reaches zero" choice and this branch's known levels (tracked items only) — the
  // sale screen greys ("Sold out") or hides an item that is out. Read again after every sale and every ~20 s.
  handle('pos:stockView', async () => tillStockView());

  handle('pos:getModifiers', async (_event, productId: string) => {
    const db = getLocalDb();
    const groups = db.prepare(`
      SELECT * FROM modifier_groups WHERE product_id=? ORDER BY sort_order
    `).all(productId) as any[];

    if (groups.length === 0) {
      // A529 (the owner's System page, 2026-10-19: /api/variants 557 calls in 36 min across ~4 tills): an empty local list
      // after a catalogue pull MEANS no options — the pull brings every product's choices. Before, every tap of a product
      // without options (most of them) asked the cloud, and a slow or down cloud held the item up to 15 s before the cart.
      // Only a till that has never pulled its catalogue asks, bounded to 2 s; another server's page is no connection
      // (cloudFetch throws) — empty.
      if (catalogueHeld()) return [];
      try {
        const res = await withinMs(tillFetch(`/api/modifiers/groups?product_id=${productId}`, {}, 2_000), 2_000);
        if (res.ok) return await res.json();
      } catch { /* offline, slow, signed out or not the cloud — return empty */ }
      return [];
    }

    return groups.map(g => ({
      ...g,
      modifier_options: db.prepare(
        `SELECT * FROM modifier_options WHERE modifier_group_id=? ORDER BY sort_order`
      ).all(g.id),
    }));
  });
}
