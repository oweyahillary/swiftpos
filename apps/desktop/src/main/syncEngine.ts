// Sync Engine — runs in Electron main process
//
// PULL: products, categories, variants, modifiers, stock_levels → SQLite  (remote wins)
// PUSH: pending sync_queue rows → POST /api/orders                         (local wins)
//
// Stock conflict resolution:
//   Remote pull    → overwrites local quantity (remote wins for price/stock reference)
//   Local sale     → delta deduction (quantity - sold), never absolute overwrite
//   This means an offline sale is always applied on top of whatever quantity is current

import { net } from 'electron';
import { getLocalDb, LOCAL_SCHEMA_VERSION } from './localDb';
import { getDeviceConfig, saveDeviceConfig, getServerUrl } from './deviceConfig';
import { hasNode, pushOrderToNode, confirmNodeDelivery } from './nodeClient';
import { v4 as uuid } from 'uuid';
// ── Sync direction — the single authoritative source of truth ────────────────
// Getting a table's direction wrong = data loss (e.g. pulling a local-origin
// table would overwrite unsynced till data with stale/empty server rows). So
// every synced table is declared here explicitly, and nothing syncs by accident.
//
//   'pull'  = remote wins. Reference data, never edited on the till. Server
//             overwrites local on every sync.
//   'push'  = local origin. Created at the till (often offline); the till is the
//             source of truth until the row is pushed. Never overwritten by pull.
//
// Phase B adds users (pull) + the shifts/float/expenses tables (push). Their
// push wiring lands in Phase C, when the shift open/close + expense UI actually
// creates rows — there is nothing to push until then, so no push code exists yet.
export const SYNC_DIRECTION: Record<string, 'pull' | 'push'> = {
  // Pull-down, remote wins
  products: 'pull', categories: 'pull', combo_items: 'pull',
  variant_groups: 'pull', variant_options: 'pull',
  modifier_groups: 'pull', modifier_options: 'pull',
  stock_levels: 'pull', branches: 'pull', users: 'pull', tables: 'pull', pumps: 'pull',
  // Push-up, local origin
  orders: 'push', order_items: 'push',
  order_item_variants: 'push', order_item_modifiers: 'push',
  payments: 'push', customer_credit_transactions: 'push',
  shifts: 'push', float_transactions: 'push', expenses: 'push',
  business_days: 'push',
};

let _serverUrl   = '';
let _accessToken  = '';   // owner/device token — used for catalogue pull
let _refreshToken = '';
let _staffToken   = '';   // per-shift staff token — used for order push
let _staffRefresh = '';
let _isSyncing    = false;

export function configureSyncEngine(serverUrl: string, accessToken: string, refreshToken = '') {
  _serverUrl    = serverUrl;
  _accessToken  = accessToken;
  _refreshToken = refreshToken;
}

