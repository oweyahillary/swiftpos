// IPC: the back office's menu — products, categories, stations, payment methods, combos, variants, modifiers.
// Registered from ipcHandlers.ts (D10); two register functions so the channels register in the order they always did.
import { isNodeRole } from '../deviceConfig';
import { getLocalDb } from '../localDb';
import { logLine } from '../logFile';
import { saveRoutingLocally, overlayPending, readPending as readPendingRouting, mayRoute } from '../stationRouting';   // A411
import { pushStationRoutingNow } from '../syncEngine';
import { signedInCan } from '../tillAccess';
import { getDeviceConfig } from '../deviceConfig';
import { overlayLocalChanges } from '../localChanges';   // A448
import { recordTillChange, tillChangeStates, changeKeys, dismissRefusedChanges, mayChange } from '../changeQueue';
import { type IpcShared } from './shared';

/** The back office's menu: saved lists offline, products, categories, stations, payment methods. */
export function registerMenuHandlers(ctx: IpcShared) {
  const { handle, requireKey, NOT_ALLOWED, STATIONS_REFUSED, manageOfflineReason, manageFetch, refreshCatalogue, overlayOnList, MENU_READ, MENU_REFUSED, withoutCosts, hasCost, PAYMENTS_REFUSED } = ctx;

  // ── Catalogue & staff management ─────────────────────────────────────────
  //
  // Deliberately ONLINE-ONLY. Orders queue offline because a sale must never be
  // refused, but catalogue edits must not: two tills inventing the same product
  // on a dead network would produce duplicates nobody can reconcile, and there
  // is no natural merge for "manager A renamed it, manager B repriced it".
  // These fail loudly with a message the owner can act on instead.
  //
  // Every call runs under the STAFF token, so the server's own permission
  // checks (products.manage, staff.manage) apply exactly as they do on the web.
  // The till does not get to decide who may edit the menu.
  // (A345: when it cannot be reached for an offline reason, the saved lists are shown — manageOfflineReason, ipc/shared.ts.)

  // What this till has saved, for the Menu page while offline (read-only). Only what sync already brought down.
  handle('manage:cachedMenu', async () => {
    const off = manageOfflineReason();
    if (!off) return { offline: null, products: [], categories: [], combos: [] };
    const db = getLocalDb();
    const products = db.prepare(`
      SELECT p.id, p.name, p.base_price, p.category_id, p.description, p.status,
             EXISTS (SELECT 1 FROM combo_items ci WHERE ci.combo_id = p.id) AS is_combo
        FROM products p WHERE COALESCE(p.status, 'active') = 'active' ORDER BY p.name COLLATE NOCASE`).all() as any[];
    const categories = db.prepare(`SELECT id, name FROM categories WHERE COALESCE(status, 'active') = 'active' ORDER BY sort_order, name`).all();
    const items = db.prepare(`SELECT combo_id, product_id, name, quantity FROM combo_items ORDER BY combo_id, sort_order`).all() as any[];
    const byCombo = new Map<string, any[]>();
    for (const it of items) {
      if (!byCombo.has(it.combo_id)) byCombo.set(it.combo_id, []);
      byCombo.get(it.combo_id)!.push({ product_id: it.product_id, name: it.name, quantity: it.quantity });
    }
    return {
      offline: off,
      products: products.map(p => ({ ...p, is_combo: !!p.is_combo })),
      categories,
      combos: [...byCombo].map(([id, list]) => ({ id, items: list })),
    };
  });

  // The Staff page while offline: the people this till knows (read-only). A branch node holds the whole branch roster; any
  // other till knows the people who have signed in on it. Names and roles only — never a PIN hash.
  handle('manage:cachedStaff', async () => {
    const off = manageOfflineReason();
    if (!off) return { offline: null, source: null, staff: [] };
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? null;
    const roster = isNodeRole(cfg?.device_role)
      ? db.prepare(`SELECT staff_id AS id, name, role_name, (status = 'active') AS is_active FROM branch_staff WHERE (? IS NULL OR branch_id = ?) ORDER BY name COLLATE NOCASE`).all(branchId, branchId)
      : db.prepare(`SELECT staff_id AS id, name, role_name FROM staff_pin_cache WHERE (? IS NULL OR branch_id = ?) ORDER BY name COLLATE NOCASE`).all(branchId, branchId);
    return {
      offline: off,
      source: isNodeRole(cfg?.device_role) ? 'branch' : 'till',
      // SQLite gives 0/1; the page reads `is_active === false`.
      staff: (roster as any[]).map(r => ('is_active' in r ? { ...r, is_active: !!r.is_active } : r)),
    };
  });

  // A448: what a product change may carry to be saved on the till first; anything more (a picture, sizes, extras, fuel,
  // sold by weight or the piece) needs the cloud first, as before.
  function tillCanHoldProduct(p: any): boolean {
    if (!p || typeof p !== 'object') return false;
    if (p.image_url) return false;
    if (p.has_variants === true || p.has_modifiers === true || p.is_fuel === true) return false;
    if (p.sold_by && p.sold_by !== 'each') return false;
    if (p.pieces_per_unit && Number(p.pieces_per_unit) > 1) return false;
    return true;
  }
  /** This till's products in the shape the menu screen reads (offline). */
  function localProductsForScreen(): any[] {
    return (getLocalDb().prepare(`SELECT p.*, p.plu AS plu_code, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.name`).all() as any[])
      .map((r) => ({ ...r, categories: r.category_id ? { id: r.category_id, name: r.category_name } : null,
        show_days: (() => { try { return r.show_days ? JSON.parse(r.show_days) : null; } catch { return null; } })() }));
  }
  // A448: what waits on this till (the screens' "not on the cloud yet" / "waiting for the owner" / "refused").
  handle('manage:changeStates', async () => tillChangeStates());
  // A520 (KRUNCH: "Changes made on this till: 5 not taken by the cloud", with nothing to do about it): a refused change is
  // already undone here (the cloud's value came back with the next pull); the manager clears them from the list once read.
  // Only the changes this person could have made (changeKeys — the same rule as making them); each is logged.
  handle('manage:dismissRefusedChanges', async () => {
    const r = dismissRefusedChanges((entity, op, data) => mayChange(entity, op, data));
    if (r.cleared) logLine('change', `A520 ${r.cleared} refused change(s) cleared from the list: ${r.summaries.join('; ').slice(0, 400)}`);
    return { ok: true, cleared: r.cleared };
  });
  const requireMenuChange = (op: 'create' | 'update', data: any) => {
    const keys = changeKeys('product', op, data && typeof data === 'object' ? data : null);
    if (!keys.every((k) => signedInCan(k))) throw new Error(MENU_REFUSED);
  };
  handle('manage:listProducts', async () => {
    requireKey(MENU_READ, NOT_ALLOWED);
    try { return withoutCosts(overlayOnList('product', await manageFetch('/api/products', 'GET'))); }
    catch { return withoutCosts(overlayOnList('product', localProductsForScreen())); }
  });
  handle('manage:createProduct', async (_e, payload: any) => {
    requireMenuChange('create', payload);
    if (hasCost(payload) && !signedInCan('menu.costs')) throw new Error(MENU_REFUSED);
    if (!tillCanHoldProduct(payload)) {
      const out = await manageFetch('/api/products', 'POST', payload);
      await refreshCatalogue();
      return out;
    }
    const ch = recordTillChange({ entity: 'product', op: 'create', data: payload });
    return { id: ch.entity_id, ...ch.data, change_state: 'pending' };
  });
  handle('manage:updateProduct', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireMenuChange('update', patch);
    if (!tillCanHoldProduct(patch)) {
      const out = await manageFetch(`/api/products/${id}`, 'PATCH', patch);
      await refreshCatalogue();
      return out;
    }
    const ch = recordTillChange({ entity: 'product', op: 'update', entity_id: id, data: patch });
    return { id, ...ch.data, change_state: 'pending' };
  });

  handle('manage:listCategories', async () => {
    requireKey(MENU_READ, NOT_ALLOWED);
    try { return overlayOnList('category', await manageFetch('/api/categories', 'GET')); }
    catch {
      const db = getLocalDb();
      return overlayOnList('category', db.prepare(`SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order`).all() as any[]);
    }
  });
  // ── Print stations ────────────────────────────────────────────────────────
  // Server-backed like categories, so one configuration reaches all three tills
  // rather than each terminal holding its own idea of where an order prints.
  // refreshCatalogue() after every write pulls the change straight back down.
  // Station writes used to refreshCatalogue() — the ENTIRE catalogue re-pulled
  // per tick-box click, so routing a 10-category kitchen meant ten multi-second
  // waits in a row. Routing edits touch exactly two tables; rewrite exactly
  // those, from the same response the panel is already shown.
  const refreshStationsLocal = async () => {
    const stations = await manageFetch('/api/stations', 'GET') as Array<{
      id: string; name: string; kind: string; sort_order: number; active: boolean; category_ids: string[] }>;
    const db = getLocalDb();
    db.transaction(() => {
      db.prepare(`DELETE FROM category_stations`).run();
      db.prepare(`DELETE FROM print_stations`).run();
      const now = new Date().toISOString();
      const insSt = db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active, synced_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const insLk = db.prepare(`INSERT OR IGNORE INTO category_stations (category_id, station_id) VALUES (?, ?)`);
      for (const st of stations ?? []) {
        insSt.run(st.id, st.name, st.kind, st.sort_order ?? 0, st.active ? 1 : 0, now);
        for (const cid of st.category_ids ?? []) insLk.run(cid, st.id);
      }
      overlayPending(db);   // A411: routing saved here and not yet on the cloud stays
      overlayLocalChanges(db);   // A448: changes made here stay
    })();
    return stations;
  };

  // Reads fall back to the LOCAL MIRRORS (pull-synced print_stations /
  // category_stations / categories) when the server is cold, rate-limited, or
  // away — the routing screen must render from the replica, not blank out
  // with "Request failed (503)" mid-setup. Writes still require the server:
  // stations are business-level, shared by every till.
  const localStations = () => {
    const db = getLocalDb();
    const sts = db.prepare(`SELECT id, name, kind, sort_order, active FROM print_stations WHERE active = 1 ORDER BY sort_order, name`).all() as any[];
    const links = db.prepare(`SELECT category_id, station_id FROM category_stations`).all() as any[];
    return sts.map(st => ({ ...st, active: !!st.active,
      category_ids: links.filter(l => l.station_id === st.id).map(l => l.category_id) }));
  };
  // A446 (owner's screenshot, 2026-10-11): the screen listed the CLOUD's stations while printing reads THIS TILL's copy —
  // a station added on the web or another till showed here, and Test print said 'No station "…"' (and the kitchen got
  // nothing for it) until the next menu pull. The list fetched is now also this till's copy, at once.
  handle('manage:listStations', async () => {
    // A411: while routing saved on this till waits for the cloud, this till's own copy is the truth for it.
    if (Object.keys(readPendingRouting(getLocalDb())).length) return withPendingFlags(localStations());
    try { await refreshStationsLocal(); return withPendingFlags(localStations()); }   // A448: the till's own (with its changes)
    catch { return withPendingFlags(localStations()); }
  });
  /** A411: mark the stations whose routing is saved here but not yet on the cloud. */
  function withPendingFlags(list: any[]) {
    const pending = readPendingRouting(getLocalDb());
    const changes = new Map(tillChangeStates('station').map((c) => [c.entity_id, c]));   // A448
    return (list ?? []).map((st: any) => {
      const c = changes.get(st.id);
      const out = pending[st.id] ? { ...st, category_ids: pending[st.id].category_ids, pending_sync: true } : st;
      return c ? { ...out, change_state: c.state, change_message: c.message } : out;
    });
  }

  // ── Custom payment methods (A97) ──────────────────────────────────────────
  // Manage from the till too, not just the dashboard. Writes go to the server;
  // after each, the local payment_methods cache (read by PaymentModal) is
  // rewritten so a newly-added tender appears at the POS without waiting for the
  // next full pull.
  async function refreshPaymentMethodsLocal() {
    try {
      const rows = await manageFetch('/api/payment-methods', 'GET') as Array<{ code: string; name: string; is_active: boolean }>;
      const db = getLocalDb();
      db.prepare('DELETE FROM payment_methods').run();
      const ins = db.prepare('INSERT OR REPLACE INTO payment_methods (code, name, sort_order) VALUES (?, ?, ?)');
      (rows ?? []).filter(m => m.is_active).forEach((m, i) => ins.run(m.code, m.name, i));
    } catch { /* the next catalogue pull will reconcile */ }
  }
  handle('manage:listPaymentMethods', async () => manageFetch('/api/payment-methods', 'GET'));
  handle('manage:createPaymentMethod', async (_e, payload: any) => {
    requireKey(['settings.payments'], PAYMENTS_REFUSED);
    const out = await manageFetch('/api/payment-methods', 'POST', payload);
    await refreshPaymentMethodsLocal();
    return out;
  });
  handle('manage:updatePaymentMethod', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireKey(['settings.payments'], PAYMENTS_REFUSED);
    const out = await manageFetch(`/api/payment-methods/${id}`, 'PATCH', patch);
    await refreshPaymentMethodsLocal();
    return out;
  });
  handle('manage:deletePaymentMethod', async (_e, id: string) => {
    requireKey(['settings.payments'], PAYMENTS_REFUSED);
    const out = await manageFetch(`/api/payment-methods/${id}`, 'DELETE');
    await refreshPaymentMethodsLocal();
    return out;
  });
  handle('manage:unassignedCategories', async () => {
    try {
      if (Object.keys(readPendingRouting(getLocalDb())).length) throw new Error('A411: answer from this till while routing waits');
      return await manageFetch('/api/stations/unassigned', 'GET');
    }
    catch {
      const db = getLocalDb();
      return (db.prepare(`
        SELECT c.id, c.name FROM categories c
         WHERE c.status = 'active'
           AND c.id NOT IN (SELECT category_id FROM category_stations)
         ORDER BY c.name`).all() as any[]);
    }
  });
  // A448 (owner, 2026-10-11: "a totally offline till can't add another printer — that's bad"): a station is added,
  // renamed or removed on this till first — it prints at once — and reaches the cloud after (changeQueue.ts).
  handle('manage:createStation', async (_e, payload: any) => {
    const name = String(payload?.name ?? '').trim();
    const dup = getLocalDb().prepare(`SELECT id FROM print_stations WHERE lower(name) = lower(?)`).get(name) as { id?: string } | undefined;
    if (dup?.id) throw new Error(`A station called "${name}" already exists here`);
    const ch = recordTillChange({ entity: 'station', op: 'create', data: { name, kind: payload?.kind ?? 'kitchen', sort_order: payload?.sort_order ?? 0 } });
    return { id: ch.entity_id, name, kind: ch.data.kind, sort_order: ch.data.sort_order ?? 0, active: true, category_ids: [], change_state: 'pending' };
  });
  // One-click day-one seed: Kitchen + Packing + Till, categories routed by
  // is_kitchen server-side (A92). Refresh the local station cache so routing
  // works on this terminal immediately.
  handle('manage:seedDefaultStations', async () => {
    requireKey(['stations.manage'], STATIONS_REFUSED);   // A490
    const out = await manageFetch('/api/stations/seed-defaults', 'POST', {});
    await refreshStationsLocal();
    return out;
  });
  handle('manage:updateStation', async (_e, { id, patch }: { id: string; patch: any }) => {
    const ch = recordTillChange({ entity: 'station', op: 'update', entity_id: id, data: patch });
    return { id, ...ch.data, change_state: 'pending' };
  });
  handle('manage:deleteStation', async (_e, id: string) => {
    recordTillChange({ entity: 'station', op: 'delete', entity_id: id });
    return { ok: true };
  });
  // A411: saved on this till first (tickets print the new way at once, online or not), then sent to the cloud — now if
  // it can be reached (through the branch server on a peer, A410), else at the next sync. See stationRouting.ts.
  handle('manage:setStationCategories', async (_e, { id, categoryIds }: { id: string; categoryIds: string[] }) => {
    const db = getLocalDb();
    const staff = db.prepare(`SELECT staff_name, role_name, permissions FROM staff_session WHERE id = 1`).get() as
      { staff_name: string; role_name: string | null; permissions: string } | undefined;
    if (!staff) throw new Error('Not signed in');
    if (!mayRoute(staff.role_name, staff.permissions)) throw new Error('Your role does not allow this change.');   // A490: stations.manage
    if (!db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(id)) throw new Error('That station is not on this till — leave this screen and open it again.');
    const saved = saveRoutingLocally(db, id, categoryIds, staff.staff_name);
    const outcome = (await pushStationRoutingNow())[id];
    if (outcome?.state === 'saved') {
      return { station_id: id, state: 'saved', category_ids: outcome.category_ids, rejected: outcome.rejected };
    }
    if (outcome?.state === 'refused') {
      // The cloud said no: show its routing again rather than the till's.
      try { await refreshStationsLocal(); } catch { /* the next pull does it */ }
      return { station_id: id, state: 'refused', message: outcome.message, category_ids: null, rejected: [] };
    }
    return { station_id: id, state: 'pending', message: outcome?.message ?? 'Saved on this till — it goes to the cloud at the next sync.',
             category_ids: saved, rejected: [] };
  });
}

