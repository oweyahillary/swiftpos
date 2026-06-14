// IPC Handlers — registered in main process, called from renderer via preload.ts
//
// Channels:
//   auth:login        → POST /api/auth/login, store session in SQLite
//   auth:logout       → clear session + all catalogue from SQLite
//   auth:getSession   → return current session row
//   pos:init          → return products + categories + branchId from SQLite
//   pos:getVariants   → return variant groups + options for a product
//   pos:getModifiers  → return modifier groups + options for a product
//   order:create      → write order to SQLite + enqueue for sync
//   sync:trigger      → run syncAll()
//   sync:status       → return { online, pendingCount }

import { ipcMain, net } from 'electron';
import { getLocalDb } from './localDb';
import { configureSyncEngine, configureStaffSession, syncAll, syncPush, retryFailedOrders, getSyncStatus, createLocalOrder } from './syncEngine';
import { getServerUrl, getDeviceConfig, saveDeviceConfig, isConfigured, clearDeviceConfig } from './deviceConfig';
import { openShift, addFloat, closeShift, currentShiftReport, computeZReport } from './shiftService';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy } from './managerReports';
import { listPrinters, printHtmlSilent } from './printService';

// Wipes all catalogue data — called on login (before pulling fresh data)
// and on logout (so the next user never sees stale data on boot).
// Orders and sync_queue are intentionally kept so pending offline orders
// can still be pushed after re-login.
function clearCatalogue(db: ReturnType<typeof getLocalDb>) {
  db.exec(`
    DELETE FROM products;
    DELETE FROM categories;
    DELETE FROM variant_groups;
    DELETE FROM variant_options;
    DELETE FROM modifier_groups;
    DELETE FROM modifier_options;
    DELETE FROM branches;
    DELETE FROM users;
    DELETE FROM tables;
  `);
}