// Set/clear the active staff token. Called on PIN login and shift end.
export function configureStaffSession(staffToken: string, staffRefresh = '') {
  _staffToken   = staffToken;
  _staffRefresh = staffRefresh;
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${_accessToken}`,
  };
}

// Silently refreshes the access token using the stored refresh token.
// Updates in-memory tokens and persists them back to SQLite session.
//
// Exported because the IPC handlers need it too. The PIN screen calls
// /api/branches with the token straight out of SQLite, and that token has
// usually expired overnight — the first launch of the day showed "Invalid or
// expired token" and an empty branch list, and only worked on the SECOND launch
// because the background sync had refreshed and persisted a new one in the
// meantime. Anything holding the owner token must be able to refresh and retry.
export async function refreshAccessToken(): Promise<boolean> {
  // The in-memory token is empty until configureSyncEngine() has run, which
  // happens on auth:getSession. Don't depend on that ordering — a handler can
  // fire before it. Fall back to whatever is persisted.
  let refresh = _refreshToken;
  if (!refresh) {
    try {
      const row = getLocalDb().prepare(`SELECT refresh_token FROM session WHERE id=1`).get() as any;
      refresh = row?.refresh_token ?? '';
    } catch { /* no db yet */ }
  }
  if (!refresh) return false;
  try {
    const res = await fetch(`${_serverUrl || getServerUrl()}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const { accessToken, refreshToken } = await res.json();
    _accessToken  = accessToken;
    _refreshToken = refreshToken;
    // Persist updated tokens to SQLite so they survive app restarts
    const db = getLocalDb();
    db.prepare(`UPDATE session SET token = ?, refresh_token = ? WHERE id = 1`)
      .run(accessToken, refreshToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns a server error body into a message worth storing.
 *
 * The server hides internal detail behind a generic message and returns a short
 * `ref` keying the full detail in its own logs. Discarding that ref made a real
 * failure — three unapplied migrations, every order rejected with "Failed to
 * create order" — take most of a day to trace, because nothing on the till
 * pointed at the log line naming the cause.
 *
 * Keeping it means last_error reads:
 *     Failed to create order (ref: fae3cb28)
 * and one search of the server log gives the answer.
 */
function describeServerError(body: any, status: number): string {
  const base   = body?.error ?? `HTTP ${status}`;
  const detail = typeof body?.detail === 'string' ? body.detail : '';   // dev builds only
  const ref    = typeof body?.ref === 'string' ? body.ref : '';
  if (detail) return `${base} — ${detail}`;
  return ref ? `${base} (ref: ${ref})` : String(base);
}

function isOnline(): boolean {
  return net.isOnline();
}

// Auth header for order push — uses the staff token if a shift is active,
// otherwise falls back to the owner token (e.g. owner ringing a sale directly).
function pushAuthHeaders() {
  const token = _staffToken || _accessToken;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    // Which local schema this build carries. Tills are updated by installing an
    // .exe by hand, so one is always behind; sending this lets the server say so
    // instead of the mismatch surfacing as an opaque column error mid-service.
    'X-Schema-Version': String(LOCAL_SCHEMA_VERSION),
  };
}

// Refresh the active STAFF token (each shift independent) and persist to
// staff_session. Returns false if there's no staff refresh token or it failed.
async function refreshStaffToken(): Promise<boolean> {
  if (!_staffRefresh) return false;
  try {
    const res = await fetch(`${_serverUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: _staffRefresh }),
    });
    if (!res.ok) return false;
    const { accessToken, refreshToken } = await res.json();
    _staffToken   = accessToken;
    _staffRefresh = refreshToken ?? _staffRefresh;
    const db = getLocalDb();
    db.prepare(`UPDATE staff_session SET token = ?, refresh_token = ? WHERE id = 1`)
      .run(_staffToken, _staffRefresh);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────

export async function syncAll(): Promise<{ pulled: boolean; pushed: number; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pulled: false, pushed: 0, errors: ['Not configured'] };
  if (!isOnline()) return { pulled: false, pushed: 0, errors: ['Offline'] };
  if (_isSyncing) return { pulled: false, pushed: 0, errors: ['Sync already in progress'] };

  _isSyncing = true;
  const errors: string[] = [];
  let pulled = false;
  let pushed = 0;

  try {
    pulled = await pullCatalogue();
    // If pull returns false it may be a 401 — try refreshing once
    if (!pulled && _refreshToken) {
      const refreshed = await refreshAccessToken();
      if (refreshed) pulled = await pullCatalogue();
    }
    await pushLocalRecords(errors);     // shifts/floats/expenses first (FK parents)
    await pushBranchPriceEdits(errors); // manager's branch-price edits (independent)
    pushed = await pushPendingOrders(errors);
    await confirmCloudDelivery(errors);  // peer tills: node_ack -> synced
    await reconcileClosedShifts(errors); // close server-side now this shift's orders are in (C6)
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    _isSyncing = false;
  }

  return { pulled, pushed, errors };
}

// Push-only pass — cheap (no catalogue pull), safe to run frequently.
// Used by the background interval, the post-sale flush, and online-reconnect.
export async function syncPush(): Promise<{ pushed: number; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pushed: 0, errors: ['Not configured'] };
  if (!isOnline()) return { pushed: 0, errors: ['Offline'] };
  if (_isSyncing) return { pushed: 0, errors: ['Sync already in progress'] };

  _isSyncing = true;
  const errors: string[] = [];
  let pushed = 0;
  try {
    await pushLocalRecords(errors);     // shifts/floats/expenses first (FK parents)
    await pushBranchPriceEdits(errors); // manager's branch-price edits (independent)
    pushed = await pushPendingOrders(errors);
    await confirmCloudDelivery(errors);  // peer tills: node_ack -> synced
    await reconcileClosedShifts(errors); // close server-side now this shift's orders are in (C6)
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    _isSyncing = false;
  }
  return { pushed, errors };
}

export function getSyncStatus(): { online: boolean; pendingCount: number; failedCount: number } {
  const db = getLocalDb();
  const pending = db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending'`).get() as { count: number };
  const failed  = db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = 'failed'`).get() as { count: number };
  // Offline-origin records (shifts/floats/expenses) waiting to push count too, so
  // the till's "N pending" reflects everything not yet on the server.
  const localPending = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM shifts             WHERE sync_status='pending') +
      (SELECT COUNT(*) FROM float_transactions WHERE sync_status='pending') +
      (SELECT COUNT(*) FROM expenses           WHERE sync_status='pending') +
      -- Handed to the branch node but not yet confirmed onto the cloud. The
      -- sync_queue row is already 'synced' at that point, so without this the
      -- header would read "Synced" while the cloud still had none of the sales —
      -- exactly when a manager should NOT be closing the shift.
      (SELECT COUNT(*) FROM orders              WHERE sync_status='node_ack') AS count
  `).get() as { count: number };
  return { online: isOnline(), pendingCount: pending.count + localPending.count, failedCount: failed.count };
}

// Re-arm rows that exhausted their 5 attempts (cashier-initiated). Resetting
// attempts gives them a fresh budget; the idempotency key on push guarantees
// a retry of an order the server actually received dedupes instead of duplicating.
export async function retryFailedOrders(): Promise<{ requeued: number; pushed: number; errors: string[] }> {
  const db = getLocalDb();
  const result = db.prepare(
    `UPDATE sync_queue SET status='pending', attempts=0 WHERE status='failed'`
  ).run();
  if (result.changes === 0) return { requeued: 0, pushed: 0, errors: [] };
  const { pushed, errors } = await syncPush();
  return { requeued: result.changes, pushed, errors };
}

// ── Pull catalogue + stock from Express ─────────────────────

async function pullCatalogue(): Promise<boolean> {
  // Price for the branch this till is actually bound to (per-branch pricing).
  // Sent as ?branch_id so /api/pos/init returns branch_price per product.
  const boundBranchForPricing: string | null = getDeviceConfig()?.branch_id ?? null;
  const initUrl = boundBranchForPricing
    ? `${_serverUrl}/api/pos/init?branch_id=${encodeURIComponent(boundBranchForPricing)}`
    : `${_serverUrl}/api/pos/init`;
  const res = await fetch(initUrl, { headers: authHeaders() });
  if (!res.ok) return false;

  const { products, categories, branchId, vatRate, ctlRate, maxDiscountPct, businessType, comboItems, receiptHeader, receiptFooter } = await res.json();
  const db = getLocalDb();
  const now = new Date().toISOString();

  // Persist the business VAT rate on every pull. POSPage used to hardcode 16,
  // which meant a business on any other rate had the wrong tax computed at the
  // till, shown in the payment modal and printed on the customer's receipt —
  // while the server recomputed the correct figure on push, so the receipt and
  // the database disagreed with nothing to flag it.
  const pulledVat = Number(vatRate);
  if (Number.isFinite(pulledVat)) saveDeviceConfig({ vat_rate: pulledVat });
  const pulledCtl = Number(ctlRate);
  if (Number.isFinite(pulledCtl)) saveDeviceConfig({ ctl_rate: pulledCtl });
  // Same reasoning as VAT: the server caps discounts on write and stores the
  // capped figure, so a till clamping to a different ceiling prints a receipt
  // the database will not agree with. Pull the real policy and clamp to it.
  const pulledMaxDiscount = Number(maxDiscountPct);
  if (Number.isFinite(pulledMaxDiscount)) saveDeviceConfig({ max_discount_pct: pulledMaxDiscount });

  // Business type comes from the server too. Set at activation, refreshed here,
  // so a change made centrally reaches every till without anyone visiting them.
  if (typeof businessType === 'string' && businessType) {
    saveDeviceConfig({ business_type: businessType });
  }
  // Cached so an offline till still prints the owner's current header/footer.
  if (typeof receiptHeader === 'string') saveDeviceConfig({ receipt_header: receiptHeader });
  if (typeof receiptFooter === 'string') saveDeviceConfig({ receipt_footer: receiptFooter });

  // The branch this till actually operates on. The device is BOUND to a
  // branch (written at first PIN login / install); /api/pos/init's branchId
  // is the business's main branch and only a fallback. Pulling stock/tables
  // for the wrong branch was exactly the "tables on web but not on the till"
  // bug — staff select branch X at the PIN pad while sync pulled for main.
  const boundBranchId: string | null = getDeviceConfig()?.branch_id ?? null;
  const effectiveBranchId: string | null = boundBranchId || branchId || null;

  // Fetch variants + modifiers
  const variantGroups: any[] = [];
  const variantOptions: any[] = [];
  const modifierGroups: any[] = [];
  const modifierOptions: any[] = [];

  for (const p of products.filter((p: any) => p.has_variants)) {
    const vRes = await fetch(`${_serverUrl}/api/variants/groups?product_id=${p.id}`, { headers: authHeaders() });
    if (vRes.ok) {
      const groups = await vRes.json();
      for (const g of groups) {
        variantGroups.push(g);
        variantOptions.push(...(g.variant_options ?? []));
      }
    }
  }

  for (const p of products.filter((p: any) => p.has_modifiers)) {
    const mRes = await fetch(`${_serverUrl}/api/modifiers/groups?product_id=${p.id}`, { headers: authHeaders() });
    if (mRes.ok) {
      const groups = await mRes.json();
      for (const g of groups) {
        modifierGroups.push(g);
        modifierOptions.push(...(g.modifier_options ?? []));
      }
    }
  }

  // Pull stock levels for this branch
  let stockLevels: any[] = [];
  if (effectiveBranchId) {
    const sRes = await fetch(`${_serverUrl}/api/inventory?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
    if (sRes.ok) {
      const data = await sRes.json();
      stockLevels = data.filter((s: any) => s.id !== null); // exclude unstocked placeholder rows
    }
  }

  // Pull staff/users — reference data for offline cashier attribution (names on
  // shift/EOD reports). PULL-DOWN, remote wins. Wrapped so a 403/offline here
  // never aborts the catalogue sync that already succeeded above.
  let users: any[] = [];
  try {
    const uRes = await fetch(`${_serverUrl}/api/staff`, { headers: authHeaders() });
    if (uRes.ok) users = await uRes.json();
  } catch { /* non-fatal — attribution falls back to id only */ }

  // Pull dining tables — reference data for the restaurant table map.
  // PULL-DOWN, remote wins. Non-restaurant businesses simply get an empty
  // list and the till keeps its product-grid behaviour. `fetched` is tracked
  // separately from emptiness so a failed request never wipes a good local
  // table map (an empty successful response legitimately clears it).
  let diningTables: any[] = [];
  let tablesFetched = false;
  if (effectiveBranchId) {
    try {
      const tRes = await fetch(`${_serverUrl}/api/tables?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
      if (tRes.ok) {
        diningTables = await tRes.json();
        tablesFetched = true;
        console.log(`[sync] tables: pulled ${diningTables.length}`);
      } else {
        console.warn(`[sync] tables fetch failed: HTTP ${tRes.status}`);
      }
    } catch (err: any) {
      console.warn('[sync] tables fetch error:', err?.message ?? err);
    }
  } else {
    console.warn('[sync] tables skipped: no bound branch and no branchId from /api/pos/init');
  }

  // Pull fuel pumps — reference data for the petrol pump grid. Same guard shape
  // as tables: a failed request must never wipe a good local pump list, but an
  // empty successful response legitimately clears it.
  let pumps: any[] = [];
  let pumpsFetched = false;
  if (effectiveBranchId) {
    try {
      const puRes = await fetch(`${_serverUrl}/api/pumps?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
      if (puRes.ok) {
        pumps = await puRes.json();
        pumpsFetched = true;
        console.log(`[sync] pumps: pulled ${pumps.length}`);
      } else {
        console.warn(`[sync] pumps fetch failed: HTTP ${puRes.status}`);
      }
    } catch (err: any) {
      console.warn('[sync] pumps fetch error:', err?.message ?? err);
    }
  }

  // Write everything in a single transaction
  db.transaction(() => {
    const upsertCat = db.prepare(`
      INSERT INTO categories (id, name, color, icon, sort_order, status, is_kitchen, synced_at)
      VALUES (@id, @name, @color, @icon, @sort_order, @status, @is_kitchen, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, color=excluded.color, icon=excluded.icon,
        sort_order=excluded.sort_order, status=excluded.status,
        is_kitchen=excluded.is_kitchen, synced_at=excluded.synced_at
    `);
    for (const c of categories) {
      upsertCat.run({ ...c, is_kitchen: c.is_kitchen ? 1 : 0, synced_at: now });
    }

    // Combo components. Replaced wholesale rather than upserted — a component
    // REMOVED from a combo upstream must disappear here too, and an upsert would
    // leave it behind to be packed and cooked forever.
    db.prepare(`DELETE FROM combo_items`).run();
    const upsertCombo = db.prepare(`
      INSERT INTO combo_items (combo_id, product_id, name, quantity, sort_order, is_kitchen, synced_at)
      VALUES (@combo_id, @product_id, @name, @quantity, @sort_order, @is_kitchen, @synced_at)
    `);
    for (const [comboId, items] of Object.entries((comboItems ?? {}) as Record<string, any[]>)) {
      items.forEach((it, idx) => upsertCombo.run({
        combo_id:   comboId,
        product_id: it.product_id,
        name:       it.name,
        quantity:   Number(it.quantity) || 1,
        sort_order: idx,
        is_kitchen: it.is_kitchen ? 1 : 0,
        synced_at:  now,
      }));
    }

    const upsertProd = db.prepare(`
      INSERT INTO products (id, category_id, name, description, base_price, branch_price, image_url, has_variants, has_modifiers, track_stock, status, barcode, plu, is_fuel, is_kitchen, synced_at)
      VALUES (@id, @category_id, @name, @description, @base_price, @branch_price, @image_url, @has_variants, @has_modifiers, @track_stock, @status, @barcode, @plu, @is_fuel, @is_kitchen, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        category_id=excluded.category_id, name=excluded.name, description=excluded.description,
        base_price=excluded.base_price, branch_price=excluded.branch_price, image_url=excluded.image_url,
        has_variants=excluded.has_variants, has_modifiers=excluded.has_modifiers,
        track_stock=excluded.track_stock, status=excluded.status,
        barcode=excluded.barcode, plu=excluded.plu, is_fuel=excluded.is_fuel,
        is_kitchen=excluded.is_kitchen,
        synced_at=excluded.synced_at
    `);
    for (const p of products) {
      upsertProd.run({
        ...p,
        has_variants:  p.has_variants  ? 1 : 0,
        has_modifiers: p.has_modifiers ? 1 : 0,
        track_stock:   p.track_stock   ? 1 : 0,
        is_fuel:       (p as any).is_fuel ? 1 : 0,
        barcode:       (p as any).barcode ?? null,
        plu:           (p as any).plu ?? null,
        branch_price:  (p as any).branch_price ?? null,
        // Preserve the tri-state: null must stay null, not become 0.
        is_kitchen:    typeof (p as any).is_kitchen === 'boolean' ? ((p as any).is_kitchen ? 1 : 0) : null,
        synced_at:     now,
      });
    }

    // Re-apply the manager's UNSYNCED local price overrides on top of the pulled
    // catalogue. The pull just overwrote products.branch_price with whatever the
    // server had; for products the manager edited locally but hasn't yet synced
    // up, the LOCAL value is authoritative (branch owns its prices). Without this
    // a routine catalogue sync would silently wipe an offline price change.
    // price NULL = the manager cleared the override → force back to base_price.
    db.prepare(`
      UPDATE products
         SET branch_price = (SELECT lpe.price FROM local_price_edits lpe
                              WHERE lpe.product_id = products.id AND lpe.synced = 0)
       WHERE id IN (SELECT product_id FROM local_price_edits WHERE synced = 0)
    `).run();

    const upsertVG = db.prepare(`
      INSERT INTO variant_groups (id, product_id, name, required, sort_order)
      VALUES (@id, @product_id, @name, @required, @sort_order)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, required=excluded.required
    `);
    const upsertVO = db.prepare(`
      INSERT INTO variant_options (id, variant_group_id, name, price_adjustment, sort_order)
      VALUES (@id, @variant_group_id, @name, @price_adjustment, @sort_order)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, price_adjustment=excluded.price_adjustment
    `);
    for (const g of variantGroups) upsertVG.run({ ...g, required: g.required ? 1 : 0 });
    for (const o of variantOptions) upsertVO.run(o);

    const upsertMG = db.prepare(`
      INSERT INTO modifier_groups (id, product_id, name, min_select, max_select, sort_order)
      VALUES (@id, @product_id, @name, @min_select, @max_select, @sort_order)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, min_select=excluded.min_select, max_select=excluded.max_select
    `);
    const upsertMO = db.prepare(`
      INSERT INTO modifier_options (id, modifier_group_id, name, price, sort_order)
      VALUES (@id, @modifier_group_id, @name, @price, @sort_order)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, price=excluded.price
    `);
    for (const g of modifierGroups) upsertMG.run(g);
    for (const o of modifierOptions) upsertMO.run(o);

    if (effectiveBranchId) {
      // The bound branch becomes the till's is_main row — the branch every
      // order, stock deduction, and table belongs to.
      db.prepare(`UPDATE branches SET is_main = 0 WHERE id != ?`).run(effectiveBranchId);
      db.prepare(`
        INSERT INTO branches (id, name, is_main) VALUES (?, 'Branch', 1)
        ON CONFLICT(id) DO UPDATE SET is_main = 1
      `).run(effectiveBranchId);
    }

    // Stock levels — remote wins (reference point for delta merges)
    const upsertStock = db.prepare(`
      INSERT INTO stock_levels (product_id, branch_id, quantity, low_stock_threshold, synced_at)
      VALUES (@product_id, @branch_id, @quantity, @low_stock_threshold, @synced_at)
      ON CONFLICT(product_id, branch_id) DO UPDATE SET
        quantity=excluded.quantity,
        low_stock_threshold=excluded.low_stock_threshold,
        synced_at=excluded.synced_at
    `);
    for (const s of stockLevels) {
      upsertStock.run({
        product_id: s.product_id,
        branch_id: s.branch_id ?? effectiveBranchId,
        quantity: s.quantity,
        low_stock_threshold: s.low_stock_threshold ?? 5,
        synced_at: now,
      });
    }

    // Users — remote wins. roles is a to-one relation -> { name } from /api/staff.
    const upsertUser = db.prepare(`
      INSERT INTO users (id, name, role_name, status, synced_at)
      VALUES (@id, @name, @role_name, @status, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, role_name=excluded.role_name,
        status=excluded.status, synced_at=excluded.synced_at
    `);
    for (const u of users) {
      upsertUser.run({
        id: u.id,
        name: u.name ?? 'Staff',
        role_name: u.roles?.name ?? null,
        status: u.status ?? 'active',
        synced_at: now,
      });
    }

    // Dining tables — remote wins, replace-all (only when the fetch SUCCEEDED:
    // tables deleted on the server must disappear here too, but a failed fetch
    // must not nuke a working offline table map).
    if (tablesFetched) {
      db.prepare(`DELETE FROM tables`).run();
      const insertTable = db.prepare(`
        INSERT INTO tables (id, name, capacity, sort_order, slot_type, pos_x, pos_y, zone, shape, synced_at)
        VALUES (@id, @name, @capacity, @sort_order, @slot_type, @pos_x, @pos_y, @zone, @shape, @synced_at)
      `);
      for (const t of diningTables) {
        insertTable.run({
          id: t.id,
          name: t.name,
          capacity: t.capacity ?? 4,
          sort_order: t.sort_order ?? 0,
          slot_type: t.slot_type ?? 'dining',
          pos_x: t.pos_x ?? null,
          pos_y: t.pos_y ?? null,
          zone: t.zone ?? null,
          shape: t.shape ?? null,
          synced_at: now,
        });
      }
    }

    // Fuel pumps — remote wins, replace-all (only on a successful fetch, same
    // rationale as tables).
    if (pumpsFetched) {
      db.prepare(`DELETE FROM pumps`).run();
      const insertPump = db.prepare(`
        INSERT INTO pumps (id, branch_id, fuel_product_id, name, status, sort_order, synced_at)
        VALUES (@id, @branch_id, @fuel_product_id, @name, @status, @sort_order, @synced_at)
      `);
      for (const pu of pumps) {
        insertPump.run({
          id: pu.id,
          branch_id: pu.branch_id ?? null,
          fuel_product_id: pu.fuel_product_id ?? null,
          name: pu.name,
          status: pu.status ?? 'idle',
          sort_order: pu.sort_order ?? 0,
          synced_at: now,
        });
      }
    }
  })();

  return true;
}

// ── Push pending orders to Express ──────────────────────────

// Push offline-origin shifts / float movements / expenses to the server. The
// server upserts BY ID, so this is idempotent and preserves the local UUIDs that
// orders.shift_id (and float/expense shift_id) reference. MUST run before the
// order push so the parent shift exists server-side when its orders arrive.
//
// Audit C6: /api/sync/push only ever writes OPEN-shift fields now — it can't
// safely trust (or even compute) a close's expected_cash/cash_variance here,
// because this shift's orders/payments usually haven't synced yet. A locally
// closed shift's sync_status therefore stays 'pending' after this call; the
// actual close is reconciled separately once its orders are confirmed synced
// (see reconcileClosedShifts, called after pushPendingOrders).
async function pushLocalRecords(errors: string[]): Promise<number> {
  const db = getLocalDb();
  const shifts = db.prepare(`
    SELECT id, business_id, branch_id, cashier_id, opened_at, closed_at, status,
           opening_float, closing_float, expected_cash, cash_variance, notes, created_at
    FROM shifts WHERE sync_status='pending'
    -- 'conflict' rows are excluded: the server refused them for a reason no
    -- retry clears, and re-sending every pass would loop forever while burying
    -- the real error in the sync log.
  `).all() as any[];
  const floats = db.prepare(`
    SELECT id, shift_id, branch_id, cashier_id, type, amount, reason, created_at
    FROM float_transactions WHERE sync_status='pending'
  `).all() as any[];
  const expenses = db.prepare(`
    SELECT id, business_id, branch_id, expense_category_id, description, amount,
           paid_by, expense_date, shift_id, created_at
    FROM expenses WHERE sync_status='pending'
  `).all() as any[];
  // Trading days. Pushed like shifts: the till originates them and the cloud is
  // the reporting surface, so a day closed on the terminal has to arrive or the
  // dashboard never sees a reconciled day at all.
  const business_days = db.prepare(`
    SELECT id, business_id, branch_id, device_id, terminal_code, business_date,
           opened_at, opened_by, closed_at, closed_by, status,
           counted_cash, expected_cash, cash_variance, notes
    FROM business_days WHERE sync_status='pending'
  `).all() as any[];

  if (!shifts.length && !floats.length && !expenses.length && !business_days.length) return 0;

  const doPost = () => fetch(`${_serverUrl}/api/sync/push`, {
    method: 'POST',
    headers: pushAuthHeaders(),
    body: JSON.stringify({ shifts, floats, expenses, business_days }),
  });

  try {
    let res = await doPost();
    if (res.status === 401) {
      const refreshed = await refreshStaffToken();
      if (refreshed) res = await doPost();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      errors.push(`Shift sync: ${describeServerError(err, res.status)}`);
      return 0;   // leave rows pending — they retry next pass
    }
    const body = await res.json().catch(() => ({} as any));

    // Rows the server understood and refused on their merits — currently only a
    // cashier who already holds an open drawer elsewhere. Retrying cannot fix
    // that; a manager has to close the other shift. So they are parked as
    // 'conflict' rather than left pending, which stops the sync engine looping on
    // them every pass and gives a human something to act on.
    // The server compares X-Schema-Version against what it needs. A behind build
    // is reported, not blocked — a terminal that still syncs correctly must keep
    // trading while someone walks round with the installer.
    if (body?.schema?.behind) {
      errors.push(String(body.schema.message ?? 'This till is running an older build — update it.'));
    }

    const rejected: { id: string; code: string; error: string }[] =
      Array.isArray(body?.rejected) ? body.rejected : [];
    const rejectedIds = new Set(rejected.map(r => r.id));

    if (rejected.length) {
      const mark = db.prepare(`UPDATE shifts SET sync_status='conflict', notes =
        TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?`);
      db.transaction(() => {
        for (const r of rejected) mark.run(`Sync rejected: ${r.error}`, r.id);
      })();
      errors.push(
        rejected.length === 1
          ? `A shift could not sync: ${rejected[0].error}`
          : `${rejected.length} shifts could not sync — a cashier has an open drawer on another till.`,
      );
    }

    // Server has the open-shift fields now. Only a still-open shift is fully
    // done here — a closed one waits for reconcileClosedShifts to confirm the
    // server-computed close before it's marked synced.
    const openShiftIds = shifts
      .filter(s => s.status !== 'closed' && !rejectedIds.has(s.id))
      .map(s => s.id);
    const markShift = db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`);
    const markFloat = db.prepare(`UPDATE float_transactions SET sync_status='synced' WHERE id=?`);
    const markExp   = db.prepare(`UPDATE expenses SET sync_status='synced' WHERE id=?`);
    const markDay   = db.prepare(`UPDATE business_days SET sync_status='synced' WHERE id=?`);
    db.transaction(() => {
      for (const id of openShiftIds) markShift.run(id);
      for (const f of floats) markFloat.run(f.id);
      for (const e of expenses) markExp.run(e.id);
      for (const d of business_days) markDay.run(d.id);
    })();
    return shifts.length + floats.length + expenses.length + business_days.length;
  } catch (err: any) {
    errors.push(`Shift sync: ${err.message}`);
    return 0;
  }
}

// Push the manager's local branch-price edits up to the cloud (the branch is the
// authority for its own prices). Reads unsynced local_price_edits, sends them to
// /api/branch-prices/sync, and on success flips synced=1 — after which a normal
// catalogue pull is free to bring the (now-matching) cloud value back down.
// price NULL = a cleared override (delete on the server). Independent of orders.
async function pushBranchPriceEdits(errors: string[]): Promise<number> {
  const db = getLocalDb();
  const branchId = getDeviceConfig()?.branch_id ?? null;
  if (!branchId) return 0;   // not bound yet → nothing to attribute

  const edits = db.prepare(`
    SELECT product_id, price, updated_at FROM local_price_edits WHERE synced = 0
  `).all() as { product_id: string; price: number | null; updated_at: string }[];
  if (!edits.length) return 0;

  const doPost = () => fetch(`${_serverUrl}/api/branch-prices/sync`, {
    method: 'POST',
    headers: pushAuthHeaders(),
    body: JSON.stringify({ branch_id: branchId, edits }),
  });

  try {
    let res = await doPost();
    if (res.status === 401) {
      const refreshed = (await refreshStaffToken()) || (await refreshAccessToken());
      if (refreshed) res = await doPost();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      errors.push(`Price sync: ${describeServerError(err, res.status)}`);
      return 0;   // leave rows unsynced — they retry next pass
    }
    const { applied } = await res.json() as { applied: string[] };
    // Only mark the products the server actually applied.
    const mark = db.prepare(`UPDATE local_price_edits SET synced = 1 WHERE product_id = ? AND synced = 0`);
    db.transaction(() => { for (const pid of (applied ?? [])) mark.run(pid); })();
    return (applied ?? []).length;
  } catch (err: any) {
    errors.push(`Price sync: ${err.message}`);
    return 0;
  }
}
async function pushPendingOrders(errors: string[]): Promise<number> {
  const db = getLocalDb();
  const pending = db.prepare(`
    SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50
  `).all() as any[];

  let pushed = 0;
  let triedStaffRefresh = false;  // refresh once per sync pass

  // If this till has a branch node, the node is its uplink — push there, not to
  // the cloud (one path: till → node → cloud). The node forwards to the cloud.
  const viaNode = hasNode();

  for (const row of pending) {
    try {
      if (viaNode) {
        const ok = await pushOrderToNode({ orderId: row.order_id, createdAt: row.created_at, payload: row.payload });
        if (ok) {
          db.prepare(`UPDATE sync_queue SET status='synced', attempts=attempts+1 WHERE id=?`).run(row.id);
          // 'node_ack', NOT 'synced'. The node has the order; the CLOUD may not
          // yet. Marking it synced here is what made a peer till close its shift
          // against a server that had not received the sales, computing expected
          // cash as short and reporting a phantom variance every evening.
          // confirmCloudDelivery() promotes these to 'synced' once the node says
          // it has actually forwarded them.
          db.prepare(`UPDATE orders SET sync_status='node_ack' WHERE id=?`).run(row.order_id);
          pushed++;
        } else {
          // Node unreachable — stay pending and retry next pass. The till keeps
          // selling regardless; nothing is lost, and a branch server that is off
          // for ten minutes must not burn through the retry budget.
          //
          // Note this branch is now genuinely "unreachable" only: pushOrderToNode
          // throws on a node that answered and refused, so a real rejection lands
          // in the catch below and escalates to 'failed' like any other error.
          db.prepare(`UPDATE sync_queue SET attempts=attempts+1, last_error='node unreachable' WHERE id=?`).run(row.id);
          errors.push(`Order ${row.order_id}: node unreachable`);
        }
        continue;
      }

      const doPost = () => fetch(`${_serverUrl}/api/orders`, {
        method: 'POST',
        headers: {
          ...pushAuthHeaders(),
          // Idempotency key — the stable local order id, so retries (even across
          // requeues) always dedupe to the same server order.
          'X-Idempotency-Key': row.order_id,
        },
        body: row.payload,
      });

      let res = await doPost();

      // Staff token expired mid-shift → refresh once and retry this same order.
      if (res.status === 401 && !triedStaffRefresh) {
        triedStaffRefresh = true;
        const refreshed = await refreshStaffToken();
        if (refreshed) res = await doPost();
      }

      if (res.ok) {
        // res.ok covers both a fresh create (201) and an idempotent duplicate
        // (200 with { duplicate: true }) — both mean the server has this order,
        // so the local row is safely marked synced. A lost first response that
        // caused this retry therefore resolves correctly instead of duplicating.
        db.prepare(`UPDATE sync_queue SET status='synced', attempts=attempts+1 WHERE id=?`).run(row.id);
        db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`).run(row.order_id);
        pushed++;
      } else if (res.status === 409) {
        // Defensive: some deployments may signal an existing record with 409.
        // That still means the server holds the order — treat as synced.
        db.prepare(`UPDATE sync_queue SET status='synced', attempts=attempts+1 WHERE id=?`).run(row.id);
        db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`).run(row.order_id);
        pushed++;
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const message = describeServerError(err, res.status);
        db.prepare(`
          UPDATE sync_queue SET attempts=attempts+1, last_error=?,
          status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?
        `).run(message, row.id);
        errors.push(`Order ${row.order_id}: ${message}`);
      }
    } catch (err: any) {
      // Same escalation as the HTTP-error branch above. Without it an order the
      // node actively refused sat 'pending' forever — invisible except as a
      // count that never cleared, with no reason recorded anywhere the cashier
      // or a manager could see. 'failed' surfaces the ⟳ N failed button, whose
      // retry is idempotent on the stable order id.
      db.prepare(`
        UPDATE sync_queue SET attempts=attempts+1, last_error=?,
        status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?
      `).run(err.message ?? 'Push failed', row.id);
      errors.push(`Order ${row.order_id}: ${err.message}`);
    }
  }

  return pushed;
}

// Reconcile locally closed shifts once their orders have all synced (audit
// C6). Calls the existing POST /:id/close — the same formula the online till
// already uses to compute expected_cash/cash_variance server-side from real
// synced payments — instead of duplicating that math here or letting the
// till's own number be trusted outright. Runs after pushPendingOrders so
// "have all this shift's orders synced?" is a real answer, not a guess.
/**
 * Promote 'node_ack' orders to 'synced' once the node confirms the cloud has them.
 *
 * On a peer till the uplink is till → node → cloud, so node acceptance is only
 * the first hop. Shift close is computed by the SERVER from the payments it
 * holds, which means closing a shift whose orders are still sitting on the node
 * makes the server read cash sales as short and report a variance that does not
 * exist. That is finding C6 reappearing one hop further out.
 *
 * Silence is not consent: an unreachable node returns null and nothing is
 * promoted, so the shift simply stays open until the answer is known. A shift
 * that closes late is an inconvenience; a shift that closes on a guess produces
 * a cash figure someone will act on.
 */
async function confirmCloudDelivery(errors: string[]): Promise<number> {
  if (!hasNode()) return 0;
  const db = getLocalDb();

  const waiting = db.prepare(
    `SELECT id FROM orders WHERE sync_status='node_ack' ORDER BY created_at LIMIT 200`
  ).all() as Array<{ id: string }>;
  if (waiting.length === 0) return 0;

  const ids = waiting.map(r => r.id);
  const delivered = await confirmNodeDelivery(ids);
  if (delivered === null) {
    // Don't push this into errors — a node that is briefly busy is normal and
    // the till would otherwise show a sync error after every ordinary sale.
    return 0;
  }

  if (delivered.length === 0) return 0;
  const mark = db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`);
  db.transaction(() => { for (const id of delivered) mark.run(id); })();
  return delivered.length;
}

async function reconcileClosedShifts(errors: string[]): Promise<number> {
  const db = getLocalDb();
  // Both terminal states, not just 'closed'.
  //
  // This used to select status='closed' alone. A manager force-closing an
  // abandoned drawer writes 'closed_unreconciled', which never matched — so the
  // row was never posted, stayed sync_status='pending' forever, and remained
  // OPEN on the server indefinitely. Now that one-open-shift-per-cashier is
  // enforced, that stranded row locks the cashier out of every surface until
  // someone edits the database by hand. Force-close is the path every forgotten
  // drawer takes, so this sat on the common route, not an edge case.
  const closed = db.prepare(`
    SELECT id, status, closing_float, notes
      FROM shifts
     WHERE status IN ('closed', 'closed_unreconciled')
       AND sync_status = 'pending'
  `).all() as { id: string; status: string; closing_float: number | null; notes: string | null }[];
  if (!closed.length) return 0;

  let reconciled = 0;
  for (const shift of closed) {
    // Skip until every order from this shift is confirmed synced — closing
    // early would make the server read cash sales as short/zero and raise a
    // false variance (see the comment on pushLocalRecords for why).
    const pending = db.prepare(
      `SELECT COUNT(*) AS count FROM orders WHERE shift_id=? AND sync_status!='synced'`
    ).get(shift.id) as { count: number };
    if (pending.count > 0) continue;

    // A forced close has no count to report, so it cannot go through /close —
    // that route requires a closing_float, and inventing one would fabricate a
    // reconciliation nobody performed. /force-close records the same absence
    // server-side: expected_cash computed, closing_float and variance left NULL.
    const forced = shift.status === 'closed_unreconciled';
    const url = forced
      ? `${_serverUrl}/api/shifts/${shift.id}/force-close`
      : `${_serverUrl}/api/shifts/${shift.id}/close`;
    const body = forced
      ? { reason: shift.notes?.trim() || 'Force-closed on terminal; no cash count was taken' }
      : { closing_float: shift.closing_float, notes: shift.notes };

    const doPost = () => fetch(url, {
      method: 'POST',
      headers: pushAuthHeaders(),
      body: JSON.stringify(body),
    });

    try {
      let res = await doPost();
      if (res.status === 401) {
        const refreshed = await refreshStaffToken();
        if (refreshed) res = await doPost();
      }
      // 404 here means "not an open shift" — since we generated this id and
      // pushed it as open ourselves, that can only mean an earlier pass's
      // close succeeded but its response was lost. Treat as done, not failed.
      //
      // 403 on a forced close means this staff token lacks manager rights.
      // Retrying will never fix that, but the shift must not be marked synced
      // either — it stays pending until a manager's session settles it, and the
      // message says so instead of repeating an opaque HTTP code every pass.
      if (res.ok || res.status === 404) {
        db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`).run(shift.id);
        reconciled++;
      } else if (forced && res.status === 403) {
        errors.push('A force-closed shift is waiting for a manager to sign in and sync it.');
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        errors.push(`Shift close: ${describeServerError(err, res.status)}`);
      }
    } catch (err: any) {
      errors.push(`Shift close: ${err.message}`);
    }
  }
  return reconciled;
}