/** The menu, continued: categories, bulk edits, combos, variants and modifiers. */
export function registerMenuOptionHandlers(ctx: IpcShared) {
  const { handle, requireKey, NOT_ALLOWED, manageFetch, refreshCatalogue, MENU_READ, MENU_REFUSED, hasCost, requireOnlineLicence } = ctx;

  // A448: saved on this till first, to the cloud after.
  handle('manage:createCategory', async (_e, payload: any) => {
    const name = String(payload?.name ?? '').trim();
    const dup = getLocalDb().prepare(`SELECT id FROM categories WHERE lower(name) = lower(?) AND status = 'active'`).get(name) as { id?: string } | undefined;
    if (dup?.id) throw new Error(`A category called "${name}" already exists.`);
    const ch = recordTillChange({ entity: 'category', op: 'create', data: payload });
    return { id: ch.entity_id, ...ch.data, change_state: 'pending' };
  });
  handle('manage:updateCategory', async (_e, { id, patch }: { id: string; patch: any }) => {
    const ch = recordTillChange({ entity: 'category', op: 'update', entity_id: id, data: patch });
    return { id, ...ch.data, change_state: 'pending' };
  });

  // Combos. The till sells a combo as one line; these define what the dispatcher
  // and kitchen tickets expand it into.
  // Bulk product import. The server maps category_name to EXISTING categories
  // and silently writes null when there is no match, so the UI creates any
  // missing categories first and only then calls this.
  handle('manage:bulkProducts', async (_e, rows: any[]) => {
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    if (Array.isArray(rows) && rows.some(hasCost) && !signedInCan('menu.costs')) throw new Error(MENU_REFUSED);   // A494
    const out = await manageFetch('/api/products/bulk', 'POST', { rows });
    await refreshCatalogue();
    return out;
  });

  handle('manage:listCombos', async () => { requireKey(MENU_READ, NOT_ALLOWED); return manageFetch('/api/combos', 'GET'); });
  handle('manage:createCombo', async (_e, payload: any) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch('/api/combos', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateCombo', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/combos/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:setComboItems', async (_e, { id, items }: { id: string; items: any[] }) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/combos/${id}/items`, 'PUT', { items });
    await refreshCatalogue();
    return out;
  });

  // Variants — the Spice group and anything else a product needs choosing.
  handle('manage:listVariantGroups', async (_e, productId: string) => {
    requireKey(MENU_READ, NOT_ALLOWED);
    return manageFetch(`/api/variants/groups?product_id=${encodeURIComponent(productId)}`, 'GET');
  });
  // Editing a group's kind, and its options. Without these the manager screen can
  // display what migration 45 classified but cannot resolve anything it left as
  // 'review' — which is exactly where a human is needed.
  handle('manage:updateVariantGroup', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/variants/groups/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:createVariantOption', async (_e, payload: any) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch('/api/variants/options', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateVariantOption', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/variants/options/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:deleteVariantOption', async (_e, id: string) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/variants/options/${id}`, 'DELETE');
    await refreshCatalogue();
    return out;
  });

  handle('manage:createVariantGroup', async (_e, payload: any) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch('/api/variants/groups', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:deleteVariantGroup', async (_e, id: string) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.edit'], MENU_REFUSED);   // A490
    const out = await manageFetch(`/api/variants/groups/${id}`, 'DELETE');
    await refreshCatalogue();
    return out;
  });

  // Add-on groups (modifier_groups). Distinct from variant groups: variants are
  // pick-exactly-one and change the unit price; modifiers are tick-any-number and
  // add on top. A meal whose fries AND drink can each be upgraded independently
  // needs modifiers — as one variant group the two upgrades are mutually
  // exclusive, so a customer could have a large chips or a bigger soda but never
  // both. The POS has always rendered these; nothing could create them.
  handle('manage:listModifierGroups', async (_e, productId: string) => {
    requireKey(MENU_READ, NOT_ALLOWED);
    return manageFetch(`/api/modifiers/groups?product_id=${encodeURIComponent(productId)}`, 'GET');
  });
  handle('manage:createModifierGroup', async (_e, payload: any) => { requireOnlineLicence(); requireKey(['menu.edit'], MENU_REFUSED); return manageFetch('/api/modifiers/groups', 'POST', payload); });
  handle('manage:deleteModifierGroup', async (_e, id: string) => { requireOnlineLicence(); requireKey(['menu.edit'], MENU_REFUSED); return manageFetch(`/api/modifiers/groups/${id}`, 'DELETE'); });
}