export function registerIpcHandlers() {

  // ── Auth ────────────────────────────────────────────────

  ipcMain.handle('auth:login', async (_event, { email, password }) => {
    // Desktop terminals authenticate via /desktop-login, which skips the
    // web_hosting gate (desktop is entitled by its per-branch licence, enforced
    // at verify-pin) instead of the web portal's /login route.
    const res = await fetch(`${getServerUrl()}/api/auth/desktop-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Login failed');

    const db = getLocalDb();

    // Clear any catalogue from a previous session before writing new one
    clearCatalogue(db);

    // Persist session (singleton row)
    db.prepare(`
      INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token=excluded.token, refresh_token=excluded.refresh_token, user_id=excluded.user_id, business_id=excluded.business_id,
        business_name=excluded.business_name, currency=excluded.currency, logged_in_at=excluded.logged_in_at
    `).run(
      data.token,
      data.refreshToken ?? null,
      data.user.id,
      data.business.id,
      data.business.name,
      data.business.currency ?? 'KES',
      new Date().toISOString(),
    );

    // Configure sync engine with new credentials (incl. refresh token)
    configureSyncEngine(getServerUrl(), data.token, data.refreshToken ?? '');

    // Wait for initial sync before returning — renderer gets fresh data immediately
    await syncAll().catch(console.error);

    return { user: data.user, business: data.business };
  });

  ipcMain.handle('auth:logout', async () => {
    const db = getLocalDb();
    clearCatalogue(db);
    db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
    db.prepare(`DELETE FROM session WHERE id=1`).run();
    configureStaffSession('', '');
    configureSyncEngine(getServerUrl(), '');
    return true;
  });

  ipcMain.handle('auth:getSession', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
    if (!session) return null;

    // Re-hydrate sync engine in case app was restarted
    configureSyncEngine(getServerUrl(), session.token, session.refresh_token ?? '');

    return {
      user: { id: session.user_id, email: null },
      business: {
        id: session.business_id,
        name: session.business_name,
        currency: session.currency,
      },
    };
  });

  // ── Staff PIN login (layered on the owner session) ──────
  // verify-pin requires the owner bearer token (requireAuth) + a branch_id.
  // The owner token lives in the session row; the renderer never sees it.

  ipcMain.handle('auth:listBranches', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT token FROM session WHERE id=1`).get() as any;
    if (!session?.token) throw new Error('Not signed in');

    const res = await fetch(`${getServerUrl()}/api/branches`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load branches');

    // Return only what the picker needs, incl. licence state.
    return (Array.isArray(data) ? data : []).map((b: any) => ({
      id: b.id,
      name: b.name,
      desktop_licensed: !!b.desktop_licensed,
    }));
  });

  ipcMain.handle('auth:verifyPin', async (_event, { pin, branch_id }) => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT token, business_name, currency FROM session WHERE id=1`).get() as any;
    if (!session?.token) throw new Error('Not signed in');

    const res = await fetch(`${getServerUrl()}/api/auth/verify-pin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ pin, branch_id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Invalid PIN');

    // Resolve branch name for display (from the local branches table if present).
    const branchRow = db.prepare(`SELECT name FROM branches WHERE id=?`).get(branch_id) as any;

    db.prepare(`
      INSERT INTO staff_session
        (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        staff_id=excluded.staff_id, staff_name=excluded.staff_name, role_name=excluded.role_name,
        branch_id=excluded.branch_id, branch_name=excluded.branch_name, permissions=excluded.permissions,
        token=excluded.token, refresh_token=excluded.refresh_token, logged_in_at=excluded.logged_in_at
    `).run(
      data.staff?.id ?? null,
      data.staff?.name ?? 'Staff',
      data.staff?.role ?? null,
      branch_id,
      branchRow?.name ?? null,
      JSON.stringify(data.permissions ?? {}),
      data.accessToken ?? data.token,
      data.refreshToken ?? null,
      new Date().toISOString(),
    );

    // Make the staff token the active credential for order pushes.
    configureStaffSession(data.accessToken ?? data.token, data.refreshToken ?? '');

    // Bind this till to the branch the cashier works on. From now on the PIN
    // screen skips the selector and — crucially — sync pulls stock/tables for
    // THIS branch instead of the business's main branch.
    const cfg = getDeviceConfig();
    if (cfg && cfg.branch_id !== branch_id) {
      saveDeviceConfig({ branch_id });
      // Branch changed → re-pull immediately so tables/stock for the newly
      // bound branch arrive without waiting for the 10-minute cycle.
      syncAll().catch(console.error);
    }

    return {
      staff: data.staff,
      role: data.staff?.role ?? null,
      permissions: data.permissions ?? {},
      branchId: branch_id,
      branchName: branchRow?.name ?? null,
    };
  });

  ipcMain.handle('auth:getStaffSession', async () => {
    const db = getLocalDb();
    const s = db.prepare(`SELECT * FROM staff_session WHERE id=1`).get() as any;
    if (!s) return null;
    return {
      staff: { id: s.staff_id, name: s.staff_name },
      role: s.role_name,
      permissions: JSON.parse(s.permissions || '{}'),
      branchId: s.branch_id,
      branchName: s.branch_name,
    };
  });

  ipcMain.handle('auth:clearStaffSession', async () => {
    const db = getLocalDb();
    db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
    configureStaffSession('', '');
    return true;
  });

  // ── POS data ────────────────────────────────────────────

  // Dining tables for the restaurant table map — synced reference data,
  // served from SQLite so the floor plan works fully offline.
  ipcMain.handle('pos:getTables', async () => {
    const db = getLocalDb();
    return db.prepare(`
      SELECT * FROM tables WHERE slot_type = 'dining' ORDER BY sort_order, name
    `).all();
  });

  // Fuel pumps for the petrol grid, each joined to its fuel product so the
  // renderer has the name + price/litre without a second lookup.
  ipcMain.handle('pos:getPumps', async () => {
    const db = getLocalDb();
    return db.prepare(`
      SELECT pu.id, pu.name, pu.status, pu.sort_order, pu.fuel_product_id,
             p.name       AS fuel_product_name,
             p.base_price AS price_per_litre
      FROM pumps pu
      LEFT JOIN products p ON p.id = pu.fuel_product_id
      ORDER BY pu.sort_order, pu.name
    `).all();
  });

  ipcMain.handle('pos:init', async () => {
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

    const shaped = products.map((p: any) => ({
      ...p,
      has_variants: p.has_variants === 1,
      has_modifiers: p.has_modifiers === 1,
      track_stock: p.track_stock === 1,
      categories: p.category_name ? { name: p.category_name, color: p.category_color } : null,
    }));

    return {
      products: shaped,
      categories,
      branchId: branch?.id ?? null,
    };
  });

  ipcMain.handle('pos:getVariants', async (_event, productId: string) => {
    const db = getLocalDb();
    const groups = db.prepare(`
      SELECT * FROM variant_groups WHERE product_id=? ORDER BY sort_order
    `).all(productId) as any[];

    if (groups.length === 0) {
      // Not in SQLite — fetch directly from server as fallback
      const session = db.prepare(`SELECT token FROM session WHERE id=1`).get() as any;
      if (session?.token) {
        try {
          const res = await fetch(`${getServerUrl()}/api/variants/groups?product_id=${productId}`, {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          if (res.ok) return await res.json();
        } catch { /* offline — return empty */ }
      }
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

  ipcMain.handle('pos:getModifiers', async (_event, productId: string) => {
    const db = getLocalDb();
    const groups = db.prepare(`
      SELECT * FROM modifier_groups WHERE product_id=? ORDER BY sort_order
    `).all(productId) as any[];

    if (groups.length === 0) {
      // Not in SQLite — fetch directly from server as fallback
      const session = db.prepare(`SELECT token FROM session WHERE id=1`).get() as any;
      if (session?.token) {
        try {
          const res = await fetch(`${getServerUrl()}/api/modifiers/groups?product_id=${productId}`, {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          if (res.ok) return await res.json();
        } catch { /* offline — return empty */ }
      }
      return [];
    }

    return groups.map(g => ({
      ...g,
      modifier_options: db.prepare(
        `SELECT * FROM modifier_options WHERE modifier_group_id=? ORDER BY sort_order`
      ).all(g.id),
    }));
  });

  // ── Orders ──────────────────────────────────────────────

  ipcMain.handle('order:create', async (_event, orderPayload: any) => {
    const orderId = createLocalOrder(orderPayload);
    // Push-only flush — the old syncAll here re-pulled the entire catalogue
    // (N+1 variant/modifier fetches) on every single sale.
    syncPush().catch(console.error);
    return { orderId };
  });

  // ── Printing (native — replaces QZ Tray on the desktop) ──

  ipcMain.handle('print:list', async () => {
    return await listPrinters();
  });

  ipcMain.handle('print:html', async (_event, opts: any) => {
    return await printHtmlSilent({
      html: String(opts?.html ?? ''),
      deviceName: String(opts?.deviceName ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      copies: Number(opts?.copies) || 1,
    });
  });

  // ── Sync ────────────────────────────────────────────────

  ipcMain.handle('sync:trigger', async () => {
    return await syncAll();
  });

  ipcMain.handle('sync:retryFailed', async () => {
    return await retryFailedOrders();
  });

  // Renderer-side `window` online/offline events are the only reliable network
  // signal Electron gives us — main forwards them into an immediate flush.
  ipcMain.handle('net:changed', async (_event, online: boolean) => {
    if (online) {
      console.log('[sync] Renderer reports online — flushing queue');
      syncAll().catch(console.error);
    }
    return getSyncStatus();
  });

  ipcMain.handle('sync:status', async () => {
    return getSyncStatus();
  });

  // ── Device config (first-run install + runtime server URL) ──

  ipcMain.handle('config:get', async () => {
    return getDeviceConfig();
  });

  ipcMain.handle('config:isConfigured', async () => {
    return isConfigured();
  });

  ipcMain.handle('config:save', async (_event, patch: any) => {
    return saveDeviceConfig(patch ?? {});
  });

  ipcMain.handle('config:clear', async () => {
    clearDeviceConfig();
    return true;
  });

  // Advisory reachability check used by the install screen. Runs in the main
  // process (no browser CORS), hits GET /health with a short timeout. Any HTTP
  // response — even 404 — counts as "reachable"; only a network/timeout error
  // is a failure. The local server PC may not be up yet at install time, so a
  // failure is informational, never a hard block.
  ipcMain.handle('config:testConnection', async (_event, url: string) => {
    const base = (url ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
      return { ok: false, reachable: false, error: 'URL must start with http:// or https://' };
    }
    if (!net.isOnline()) {
      return { ok: false, reachable: false, error: 'This device appears to be offline' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return { ok: res.ok, reachable: true, status: res.status };
    } catch (err: any) {
      return { ok: false, reachable: false, error: err?.message ?? 'Could not reach server' };
    }
  });

  // ── Shifts (offline cash-up + Z-report) ─────────────────────

  ipcMain.handle('shift:current', async () => {
    return currentShiftReport();
  });

  ipcMain.handle('shift:open', async (_event, { opening_float }: { opening_float: number }) => {
    openShift(Number(opening_float) || 0);
    return currentShiftReport();
  });

  ipcMain.handle('shift:float', async (_event, { type, amount, reason }: { type: 'float_in' | 'float_out'; amount: number; reason?: string }) => {
    addFloat(type, Number(amount), reason);
    return currentShiftReport();
  });

  ipcMain.handle('shift:close', async (_event, { closing_float, notes }: { closing_float: number; notes?: string }) => {
    // Returns the final Z-report. Throws (with .variance/.expected_cash) if a
    // variance note is required — the renderer surfaces that message.
    return closeShift(Number(closing_float), notes);
  });

  ipcMain.handle('shift:zreport', async (_event, shiftId: string) => {
    return computeZReport(shiftId);
  });

  // ── Manager dashboard reports (local SQLite — D9 tiered depth) ────────────

  ipcMain.handle('manager:salesSummary',  async () => getSalesSummary());
  ipcMain.handle('manager:topProducts',   async () => getTopProducts(8));
  ipcMain.handle('manager:recentOrders',  async () => getRecentOrders(30));
  ipcMain.handle('manager:stockLevels',   async () => getStockLevels());
  ipcMain.handle('manager:fuelSales',     async () => getFuelSalesToday());
  ipcMain.handle('manager:pumpStatus',    async () => getPumpStatus());
  ipcMain.handle('manager:tableOccupancy',async () => getTableOccupancy());

  // ── Expenses (record petty-cash at the till) ──────────────────────────────

  // List categories from server (online) for the expense form
  ipcMain.handle('expense:categories', async () => {
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) return [];
    const staffRow = (getLocalDb() as any).prepare(`SELECT token FROM staff_session WHERE id=1`).get() as any;
    const ownerRow = (getLocalDb() as any).prepare(`SELECT token FROM session WHERE id=1`).get() as any;
    const token = staffRow?.token ?? ownerRow?.token;
    if (!token) return [];
    try {
      const res = await fetch(`${cfg.server_url}/api/expenses/categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  });

  // Save expense locally (syncs up on next push pass)
  ipcMain.handle('expense:create', async (_event, {
    description, amount, expense_category_id, paid_by,
  }: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) => {
    const db = getLocalDb();
    const session  = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as any;
    const staff    = db.prepare(`SELECT branch_id, staff_id FROM staff_session WHERE id=1`).get() as any;
    const shift    = db.prepare(`SELECT id FROM shifts WHERE status='open' ORDER BY created_at DESC LIMIT 1`).get() as any;

    if (!session?.business_id) throw new Error('No active session');
    if (!staff?.branch_id)     throw new Error('No staff session');

    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO expenses
        (id, business_id, branch_id, expense_category_id, description, amount,
         paid_by, expense_date, shift_id, created_at, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, session.business_id, staff.branch_id,
      expense_category_id ?? null, description, amount,
      paid_by ?? staff.staff_id ?? null,
      now.slice(0, 10), shift?.id ?? null, now,
    );
    return { id };
  });

  // Recent expenses for the current shift (for display in ShiftPanel)
  ipcMain.handle('expense:list', async () => {
    const db = getLocalDb();
    const shift = db.prepare(`SELECT id FROM shifts WHERE status='open' ORDER BY created_at DESC LIMIT 1`).get() as any;
    if (!shift) return [];
    return db.prepare(`
      SELECT id, description, amount, expense_category_id, paid_by, created_at, sync_status
      FROM expenses WHERE shift_id=? ORDER BY created_at DESC
    `).all(shift.id);
  });

  // ── Order void (manager/supervisor only — server enforces permission) ──────
  ipcMain.handle('order:void', async (_event, { orderId, reason, supervisor_pin }: { orderId: string; reason: string; supervisor_pin?: string }) => {
    const db = getLocalDb();
    // Get server URL + best available auth token
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    const staffRow = db.prepare(`SELECT token FROM staff_session WHERE id=1`).get() as any;
    const ownerRow = db.prepare(`SELECT token FROM session WHERE id=1`).get() as any;
    const token = staffRow?.token ?? ownerRow?.token;
    if (!token) throw new Error('Not signed in');

    const res = await fetch(`${cfg.server_url}/api/orders/${orderId}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason, ...(supervisor_pin ? { supervisor_pin } : {}) }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error ?? 'Void failed');

    // Mark local order voided so order history reflects it immediately
    db.prepare(`UPDATE orders SET status='voided' WHERE id=?`).run(orderId);
    return { ok: true };
  });
}