// Returns the currently open shift row (most recent), or null if none is open.
// Used to stamp shift_id onto offline orders for shift/EOD reporting (Phase C).
export function getOpenShift(): any | null {
  const db = getLocalDb();
  return db.prepare(
    `SELECT * FROM shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`
  ).get() ?? null;
}

// ── Write a new order locally + deduct stock (delta merge) ──

export function createLocalOrder(orderPayload: any): string {
  const db = getLocalDb();
  const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
  if (!session) throw new Error('No session — not logged in');

  // Cashier attribution for OFFLINE reports. The server sets cashier_id from the
  // staff token on push (req.userId), so we deliberately do NOT add it to the
  // sync payload — it would be ignored. We only need it on the local row so
  // offline shift/EOD reports can attribute the sale.
  const staff = db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get() as any;
  const cashierId = staff?.staff_id ?? null;

  // THE SELL GATE.
  //
  // shift_id used to be `getOpenShift()?.id ?? null` — so with no drawer open
  // this stamped null and sold anyway, and a cashier could trade an entire day
  // having never opened a shift. Every cash control downstream (Z-report,
  // variance, day close) is computed from shift_id, so a null there does not
  // merely lose attribution: it removes the sale from the reconciliation
  // altogether, silently.
  //
  // assertCanSell also enforces the trading-day rule, because a till whose
  // previous day was never closed must not sell either — doing so posts today's
  // takings against yesterday's drawer, which is exactly the harm the day close
  // exists to prevent.
  //
  // Enforced here in the main process rather than in the UI: this is the single
  // choke point every sale passes through, offline included.
  // Lazy require: dayService imports getOpenShift from this module, so a
  // top-level import here would close a cycle.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assertCanSell } = require('./dayService') as typeof import('./dayService');
  const { shiftId } = assertCanSell();

  // The physical terminal that created this sale — travels with the order through
  // till → aggregation node → cloud for per-till attribution and audit.
  const deviceId = getDeviceConfig()?.device_id ?? null;

  const orderId = uuid();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, delivery_person, status, subtotal, vat_amount, ctl_amount, discount_amount, tip_amount, total, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, session.business_id, orderPayload.branch_id, orderPayload.order_number,
      orderPayload.order_type ?? 'retail',
      orderPayload.order_type === 'delivery' ? (orderPayload.delivery_person ?? null) : null,
      orderPayload.subtotal, orderPayload.vat_amount,
      orderPayload.ctl_amount ?? 0,
      orderPayload.discount_amount ?? 0, orderPayload.tip_amount ?? 0,
      orderPayload.total,
      cashierId, shiftId,
      orderPayload.customer_id ?? null, orderPayload.customer_name ?? null, orderPayload.customer_phone ?? null,
      now, deviceId,
    );

    for (const item of orderPayload.items) {
      const itemId = uuid();
      db.prepare(`
        INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(itemId, orderId, item.product.id, item.product.name, item.product.categories?.name ?? null, item.unitPrice, item.quantity, item.lineTotal,
        item.course ?? null, item.fire_status === 'held' ? 'held' : 'fired');

      for (const v of item.selectedVariants ?? []) {
        db.prepare(`
          INSERT INTO order_item_variants (id, order_item_id, variant_group_name, variant_option_name, price_adjustment)
          VALUES (?, ?, ?, ?, ?)
        `).run(uuid(), itemId, v.groupName, v.optionName, v.priceAdjustment);
      }
      for (const m of item.selectedModifiers ?? []) {
        db.prepare(`
          INSERT INTO order_item_modifiers (id, order_item_id, modifier_group_name, modifier_option_name, price)
          VALUES (?, ?, ?, ?, ?)
        `).run(uuid(), itemId, m.groupName, m.optionName, m.price);
      }

      // Stock delta deduction — only for tracked products
      const product = db.prepare(`SELECT track_stock FROM products WHERE id=?`).get(item.product.id) as any;
      if (product?.track_stock) {
        const stock = db.prepare(`
          SELECT quantity FROM stock_levels WHERE product_id=? AND branch_id=?
        `).get(item.product.id, orderPayload.branch_id) as any;

        const currentQty = stock?.quantity ?? 0;
        const newQty = Math.max(0, currentQty - item.quantity);

        db.prepare(`
          INSERT INTO stock_levels (product_id, branch_id, quantity, low_stock_threshold)
          VALUES (?, ?, ?, 5)
          ON CONFLICT(product_id, branch_id) DO UPDATE SET quantity=excluded.quantity
        `).run(item.product.id, orderPayload.branch_id, newQty);

        // Log local movement
        db.prepare(`
          INSERT INTO stock_movements (id, product_id, branch_id, movement_type, quantity_change, quantity_after, notes, created_at)
          VALUES (?, ?, ?, 'sale', ?, ?, ?, ?)
        `).run(uuid(), item.product.id, orderPayload.branch_id, -item.quantity, newQty, `Order ${orderPayload.order_number}`, now);
      }
    }

    // Payments — support split tender (payments[]) and legacy single payment.
    const legs = Array.isArray(orderPayload.payments) && orderPayload.payments.length
      ? orderPayload.payments
      : orderPayload.payment ? [orderPayload.payment] : [];
    const insertPayment = db.prepare(`
      INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'pending')
    `);
    for (const leg of legs) {
      insertPayment.run(uuid(), orderId, leg.method, leg.amount,
        leg.amount_tendered ?? leg.amount, leg.change_given ?? 0, leg.reference ?? null, now);
    }

    // Credit sale: record a local ledger movement so the offline balance is
    // correct until sync. The server re-applies authoritatively on push.
    const creditLeg = legs.find((l: any) => l.method === 'credit');
    if (creditLeg && orderPayload.customer_id) {
      db.prepare(`
        INSERT INTO customer_credit_transactions (id, customer_id, branch_id, order_id, type, amount, created_at, sync_status)
        VALUES (?, ?, ?, ?, 'charge', ?, ?, 'pending')
      `).run(uuid(), orderPayload.customer_id, orderPayload.branch_id, orderId,
        Math.abs(Number(creditLeg.amount) || 0), now);
    }

    db.prepare(`
      INSERT INTO sync_queue (order_id, payload, created_at, status)
      VALUES (?, ?, ?, 'pending')
    `).run(orderId, JSON.stringify({ ...orderPayload, payments: legs, shift_id: shiftId, device_id: deviceId, _localOrderId: orderId, idempotency_key: orderId }), now);
  })();

  return orderId;
}
