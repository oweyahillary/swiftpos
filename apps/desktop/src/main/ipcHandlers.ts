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

import { app, ipcMain, net } from 'electron';
import { isNodeRole, ensureNodeSecret } from './deviceConfig';
import { getLocalDb, getDbPath, closeLocalDb } from './localDb';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { configureSyncEngine, configureStaffSession, syncAll, syncPush, retryFailedOrders, getSyncStatus, createLocalOrder, refreshAccessToken } from './syncEngine';
import { getServerUrl, getDeviceConfig, saveDeviceConfig, isConfigured, clearDeviceConfig } from './deviceConfig';
import { openShift, addFloat, closeShift, currentShiftReport, computeZReport, getStaleShift, forceCloseShift } from './shiftService';
import { resolveRange, getReportScope, type RangePreset } from './managerReports';
import { exportReportCsv } from './reportExport';
import { exportDailySalesReport } from './dailySalesReport';

/** Range selection sent from the manager report screens. */
type RangeArg = { preset?: RangePreset; from?: string; to?: string; limit?: number };
import { checkDayGate, getOpenDay, getDayCloseSummary, closeDay, isManager, getConflictedShifts, retryConflictedShift, businessDateNow } from './dayService';
import { branchCloseOverview, createCloseInstruction, executeCloseDay } from './branchClose';
import { takeSnapshot, maintenanceStatus } from './maintenance';
import { emitEvent } from './nodeIngest';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy, getPriceList, setBranchPrice, clearBranchPrice } from './managerReports';
import { listPrinters, printHtmlSilent, openPrintPreview, probePrinter, probeGeometry } from './printService';
import { refreshTechConfig, checkRevealCode, openTechSession, getActiveSession, closeTechSession, logTechAction, flushTechAudit, runTechQuery, closeTechReadonlyDb, getRawTechToken } from './techService';
import { hasNode, isNodeReachable, fetchNodeReport, broadcastTechToken, fetchNodeTechToken, probeNode } from './nodeClient';
import { startNodeServer, stopNodeServer } from './nodeServer';

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
      // device_id is generated once at install and never changes. Sending it
      // lets the server tell this till apart from the others.
      //
      // Without it the server fell back to the User-Agent, which is identical on
      // every till — same Electron build, same Windows — so signing in on till 2
      // revoked till 1's session and till 3 revoked till 2's. Each new install
      // silently signed out the one before it, and the till only found out on its
      // next refresh.
      body: JSON.stringify({ email, password, device_id: getDeviceConfig()?.device_id ?? undefined }),
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

    // The business type is decided when the business is created, and the server
    // returns it here. Persist it rather than asking the technician — the
    // install wizard used to offer a picker, which meant a till could be set to
    // "retail" for a restaurant and quietly lose tables, dine-in and the whole
    // kitchen flow, with nothing on screen to say why.
    if (data.business?.type) saveDeviceConfig({ business_type: String(data.business.type) });

    // Configure sync engine with new credentials (incl. refresh token)
    configureSyncEngine(getServerUrl(), data.token, data.refreshToken ?? '');

    // Cache the branch's tech reveal code + token-verification public key so the
    // tech panel can be unlocked offline later. Best-effort (online at login).
    refreshTechConfig(data.token).catch(() => {});

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
        // From device_config, where login and every sync persist it. This was
        // omitted, so a restart rebuilt the session without a type, modeFlags
        // defaulted to 'retail', and the manager screen silently dropped Item
        // Mix and the restaurant overview — which read as "the update removed
        // a feature" when it was any restart at all.
        type: getDeviceConfig()?.business_type ?? null,
      },
    };
  });

  // ── Staff PIN login (layered on the owner session) ──────
  // verify-pin requires the owner bearer token (requireAuth) + a branch_id.
  // The owner token lives in the session row; the renderer never sees it.

  /**
   * Calls the server with the OWNER access token, refreshing and retrying once
   * on a 401.
   *
   * Every caller used to read session.token straight out of SQLite and give up
   * if the server rejected it. Access tokens are short-lived, so the first
   * launch after a shop has been closed overnight always failed: the PIN screen
   * showed "Invalid or expired token" with an empty branch list, and staff had
   * to close the app and open it again. That worked purely by accident — the
   * failed launch had started the sync engine, which refreshed the token and
   * persisted it, so the SECOND launch read a valid one.
   *
   * Refreshing here makes the first launch work, which is the one that happens
   * in front of the customer at opening time.
   */
  async function ownerFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const db = getLocalDb();
    const readToken = () =>
      (db.prepare(`SELECT token FROM session WHERE id=1`).get() as any)?.token as string | undefined;

    let token = readToken();
    if (!token) throw new Error('Not signed in');

    const call = (t: string) => fetch(`${getServerUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${t}`,
        'X-App-Version': app.getVersion(),
      },
    });

    let res = await call(token);
    if (res.status !== 401) return res;

    // Expired, not wrong. Refresh persists the new token to SQLite, so read it
    // back rather than assuming what it is.
    const refreshed = await refreshAccessToken();
    if (!refreshed) return res;          // let the caller surface the 401 body

    token = readToken();
    if (!token) return res;
    res = await call(token);
    return res;
  }

  ipcMain.handle('auth:listBranches', async () => {
    const res  = await ownerFetch('/api/branches');
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
    const session = db.prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as any;

    // Same expiry problem as listBranches: the PIN pad is the first thing
    // touched each morning, so this is exactly where a stale owner token bites.
    const res = await ownerFetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The running build, reported on the one call every till makes every day.
      // Three tills are updated by hand and drift; without this a bug report
      // cannot be tied to a version, so a fixed bug and an un-updated till look
      // identical from the outside.
      body: JSON.stringify({
        pin, branch_id,
        app_version: app.getVersion(),
        device_id: getDeviceConfig()?.device_id ?? undefined,
      }),
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
             COALESCE(p.branch_price, p.base_price) AS price_per_litre
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
      // Real business rate, refreshed by every catalogue pull. Null until the
      // first successful sync — POSPage falls back to 16 in that window only.
      vatRate: getDeviceConfig()?.vat_rate ?? null,
      ctlRate: getDeviceConfig()?.ctl_rate ?? 0,
      // Null until the first sync — POSPage falls back to the shared default,
      // which is the server's own, so an unsynced till cannot over-discount.
      maxDiscountPct: getDeviceConfig()?.max_discount_pct ?? null,
      receiptHeader: getDeviceConfig()?.receipt_header ?? '',
      receiptFooter: getDeviceConfig()?.receipt_footer ?? '',
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

  ipcMain.handle('pos:getVariants', async (_event, productId: string) => {
    const db = getLocalDb();
    const groups = db.prepare(`
      SELECT * FROM variant_groups WHERE product_id=? ORDER BY sort_order
    `).all(productId) as any[];

    if (groups.length === 0) {
      // Not in SQLite — fetch directly from server as fallback. Goes through
      // ownerFetch so an expired token refreshes rather than silently dropping
      // the option groups and letting the item be rung with no size chosen.
      try {
        const res = await ownerFetch(`/api/variants/groups?product_id=${productId}`);
        if (res.ok) return await res.json();
      } catch { /* offline or signed out — return empty */ }
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
      // Not in SQLite — fetch directly from server as fallback. Goes through
      // ownerFetch so an expired token refreshes rather than silently dropping
      // the option groups and letting the item be rung with no size chosen.
      try {
        const res = await ownerFetch(`/api/modifiers/groups?product_id=${productId}`);
        if (res.ok) return await res.json();
      } catch { /* offline or signed out — return empty */ }
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

  // Ping a printer without printing. Cashiers use this constantly; it must not
  // consume paper.
  ipcMain.handle('print:probe', async (_event, deviceName: string) =>
    probePrinter(String(deviceName ?? '')));

  // Reads the driver's real media size and imageable area, so paper width does
  // not have to be a setting the user can silently get wrong. Returns null when
  // it cannot be determined and the caller falls back to the dot table.
  ipcMain.handle('print:geometry', async (_event, deviceName: string) =>
    probeGeometry(String(deviceName ?? '')));

  // Preview: renders the ticket in a visible window instead of printing it.
  // The only way to see a ticket without thermal hardware, since the silent
  // path deliberately suppresses every OS dialog.
  ipcMain.handle('print:preview', async (_event, opts: any) => {
    return openPrintPreview({
      html: String(opts?.html ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      title: opts?.title ? String(opts.title) : undefined,
    });
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
    const saved = saveDeviceConfig(patch ?? {});
    try {
      if (isNodeRole(saved.device_role)) startNodeServer();
      else stopNodeServer();
    } catch (e) {
      console.error('[config:save] node server transition failed:', e);
    }
    return saved;
  });

  // Synchronous so preload can expose it as a plain string at bridge-build
  // time. process.env.npm_package_version is only set when Electron is launched
  // through an npm script, so every packaged build reported '0.0.1'.
  // ── Bill numbering ──────────────────────────────────────────────────────
  // Every bill is prefixed with this till's terminal code, so three machines in
  // one branch can mint numbers offline and independently without ever
  // colliding — which the previous ORD-<timestamp>-<random> scheme could not
  // guarantee, and which told you nothing about where a sale came from.
  //
  // The counter is per-device and monotonic. Gaps are expected and harmless:
  // one number is held in reserve by the till, so a restart can skip one.
  // A wiped local database restarts the sequence — deliberate, since a wipe is
  // an explicit act, and the terminal prefix still separates the tills.
  ipcMain.handle('orders:nextBillNumber', async () => {
    const db = getLocalDb();
    const code = getDeviceConfig()?.terminal_code?.trim();

    // better-sqlite3 transactions are synchronous and atomic, so no two callers
    // can interleave. Deliberately avoids RETURNING, which needs SQLite 3.35+ —
    // not worth a runtime failure on a till over one saved statement.
    const bump = db.transaction(() => {
      db.prepare(`INSERT INTO counters (name, value) VALUES ('bill_seq', 0) ON CONFLICT(name) DO NOTHING`).run();
      db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'bill_seq'`).run();
      return (db.prepare(`SELECT value FROM counters WHERE name = 'bill_seq'`).get() as any)?.value;
    });
    const seq = Number(bump() ?? 1);

    // No terminal code yet (upgraded install that never re-ran setup) falls back
    // to the old scheme rather than minting an unprefixed number that could
    // collide with a sibling till.
    if (!code) return `ORD-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
    return `${code}--${seq}`;
  });

  ipcMain.on('app:version', (event) => { event.returnValue = app.getVersion(); });

  // Gated + audited (audit: clearDeviceConfig was ungated). Clearing config is
  // how a till sheds its branch binding and re-registers as a new device —
  // with device-branch binding and per-seat licensing live, an anonymous
  // one-click version of that is a control bypass. The reveal-code + signed
  // token is the same bar as every other tech action, and the audit row means
  // the new device appearing in the fleet has a name attached to its birth.
  ipcMain.handle('config:clear', async () => {
    if (!getActiveSession()) {
      throw new Error('Clearing the device configuration requires an active tech session.');
    }
    logTechAction('device.config_clear', {
      terminal: getDeviceConfig()?.terminal_code ?? null,
      device_id: getDeviceConfig()?.device_id ?? null,
    });
    clearDeviceConfig();
    return true;
  });

  /**
   * What a full device reset would destroy. Called before offering one.
   *
   * The count that matters is unsynced orders. Wiping a till holding sales the
   * cloud has never seen deletes real takings, silently — no warning, no total,
   * nothing to reconcile against later. On install day the instinct when a till
   * misbehaves is to wipe and start over, which is exactly when this bites.
   */
  ipcMain.handle('device:resetPreview', async () => {
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    const ownDevice = cfg?.device_id ?? null;
    const unsynced = (db.prepare(
      // own: this warns what THIS wipe destroys. Counting peers' rows would
      // overstate the loss and scare someone out of a legitimate reset.
      `SELECT COUNT(*) n FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.n ?? 0;
    const value = (db.prepare(
      `SELECT COALESCE(SUM(total),0) v FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.v ?? 0;
    const openShift = (db.prepare(`SELECT COUNT(*) n FROM shifts WHERE status='open' AND COALESCE(device_id,'') = COALESCE(?,'')`).get(ownDevice) as any)?.n ?? 0;

    return {
      terminalCode: cfg?.terminal_code ?? null,
      deviceRole:   cfg?.device_role ?? null,
      unsyncedOrders: Number(unsynced),
      unsyncedValue:  Number(value),
      openShifts:     Number(openShift),
      safe: Number(unsynced) === 0 && Number(openShift) === 0,
    };
  });

  /**
   * Wipes this device back to a fresh install.
   *
   * REFUSES while orders are unsynced, unless explicitly forced. A reset button
   * that quietly discards takings is worse than no reset button — someone would
   * press it in good faith on a till showing "7 pending" and nobody would find
   * out until the day's totals failed to add up.
   */
  ipcMain.handle('device:reset', async (_e, { force }: { force?: boolean } = {}) => {
    // Same bar as config:clear, for a bigger action: this deletes the database.
    // TechPage already sits behind a session — this closes every other route.
    if (!getActiveSession()) {
      throw new Error('Resetting this device requires an active tech session.');
    }
    const db = getLocalDb();
    const ownDevice = getDeviceConfig()?.device_id ?? null;
    const unsynced = (db.prepare(
      `SELECT COUNT(*) n FROM orders WHERE (sync_status IS NULL OR sync_status != 'synced')
         AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).get(ownDevice) as any)?.n ?? 0;

    if (Number(unsynced) > 0 && !force) {
      throw new Error(
        `${unsynced} order${unsynced === 1 ? '' : 's'} on this till have not reached the server. ` +
        'Get it back online and let them sync before resetting, or they are lost.',
      );
    }

    // Logged BEFORE the file is dropped — afterwards there is no queue to log
    // into. The flush happens on the next session from any till at this branch.
    logTechAction('device.reset', {
      terminal: getDeviceConfig()?.terminal_code ?? null,
      device_id: ownDevice, unsynced: Number(unsynced), forced: !!force,
    });
    // The entry above lives in the database about to be deleted. Flush it now,
    // best-effort with a hard 3s cap — a reset must not hang on a dead network,
    // and if the flush loses the race the wipe is still visible server-side as
    // this device vanishing from the fleet and a new one registering.
    const rawToken = getRawTechToken();
    if (rawToken) {
      await Promise.race([
        flushTechAudit(rawToken).catch(() => {}),
        new Promise(res => setTimeout(res, 3_000)),
      ]);
    }

    // Drop the file rather than the tables: a reset should leave nothing behind,
    // including schema drift from an older build.
    const dbPath = getDbPath();
    try { db.close(); } catch { /* already closed */ }
    closeTechReadonlyDb();   // the readonly console handle also pins the file
    closeLocalDb?.();
    try { fs.rmSync(dbPath, { force: true }); } catch { /* fall through */ }
    for (const suffix of ['-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }

    // Relaunch so the wizard runs against a clean database.
    app.relaunch();
    app.exit(0);
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
      // ok is 2xx ONLY. A 404 means something answered but it is not our
      // /health endpoint — almost always a URL with an extra path on it, which
      // the install screen used to report as a green "Server reachable".
      return { ok: res.ok, reachable: true, status: res.status };
    } catch (err: any) {
      return { ok: false, reachable: false, error: err?.message ?? 'Could not reach server' };
    }
  });

  // ── Shifts (offline cash-up + Z-report) ─────────────────────

  ipcMain.handle('shift:current', async () => {
    return currentShiftReport();
  });

  // A shift left open past ~18h. Reported, never auto-closed — see
  // forceCloseShift() for why a fabricated cash count is worse than none.
  ipcMain.handle('shift:stale', async () => getStaleShift());

  // ── Trading day (per till) ────────────────────────────────────────────────
  // checkDayGate is what the POS screen reads to decide whether it may sell at
  // all. closeDay is manager-gated inside dayService, NOT by hiding the button:
  // a control that exists only in the UI is a suggestion.
  // Which terminal this is. Read-only identity for display: the cashier should
  // not be asked which till they are standing at when the install already knows.
  ipcMain.handle('device:identity', async () => {
    const cfg = getDeviceConfig();
    return {
      deviceId:     cfg?.device_id ?? null,
      terminalCode: cfg?.terminal_code ?? null,
    };
  });

  // Fail CLOSED. If this check throws, the renderer's .catch leaves dayGate
  // null, needsShift computes false, and the till trades with no drawer until
  // the raw driver error surfaces inside the payment modal — which is exactly
  // what a missing bind in getOpenShift did in production. A gate that cannot
  // run must block and say why, using the same hard-block UI as an unclosed day.
  ipcMain.handle('day:gate', async () => {
    try { return checkDayGate(); }
    catch (err: any) {
      return {
        canTrade: false,
        needsManager: true,
        reason: `This till cannot verify its trading day (${err?.message ?? 'internal error'}). ` +
                'Restart the app; if this persists, contact support.',
      };
    }
  });
  ipcMain.handle('day:current', async () => getOpenDay());

  // ── Central day close (Phase 4) — node-side manager screen ────────────────
  ipcMain.handle('branchClose:overview', async () => {
    try { return branchCloseOverview(); }
    catch (err: any) { return { error: err?.message ?? 'Could not read the branch state' }; }
  });
  ipcMain.handle('branchClose:closeTill', async (_e, { device_id, counted_cash, notes }:
    { device_id: string; counted_cash: number; notes?: string }) => {
    try {
      if (!isManager()) return { ok: false, error: 'Only a manager can close the branch.' };
      const cfg = getDeviceConfig();
      const staff = getLocalDb().prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as any;
      const payload = {
        business_date: businessDateNow(),
        counted_cash: Number(counted_cash),
        notes,
        closed_by_staff_id: staff?.staff_id ?? null,
        closed_by_name: staff?.staff_name ?? null,
      };
      if (device_id === cfg?.device_id) {
        // The node is a normal till; its own day closes directly — no
        // instruction, no poll, and any refusal surfaces immediately.
        const r = executeCloseDay(payload);
        return r.ok ? { ok: true, self: true, summary: r.summary ?? null, already_closed: r.already_closed ?? false }
                    : { ok: false, error: r.error };
      }
      const { id } = createCloseInstruction(device_id, payload, staff?.staff_id ?? null);
      return { ok: true, instruction_id: id };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not start the close' };
    }
  });
  ipcMain.handle('day:summary', async () => getDayCloseSummary());
  ipcMain.handle('day:isManager', async () => isManager());
  ipcMain.handle('day:conflicts', async () => getConflictedShifts());
  ipcMain.handle('day:retryConflict', async (_e, { shiftId }: { shiftId: string }) => {
    try {
      const r = retryConflictedShift(String(shiftId));
      // Offer it now rather than on the next timer tick: the manager is standing
      // at the screen and the whole point of the button is to watch it clear.
      syncPush().catch(() => { /* the re-arm alone is the guarantee */ });
      return { ok: true, rearmed: r.rearmed };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not retry this shift' };
    }
  });
  ipcMain.handle('day:close', async (_e, { countedCash, notes }: { countedCash: number; notes?: string }) => {
    try { return { ok: true, summary: closeDay(Number(countedCash), notes) }; }
    catch (err: any) { return { ok: false, error: err?.message ?? 'Could not close the day' }; }
  });

  ipcMain.handle('shift:forceClose', async (_e, { reason }: { reason: string }) =>
    forceCloseShift(String(reason ?? '')));

  ipcMain.handle('shift:open', async (_event, { opening_float, drawer_label }: { opening_float: number; drawer_label?: string }) => {
    openShift(Number(opening_float) || 0, drawer_label);
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
  async function manageFetch(path: string, method: string, body?: any) {
    const db = getLocalDb();
    const row = db.prepare(`SELECT token FROM staff_session WHERE id=1`).get() as any;
    if (!row?.token) throw new Error('Not signed in');

    let res: Response;
    try {
      res = await fetch(`${getServerUrl()}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('No connection — menu and staff changes need internet. Try again once you are back online.');
    }

    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (!res.ok) {
      if (res.status === 403) throw new Error('Your role does not allow this change.');
      throw new Error(data?.error ?? `Request failed (${res.status})`);
    }
    return data;
  }

  // A catalogue write is pointless until the till re-reads it, so pull straight
  // after. Failure here is non-fatal — the edit landed on the server and the
  // next scheduled sync will collect it.
  async function refreshCatalogue() {
    try { await syncAll(); } catch (e: any) { console.warn('[manage] post-edit sync failed:', e?.message); }
  }

  ipcMain.handle('manage:listProducts', async () => manageFetch('/api/products', 'GET'));
  ipcMain.handle('manage:createProduct', async (_e, payload: any) => {
    const out = await manageFetch('/api/products', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:updateProduct', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/products/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });

  ipcMain.handle('manage:listCategories', async () => manageFetch('/api/categories', 'GET'));
  // ── Print stations ────────────────────────────────────────────────────────
  // Server-backed like categories, so one configuration reaches all three tills
  // rather than each terminal holding its own idea of where an order prints.
  // refreshCatalogue() after every write pulls the change straight back down.
  ipcMain.handle('manage:listStations', async () => manageFetch('/api/stations', 'GET'));
  ipcMain.handle('manage:unassignedCategories', async () =>
    manageFetch('/api/stations/unassigned', 'GET'));
  ipcMain.handle('manage:createStation', async (_e, payload: any) => {
    const out = await manageFetch('/api/stations', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:updateStation', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/stations/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:deleteStation', async (_e, id: string) => {
    const out = await manageFetch(`/api/stations/${id}`, 'DELETE');
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:setStationCategories', async (_e, { id, categoryIds }: { id: string; categoryIds: string[] }) => {
    const out = await manageFetch(`/api/stations/${id}/categories`, 'PUT', { category_ids: categoryIds });
    await refreshCatalogue();
    return out;
  });

  ipcMain.handle('manage:createCategory', async (_e, payload: any) => {
    const out = await manageFetch('/api/categories', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:updateCategory', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/categories/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });

  // Combos. The till sells a combo as one line; these define what the dispatcher
  // and kitchen tickets expand it into.
  // Bulk product import. The server maps category_name to EXISTING categories
  // and silently writes null when there is no match, so the UI creates any
  // missing categories first and only then calls this.
  ipcMain.handle('manage:bulkProducts', async (_e, rows: any[]) => {
    const out = await manageFetch('/api/products/bulk', 'POST', { rows });
    await refreshCatalogue();
    return out;
  });

  ipcMain.handle('manage:listCombos', async () => manageFetch('/api/combos', 'GET'));
  ipcMain.handle('manage:createCombo', async (_e, payload: any) => {
    const out = await manageFetch('/api/combos', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:updateCombo', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/combos/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:setComboItems', async (_e, { id, items }: { id: string; items: any[] }) => {
    const out = await manageFetch(`/api/combos/${id}/items`, 'PUT', { items });
    await refreshCatalogue();
    return out;
  });

  // Variants — the Spice group and anything else a product needs choosing.
  ipcMain.handle('manage:listVariantGroups', async (_e, productId: string) =>
    manageFetch(`/api/variants/groups?product_id=${encodeURIComponent(productId)}`, 'GET'));
  // Editing a group's kind, and its options. Without these the manager screen can
  // display what migration 45 classified but cannot resolve anything it left as
  // 'review' — which is exactly where a human is needed.
  ipcMain.handle('manage:updateVariantGroup', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/variants/groups/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:createVariantOption', async (_e, payload: any) => {
    const out = await manageFetch('/api/variants/options', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:updateVariantOption', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/variants/options/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:deleteVariantOption', async (_e, id: string) => {
    const out = await manageFetch(`/api/variants/options/${id}`, 'DELETE');
    await refreshCatalogue();
    return out;
  });

  ipcMain.handle('manage:createVariantGroup', async (_e, payload: any) => {
    const out = await manageFetch('/api/variants/groups', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  ipcMain.handle('manage:deleteVariantGroup', async (_e, id: string) => {
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
  ipcMain.handle('manage:listModifierGroups', async (_e, productId: string) =>
    manageFetch(`/api/modifiers/groups?product_id=${encodeURIComponent(productId)}`, 'GET'));
  ipcMain.handle('manage:createModifierGroup', async (_e, payload: any) =>
    manageFetch('/api/modifiers/groups', 'POST', payload));
  ipcMain.handle('manage:deleteModifierGroup', async (_e, id: string) =>
    manageFetch(`/api/modifiers/groups/${id}`, 'DELETE'));

  ipcMain.handle('manage:listStaff', async () => manageFetch('/api/staff', 'GET'));
  ipcMain.handle('manage:listRoles', async () => manageFetch('/api/staff/roles', 'GET'));
  ipcMain.handle('manage:createStaff', async (_e, payload: any) =>
    manageFetch('/api/staff', 'POST', payload));
  ipcMain.handle('manage:updateStaff', async (_e, { id, patch }: { id: string; patch: any }) =>
    manageFetch(`/api/staff/${id}`, 'PATCH', patch));

  ipcMain.handle('manage:getReceiptText', async () => {
    const cfg = getDeviceConfig();
    return { header: cfg?.receipt_header ?? '', footer: cfg?.receipt_footer ?? '' };
  });
  ipcMain.handle('manage:setReceiptText', async (_e, { header, footer }: { header: string; footer: string }) => {
    // The endpoint upserts ONE key/value pair per call — posting an object of
    // keys returns "key and value are required". Two sequential calls.
    await manageFetch('/api/business/settings', 'POST', { key: 'receipt_header', value: header });
    const out = await manageFetch('/api/business/settings', 'POST', { key: 'receipt_footer', value: footer });
    // Cache immediately so the next receipt is right even before a full sync.
    saveDeviceConfig({ receipt_header: header, receipt_footer: footer });
    await refreshCatalogue();
    return out;
  });

  // ── Manager dashboard reports (local SQLite — D9 tiered depth) ────────────

  // Range is optional so existing callers keep today's behaviour untouched.
  ipcMain.handle('manager:salesSummary',  async (_e, r?: RangeArg) =>
    getSalesSummary(r ? resolveRange(r.preset, r.from, r.to) : undefined));
  ipcMain.handle('manager:topProducts',   async (_e, r?: RangeArg) =>
    getTopProducts(r?.limit ?? 8, r ? resolveRange(r.preset, r.from, r.to) : undefined));
  ipcMain.handle('manager:recentOrders',  async (_e, r?: RangeArg) =>
    getRecentOrders(r?.limit ?? 30, r ? resolveRange(r.preset, r.from, r.to) : undefined));

  // What the figures cover. Paired with every range query so a till's partial
  // view can never be read as the branch's takings.
  ipcMain.handle('manager:reportScope', async () => getReportScope());
  ipcMain.handle('manager:resolveRange', async (_e, r: RangeArg) =>
    resolveRange(r?.preset, r?.from, r?.to));
  ipcMain.handle('manager:exportCsv', async (_e, req: any) => exportReportCsv(req));
  ipcMain.handle('manager:dailyReport', async (_e, req: any) => exportDailySalesReport(req ?? {}));
  ipcMain.handle('manager:stockLevels',   async () => getStockLevels());
  ipcMain.handle('manager:fuelSales',     async () => getFuelSalesToday());
  ipcMain.handle('manager:pumpStatus',    async () => getPumpStatus());
  ipcMain.handle('manager:tableOccupancy',async () => getTableOccupancy());

  // ── Branch price management (manager = branch authority, local-first) ──────
  ipcMain.handle('manager:priceList',      async () => getPriceList());
  ipcMain.handle('manager:setBranchPrice', async (_e, { product_id, price }) => setBranchPrice(product_id, price));
  ipcMain.handle('manager:clearBranchPrice', async (_e, { product_id }) => clearBranchPrice(product_id));

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
    const shift    = db.prepare(`SELECT id FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY created_at DESC LIMIT 1`).get(getDeviceConfig()?.device_id ?? null) as any;

    if (!session?.business_id) throw new Error('No active session');
    if (!staff?.branch_id)     throw new Error('No staff session');

    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO expenses
        (id, business_id, branch_id, expense_category_id, description, amount,
         paid_by, expense_date, shift_id, created_at, device_id, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, session.business_id, staff.branch_id,
      expense_category_id ?? null, description, amount,
      paid_by ?? staff.staff_id ?? null,
      now.slice(0, 10), shift?.id ?? null, now,
      // See the note in shiftService.recordFloat: a NULL-attributed row matches
      // nothing under COALESCE(device_id,'') = COALESCE(own,''), so it is never
      // collected by the push and the expense silently never leaves the till.
      getDeviceConfig()?.device_id ?? null,
    );
    return { id };
  });

  // Recent expenses for the current shift (for display in ShiftPanel)
  ipcMain.handle('expense:list', async () => {
    const db = getLocalDb();
    const shift = db.prepare(`SELECT id FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY created_at DESC LIMIT 1`).get(getDeviceConfig()?.device_id ?? null) as any;
    if (!shift) return [];
    return db.prepare(`
      SELECT id, description, amount, expense_category_id, paid_by, created_at, sync_status
      FROM expenses WHERE shift_id=? ORDER BY created_at DESC
    `).all(shift.id);
  });

  // ── Order void (manager/supervisor only — server enforces permission) ──────
  ipcMain.handle('order:void', async (_event, { orderId, reason, supervisor_pin, override_pin, authorizer_id }:
    { orderId: string; reason: string; supervisor_pin?: string; override_pin?: string; authorizer_id?: string }) => {
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
      // The server accepts an authorizer_id + that person's override PIN, which
      // records WHO approved the void rather than just that someone knew a PIN.
      body: JSON.stringify({
        reason,
        ...(supervisor_pin ? { supervisor_pin } : {}),
        ...(override_pin   ? { override_pin }   : {}),
        ...(authorizer_id  ? { authorizer_id }  : {}),
      }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      // requirePermission answers a bare "Forbidden" and puts the useful part in
      // `detail` ("Missing permission: orders.void"). Dropping it left the
      // cashier — and whoever they phoned — with a one-word error and no way to
      // tell a permission problem from a wrong PIN or an expired void window.
      const detail = typeof data?.detail === 'string' ? data.detail : '';
      if (res.status === 403 && /missing permission/i.test(detail)) {
        throw new Error(
          'This role cannot void orders. A manager needs to grant the "orders.void" permission to it.',
        );
      }
      throw new Error(detail ? `${data.error ?? 'Void failed'} — ${detail}` : (data.error ?? 'Void failed'));
    }

    // Mark local order voided so order history reflects it immediately.
    // voided_at is written too — the column existed and nothing ever set it.
    const voidedAt = new Date().toISOString();
    db.prepare(`UPDATE orders SET status='voided', voided_at=? WHERE id=?`).run(voidedAt, orderId);
    // Phase 2b: without the event, every replica of this order stays
    // 'completed' and the branch revenue on other tills counts a voided sale.
    emitEvent('order_voided', String(orderId), { status: 'voided', voided_at: voidedAt });
    return { ok: true };
  });

  // Refund a completed sale (audit M3). Online only, like void — money leaving
  // the drawer needs supervisor authorisation, and authorising offline would
  // mean trusting a PIN this till cannot verify.
  ipcMain.handle('order:refund', async (_event, { orderId, reason, override_pin, authorizer_id }:
    { orderId: string; reason: string; override_pin?: string; authorizer_id?: string }) => {
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    const staffRow = db.prepare(`SELECT token FROM staff_session WHERE id=1`).get() as any;
    const ownerRow = db.prepare(`SELECT token FROM session WHERE id=1`).get() as any;
    const token = staffRow?.token ?? ownerRow?.token;
    if (!token) throw new Error('Not signed in');

    const res = await fetch(`${cfg.server_url}/api/orders/${orderId}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        reason,
        ...(override_pin  ? { override_pin }  : {}),
        ...(authorizer_id ? { authorizer_id } : {}),
      }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : '';
      if (res.status === 403 && /missing permission/i.test(detail)) {
        throw new Error('This role cannot refund. A manager needs to grant the "orders.void" permission to it.');
      }
      throw new Error(detail ? `${data.error ?? 'Refund failed'} — ${detail}` : (data.error ?? 'Refund failed'));
    }

    // Mirror it locally so the Z-report on THIS till is right immediately, and
    // stays right if the network drops before the next catalogue pull. The
    // negative rows are what make expected cash come out correct: the till's
    // shift query sums every payment row for a non-voided order, so the money
    // out cancels the money in. Without them the drawer would read short by the
    // refunded amount — audit M8.
    const now = new Date().toISOString();
    const legs: Array<{ method: string; amount: number }> = Array.isArray(data?.byMethod) ? data.byMethod : [];
    const insert = db.prepare(`
      INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
      VALUES (?, ?, ?, ?, 0, 0, ?, 'refunded', ?, 'synced')
    `);
    const orderRow = db.prepare(`SELECT order_number FROM orders WHERE id=?`).get(orderId) as any;
    const applyLocal = db.transaction(() => {
      for (const leg of legs) {
        insert.run(uuid(), orderId, leg.method, -Math.abs(Number(leg.amount) || 0),
          `REFUND-${orderRow?.order_number ?? ''}`, now);
      }
      db.prepare(`UPDATE orders SET refunded_at=?, refunded_amount=?, refund_reason=? WHERE id=?`)
        .run(now, Number(data?.refunded) || 0, String(reason ?? ''), orderId);
    });
    applyLocal();

    return { ok: true, refunded: Number(data?.refunded) || 0 };
  });

  // ── Tech access ────────────────────────────────────────────────────────────
  // Reveal code check (doorknock) — opens the token prompt. Grants nothing.
  ipcMain.handle('tech:checkReveal', async (_event, code: string) => {
    const ok = checkRevealCode(code);
    return { ok };
  });

  // Verify the Ed25519 token OFFLINE and open a 4-hour active session.
  ipcMain.handle('tech:openSession', async (_event, token: string) => {
    const result = openTechSession(String(token ?? '').trim());
    if (!result.ok) return { ok: false, error: result.reason };
    // Best-effort: flush queued audit + mark token used server-side if reachable.
    flushTechAudit(String(token).trim()).catch(() => {});
    // Share the token with branch peers (via the node) so all tills reflect the
    // same active session. Each peer re-verifies it locally; no shared clock.
    broadcastTechToken(String(token).trim()).catch(() => {});
    return { ok: true, session: result.session };
  });

  // A peer till adopts an active tech session broadcast to the branch node.
  ipcMain.handle('tech:adoptFromNode', async () => {
    const existing = getActiveSession();
    if (existing) return { ok: true, session: existing };
    const token = await fetchNodeTechToken().catch(() => null);
    if (!token) return { ok: false };
    const result = openTechSession(token);
    return result.ok ? { ok: true, session: result.session } : { ok: false };
  });

  ipcMain.handle('tech:getSession', async () => getActiveSession());

  ipcMain.handle('tech:closeSession', async () => { closeTechSession(); return { ok: true }; });

  ipcMain.handle('tech:logAction', async (_event, { action, detail }: { action: string; detail?: any }) => {
    logTechAction(action, detail);
    return { ok: true };
  });

  // Read-only DB console. Gated in MAIN on an active tech session — the
  // renderer's gating is a courtesy; this check is the door. The query is
  // audited verbatim BEFORE it runs, so a query that errors is still on record.
  // Manual snapshot from the tech panel — same job as the nightly one, on
  // demand, session-gated like every tech action.
  // Phase 3 — the promotion lever. "Failover is a role flag" was a claim
  // until this existed. Promotion is safe because the promoted till already
  // holds the branch (2a distribution) and already carries the branch secret
  // it was authenticating with as a peer — the listener is the only thing
  // that was not running.
  ipcMain.handle('tech:promoteToNode', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    const before = getDeviceConfig()?.device_role ?? 'till';
    logTechAction('role.promote', { from: before, to: 'node' });
    saveDeviceConfig({ device_role: 'node', node_url: null });
    startNodeServer();
    const secret = ensureNodeSecret();
    return { ok: true, role: 'node', secret,
             note: 'Now repoint each remaining till at this machine (Tech → branch server address).' };
  });

  // Repoint this till at a (new) branch server. Probe BEFORE save — a wrong
  // address written blind is a till that silently stops replicating. Also the
  // demotion path: a former node repointed at the new one becomes a till again.
  ipcMain.handle('tech:setNodeUrl', async (_e, { url }: { url: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    const probe = await probeNode(String(url ?? ''));
    if (!probe.ok) return { ok: false, error: probe.error };
    const was = getDeviceConfig()?.device_role ?? 'till';
    logTechAction('role.repoint', { from: was, node_url: url });
    if (was === 'node') stopNodeServer();   // stepping down: stop serving first
    saveDeviceConfig({ node_url: String(url), device_role: was === 'node' ? 'till' : was });
    return { ok: true, role: was === 'node' ? 'till' : was };
  });

  ipcMain.handle('tech:backupNow', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('backup.manual', {});
    return await takeSnapshot();
  });

  ipcMain.handle('tech:maintenance', async () => maintenanceStatus());

  ipcMain.handle('tech:query', async (_event, { sql }: { sql: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('db_query', { sql: String(sql ?? '').slice(0, 2000) });
    return runTechQuery(sql);
  });

  // Local, offline-safe diagnostics for the tech screen.
  ipcMain.handle('tech:status', async () => {
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    const sync = getSyncStatus();
    // branch-wide: tech diagnostics. A tech looking at a node wants the latest
    // activity anywhere at the branch, not just this machine's.
    const lastOrder = (db.prepare(
      `SELECT created_at FROM orders ORDER BY created_at DESC LIMIT 1`,
    ).get() as any)?.created_at ?? null;
    return {
      device: {
        device_id: cfg?.device_id ?? null, device_name: cfg?.device_name ?? null,
        device_role: cfg?.device_role ?? 'till', branch_id: cfg?.branch_id ?? null,
        deploy_mode: cfg?.deploy_mode ?? null, server_url: cfg?.server_url ?? null,
        node_url: cfg?.node_url ?? null,
      },
      sync: { online: sync.online, pending: sync.pendingCount, failed: sync.failedCount, lastOrder },
    };
  });

  // ── Manager branch-wide report ──────────────────────────────────────────────
  // Any till can see ALL the branch's tills' data by reading from the aggregation
  // node. If the node is unreachable (or this device has none) it falls back to
  // this machine's own local data, flagged so the UI can say so.
  ipcMain.handle('manager:branchReport', async () => {
    if (hasNode()) {
      const report = await fetchNodeReport().catch(() => null);
      if (report) return { ...report, source: 'node' as const };
    }
    // Fallback: local-only view of this device.
    return {
      salesSummary: getSalesSummary(),
      topProducts:  getTopProducts(),
      recentOrders: getRecentOrders(),
      stockLevels:  getStockLevels(),
      source: hasNode() ? ('local_fallback' as const) : ('local' as const),
    };
  });
}
