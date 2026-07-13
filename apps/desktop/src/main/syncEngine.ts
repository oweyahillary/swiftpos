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
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { hasNode, pushOrderToNode } from './nodeClient';
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
  products: 'pull', categories: 'pull',
  variant_groups: 'pull', variant_options: 'pull',
  modifier_groups: 'pull', modifier_options: 'pull',
  stock_levels: 'pull', branches: 'pull', users: 'pull', tables: 'pull', pumps: 'pull',
  // Push-up, local origin
  orders: 'push', order_items: 'push',
  order_item_variants: 'push', order_item_modifiers: 'push',
  payments: 'push', customer_credit_transactions: 'push',
  shifts: 'push', float_transactions: 'push', expenses: 'push',
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
async function refreshAccessToken(): Promise<boolean> {
  if (!_refreshToken) return false;
  try {
    const res = await fetch(`${_serverUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: _refreshToken }),
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
      (SELECT COUNT(*) FROM expenses           WHERE sync_status='pending') AS count
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

  const { products, categories, branchId } = await res.json();
  const db = getLocalDb();
  const now = new Date().toISOString();

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
      INSERT INTO categories (id, name, color, icon, sort_order, status, synced_at)
      VALUES (@id, @name, @color, @icon, @sort_order, @status, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, color=excluded.color, icon=excluded.icon,
        sort_order=excluded.sort_order, status=excluded.status, synced_at=excluded.synced_at
    `);
    for (const c of categories) upsertCat.run({ ...c, synced_at: now });

    const upsertProd = db.prepare(`
      INSERT INTO products (id, category_id, name, description, base_price, branch_price, image_url, has_variants, has_modifiers, track_stock, status, barcode, plu, is_fuel, synced_at)
      VALUES (@id, @category_id, @name, @description, @base_price, @branch_price, @image_url, @has_variants, @has_modifiers, @track_stock, @status, @barcode, @plu, @is_fuel, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        category_id=excluded.category_id, name=excluded.name, description=excluded.description,
        base_price=excluded.base_price, branch_price=excluded.branch_price, image_url=excluded.image_url,
        has_variants=excluded.has_variants, has_modifiers=excluded.has_modifiers,
        track_stock=excluded.track_stock, status=excluded.status,
        barcode=excluded.barcode, plu=excluded.plu, is_fuel=excluded.is_fuel,
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
async function pushLocalRecords(errors: string[]): Promise<number> {
  const db = getLocalDb();
  const shifts = db.prepare(`
    SELECT id, business_id, branch_id, cashier_id, opened_at, closed_at, status,
           opening_float, closing_float, expected_cash, cash_variance, notes, created_at
    FROM shifts WHERE sync_status='pending'
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

  if (!shifts.length && !floats.length && !expenses.length) return 0;

  const doPost = () => fetch(`${_serverUrl}/api/sync/push`, {
    method: 'POST',
    headers: pushAuthHeaders(),
    body: JSON.stringify({ shifts, floats, expenses }),
  });

  try {
    let res = await doPost();
    if (res.status === 401) {
      const refreshed = await refreshStaffToken();
      if (refreshed) res = await doPost();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      errors.push(`Shift sync: ${err.error ?? res.status}`);
      return 0;   // leave rows pending — they retry next pass
    }
    // Server has them now — mark synced. (Re-opening/closing a shift, or adding a
    // float, resets sync_status to 'pending' again, so later changes re-push.)
    const markShift = db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`);
    const markFloat = db.prepare(`UPDATE float_transactions SET sync_status='synced' WHERE id=?`);
    const markExp   = db.prepare(`UPDATE expenses SET sync_status='synced' WHERE id=?`);
    db.transaction(() => {
      for (const s of shifts) markShift.run(s.id);
      for (const f of floats) markFloat.run(f.id);
      for (const e of expenses) markExp.run(e.id);
    })();
    return shifts.length + floats.length + expenses.length;
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
      errors.push(`Price sync: ${err.error ?? res.status}`);
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
          db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`).run(row.order_id);
          pushed++;
        } else {
          // Node unreachable/declined — stay pending and retry next pass. The
          // till keeps selling regardless; nothing is lost.
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
        db.prepare(`
          UPDATE sync_queue SET attempts=attempts+1, last_error=?,
          status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?
        `).run(err.error ?? 'Server error', row.id);
        errors.push(`Order ${row.order_id}: ${err.error}`);
      }
    } catch (err: any) {
      db.prepare(`UPDATE sync_queue SET attempts=attempts+1, last_error=? WHERE id=?`).run(err.message, row.id);
      errors.push(`Order ${row.order_id}: ${err.message}`);
    }
  }

  return pushed;
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
  // offline shift/EOD reports can attribute the sale. shift_id is stamped when a
  // shift is open (Phase C opens shifts; until then it's simply null).
  const staff = db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get() as any;
  const cashierId = staff?.staff_id ?? null;
  const shiftId = (getOpenShift() as any)?.id ?? null;
  // The physical terminal that created this sale — travels with the order through
  // till → aggregation node → cloud for per-till attribution and audit.
  const deviceId = getDeviceConfig()?.device_id ?? null;

  const orderId = uuid();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, discount_amount, tip_amount, total, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, sync_status)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, session.business_id, orderPayload.branch_id, orderPayload.order_number,
      orderPayload.order_type ?? 'retail', orderPayload.subtotal, orderPayload.vat_amount,
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
