// IPC Handlers — registered in main process, called from renderer via preload.ts
//
// Channels:
//   auth:enrolDevice   → POST /api/auth/enrol/redeem, store session in SQLite
//                        (owner email/password login RETIRED — A158)
//   auth:logout       → clear session + all catalogue from SQLite
//   auth:getSession   → return current session row
//   pos:init          → return products + categories + branchId from SQLite
//   pos:getVariants   → return variant groups + options for a product
//   pos:getModifiers  → return modifier groups + options for a product
//   order:create      → write order to SQLite + enqueue for sync
//   sync:trigger      → run syncAll()
//   sync:status       → return { online, pendingCount }

import { getMacAddressCached } from './machineFingerprint';
import { app, ipcMain, net } from 'electron';
import { isNodeRole, ensureNodeSecret } from './deviceConfig';
import { printSale, escposEnabled, setEscposEnabled, kitchenExclusions, kitchenExclusionsState, setKitchenExclusions, clearKitchenExclusionsOverride } from './escposBridge';
import { expectStringArray, assertPayload } from './ipcValidate';
import { installValidatedHandle } from './ipcGuard';
import { getBuildInfo } from './buildInfo';
import { cashierHistoryView, historyMethodsSettingValue, CASHIER_HISTORY_METHODS_KEY } from './cashierHistory';   // 0.6.37 (A387)
import { printerShares } from './printService';
import { kitchenPreset, dispatchPreset, receiptPreset, monoRasterFromString, type MonoRaster } from '@swiftpos/printing';

/** A312: the receipt logo the print path should use right now, or undefined. Reads the
 *  local branding row (synced remote-wins from the cloud, or tech-set); the toggle gates it. */
function resolveReceiptLogo(): MonoRaster | undefined {
  const b = getBranding();
  if (!b || !b.receiptLogoEnabled || !b.logoReceipt) return undefined;
  return monoRasterFromString(b.logoReceipt) ?? undefined;
}
import { assignments } from './print/printWorker';
import { getLocalDb, getDbPath, closeLocalDb, getBranding, setBranding } from './localDb';
import { getUpdateStatus, installUpdateNow } from './autoUpdate';
import { logLine } from './logFile';
import { readSessionTokens, readStaffTokens, writeSessionTokens, writeStaffTokens, writeDeviceSecret, clearDeviceSecret } from './tokenStore';
import { isSessionRefusal } from './sessionRecovery';   // A407
import { cloudFetch } from './cloudGateway';   // A410: a till on a branch reaches the cloud only through its branch server
import { saveRoutingLocally, overlayPending, readPending as readPendingRouting, mayRoute } from './stationRouting';   // A411
import { cacheStaffCredential, verifyPinOffline, clearPinCache } from './pinCache';
import { setIdleSurface, clearIdleLock, suppressIdleLock } from './idleMonitor';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { configureSyncEngine, configureStaffSession, syncAll, syncPush, pushStationRoutingNow, retryFailedOrders, getSyncStatus, createLocalOrder, refreshAccessToken, refreshStaffToken, testConnection, pullWebSales, getOpenShift, queueBrandingPush } from './syncEngine';
import { getCloudUrl, getDeviceConfig, saveDeviceConfig, isConfigured, clearDeviceConfig, getPosFeatures, getReversalRules, setReversalRules, getSupportContact, getCashierHistoryMethods, setCashierHistoryMethods, getStockCountFreeze } from './deviceConfig';
import { isReversalSettingKey, reversalSettingValue } from './reversalRules';
import { reverseOffline, mayReverseLocal, type LocalPerson } from './offlineReversal';
import { parseNotePicks, cleanNote, ORDER_NOTE_MAX } from './orderNotes';
import { openShift, addFloat, closeShift, currentShiftReport, computeZReport, getStaleShift, forceCloseShift, adoptCloudShift, localShiftIds, listShifts, listExpenses, awaitingConfirmation, confirmShift, shiftCloseRights, isShiftManager, historyScope, blindClose, blindReport, confirmView, type ForeignCash } from './shiftService';
import { resolveRange, getReportScope, type RangePreset } from './managerReports';
import { cloudBranchOrders, mirrorTillRefund, reverseRiderPayout } from './webSales';
import { cleanExpenseMethod } from './expenseMethod';
import { cleanDeliveryFee } from './delivery';
import { recordKitchenSend, markKitchenPaid, recordKitchenVoid, openKitchenOrders, kitchenCloseBlock } from './kitchenService';
import { anySent, voidReasonLabel } from './kitchenLines';
import { exportReportCsv } from './reportExport';
import { exportDailySalesReport } from './dailySalesReport';

/** Range selection sent from the manager report screens. */
type RangeArg = { preset?: RangePreset; from?: string; to?: string; limit?: number };
import { checkDayGate, getOpenDay, getDayCloseSummary, closeDay, isManager, getConflictedShifts, retryConflictedShift, businessDateNow } from './dayService';
import { branchCloseOverview, createCloseInstruction, executeCloseDay } from './branchClose';
import { takeSnapshot, maintenanceStatus } from './maintenance';
import { emitEvent, resetOutboxCursors } from './nodeIngest';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy, getPriceList, setBranchPrice, clearBranchPrice } from './managerReports';
import { listPrinters, printHtmlSilent, openPrintPreview, probePrinter, probeGeometry } from './printService';
import { refreshTechConfig, checkRevealCode, openTechSession, getActiveSession, closeTechSession, logTechAction, flushTechAudit, runTechQuery, closeTechReadonlyDb, getRawTechToken } from './techService';
import { hasNode, isNodeReachable, fetchNodeReport, broadcastTechToken, fetchNodeTechToken, probeNode, verifyPinAtNodeClient, fetchRosterFromNode } from './nodeClient';
import { isUnreachableStatus } from './authTransport';
import { holdOfflinePin, clearOfflinePin, heldOfflinePin, upgradeOfflineSession, OFFLINE_SESSION_MESSAGE, NO_CONNECTION_MESSAGE, type ManageOfflineReason } from './offlineSession';
import { verifyPinAtNode, storeBranchStaff } from './branchStaff';
import { unpackRosterSnapshot } from './rosterSnapshot';
import { startNodeServer, stopNodeServer } from './nodeServer';
import { cleanShowDays } from './productDays';

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

  // D7: every channel below is registered through `handle`, which validates the
  // payload against ipcSchemas.ts before the handler runs (installValidatedHandle).
  // A channel with no registry entry throws at the boundary; check-ipc-validation
  // fails the build first, so it can't ship. This is why the handlers no longer
  // need per-channel payload boilerplate.
  const handle = installValidatedHandle(ipcMain);

  // ── Auth ────────────────────────────────────────────────

  // A158: owner email/password login on the till was RETIRED. A terminal is now
  // provisioned ONLY by a one-time enrolment code (auth:enrolDevice below), so the
  // owner's reusable dashboard credentials are never typed or stored on a shared
  // till. The server /desktop-login route is tombstoned to match. Web dashboard
  // login (/api/auth/login) is unaffected.

  // D4 — provision this till with a single-use enrolment code instead of an owner
  // login (closes D1: the business is chosen by id, so a two-business owner is no
  // longer a dead end). This is now the ONLY way a till is provisioned (owner
  // email/password login was retired — A158). The credential is a one-time
  // business_id + code, redeemed against /enrol/redeem. The
  // server returns the same { token, refreshToken, user, business } shape, so the
  // session is stored identically.
  handle('auth:enrolDevice', async (_event, payload) => {
    // D7: both credentials must be present and non-empty before we call the server.
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    const res = await cloudFetch(`${getCloudUrl()}/api/auth/enrol/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: String(business_id ?? '').trim(),
        code:        String(code ?? '').trim(),
        // Same stable per-install device_id the login path sends, so the server
        // records THIS terminal and tells it apart from the rest of the fleet.
        device_id:   getDeviceConfig()?.device_id ?? undefined,
        // A182: the machine's stable MAC, so if this box was enrolled before (a
        // reinstall) the server can hand back its previous terminal code/name.
        mac_address: getMacAddressCached() ?? undefined,
        // A273 follow-up: the till's code and the name typed at setup, so the web
        // POS's till picker shows THIS till's real name (the cloud used to label
        // every till "SwiftPOS till"). Absent on a first enrolment before setup.
        terminal_code: getDeviceConfig()?.terminal_code ?? undefined,
        device_name:   getDeviceConfig()?.device_name ?? undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Enrolment failed');

    const db = getLocalDb();
    clearCatalogue(db);

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

    // D5: wrap the credentials at rest, same as the login path.
    writeSessionTokens({ token: data.token, refreshToken: data.refreshToken ?? '' });
    // A407: the device secret — the till's own way back in if its session is ever refused.
    if (typeof data.deviceSecret === 'string' && data.deviceSecret) writeDeviceSecret(data.deviceSecret);

    if (data.business?.type) saveDeviceConfig({ business_type: String(data.business.type) });

    // A182: if the server recognised this machine (same MAC as a prior install),
    // restore its previous terminal code + name so a reinstalled till comes back
    // as itself instead of a blank "new till" that gets re-named T1 and collides
    // (A181). Only fills gaps — never overwrites a code the operator has set here.
    if (data.restore && (data.restore.terminal_code || data.restore.device_label)) {
      const cfg = getDeviceConfig();
      const patch: Record<string, unknown> = {};
      if (data.restore.terminal_code && !cfg?.terminal_code) patch.terminal_code = String(data.restore.terminal_code);
      if (data.restore.device_label && !cfg?.device_name)   patch.device_name   = String(data.restore.device_label);
      if (Object.keys(patch).length) { saveDeviceConfig(patch); logLine('enrol', `restored identity from a prior install: ${JSON.stringify(patch)}`); }
    }

    configureSyncEngine(getCloudUrl(), data.token, data.refreshToken ?? '');
    refreshTechConfig(data.token).catch(() => {});
    await syncAll().catch(console.error);

    return { user: data.user, business: data.business, branchId: data.branchId ?? null };
  });

  handle('auth:logout', async () => {
    const db = getLocalDb();
    clearCatalogue(db);
    db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
    db.prepare(`DELETE FROM session WHERE id=1`).run();
    // Signing the terminal out must also remove the offline way in, or a
    // decommissioned till keeps working credentials for another fortnight.
    clearPinCache();
    clearDeviceSecret();   // A407: and its way back in
    clearOfflinePin();
    configureStaffSession('', '');
    configureSyncEngine(getCloudUrl(), '');
    return true;
  });

  handle('auth:getSession', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
    if (!session) return null;

    // Re-hydrate sync engine in case app was restarted. Credentials are wrapped
    // at rest (D5), so they come from the store rather than off the row.
    const sessTok = readSessionTokens();
    configureSyncEngine(getCloudUrl(), sessTok.token, sessTok.refreshToken);

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
    const db = getLocalDb();
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
    return take(id);
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
      readSessionTokens().token || undefined;

    let token = readToken();
    if (!token) throw new Error('Not signed in');

    const call = (t: string) => cloudFetch(`${getCloudUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        // Rate limiting keys on this: per-DEVICE buckets instead of the
        // branch's one shared NAT IP, so two tills never starve each other.
        'x-device-id': getDeviceConfig()?.device_id ?? '',
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

  // ── A334 (2026-09-26): drawers shared with the web POS ─────────────────────
  // Both are best-effort and bounded: a slow or absent cloud never blocks a sign-in
  // or a close — the till falls back to what it holds, and says so (foreign = null).
  const withinMs = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);

  /** The cash on this drawer rung on another surface (the web POS). null = not known (offline / no answer). */
  async function fetchForeignCash(shiftId: string | null | undefined): Promise<ForeignCash | null> {
    if (!shiftId) return null;
    try {
      const res = await withinMs(ownerFetch(`/api/shifts/${encodeURIComponent(shiftId)}/foreign-cash`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localShiftIds(shiftId)),
      }), 4_000);
      if (!res.ok) return null;
      const f = await res.json();
      return f && typeof f.cash_sales === 'number' ? f as ForeignCash : null;
    } catch { return null; }
  }

  /**
   * At an ONLINE sign-in: is this till's drawer already open in the cloud — opened on the web POS
   * standing in for this till? If so, take it in (adoptCloudShift) so the till sells into it instead of
   * opening a second drawer the cloud will refuse. Returns what the PIN screen shows: nothing for the
   * cashier who opened it (they just resume), the opener's name and time for anyone else (owner:
   * show it and offer to join).
   */
  async function joinCloudDrawer(staffId: string | null | undefined): Promise<{ openedByName: string | null; openedAt: string; sameCashier: boolean } | null> {
    try {
      const res = await withinMs(ownerFetch('/api/shifts/current'), 4_000);
      if (!res.ok) return null;
      const cloud = await res.json().catch(() => null);
      const adopted = adoptCloudShift(cloud);
      if (!adopted) return null;
      const openedBy = adopted.opened_by ?? adopted.cashier_id ?? null;
      const who = openedBy ? (getLocalDb().prepare(`SELECT name FROM users WHERE id=?`).get(openedBy) as any)?.name ?? null : null;
      logLine('shift', `joined the drawer opened on the web POS (${adopted.id})`);
      return { openedByName: who, openedAt: adopted.opened_at, sameCashier: !!staffId && openedBy === staffId };
    } catch (e: any) {
      logLine('shift', `drawer check at sign-in skipped: ${e?.message ?? e}`);
      return null;
    }
  }

  handle('auth:listBranches', async () => {
    // LOCAL-FIRST — this was a server round trip, and every cold start, 429,
    // or dead link blanked the PIN screen with "No branches available" while
    // the bound branch and the branches table sat on this disk the whole
    // time. A till that cannot show its own branch until a cloud answers is
    // not offline-first; it is online-with-extra-steps. The server refresh
    // improves the answer (licence state, renames); it never gates it.
    const db = getLocalDb();
    const local = (db.prepare(`SELECT id, name FROM branches ORDER BY name`).all() as any[])
      .map(b => ({ id: b.id, name: b.name, desktop_licensed: true }));

    try {
      const res  = await Promise.race([
        ownerFetch('/api/branches'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 4_000)),
      ]);
      const data = await (res as Response).json();
      if ((res as Response).ok && Array.isArray(data)) {
        return data.map((b: any) => ({ id: b.id, name: b.name, desktop_licensed: !!b.desktop_licensed }));
      }
    } catch { /* cold server, rate limit, no link — the local answer stands */ }

    if (local.length) return local;
    // Truly first run, nothing synced yet: only now is the server the answer.
    const res  = await ownerFetch('/api/branches');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load branches');
    return (Array.isArray(data) ? data : []).map((b: any) => ({
      id: b.id, name: b.name, desktop_licensed: !!b.desktop_licensed,
    }));
  });

  /** The staff's own cloud tokens and cached credential, from a verify-pin answer — shared by the online sign-in and the
   *  A345 upgrade of an offline sign-in. Returns the branch row (for the display name). */
  function persistCloudSignIn(data: any, branch_id: string): { name?: string | null } | undefined {
    const db = getLocalDb();
    // Online sign-in succeeded, so the server has just confirmed this PIN and
    // that it is unique across the business. Only now is it safe to cache.
    cacheStaffCredential(
      { staffId: data.staff?.id, name: data.staff?.name ?? 'Staff',
        roleName: data.staff?.role ?? null, permissions: data.permissions ?? {} },
      data.offlineAuth?.pinHash,
      branch_id,
    );

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

    // D5 - wrap at rest, same as the owner session.
    writeStaffTokens({ token: data.accessToken ?? data.token ?? '', refreshToken: data.refreshToken ?? '' });

    // Make the staff token the active credential for order pushes.
    configureStaffSession(data.accessToken ?? data.token, data.refreshToken ?? '');
    return branchRow;
  }

  /** POST /api/auth/verify-pin's body — the same on a sign-in and on the A345 background upgrade. */
  function verifyPinBody(pin: string, branch_id: string): string {
    return JSON.stringify({
      pin, branch_id,
      // The running build, reported on the one call every till makes every day.
      // Three tills are updated by hand and drift; without this a bug report
      // cannot be tied to a version, so a fixed bug and an un-updated till look
      // identical from the outside.
      app_version: app.getVersion(),
      device_id: getDeviceConfig()?.device_id ?? undefined,
      // A273 follow-up: sent on every sign-in so the cloud label follows the till's
      // setup name (the setup name always wins — owner, 2026-09-26).
      terminal_code: getDeviceConfig()?.terminal_code ?? undefined,
      device_name:   getDeviceConfig()?.device_name ?? undefined,
    });
  }

  handle('auth:verifyPin', async (_event, payload) => {
    // D7: validate at the boundary. A malformed payload throws a clear error the
    // renderer already catches, instead of destructuring undefined mid-handler.
    const { pin, branch_id } = assertPayload<{ pin: string; branch_id: string }>(
      { pin: { t: 'string', min: 1 }, branch_id: { t: 'string', min: 1 } }, payload);
    const db = getLocalDb();
    const session = db.prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as any;

    // Same expiry problem as listBranches: the PIN pad is the first thing
    // touched each morning, so this is exactly where a stale owner token bites.
    //
    // OFFLINE FALLBACK — the rule that matters:
    //
    //   Fall back only when the server could not be REACHED.
    //   Never when the server ANSWERED and said no.
    //
    // A 401, a 409 PIN_NOT_UNIQUE, a disabled account — those are decisions,
    // and honouring the cache over them would mean a sacked cashier signs in by
    // unplugging the network cable. Only a transport failure (fetch throws)
    // reaches the cache. Everything else is the server's answer and stands.
    const authCfg = getDeviceConfig();
    const amNode = isNodeRole(authCfg?.device_role);
    const hasNodeUrl = !!authCfg?.node_url && !amNode;

    // Local sign-in from a resolved staff identity — no server JWT. Orders push
    // under the OWNER token (syncEngine authHeaders) and cashier_id comes from
    // this staff_session row, so the sale queues, attributes correctly and syncs
    // when the line returns. Shared by the node, node-own-roster and cache paths.
    const signInLocal = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }) => {
      const branchRowOff = db.prepare(`SELECT name FROM branches WHERE id=?`).get(branch_id) as any;
      // A167: token is TEXT NOT NULL (localDb.ts). An offline session has no
      // server JWT, but writing NULL here throws `NOT NULL constraint failed:
      // staff_session.token` and defeats the whole offline-auth fallback at its
      // last step. Write '' — the reader already coerces it (tokenStore.read:
      // `unwrap(token_enc) || token || ''`) and configureStaffSession('','')
      // already represents an offline staff session as empty in memory, so ''
      // is the value the rest of the code expects, not a sentinel. No migration
      // (rule 13): the column and its readers are unchanged.
      db.prepare(`
        INSERT INTO staff_session
          (id, staff_id, staff_name, role_name, branch_id, branch_name, permissions, token, refresh_token, logged_in_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, '', NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          staff_id=excluded.staff_id, staff_name=excluded.staff_name, role_name=excluded.role_name,
          branch_id=excluded.branch_id, branch_name=excluded.branch_name, permissions=excluded.permissions,
          token='', refresh_token=NULL, logged_in_at=excluded.logged_in_at
      `).run(
        staff.staffId, staff.name, staff.roleName, branch_id,
        branchRowOff?.name ?? null, JSON.stringify(staff.permissions ?? {}),
        new Date().toISOString(),
      );
      configureStaffSession('', '');
      // A345: held in memory so the session becomes a cloud sign-in by itself once the network is back (offlineSession.ts).
      holdOfflinePin({ staffId: staff.staffId, branchId: branch_id, pin: String(pin) });
      return {
        staff: { id: staff.staffId, name: staff.name, role: staff.roleName },
        // The PIN screen routes on the TOP-LEVEL role (App.tsx hasManagerRights), exactly as the online answer gives it
        // (`role: data.staff?.role` below). Without it an offline manager — no '*' and, since migration 59, no
        // settings.manage — was sent to the cashier screen (owner, 2026-09-27; A339).
        role: staff.roleName,
        permissions: staff.permissions,
        branch: { id: branch_id, name: branchRowOff?.name ?? null },
        business: { name: session?.business_name ?? null, currency: session?.currency ?? null },
        offline: true,
      };
    };

    // AUTHORITY CHAIN (A17): node → cloud → last resort. Fall back only when an
    // authority could not be REACHED; a rejection from any of them is FINAL, or a
    // sacked cashier signs in by unplugging a cable — now with two to choose from.

    // 1. A peer asks its branch node over the LAN first.
    if (hasNodeUrl) {
      const r = await verifyPinAtNodeClient(String(pin), branch_id);
      if (r.status === 'ok') { logLine('pin', `node sign-in: ${r.staff.name}`); return signInLocal(r.staff); }
      if (r.status === 'rejected') throw new Error(r.message);   // answered no — final
      // transport failure → fall through to the cloud
    }

    // 3. Last resort. A NODE verifies against its OWN roster (never expires); a
    //    peer or standalone till uses the offline cache (which no longer expires
    //    on a node-configured peer — see pinCache, A17). Shared by BOTH the
    //    thrown-transport path and the 5xx path (A152) so a "down-but-answering"
    //    cloud rescues identically to an unreachable one.
    const fallbackToLocalAuthority = () => {
      if (amNode) {
        const v = verifyPinAtNode(String(pin), branch_id);
        if (!v.ok) throw new Error(v.message);
        return signInLocal(v.staff);
      }
      const verdict = verifyPinOffline(String(pin), branch_id);
      if (!verdict.ok) throw new Error(verdict.message);
      return signInLocal(verdict.staff);
    };

    // 2. The cloud, exactly as before.
    let res: Awaited<ReturnType<typeof ownerFetch>>;
    try {
      res = await ownerFetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // PIN, branch, the running build and this till's name (verifyPinBody).
      body: verifyPinBody(String(pin), branch_id),
      });
    } catch (netErr: any) {
      logLine('pin', `server unreachable at sign-in (${netErr?.message ?? netErr}) - trying the local authority`);
      return fallbackToLocalAuthority();
    }

    // A152: a cloud that ANSWERS with a 5xx is UNREACHABLE, not a rejection.
    // Render process down behind a live edge returns 502/503; without this the
    // next two lines either threw an unhandled parse error on the gateway's HTML
    // body or read !res.ok as "Invalid PIN" — and the offline cache/node never
    // rescued a login it should have. A clean 4xx below stays FINAL.
    if (isUnreachableStatus(res.status)) {
      logLine('pin', `cloud answered ${res.status} at sign-in - treating as unreachable, trying the local authority`);
      return fallbackToLocalAuthority();
    }

    // Guard the body: a non-JSON error page must not throw here (A152).
    const data = await res.json().catch(() => ({} as any));
    // A407: the cloud refused the TILL's session (not the PIN — a wrong PIN is a 401 "Invalid PIN" with no code) and the
    // renewal and the device secret could not fix it. The person's PIN is still checked — on the till, as offline — so
    // the cashier keeps selling; the till keeps trying to sign itself back in, and ZapTill is emailed if it cannot.
    if (res.status === 401 && isSessionRefusal(data)) {
      logLine('pin', `the cloud refused this till's session (${data.code ?? data.error ?? '401'}) - signing in on the till's own PIN check`);
      return fallbackToLocalAuthority();
    }
    if (!res.ok) throw new Error(data.error ?? 'Invalid PIN');

    // Online sign-in succeeded: an offline PIN held from an earlier sign-in is no longer needed (A345).
    clearOfflinePin();
    const branchRow = persistCloudSignIn(data, branch_id);

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

    // A334: a drawer the web POS opened as this till → sell into it (not a second one).
    const joinedDrawer = await joinCloudDrawer(data.staff?.id);
    if (joinedDrawer) syncPush().catch(() => { /* the timer retries */ });   // record this till's day on the joined drawer now
    // Cross-sync stage 1: the web's sales on this till's drawer, at sign-in rather than on the next 20-s beat.
    pullWebSales().catch(() => { /* the 20-s poll retries */ });

    return {
      staff: data.staff,
      role: data.staff?.role ?? null,
      permissions: data.permissions ?? {},
      branchId: branch_id,
      branchName: branchRow?.name ?? null,
      joinedDrawer,
    };
  });

  handle('auth:getStaffSession', async () => {
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

  // ── Idle lock (A52) ────────────────────────────────────────────────────────
  // Suppression tokens are handed out rather than exposing the release closure,
  // because a renderer that reloads mid-print would otherwise strand a
  // suppression forever and the till would never lock again. Tokens are held
  // here, in the process that owns the counter.
  const _idleReleases = new Map<number, () => void>();
  let _idleToken = 0;

  handle('idle:setSurface', async (_e, surface: 'manager' | 'pos' | null) => {
    setIdleSurface(surface);
    return true;
  });
  handle('idle:clear', async () => { clearIdleLock(); return true; });
  handle('idle:suppress', async () => {
    const token = ++_idleToken;
    _idleReleases.set(token, suppressIdleLock());
    return token;
  });
  handle('idle:release', async (_e, token: number) => {
    const release = _idleReleases.get(token);
    if (!release) return false;   // already released, or never issued
    release();
    _idleReleases.delete(token);
    return true;
  });

  handle('auth:clearStaffSession', async () => {
    const db = getLocalDb();
    db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
    clearOfflinePin();   // A345: locking the till ends the offline sign-in's upgrade too
    configureStaffSession('', '');
    return true;
  });

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

    return {
      products: shaped,
      branchName,
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

  handle('pos:getVariants', async (_event, productId: string) => {
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

  // A367: the quick picks for order notes — the owner's list cached by the catalogue pull, else the defaults.
  handle('pos:notePicks', async () => parseNotePicks(getDeviceConfig()?.order_note_picks ?? null));

  // 0.6.27: the per-client POS switches (admin portal), as the till last heard them — all off until told.
  handle('pos:features', async () => getPosFeatures());
  // A394: the items a stock count freezes at this branch (the sale screen refuses them).
  handle('pos:stockCountFreeze', async () => getStockCountFreeze());

  handle('pos:getModifiers', async (_event, productId: string) => {
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

  /**
   * Queue thermal tickets for an order payload.
   *
   * Shared by order:create (the receipt, at payment) and escpos:printProduction
   * (the kitchen and dispatch tickets, when the order is SENT). Splitting the
   * two moments is the point: queuing all three together meant the kitchen only
   * saw an order after the customer had paid for it, so nothing was cooking
   * while they settled the bill.
   *
   * NEVER THROWS. It runs after the money is taken and the order is committed;
   * a printer problem must not turn a completed sale into an error on screen.
   */
  function queueThermal(
    payload: any,
    kinds: Array<'kitchen' | 'dispatch' | 'receipt'>,
    reprint?: { at: Date; count: number },
    // 0.5.27 — returns the stations that produced NOTHING. printSale has always
    // computed this and every caller threw it away, so a station with no printer
    // bound on this terminal was skipped in silence. That is register D8, and
    // with the HTML fallback gone there is no second system to catch it: the
    // cashier must be told, or a bag leaves with items missing.
  ): { skipped: string[]; failed: string[] } {
    try {
      if (!escposEnabled()) return { skipped: [], failed: [] };

      const db = getLocalDb();
      const cfg = getDeviceConfig();
      const stations = db.prepare(
        `SELECT id, name, kind FROM print_stations WHERE active = 1 ORDER BY sort_order, name`
      ).all() as Array<{ id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt' }>;

      // A business with no stations configured is not an error — it is one that
      // has not set them up. Falling back to the three built-ins keeps a
      // freshly-upgraded till printing.
      const effective = stations.length ? [...stations] : [
        { id: 'kitchen',  name: 'Kitchen',  kind: 'kitchen'  as const },
        { id: 'dispatch', name: 'Dispatch', kind: 'dispatch' as const },
        { id: 'receipt',  name: 'Till',     kind: 'receipt'  as const },
      ];

      // The receipt station is added when the business has not defined one.
      // Kitchen and dispatch are genuinely optional — a retail shop has neither
      // — but somewhere to print the bill is not.
      if (!effective.some(st => st.kind === 'receipt')) {
        effective.push({ id: 'receipt', name: 'Till receipt', kind: 'receipt' as const });
      }

      // Which stations have a printer bound on THIS terminal. Drives the Kots
      // count, so it reflects paper that will exist rather than stations that
      // merely exist.
      const assignedIds = new Set(assignments().map(a => a.stationId));

      const staff = db.prepare(
        `SELECT staff_name, branch_name FROM staff_session WHERE id = 1`
      ).get() as { staff_name?: string; branch_name?: string } | undefined;

      // business_name and currency live on `session`, branch_name on
      // `staff_session`. NOT on device_config — that holds the machine's own
      // settings, not the tenant's identity. Getting this wrong prints a receipt
      // with a blank shop name at the top.
      const sess = db.prepare(
        `SELECT business_name, currency FROM session WHERE id = 1`
      ).get() as { business_name?: string; currency?: string } | undefined;

      const saleResult = printSale(
        {
          billNumber:     String(payload.order_number ?? ''),
          orderType:      String(payload.order_type ?? 'retail'),
          cashierName:    staff?.staff_name ?? '',
          soldAt:         new Date(),
          tableNumber:    payload.table_number ?? undefined,
          deliveryPerson: payload.delivery_person ?? undefined,
          note:           payload.notes ?? null,   // A367: the order's note, on the kitchen ticket and the receipt
          cart:           payload.items ?? [],
          payments:       payload.payments ?? [],
          changeGiven:    Number(payload.change_given ?? 0),
          total:          Number(payload.total ?? 0),
          // A349: the BILL is after the discount and excludes the tip; the receipt needs both to reconcile and print.
          discount:       Number(payload.discount_amount ?? 0),
          tip:            Number(payload.tip_amount ?? 0),
          deliveryFee:    Number(payload.delivery_fee ?? 0),   // 0.6.27: after the total with the tip; PAY includes it
          deliveryFree:   payload.delivery_free === true,       // 0.6.33: "Delivery: FREE" — the fee is not the customer's
          // "How many kitchen tickets did this order produce" — the number the
          // expeditor counts against what arrives at the pass. Counted from
          // stations that will ACTUALLY print here; a station with no printer
          // on this terminal produces no ticket. Receipts are not KOTs.
          // 0.6.28: a kitchen void reprints the taken-back items under a VOID banner (kitchen and dispatch only).
          voided:         payload.kitchen_void
            ? { at: new Date(), by: String(payload.kitchen_void.by ?? ''), reason: String(payload.kitchen_void.reason ?? '') }
            : undefined,
          kotCount:       effective.filter(
            st => st.kind !== 'receipt' && assignedIds.has(st.id)).length,
          reprint,
        },
        {
          name:            sess?.business_name ?? '',
          branchName:      staff?.branch_name ?? undefined,
          header:          (cfg as any)?.receipt_header || undefined,
          currencyCode:    sess?.currency ?? 'KES',
          // Cached from /api/pos/init on every catalogue pull, so an offline
          // till still prints the business's real rates rather than a hardcoded
          // 16 — which printed the wrong tax for anyone on a different rate.
          vatRate:         Number((cfg as any)?.vat_rate ?? 16),
          ctlRate:         Number((cfg as any)?.ctl_rate ?? 0),
          thankYouMessage: (cfg as any)?.receipt_footer || undefined,
          footerCredit:    'Powered by ZapTill',
          // A312: the client logo on customer receipts — ONLY when the client's toggle is on
          // and a raster exists. Decoded by shared/printing; a malformed stored value decodes
          // to null and prints no logo. The renderer prints it on receipts only (A310).
          logoRaster:      resolveReceiptLogo(),
        },
        // The presets shared/printing exports, NOT a hand-rolled config here.
        // They are what the verified sample output was rendered from, so a
        // ticket printed on the counter is laid out identically to the one in
        // SAMPLE-OUTPUT.
        //
        // Paper width comes from the terminal's assignment (what is physically
        // loaded), applied inside queueTickets — an 80mm layout on a 58mm roll
        // wraps its whole right-hand column.
        effective.map(s =>
          s.kind === 'kitchen'  ? kitchenPreset(s.id, s.name)
        : s.kind === 'dispatch' ? dispatchPreset(s.id, s.name)
        :                         receiptPreset(s.id, s.name)),
        kinds,
      );

      return { skipped: saleResult?.skipped ?? [], failed: saleResult?.failed ?? [] };
    } catch (e) {
      console.error('[escpos] queueing tickets failed (non-blocking):', e);
      // NEVER THROWS — it runs after the money is taken. A349: the failure is also returned so the cashier is told.
      return { skipped: [], failed: ['all tickets'] };
    }
  }

  /**
   * Kitchen and dispatch tickets, at the moment the order is sent.
   *
   * Called from Send to kitchen, before any money is taken. The renderer sets
   * kot_sent on the payload it later passes to order:create so the same tickets
   * are not produced twice.
   */
  /**
   * The exclusion list this terminal's printer applies, and where it came from.
   *
   * `terms` is the EFFECTIVE list (override if set, else the synced cloud
   * baseline); `source` says which; `cloudTerms` carries the baseline so the
   * setup screen can show "the dashboard says X" while a local override is in
   * force. `terms` is kept as the first field so the older PrintersTab caller,
   * which destructured `{ terms }`, keeps working unchanged.
   *
   * "Local is final" lives one layer down, in escposBridge: the printer path
   * calls kitchenExclusions() directly, which already resolves the override.
   */
  handle('escpos:kitchenExclusions', () => {
    try { return kitchenExclusionsState(); }
    catch { return { terms: [] as string[], source: 'cloud' as const, cloudTerms: [] as string[] }; }
  });

  /**
   * Set this terminal's local override. Available on any till — a cloud till may
   * still override the business default for its own printer, and the override
   * survives every catalogue pull. See escposBridge.setKitchenExclusions.
   */
  handle('escpos:setKitchenExclusions', (_e, terms: unknown) => {
    // D7 reference adoption: validate at the boundary. A malformed payload is a
    // clean rejection, not a silent coerce-to-empty that would wipe the list.
    const v = expectStringArray(terms, 'terms');
    if (!v.ok) return { ok: false, error: v.error, terms: kitchenExclusions() };
    try {
      const saved = setKitchenExclusions(v.value);
      return { ok: true, terms: saved };
    } catch {
      return { ok: false, error: 'write failed', terms: kitchenExclusions() };
    }
  });

  /**
   * Drop the local override and follow the cloud baseline again. Returns the
   * baseline that is now in force so the screen can repaint without a round trip.
   */
  handle('escpos:clearKitchenExclusions', () => {
    try { return { ok: true, terms: clearKitchenExclusionsOverride() }; }
    catch { return { ok: false, error: 'write failed', terms: kitchenExclusions() }; }
  });

  handle('escpos:printProduction', (_e, payload: any) => {
    // `skipped` reaches the renderer so the cashier is told which station
    // produced nothing. Previously this returned a bare { ok: true } and the
    // information was discarded here — D8.
    const { skipped, failed } = queueThermal(payload, ['kitchen', 'dispatch']);
    // A349: a ticket that could not be produced is named alongside the stations with no printer.
    return { ok: true, skipped: [...skipped, ...failed.map((f) => `${f} (could not be produced)`)] };
  });

  /**
   * The last order this terminal rang, kept so the receipt can be reprinted.
   *
   * In memory only, and only the payload needed to render a receipt. A restart
   * clears it, which is correct — reprinting yesterday's last sale from a
   * screen that says "Payment successful" would be worse than not offering it.
   */
  let lastOrderPayload: any = null;
  let reprintCount = 0;

  handle('escpos:reprintReceipt', () => {
    if (!lastOrderPayload) return { ok: false, error: 'nothing to reprint' };
    reprintCount += 1;
    // Marked as a duplicate on the paper itself. An unmarked second copy of a
    // receipt is the thing an auditor cannot tell from a second sale.
    const r = queueThermal(lastOrderPayload, ['receipt'], { at: new Date(), count: reprintCount });
    if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
    return { ok: true };
  });

  // Reprint any recent order from Order History (A94). Replays the stored payload
  // through the same path as the original — byte-identical, marked "Duplicate
  // Print". Only orders created on THIS terminal (after the feature shipped) have
  // a stored payload; anything else reports honestly rather than printing wrong.
  handle('escpos:reprintReceiptForOrder', (_e, orderId: string) => {
    // 0.6.27: History's Reprint is for managers when the client has 'cashier_no_reprint' on — refused here too.
    if (!historyScope().canReprint) return { ok: false, error: 'Reprinting is for managers on this till.' };
    const row = getLocalDb()
      .prepare('SELECT payload FROM receipt_payloads WHERE order_id = ?')
      .get(orderId) as { payload?: string } | undefined;
    if (!row?.payload) {
      return { ok: false, error: 'No stored receipt for this order on this terminal.' };
    }
    try {
      const r = queueThermal(JSON.parse(row.payload), ['receipt'], { at: new Date(), count: 1 });
      if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not rebuild this receipt.' };
    }
  });

  handle('order:create', async (_event, orderPayload: any) => {
    const orderId = createLocalOrder(orderPayload);
    markKitchenPaid(orderPayload?.order_number);   // 0.6.28: its sent lines are paid for
    // A299: event summary — id, total, method, item count. No line-item detail
    // or customer data (the DB + cloud are the record; this is the trail).
    logLine('sale', `created ${orderId} ${orderPayload?.total ?? '?'} `
      + `${orderPayload?.payments?.[0]?.method ?? orderPayload?.payment_method ?? ''} `
      + `x${orderPayload?.items?.length ?? 0}`.replace(/\s+/g, ' ').trim());
    lastOrderPayload = orderPayload;
    reprintCount = 0;
    // Push-only flush — the old syncAll here re-pulled the entire catalogue
    // (N+1 variant/modifier fetches) on every single sale.
    syncPush().catch(console.error);

    // AFTER the order is committed and AFTER the sync flush is scheduled, and
    // never awaited. The spool owns delivery; the sale does not wait on a
    // printer and cannot fail because of one.
    //
    // A restaurant order that already went to the kitchen gets ONLY the receipt
    // here — its production tickets were queued when it was sent, which is the
    // whole reason the split exists. A counter sale has no send step, so it
    // gets everything at once, which is correct there.
    const printed = queueThermal(
      orderPayload,
      orderPayload?.kot_sent ? ['receipt'] : ['kitchen', 'dispatch', 'receipt'],
    );

    // A349: a ticket that could not be produced reaches the sale screen (a missing printer is not a failure — that is
    // "skipped", and a till with no receipt printer would otherwise be nagged on every sale).
    return { orderId, printFailed: printed.failed };
  });

  // ── Printing (native — replaces QZ Tray on the desktop) ──

  handle('print:list', async () => {
    return await listPrinters();
  });

  /**
   * Which printers are SHARED, and under what name.
   *
   * The Printers screen needs this to build a working \\localhost\<share>
   * target. Without it the picker guessed the printer's own name, which is a
   * different field and is absent entirely on a printer nobody has shared.
   */
  handle('print:shares', async () => await printerShares());

  // Ping a printer without printing. Cashiers use this constantly; it must not
  // consume paper.
  handle('print:probe', async (_event, deviceName: string) =>
    probePrinter(String(deviceName ?? '')));

  // Reads the driver's real media size and imageable area, so paper width does
  // not have to be a setting the user can silently get wrong. Returns null when
  // it cannot be determined and the caller falls back to the dot table.
  handle('print:geometry', async (_event, deviceName: string) =>
    probeGeometry(String(deviceName ?? '')));

  // Preview: renders the ticket in a visible window instead of printing it.
  // The only way to see a ticket without thermal hardware, since the silent
  // path deliberately suppresses every OS dialog.
  handle('print:preview', async (_event, opts: any) => {
    return openPrintPreview({
      html: String(opts?.html ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      title: opts?.title ? String(opts.title) : undefined,
    });
  });

  handle('print:html', async (_event, opts: any) => {
    return await printHtmlSilent({
      html: String(opts?.html ?? ''),
      deviceName: String(opts?.deviceName ?? ''),
      paperWidthMm: opts?.paperWidthMm === 58 ? 58 : 80,
      copies: Number(opts?.copies) || 1,
    });
  });

  // ── Sync ────────────────────────────────────────────────

  handle('sync:trigger', async () => {
    return await syncAll();
  });

  handle('sync:retryFailed', async () => {
    return await retryFailedOrders();
  });

  // Renderer-side `window` online/offline events are the only reliable network
  // signal Electron gives us — main forwards them into an immediate flush.
  handle('net:changed', async (_event, online: boolean) => {
    if (online) {
      console.log('[sync] Renderer reports online — flushing queue');
      syncAll().catch(console.error);
    }
    return getSyncStatus();
  });

  handle('sync:status', async () => {
    return getSyncStatus();
  });

  // ── Device config (first-run install + runtime server URL) ──

  handle('config:get', async () => {
    return getDeviceConfig();
  });

  // A295: client branding (accent + logo) for the lock screen. Null until the
  // branding sync fills the local table → PinPage renders the SwiftPOS default.
  handle('branding:get', async () => getBranding());

  // A301: desktop-local WRITE path. Validates + upserts the branding row; the accent/logo
  // then flows through PinPage's existing read seam. Throws on invalid input, surfaced to
  // the caller verbatim (rule 7). SVG is rejected in the guard here too — defence in depth,
  // never trust the renderer (the persist-time check the SVG-upload research calls for).
  handle('branding:set', async (
    _event,
    { businessId, accentHex, logoPng, logoRgba, receiptLogoEnabled }:
      { businessId: string; accentHex?: string | null; logoPng?: string | null;
        logoRgba?: { width: number; height: number; data: ArrayLike<number> } | null;
        receiptLogoEnabled?: boolean },
  ) => {
    const saved = setBranding(businessId, { accentHex, logoPng, logoRgba, receiptLogoEnabled });
    // 0.6.25: and to the cloud (owner's decision), so the next pull does not put the old logo back. Never fails the save.
    const cloud = await queueBrandingPush().catch((e: any) => ({ state: 'pending' as const, message: String(e?.message ?? e) }));
    return { ...saved, cloud };
  });

  // A306: auto-update status for the renderer banner. Push is via update:status
  // (webContents.send from autoUpdate.ts); this is the poll the renderer runs on mount.
  handle('update:getStatus', async () => getUpdateStatus());
  // Apply a downloaded update now, NSIS progress visible + relaunch. Gated to a manager/tech
  // PIN at the call site (the banner verifies before invoking); a no-op unless an update is
  // actually downloaded, so it can never half-restart a trading till.
  handle('update:installNow', async () => {
    // A306 (hardened 2026-09-22): the banner verifies a manager PIN before invoking this, but a
    // renderer-only gate is bypassable by any code that can reach the bridge. Refuse in MAIN
    // unless the CURRENT staff session is a manager — the same isManager() gate closeDay uses.
    // The banner's verifyPin signs the manager in first, so the honest path still passes.
    if (!isManager()) return { ok: false, reason: 'manager_required' };
    return installUpdateNow();
  });

  handle('config:isConfigured', async () => {
    return isConfigured();
  });

  handle('config:save', async (_event, patch: any) => {
    const saved = saveDeviceConfig(patch ?? {});
    try {
      if (isNodeRole(saved.device_role)) startNodeServer();
      else stopNodeServer();
    } catch (e) {
      console.error('[config:save] node server transition failed:', e);
    }
    // A299: log WHICH keys changed, never their values — device_config holds the
    // node secret and cloud url. Keys are enough for "what was changed, when".
    logLine('config', `saved ${Object.keys(patch ?? {}).join(',') || '(empty)'}`);
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
  handle('orders:nextBillNumber', async () => {
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

  // A299: renderer-side errors (window.onerror, unhandledrejection, and its
  // console.error/warn — e.g. the "[Overview] salesSummary failed" that only a
  // DevTools screenshot caught on 2026-09-18) forward here so they land in
  // swiftpos.log too. Fire-and-forget send/on: no invoke, so no schema/parity
  // concern. Bounded so a chatty renderer can't flood the file.
  ipcMain.on('log:renderer', (_event, msg: unknown) => {
    logLine('renderer', String(msg ?? '').replace(/\s+/g, ' ').slice(0, 2000));
  });

  // Gated + audited (audit: clearDeviceConfig was ungated). Clearing config is
  // how a till sheds its branch binding and re-registers as a new device —
  // with device-branch binding and per-seat licensing live, an anonymous
  // one-click version of that is a control bypass. The reveal-code + signed
  // token is the same bar as every other tech action, and the audit row means
  // the new device appearing in the fleet has a name attached to its birth.
  handle('config:clear', async () => {
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
  handle('device:resetPreview', async () => {
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
  handle('device:reset', async (_e, { force }: { force?: boolean } = {}) => {
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
  handle('config:testConnection', async (_event, url: string) => {
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

  // includeForeign (A334): the close screen and the manager report add the web's cash on a shared
  // drawer. The POS sell gate calls this WITHOUT it — it must never wait on the cloud.
  handle('shift:current', async (_e, opts?: { includeForeign?: boolean }) => {
    // 0.6.27: a cashier on a blind close gets the report without its figures (blindReport).
    const view = (z: ReturnType<typeof currentShiftReport>) => (z && blindClose() ? blindReport(z) : z);
    if (!opts?.includeForeign) return view(currentShiftReport());
    const local = currentShiftReport();
    if (!local) return null;
    return view(currentShiftReport(await fetchForeignCash(local.shift.id)));
  });

  // A shift left open past ~18h. Reported, never auto-closed — see
  // forceCloseShift() for why a fabricated cash count is worse than none.
  handle('shift:stale', async () => getStaleShift());

  // ── Trading day (per till) ────────────────────────────────────────────────
  // checkDayGate is what the POS screen reads to decide whether it may sell at
  // all. closeDay is manager-gated inside dayService, NOT by hiding the button:
  // a control that exists only in the UI is a suggestion.
  // Which terminal this is. Read-only identity for display: the cashier should
  // not be asked which till they are standing at when the install already knows.
  handle('device:identity', async () => {
    const cfg = getDeviceConfig();
    return {
      deviceId:     cfg?.device_id ?? null,
      terminalCode: cfg?.terminal_code ?? null,
      deviceName:   cfg?.device_name ?? null,   // A334: the join notice names the till
    };
  });

  // Fail CLOSED. If this check throws, the renderer's .catch leaves dayGate
  // null, needsShift computes false, and the till trades with no drawer until
  // the raw driver error surfaces inside the payment modal — which is exactly
  // what a missing bind in getOpenShift did in production. A gate that cannot
  // run must block and say why, using the same hard-block UI as an unclosed day.
  handle('day:gate', async () => {
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
  handle('day:current', async () => getOpenDay());

  // ── Central day close (Phase 4) — node-side manager screen ────────────────
  handle('branchClose:overview', async () => {
    try { return branchCloseOverview(); }
    catch (err: any) { return { error: err?.message ?? 'Could not read the branch state' }; }
  });
  handle('branchClose:closeTill', async (_e, { device_id, counted_cash, notes }:
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
  handle('day:summary', async () => getDayCloseSummary());
  handle('day:isManager', async () => isManager());
  handle('day:conflicts', async () => getConflictedShifts());
  handle('day:retryConflict', async (_e, { shiftId }: { shiftId: string }) => {
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
  handle('day:close', async (_e, { countedCash, notes }: { countedCash: number; notes?: string }) => {
    try { return { ok: true, summary: closeDay(Number(countedCash), notes) }; }
    catch (err: any) { return { ok: false, error: err?.message ?? 'Could not close the day' }; }
  });

  // A334 follow-up (owner, 2026-09-27: "can it be instant"): a shift change reaches the cloud NOW, the way a sale
  // already does (order:create), not on the next timer tick — so the web POS sees a till's drawer open / close within
  // seconds. Fire-and-forget: the push self-guards on offline / in-flight, and the 30 s timer is the backstop.
  const pushNow = () => { syncPush().catch(() => { /* the timer retries */ }); };

  handle('shift:forceClose', async (_e, { reason }: { reason: string }) => {
    const z = forceCloseShift(String(reason ?? ''));
    pushNow();
    return z;
  });

  handle('shift:open', async (_event, { opening_float, drawer_label }: { opening_float: number; drawer_label?: string }) => {
    openShift(Number(opening_float) || 0, drawer_label);
    logLine('shift', `open float ${Number(opening_float) || 0}${drawer_label ? ` (${drawer_label})` : ''}`);
    pushNow();
    return currentShiftReport();
  });

  handle('shift:float', async (_event, { type, amount, reason, pin }: { type: 'float_in' | 'float_out'; amount: number; reason?: string; pin?: string }) => {
    // 0.6.37 (A388): a cash-out needs a manager — signed in, or their PIN on the spot. A pay-in needs nobody.
    const approver = type === 'float_out' ? await payoutApprover(pin) : null;
    addFloat(type, Number(amount), reason, approver);
    if (approver) logLine('shift', `pay-out ${Number(amount)} approved by ${approver.name ?? approver.id}`);
    pushNow();
    return currentShiftReport();
  });

  handle('shift:close', async (_event, { closing_float, notes, declared }: { closing_float: number; notes?: string; declared?: Record<string, number> }) => {
    // Returns the final Z-report. Throws (with .variance/.expected_cash) if a
    // variance note is required — the renderer surfaces that message.
    // A334: a shared drawer's web cash is part of what the cashier counted.
    // A365: `declared` — the cashier's figure for every payment method; the shift then awaits a manager.
    // 0.6.28: with 'kitchen_void_approval', not while an order sent to the kitchen on this shift is unpaid.
    const openShiftId = currentShiftReport()?.shift.id;
    const kitchenBlock = openShiftId ? kitchenCloseBlock(openShiftId) : null;
    if (kitchenBlock) throw new Error(kitchenBlock);
    const z = closeShift(Number(closing_float), notes, await fetchForeignCash(currentShiftReport()?.shift.id), declared ?? null);
    logLine('shift', `close float ${Number(closing_float) || 0}`);
    pushNow();
    return blindClose() ? blindReport(z) : z;   // 0.6.27: a blind close hands back no figures
  });

  // ── A365: a manager confirms a closed shift (blind recount of every payment method) ──────────────────────────
  // Who may confirm: owner/admin/manager/supervisor roles, '*', orders.void, shifts.manage, settings.manage — the
  // cloud's mayConfirm. The PIN goes to an AUTHORITY first (the branch node, then the cloud); only when none can be
  // reached does the till's own saved sign-in answer. A "no" from an authority is final (same chain as sign-in, A17).
  const mayConfirmLocal = (staff: { roleName?: string | null; permissions?: unknown }) =>
    isShiftManager(staff.roleName, (staff.permissions ?? {}) as Record<string, unknown>);
  const NOT_A_CONFIRMER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  // 0.6.37 (A388): a cash-out or an expense with no manager signed in and no PIN.
  const PAYOUT_APPROVAL_NEEDED = 'A manager must approve this — enter a manager’s PIN.';
  async function identifyConfirmer(pin: string): Promise<{ id: string; name: string | null }> {
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? '';
    const local = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }) => {
      if (!mayConfirmLocal(staff)) throw new Error(NOT_A_CONFIRMER);
      return { id: staff.staffId, name: staff.name };
    };
    if (cfg?.node_url && !isNodeRole(cfg?.device_role)) {
      const r = await verifyPinAtNodeClient(pin, branchId);
      if (r.status === 'ok') return local(r.staff);
      if (r.status === 'rejected') throw new Error(NOT_A_CONFIRMER);
    }
    let res: Response | null = null;
    try {
      res = await ownerFetch('/api/shifts/confirmer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
      });
    } catch { res = null; }
    if (res && !isUnreachableStatus(res.status)) {
      if (res.ok) { const b = await res.json() as { id: string; name: string | null }; return { id: b.id, name: b.name ?? null }; }
      if (res.status === 403) throw new Error(NOT_A_CONFIRMER);
      const b = await res.json().catch(() => ({} as any));
      throw new Error(b?.error ?? `Could not check the PIN (HTTP ${res.status}).`);
    }
    // No authority could be reached: the node's own roster, or this till's saved sign-ins.
    if (isNodeRole(cfg?.device_role)) {
      const v = verifyPinAtNode(pin, branchId);
      if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_A_CONFIRMER : v.message);
      return local(v.staff);
    }
    const v = verifyPinOffline(pin, branchId);
    if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_A_CONFIRMER : v.message);
    return local(v.staff);
  }

  handle('shift:awaiting', async () => awaitingConfirmation());

  // A366: may the signed-in person close the open shift (its owner or a manager)? The screen asks first; closeShift
  // enforces it regardless.
  handle('shift:closeRights', async () => ({ ...shiftCloseRights(getOpenShift()), blind: blindClose() }));   // 0.6.27: blind

  // 0.6.23 (owner: "since its the manager who is logged in do they need to key in their password?"): a manager already
  // signed in on this till confirms as themselves — no PIN. Anyone else still needs a manager's PIN.
  const signedInConfirmer = (): { id: string; name: string | null } | null => {
    const st = getLocalDb().prepare(`SELECT staff_id, staff_name, role_name, permissions FROM staff_session WHERE id=1`).get() as
      { staff_id: string; staff_name: string; role_name: string | null; permissions: string | null } | undefined;
    if (!st?.staff_id) return null;
    let permissions: unknown = {};
    try { permissions = JSON.parse(st.permissions || '{}'); } catch { /* none */ }
    return mayConfirmLocal({ roleName: st.role_name, permissions }) ? { id: st.staff_id, name: st.staff_name } : null;
  };
  handle('shift:canConfirm', async () => signedInConfirmer() !== null);

  // 0.6.37 (A388) — owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot". A manager
  // signed in on this till approves as themselves; anyone else enters a manager's PIN, checked like a shift
  // confirmation (the branch node, the cloud, else this till's saved sign-ins — so it works offline). The approver is
  // stored on the row, pushed, and printed on the Z-report.
  async function payoutApprover(pin?: string): Promise<{ id: string; name: string | null }> {
    const p = String(pin ?? '').trim();
    if (p) return identifyConfirmer(p);
    const me = signedInConfirmer();
    if (me) return me;
    throw new Error(PAYOUT_APPROVAL_NEEDED);
  }

  handle('shift:confirm', async (_event, payload) => {
    const { shiftId, pin, counts, reasons } = assertPayload<{ shiftId: string; pin?: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { shiftId: { t: 'string', min: 1 }, pin: { t: 'string', optional: true }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    const signedIn = signedInConfirmer();
    if (!signedIn && !String(pin ?? '').trim()) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    const confirmer = signedIn && !String(pin ?? '').trim() ? signedIn : await identifyConfirmer(String(pin));
    const c = confirmShift(shiftId, confirmer, counts, reasons ?? null);   // 0.6.27: reasons
    logLine('shift', `A365 shift ${shiftId} confirmed by ${confirmer.name ?? confirmer.id}${c.self ? ' (self-confirmed)' : ''}` +
      `${c.lines.some((l) => l.mismatch) ? ' — recount differs from the cashier' : ''}`);
    pushNow();
    return c;
  });

  // 0.6.27: may the confirm screen show the cashier's figures ('confirm_shows_cashier_figures')?
  handle('shift:confirmView', async (_event, shiftId: string) => confirmView(String(shiftId)));

  // ── 0.6.28: Send to kitchen is recorded; sent items come back only as a recorded kitchen void ────────────────────
  // Owner, 2026-10-01: a sent order cancelled after the customer paid in cash — "the cashier pockets the money". Every
  // sent item ends paid (order:create → markKitchenPaid) or voided here. See kitchenService.ts.
  handle('kitchen:sent', async (_event, payload) => {
    const { order_number, lines, order_type, table_number } = assertPayload<{
      order_number: string; lines: unknown; order_type?: string; table_number?: string;
    }>({ order_number: { t: 'string', min: 1 }, lines: { t: 'any' }, order_type: { t: 'string', optional: true },
         table_number: { t: 'string', optional: true } }, payload);
    return { recorded: recordKitchenSend(order_number, lines, { order_type: order_type ?? null, table_number: table_number ?? null }) };
  });

  /**
   * Take sent items back. With 'kitchen_void_approval' a manager approves: a manager signed in on this till as
   * themselves, or a manager's PIN (node → cloud → this till's saved sign-ins, as shift:confirm). Without the switch the
   * cashier may — it is still recorded, and the kitchen still gets the VOID ticket.
   */
  handle('kitchen:void', async (_event, payload) => {
    const p = assertPayload<{ order_number: string; lines: unknown; reason: string; note?: string; cooked?: boolean;
                              pin?: string; order_type?: string; table_number?: string }>({
      order_number: { t: 'string', min: 1 }, lines: { t: 'any' }, reason: { t: 'string', min: 1 },
      note: { t: 'string', optional: true }, cooked: { t: 'boolean', optional: true }, pin: { t: 'string', optional: true },
      order_type: { t: 'string', optional: true }, table_number: { t: 'string', optional: true },
    }, payload);
    let approver: { id: string; name: string | null } | null = null;
    if (getPosFeatures().kitchen_void_approval) {
      const signedIn = signedInConfirmer();
      if (!signedIn && !String(p.pin ?? '').trim()) throw new Error('A manager must approve this. Enter a manager’s PIN.');
      approver = signedIn && !String(p.pin ?? '').trim() ? signedIn : await identifyConfirmer(String(p.pin));
    }
    const v = recordKitchenVoid(p, approver);
    // The VOID ticket: the same stations the items went to, under a VOID banner, so the kitchen stops cooking them.
    const printed = queueThermal({
      order_number: p.order_number, order_type: p.order_type ?? 'retail', table_number: p.table_number,
      items: v.lines.map((l) => (l.item && typeof l.item === 'object')
        ? { ...(l.item as object), quantity: l.qty, lineTotal: l.unit_price * l.qty }
        : { product: { id: l.product_id, name: l.product_name }, quantity: l.qty, unitPrice: l.unit_price,
            lineTotal: l.unit_price * l.qty, selectedVariants: [], selectedModifiers: [] }),
      kitchen_void: { by: approver?.name ?? '', reason: voidReasonLabel(v.reason) },
    }, ['kitchen', 'dispatch']);
    logLine('sale', `kitchen void #${p.order_number} ${v.lines.map((l) => `${l.qty}x ${l.product_name}`).join(', ')} ` +
      `${v.total} — ${v.reason}${v.cooked ? ' (cooked)' : ''}${approver ? ` approved by ${approver.name ?? approver.id}` : ''}`);
    pushNow();
    return { ok: true, total: v.total, approvedBy: approver?.name ?? null,
             skipped: [...printed.skipped, ...printed.failed.map((f) => `${f} (could not be produced)`)] };
  });

  /** Sent orders not yet paid: `shift` — this shift's (End Shift lists them); `all` — every one (recovery). */
  handle('kitchen:open', async () => {
    const shiftId = getOpenShift()?.id ?? null;
    return { all: openKitchenOrders(), shift: shiftId ? openKitchenOrders(shiftId) : [] };
  });

  handle('shift:zreport', async (_event, shiftId: string) => {
    return computeZReport(shiftId, await fetchForeignCash(shiftId));   // A334
  });

  // 0.6.11 (owner: "I should be able to print previous shift reports") — this till's shifts, newest first.
  // Each opens through shift:zreport above, which already rebuilds any shift's report from local data.
  handle('shift:history', async () => listShifts(60));

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

  // ── A345: offline sign-ins ─────────────────────────────────────────────────
  // Why the last cloud-owned list could not be read: an offline sign-in, or no connection. null = the last call reached the
  // cloud. Only these two reasons let the Menu / Staff pages fall back to what this till has saved — a refusal (403) or any
  // other answer never does.
  let lastManageFailure: ManageOfflineReason | null = null;

  /** One attempt to turn an offline sign-in into a cloud sign-in (offlineSession.ts). Never throws; bounded to 8 s. */
  async function tryUpgradeOfflineSession() {
    if (!heldOfflinePin()) return 'nothing' as const;
    const outcome = await upgradeOfflineSession({
      currentSession: () => {
        const r = getLocalDb().prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get() as { staff_id: string } | undefined;
        return r ? { staffId: r.staff_id, hasToken: !!readStaffTokens().token } : null;
      },
      verifyAtCloud: async (pin, branchId) => {
        const res = await withinMs(ownerFetch('/api/auth/verify-pin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: verifyPinBody(pin, branchId),
        }), 8_000);
        return { status: res.status, body: await res.json().catch(() => ({})) };
      },
      adopt: (data, branchId) => { persistCloudSignIn(data, branchId); },
      isUnreachableStatus,
      log: (line) => logLine('pin', line),
    }).catch(() => 'unreachable' as const);
    if (outcome === 'upgraded') {
      lastManageFailure = null;
      pullWebSales().catch(() => { /* the 20-s poll retries */ });
    }
    return outcome;
  }
  // The network coming back is not an event the till is told about, so look every 30 s while an offline sign-in is held.
  // Nothing is sent while none is (heldOfflinePin() is checked first). unref: never keeps the app (or a test) alive.
  const offlineUpgradeTimer = setInterval(() => { if (heldOfflinePin()) void tryUpgradeOfflineSession(); }, 30_000);
  (offlineUpgradeTimer as any).unref?.();

  /** Signed in, but offline (no cloud token for the person at the till). */
  function offlineSessionNow(): boolean {
    return !!getLocalDb().prepare(`SELECT 1 FROM staff_session WHERE id=1`).get() && !readStaffTokens().token;
  }

  /** Is the back office's cloud-owned data unreachable for an OFFLINE reason? (The only case the saved lists are shown.) */
  function manageOfflineReason(): { reason: ManageOfflineReason; message: string } | null {
    if (offlineSessionNow()) return { reason: 'offline_session', message: OFFLINE_SESSION_MESSAGE };
    if (lastManageFailure === 'no_connection') return { reason: 'no_connection', message: NO_CONNECTION_MESSAGE };
    return null;
  }

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

  /**
   * The manager-screen fetch: Menu, Staff, Prices, Combos, Receipt, Printers.
   * 35 handlers route through it.
   *
   * ── WHY THE 401 BRANCH EXISTS ──────────────────────────────────────────────
   * The staff ACCESS token lives 15 minutes; its refresh token lives 30 days.
   * This function used to read the access token once and throw on any non-2xx,
   * so the first manager action after fifteen idle minutes produced a 401,
   * humaniseError matched /unauthor/i, and the screen said
   *
   *     "This till was signed out. Ask a manager to sign in again."
   *
   * The till was NOT signed out. The sync engine was refreshing on its own
   * schedule the whole time and selling was unaffected — only the manager
   * screens were, and only because this one function never refreshed. Reported
   * from the field on 0.5.27 (Beryl), on the Menu screen, after idling.
   *
   * ownerFetch has had exactly this branch since it was written. The two
   * builders disagreed about token expiry and nothing compared them — the same
   * seam as A38's two header spellings.
   *
   * refreshStaffToken() is single-flight, so overlapping manager actions await
   * one request rather than presenting the same rotating token twice. That
   * matters: a doubled refresh is what the server's replay detection treats as
   * a stolen token, and it revokes EVERY session for that user.
   *
   * ONE retry, and only on 401. A second 401 after a successful refresh is a
   * real rejection (revoked, deactivated, permissions changed) and must reach
   * the user rather than looping.
   */
  async function manageFetch(path: string, method: string, body?: any) {
    const db = getLocalDb();
    const readToken = () => readStaffTokens().token;

    let token = readToken();
    if (!token) {
      // A345: an OFFLINE sign-in has no cloud token. Try to make it a cloud sign-in now (the network may be back), and if it
      // cannot be, say so — it is NOT "not signed in" (owner's screenshots, v0.6.14 checklist).
      const signedIn = !!db.prepare(`SELECT 1 FROM staff_session WHERE id=1`).get();
      if (!signedIn) throw new Error('Not signed in');
      await tryUpgradeOfflineSession();
      token = readToken();
      if (!token) { lastManageFailure = 'offline_session'; throw new Error(OFFLINE_SESSION_MESSAGE); }
    }

    const call = (t: string) => cloudFetch(`${getCloudUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let res: Response;
    try {
      res = await call(token);

      if (res.status === 401) {
        // Expired, not wrong. refreshStaffToken persists the new pair to
        // SQLite, so read it back rather than assuming what it is — the
        // in-memory copy can lag the disk.
        const refreshed = await refreshStaffToken();
        if (refreshed) {
          const fresh = readToken();
          if (fresh) res = await call(fresh);
        }
      }
    } catch {
      lastManageFailure = 'no_connection';
      throw new Error(NO_CONNECTION_MESSAGE);
    }
    lastManageFailure = null;

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

  handle('manage:listProducts', async () => manageFetch('/api/products', 'GET'));
  handle('manage:createProduct', async (_e, payload: any) => {
    const out = await manageFetch('/api/products', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateProduct', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/products/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });

  handle('manage:listCategories', async () => {
    try { return await manageFetch('/api/categories', 'GET'); }
    catch {
      const db = getLocalDb();
      return db.prepare(`SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order`).all();
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
  handle('manage:listStations', async () => {
    // A411: while routing saved on this till waits for the cloud, this till's own copy is the truth for it.
    if (Object.keys(readPendingRouting(getLocalDb())).length) return withPendingFlags(localStations());
    try { return withPendingFlags(await manageFetch('/api/stations', 'GET')); }
    catch { return withPendingFlags(localStations()); }
  });
  /** A411: mark the stations whose routing is saved here but not yet on the cloud. */
  function withPendingFlags(list: any[]) {
    const pending = readPendingRouting(getLocalDb());
    return (list ?? []).map((st: any) => pending[st.id]
      ? { ...st, category_ids: pending[st.id].category_ids, pending_sync: true } : st);
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
    const out = await manageFetch('/api/payment-methods', 'POST', payload);
    await refreshPaymentMethodsLocal();
    return out;
  });
  handle('manage:updatePaymentMethod', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/payment-methods/${id}`, 'PATCH', patch);
    await refreshPaymentMethodsLocal();
    return out;
  });
  handle('manage:deletePaymentMethod', async (_e, id: string) => {
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
  handle('manage:createStation', async (_e, payload: any) => {
    const out = await manageFetch('/api/stations', 'POST', payload);
    await refreshStationsLocal();
    return out;
  });
  // One-click day-one seed: Kitchen + Packing + Till, categories routed by
  // is_kitchen server-side (A92). Refresh the local station cache so routing
  // works on this terminal immediately.
  handle('manage:seedDefaultStations', async () => {
    const out = await manageFetch('/api/stations/seed-defaults', 'POST', {});
    await refreshStationsLocal();
    return out;
  });
  handle('manage:updateStation', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/stations/${id}`, 'PATCH', patch);
    await refreshStationsLocal();
    return out;
  });
  handle('manage:deleteStation', async (_e, id: string) => {
    const out = await manageFetch(`/api/stations/${id}`, 'DELETE');
    await refreshStationsLocal();
    return out;
  });
  // A411: saved on this till first (tickets print the new way at once, online or not), then sent to the cloud — now if
  // it can be reached (through the branch server on a peer, A410), else at the next sync. See stationRouting.ts.
  handle('manage:setStationCategories', async (_e, { id, categoryIds }: { id: string; categoryIds: string[] }) => {
    const db = getLocalDb();
    const staff = db.prepare(`SELECT staff_name, role_name, permissions FROM staff_session WHERE id = 1`).get() as
      { staff_name: string; role_name: string | null; permissions: string } | undefined;
    if (!staff) throw new Error('Not signed in');
    if (!mayRoute(staff.role_name, staff.permissions)) throw new Error('Your role does not allow this change.');
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

  handle('manage:createCategory', async (_e, payload: any) => {
    const out = await manageFetch('/api/categories', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateCategory', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/categories/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });

  // Combos. The till sells a combo as one line; these define what the dispatcher
  // and kitchen tickets expand it into.
  // Bulk product import. The server maps category_name to EXISTING categories
  // and silently writes null when there is no match, so the UI creates any
  // missing categories first and only then calls this.
  handle('manage:bulkProducts', async (_e, rows: any[]) => {
    const out = await manageFetch('/api/products/bulk', 'POST', { rows });
    await refreshCatalogue();
    return out;
  });

  handle('manage:listCombos', async () => manageFetch('/api/combos', 'GET'));
  handle('manage:createCombo', async (_e, payload: any) => {
    const out = await manageFetch('/api/combos', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateCombo', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/combos/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:setComboItems', async (_e, { id, items }: { id: string; items: any[] }) => {
    const out = await manageFetch(`/api/combos/${id}/items`, 'PUT', { items });
    await refreshCatalogue();
    return out;
  });

  // Variants — the Spice group and anything else a product needs choosing.
  handle('manage:listVariantGroups', async (_e, productId: string) =>
    manageFetch(`/api/variants/groups?product_id=${encodeURIComponent(productId)}`, 'GET'));
  // Editing a group's kind, and its options. Without these the manager screen can
  // display what migration 45 classified but cannot resolve anything it left as
  // 'review' — which is exactly where a human is needed.
  handle('manage:updateVariantGroup', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/variants/groups/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:createVariantOption', async (_e, payload: any) => {
    const out = await manageFetch('/api/variants/options', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:updateVariantOption', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/variants/options/${id}`, 'PATCH', patch);
    await refreshCatalogue();
    return out;
  });
  handle('manage:deleteVariantOption', async (_e, id: string) => {
    const out = await manageFetch(`/api/variants/options/${id}`, 'DELETE');
    await refreshCatalogue();
    return out;
  });

  handle('manage:createVariantGroup', async (_e, payload: any) => {
    const out = await manageFetch('/api/variants/groups', 'POST', payload);
    await refreshCatalogue();
    return out;
  });
  handle('manage:deleteVariantGroup', async (_e, id: string) => {
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
  handle('manage:listModifierGroups', async (_e, productId: string) =>
    manageFetch(`/api/modifiers/groups?product_id=${encodeURIComponent(productId)}`, 'GET'));
  handle('manage:createModifierGroup', async (_e, payload: any) =>
    manageFetch('/api/modifiers/groups', 'POST', payload));
  handle('manage:deleteModifierGroup', async (_e, id: string) =>
    manageFetch(`/api/modifiers/groups/${id}`, 'DELETE'));

  handle('manage:listStaff', async () => manageFetch('/api/staff', 'GET'));
  handle('manage:listRoles', async () => manageFetch('/api/staff/roles', 'GET'));
  handle('manage:createStaff', async (_e, payload: any) =>
    manageFetch('/api/staff', 'POST', payload));
  handle('manage:updateStaff', async (_e, { id, patch }: { id: string; patch: any }) =>
    manageFetch(`/api/staff/${id}`, 'PATCH', patch));

  handle('manage:getReceiptText', async () => {
    const cfg = getDeviceConfig();
    return { header: cfg?.receipt_header ?? '', footer: cfg?.receipt_footer ?? '' };
  });
  handle('manage:setReceiptText', async (_e, { header, footer }: { header: string; footer: string }) => {
    // The endpoint upserts ONE key/value pair per call — posting an object of
    // keys returns "key and value are required". Two sequential calls.
    await manageFetch('/api/business/settings', 'POST', { key: 'receipt_header', value: header });
    const out = await manageFetch('/api/business/settings', 'POST', { key: 'receipt_footer', value: footer });
    // Cache immediately so the next receipt is right even before a full sync.
    saveDeviceConfig({ receipt_header: header, receipt_footer: footer });
    await refreshCatalogue();
    return out;
  });

  // 24-hour / continuous operation (A104), per business. Read from the cached
  // config; written to business_settings so it reaches every till, and cached
  // locally at once so the day gate honours it before the next sync.
  handle('manage:getContinuousOperation', async () => {
    return { enabled: getDeviceConfig()?.continuous_operation === true };
  });
  handle('manage:setContinuousOperation', async (_e, enabled: boolean) => {
    const out = await manageFetch('/api/business/settings', 'POST', {
      key: 'continuous_operation', value: enabled ? 'true' : 'false',
    });
    saveDeviceConfig({ continuous_operation: !!enabled });
    return out;
  });

  // 0.6.30 (A336 stage 3): the owner's void window and offline void/refund rules, from Manager → Settings. The cloud
  // stores only what the owner sends (routes/business.ts refuses anyone else); this till uses the new value at once.
  handle('manage:setReversalRule', async (_e, payload) => {
    const { key, value } = assertPayload<{ key: string; value: unknown }>({ key: { t: 'string', min: 1 }, value: { t: 'any' } }, payload);
    if (!isReversalSettingKey(key)) throw new Error('Not one of the owner\'s rules.');
    const clean = reversalSettingValue(key, value);
    if (clean === null) throw new Error('That value is not allowed.');
    const out = await manageFetch('/api/business/settings', 'POST', { key, value: JSON.parse(clean) });
    const now = getReversalRules();
    setReversalRules({
      voidWindowMinutes: key === 'void_window_minutes' ? JSON.parse(clean) : now.voidWindowMinutes,
      offlineRefundMethods: key === 'offline_refund_methods' ? JSON.parse(clean) : now.offlineRefundMethods,
      offlineReverseWebSales: key === 'offline_reverse_web_sales' ? JSON.parse(clean) : now.offlineReverseWebSales,
      freeDeliveryAllowed: key === 'delivery_free_allowed' ? JSON.parse(clean) : now.freeDeliveryAllowed,   // 0.6.33
      freeDeliveryOver: key === 'delivery_free_over' ? (JSON.parse(clean) || null) : now.freeDeliveryOver,  // 0.6.33
    });
    return out;
  });

  // 0.6.37 (A387): the payment methods a cashier's History shows, from Manager → Settings. The cloud stores it for the
  // business (settings.manage); this till uses the new list at once, the others on their next pull.
  handle('manage:getCashierHistoryMethods', async () => ({ methods: getCashierHistoryMethods() }));
  handle('manage:setCashierHistoryMethods', async (_e, methods) => {
    const clean = historyMethodsSettingValue(methods);
    if (clean === null) throw new Error('Choose payment methods from the list.');
    const out = await manageFetch('/api/business/settings', 'POST', { key: CASHIER_HISTORY_METHODS_KEY, value: JSON.parse(clean) });
    setCashierHistoryMethods(clean);
    return out;
  });

  // ── Manager dashboard reports (local SQLite — D9 tiered depth) ────────────

  // Range is optional so existing callers keep today's behaviour untouched.
  handle('manager:salesSummary',  async (_e, r?: RangeArg) =>
    getSalesSummary(r ? resolveRange(r.preset, r.from, r.to) : undefined));
  handle('manager:topProducts',   async (_e, r?: RangeArg) =>
    getTopProducts(r?.limit ?? 8, r ? resolveRange(r.preset, r.from, r.to) : undefined));
  // 0.6.27: the POS History — the last 30 sales, narrowed to the signed-in cashier's own when the client has
  // 'cashier_own_history' on (a manager sees all); says whether Reprint is offered ('cashier_no_reprint').
  handle('pos:history', async () => {
    const scope = historyScope();
    if (scope.ownOnly && !scope.staffId) return { scope, orders: [] };
    // 0.6.29 (owner): "it should show everything of the days sales" — today's, all of them (it was the last 30).
    const orders = getRecentOrders(0, resolveRange('today'), scope.ownOnly ? scope.staffId : null);
    // 0.6.37 (A387): a cashier sees only the payment methods the manager chose (a split sale: only its allowed part).
    return { scope, orders: scope.methods.length ? cashierHistoryView(orders as any[], scope.methods) : orders };
  });
  handle('manager:recentOrders',  async (_e, r?: RangeArg) =>
    getRecentOrders(r?.limit ?? 30, r ? resolveRange(r.preset, r.from, r.to) : undefined));

  // Cross-sync stage 1 (2026-09-27): every till's sales at this branch, read from the cloud (owner: "Branch
  // view, read from cloud"). Online only — the caller falls back to this till's own list and says so.
  handle('manager:branchOrders', async (_e, r?: RangeArg) => {
    const cfg = getDeviceConfig();
    const token = readStaffTokens().token ?? readSessionTokens().token;
    if (!token) throw new Error('Not signed in');
    const range = resolveRange(r?.preset ?? 'today', r?.from, r?.to);
    const q = new URLSearchParams({ date_from: range.from, date_to: range.to, limit: '500', status: 'completed' });
    if (cfg?.branch_id) q.set('branch_id', cfg.branch_id);
    const res = await withinMs(cloudFetch(`${getCloudUrl()}/api/orders?${q}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-device-id': cfg?.device_id ?? '' },
    }), 8_000);
    if (!res.ok) throw new Error(`The cloud did not answer (HTTP ${res.status})`);
    const body = await res.json() as { orders?: any[] };
    return cloudBranchOrders(body.orders ?? [], cfg?.device_id ?? null);
  });

  // What the figures cover. Paired with every range query so a till's partial
  // view can never be read as the branch's takings.
  handle('manager:reportScope', async () => getReportScope());
  handle('manager:resolveRange', async (_e, r: RangeArg) =>
    resolveRange(r?.preset, r?.from, r?.to));
  handle('manager:exportCsv', async (_e, req: any) => exportReportCsv(req));
  handle('manager:dailyReport', async (_e, req: any) => exportDailySalesReport(req ?? {}));
  handle('manager:stockLevels',   async () => getStockLevels());
  handle('manager:fuelSales',     async () => getFuelSalesToday());
  handle('manager:pumpStatus',    async () => getPumpStatus());
  handle('manager:tableOccupancy',async () => getTableOccupancy());

  // ── Branch price management (manager = branch authority, local-first) ──────
  handle('manager:priceList',      async () => getPriceList());
  handle('manager:setBranchPrice', async (_e, { product_id, price }) => setBranchPrice(product_id, price));
  handle('manager:clearBranchPrice', async (_e, { product_id }) => clearBranchPrice(product_id));

  // ── Expenses (record petty-cash at the till) ──────────────────────────────

  // List categories from server (online) for the expense form
  handle('expense:categories', async () => {
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) return [];
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    if (!token) return [];
    try {
      const res = await cloudFetch(`${cfg.server_url}/api/expenses/categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  });

  // A341: a manager adds an expense type from the till — saved on the cloud (the dashboard's own route and
  // permission, expenses.manage); manageFetch gives the offline / role messages.
  handle('expense:addCategory', async (_e, { name }: { name: string }) =>
    manageFetch('/api/expenses/categories', 'POST', { name: String(name ?? '').trim() }));

  // Save expense locally (syncs up on next push pass)
  handle('expense:create', async (_event, {
    description, amount, expense_category_id, paid_by, payment_method, category_name, pin,
  }: { description: string; amount: number; expense_category_id?: string; paid_by?: string;
       payment_method?: string; category_name?: string; pin?: string }) => {
    const db = getLocalDb();
    const approver = await payoutApprover(pin);   // 0.6.37 (A388): every expense needs a manager
    const session  = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as any;
    const staff    = db.prepare(`SELECT branch_id, staff_id FROM staff_session WHERE id=1`).get() as any;
    const shift    = db.prepare(`SELECT id FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY created_at DESC LIMIT 1`).get(getDeviceConfig()?.device_id ?? null) as any;

    if (!session?.business_id) throw new Error('No active session');
    if (!staff?.branch_id)     throw new Error('No staff session');

    const id = uuid();   // A179: MUST be a UUID — the cloud expenses.id is uuid; a
                         // prefixed id (exp_…) fails 22P02 and, batched with shifts/
                         // days/floats, blocks ALL of them from syncing.
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO expenses
        (id, business_id, branch_id, expense_category_id, description, amount,
         paid_by, expense_date, shift_id, created_at, device_id, payment_method, expense_type_name,
         approved_by, approved_by_name, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, session.business_id, staff.branch_id,
      expense_category_id ?? null, description, amount,
      paid_by ?? staff.staff_id ?? null,
      now.slice(0, 10), shift?.id ?? null, now,
      // See the note in shiftService.recordFloat: a NULL-attributed row matches
      // nothing under COALESCE(device_id,'') = COALESCE(own,''), so it is never
      // collected by the push and the expense silently never leaves the till.
      getDeviceConfig()?.device_id ?? null,
      // 0.6.27: how it was paid (only cash leaves the drawer) and the type's name (the Z-report shows it, offline too).
      cleanExpenseMethod(payment_method),
      expense_category_id ? (String(category_name ?? '').trim().slice(0, 100) || null) : null,
      approver.id, approver.name,
    );
    logLine('shift', `expense ${Number(amount)} approved by ${approver.name ?? approver.id}`);
    return { id, approvedBy: approver.name };
  });

  // 0.6.11 (owner: "I should be able to see expenses") — the manager's Expenses screen, by date range.
  handle('expense:range', async (_e, r?: RangeArg) => {
    const range = resolveRange(r?.preset ?? 'today', r?.from, r?.to);
    return { ...listExpenses(range.from, range.to), label: range.label };
  });

  // Recent expenses for the current shift (for display in ShiftPanel)
  handle('expense:list', async () => {
    const db = getLocalDb();
    const shift = db.prepare(`SELECT id FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY created_at DESC LIMIT 1`).get(getDeviceConfig()?.device_id ?? null) as any;
    if (!shift) return [];
    return db.prepare(`
      SELECT id, description, amount, expense_category_id, paid_by, created_at, sync_status,
             expense_type_name AS category_name, COALESCE(payment_method, 'cash') AS payment_method
      FROM expenses WHERE shift_id=? ORDER BY created_at DESC
    `).all(shift.id);
  });

  // ── 0.6.30 (A336 stage 3): void / refund while the cloud cannot be reached ─────────────────────────────────────
  // The online path below is tried first; only "could not reach the cloud" (no network, a gateway error, an offline
  // sign-in that cannot become a cloud one) falls through to here. The approver's PIN goes to the branch node first,
  // else this till's saved sign-ins (the A365 chain); the owner's rules decide the rest (offlineReversal.ts).
  const signedInPerson = (): LocalPerson | null => {
    const st = getLocalDb().prepare(`SELECT staff_id, staff_name, role_name, permissions FROM staff_session WHERE id=1`).get() as
      { staff_id: string; staff_name: string; role_name: string | null; permissions: string | null } | undefined;
    return st?.staff_id ? { id: st.staff_id, name: st.staff_name ?? null, roleName: st.role_name, permissions: st.permissions ?? '{}' } : null;
  };
  const NOT_AN_APPROVER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  async function identifyApproverOffline(pin: string): Promise<LocalPerson> {
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? '';
    const asPerson = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }): LocalPerson => {
      const p = { id: staff.staffId, name: staff.name ?? null, roleName: staff.roleName, permissions: staff.permissions };
      if (!mayReverseLocal(p)) throw new Error(NOT_AN_APPROVER);
      return p;
    };
    if (cfg?.node_url && !isNodeRole(cfg?.device_role)) {
      const r = await verifyPinAtNodeClient(pin, branchId);
      if (r.status === 'ok') return asPerson(r.staff);
      if (r.status === 'rejected') throw new Error(NOT_AN_APPROVER);
    }
    if (isNodeRole(cfg?.device_role)) {
      const v = verifyPinAtNode(pin, branchId);
      if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_AN_APPROVER : v.message);
      return asPerson(v.staff);
    }
    const v = verifyPinOffline(pin, branchId);
    if (!v.ok) throw new Error(v.reason === 'no_match' ? NOT_AN_APPROVER : v.message);
    return asPerson(v.staff);
  }
  async function reverseWhileOffline(kind: 'void' | 'refund', orderId: string, reason: string, pin: string | undefined) {
    const actor = signedInPerson();
    const approver = String(pin ?? '').trim()
      ? await identifyApproverOffline(String(pin).trim())
      : (mayReverseLocal(actor) ? actor : null);
    if (!approver) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    const r = reverseOffline({
      kind, orderId: String(orderId), reason: String(reason ?? ''), actor, approver,
      rules: getReversalRules(), deviceId: getDeviceConfig()?.device_id ?? null,
    });
    if (kind === 'void') emitEvent('order_voided', String(orderId), { status: 'voided', voided_at: r.at });
    logLine('sale', `offline ${kind} ${orderId}${kind === 'refund' ? ` ${r.refunded}` : ''} approved by ${approver.name ?? approver.id}`
      + ` — ${String(reason ?? '').slice(0, 120)}`);
    pushNow();
    return { ok: true, offline: true, refunded: r.refunded, approvedBy: approver.name ?? null };
  }
  /** A gateway answer is "the cloud is not there", not the cloud's answer (a 500 may have half-applied — not retried). */
  const cloudUnreachable = (status: number) => status === 502 || status === 503 || status === 504;
  const REVERSE_TIMEOUT_MS = 15_000;

  // ── 0.6.30: the owner's rules, for History's labels and the void/refund window ──
  handle('pos:reversalRules', async () => getReversalRules());

  // ── 0.6.35 (A384): the Help screen — who to call (the shop's tech, or SwiftPOS support) and which till this is ──
  // Offline, before anyone signs in (the PIN pad has Help: a locked-out cashier needs it most).
  handle('pos:help', async () => {
    const cfg = getDeviceConfig();
    return {
      contact: getSupportContact(),
      till: cfg?.terminal_code || cfg?.device_name || null,
      version: app.getVersion(),
    };
  });

  // ── Order void (manager/supervisor only — server enforces permission) ──────
  handle('order:void', async (_event, payload) => {
    // D7: the void identifier and reason must be present and well-typed before we
    // build a request from them; the approval PINs are optional.
    const { orderId, reason, supervisor_pin, override_pin, authorizer_id } =
      assertPayload<{ orderId: string; reason: string; supervisor_pin?: string; override_pin?: string; authorizer_id?: string }>(
        {
          orderId:        { t: 'string', min: 1 },
          reason:         { t: 'string' },
          supervisor_pin: { t: 'string', optional: true },
          override_pin:   { t: 'string', optional: true },
          authorizer_id:  { t: 'string', optional: true },
        }, payload);
    const db = getLocalDb();
    // Get server URL + best available auth token
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    // A345: an offline sign-in has no cloud token yet — make it a cloud sign-in first if the network is back.
    if (!readStaffTokens().token) await tryUpgradeOfflineSession();
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    const approvalPin = override_pin ?? supervisor_pin;
    // 0.6.30: an offline sign-in that cannot become a cloud one yet — void here, by the owner's offline rules.
    if (!token) {
      if (offlineSessionNow()) return reverseWhileOffline('void', String(orderId), reason, approvalPin);
      throw new Error('Not signed in');
    }

    let res: Response;
    try {
      res = await cloudFetch(`${cfg.server_url}/api/orders/${orderId}/void`, {
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
        signal: AbortSignal.timeout(REVERSE_TIMEOUT_MS),
      });
    } catch {
      return reverseWhileOffline('void', String(orderId), reason, approvalPin);   // 0.6.30: the cloud is not there
    }
    if (cloudUnreachable(res.status)) return reverseWhileOffline('void', String(orderId), reason, approvalPin);
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
    reverseRiderPayout(String(orderId), db);   // 0.6.27: a voided delivery's rider pay-out goes back in
    // Phase 2b: without the event, every replica of this order stays
    // 'completed' and the branch revenue on other tills counts a voided sale.
    emitEvent('order_voided', String(orderId), { status: 'voided', voided_at: voidedAt });
    logLine('sale', `void ${orderId}${reason ? ` — ${String(reason).slice(0, 120)}` : ''}`);
    return { ok: true };
  });

  // Refund a completed sale (audit M3). Money leaving the drawer needs a manager's authorisation. 0.6.30: offline too
  // now — the till checks the approver's PIN (node, else its saved sign-ins) and the owner's offline rules
  // (reverseWhileOffline above); online, the cloud decides as before.
  handle('order:refund', async (_event, { orderId, reason, override_pin, authorizer_id }:
    { orderId: string; reason: string; override_pin?: string; authorizer_id?: string }) => {
    const cfg = getDeviceConfig();
    if (!cfg?.server_url) throw new Error('Device not configured');
    // A345: an offline sign-in has no cloud token yet — make it a cloud sign-in first if the network is back.
    if (!readStaffTokens().token) await tryUpgradeOfflineSession();
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
    const token = staffRow?.token ?? ownerRow?.token;
    // 0.6.30: an offline sign-in that cannot become a cloud one yet — refund here, by the owner's offline rules.
    if (!token) {
      if (offlineSessionNow()) return reverseWhileOffline('refund', String(orderId), reason, override_pin);
      throw new Error('Not signed in');
    }

    let res: Response;
    try {
      res = await cloudFetch(`${cfg.server_url}/api/orders/${orderId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reason,
          ...(override_pin  ? { override_pin }  : {}),
          ...(authorizer_id ? { authorizer_id } : {}),
        }),
        signal: AbortSignal.timeout(REVERSE_TIMEOUT_MS),
      });
    } catch {
      return reverseWhileOffline('refund', String(orderId), reason, override_pin);   // 0.6.30: the cloud is not there
    }
    if (cloudUnreachable(res.status)) return reverseWhileOffline('refund', String(orderId), reason, override_pin);
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
    // 0.6.26: skipped when the web-sales pull already stored the cloud's copy of this refund (mirrorTillRefund).
    const legs: Array<{ method: string; amount: number }> = Array.isArray(data?.byMethod) ? data.byMethod : [];
    mirrorTillRefund(String(orderId), legs, Number(data?.refunded) || 0, String(reason ?? ''));

    logLine('sale', `refund ${orderId} ${Number(data?.refunded) || 0}`
      + `${reason ? ` — ${String(reason).slice(0, 120)}` : ''}`);
    return { ok: true, refunded: Number(data?.refunded) || 0 };
  });

  // ── Tech access ────────────────────────────────────────────────────────────
  // Reveal code check (doorknock) — opens the token prompt. Grants nothing.
  handle('tech:checkReveal', async (_event, code: string) => {
    const ok = checkRevealCode(code);
    return { ok };
  });

  // Verify the Ed25519 token OFFLINE and open a 4-hour active session.
  handle('tech:openSession', async (_event, token: string) => {
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
  handle('tech:adoptFromNode', async () => {
    const existing = getActiveSession();
    if (existing) return { ok: true, session: existing };
    const token = await fetchNodeTechToken().catch(() => null);
    if (!token) return { ok: false };
    const result = openTechSession(token);
    return result.ok ? { ok: true, session: result.session } : { ok: false };
  });

  handle('tech:getSession', async () => getActiveSession());

  handle('tech:closeSession', async () => { closeTechSession(); return { ok: true }; });

  handle('tech:logAction', async (_event, { action, detail }: { action: string; detail?: any }) => {
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
  handle('tech:promoteToNode', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    const before = getDeviceConfig()?.device_role ?? 'till';
    // A22 — split-brain guard. Promoting clears node_url and starts serving; if the
    // CURRENT branch server is still reachable, promoting now would put two nodes on
    // one branch (the classic case: an old node merely unplugged, then reconnected).
    // There is no legitimate reason to promote while the old node still answers, so
    // refuse loudly and tell the tech to demote/disconnect it first. (A reconnect
    // AFTER promotion is caught server-side: confirmServingRole records the conflict
    // and the fleet view flags it.)
    const currentNodeUrl = getDeviceConfig()?.node_url ?? null;
    if (currentNodeUrl) {
      const probe = await probeNode(currentNodeUrl);
      if (probe.ok) {
        return {
          ok: false,
          code: 'node_reachable',
          error: `The current branch server at ${currentNodeUrl} is still reachable. ` +
                 `Promoting now would put TWO servers on this branch (split-brain). ` +
                 `Demote or disconnect it first, then promote.`,
        };
      }
    }
    // A20 backstop: pull a fresh roster from the CURRENT node before we stop being
    // a peer, so the promoted node can authenticate cashiers the instant it serves.
    // Best-effort and guarded (unpackRosterSnapshot refuses an empty/pinless pull,
    // so this can only ever ADD a current roster, never wipe one). Must run BEFORE
    // the role flip — a node has no node_url to pull from. A peer that was
    // replicating already holds the roster via sync; this guarantees it's current.
    try {
      const snapshot = await fetchRosterFromNode();
      if (snapshot) {
        const d = unpackRosterSnapshot(snapshot);
        if (d.apply) storeBranchStaff(d.branchId, d.roster);
      }
    } catch { /* promotion proceeds; the node refreshes the roster on its own cloud sync */ }
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
  // Repoint this till at a (new) branch server. Probe BEFORE save — a wrong
  // address written blind is a till that silently stops replicating. Also the
  // demotion path: a former node repointed at the new one becomes a till again.
  //
  // A21 — WHY THE OUTBOX CURSORS ARE RESET WHEN THE ADDRESS CHANGES.
  // `outbox_cursors` is keyed by table_name ALONE and carries no node identity,
  // while `peer_cursors` on the node side is keyed (device_id, table_name).
  // That asymmetry only shows on failover, and then it loses rows: a peer that
  // offered orders to seq 500 to the OLD node, which distributed only to 430
  // before dying, will never re-offer 431-500 to its replacement. Those sales
  // sit on this till and on a dead machine's disk, absent from the new source of
  // truth, the day close and the cloud, with nothing reporting a gap.
  //
  // Re-offering is free: ingest is INSERT OR IGNORE on stable client UUIDs with
  // origin device_id and seq preserved end to end, so anything the new node
  // already holds is recognised and ignored rather than duplicated.
  //
  // Only on an ACTUAL change — re-entering the same address must not trigger a
  // full re-offer.
  handle('tech:setNodeUrl', async (_e, { url }: { url: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    const probe = await probeNode(String(url ?? ''));
    if (!probe.ok) return { ok: false, error: probe.error };
    const was = getDeviceConfig()?.device_role ?? 'till';
    logTechAction('role.repoint', { from: was, node_url: url });
    const previousUrl = getDeviceConfig()?.node_url ?? null;
    const nextUrl     = String(url);
    const nodeChanged = previousUrl !== nextUrl;
    if (was === 'node') stopNodeServer();   // stepping down: stop serving first
    saveDeviceConfig({ node_url: nextUrl, device_role: was === 'node' ? 'till' : was });
    if (nodeChanged) {
      // A21 — see the note above. Audited as its own action rather than folded
      // into role.repoint: re-offering the whole outbox is a distinct, visible
      // event, and a tech reading the log should see it named.
      resetOutboxCursors();
      logTechAction('node.reoffer', { from: previousUrl, to: nextUrl });
      logLine('node', `node changed ${previousUrl ?? '(none)'} -> ${nextUrl}; outbox cursors reset so every row is re-offered`);
    }
    return { ok: true, role: was === 'node' ? 'till' : was, reoffering: nodeChanged };
  });

  handle('tech:backupNow', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('backup.manual', {});
    return await takeSnapshot();
  });

  handle('tech:maintenance', async () => maintenanceStatus());

  handle('tech:query', async (_event, { sql }: { sql: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('db_query', { sql: String(sql ?? '').slice(0, 2000) });
    return runTechQuery(sql);
  });

  // Local, offline-safe diagnostics for the tech screen.
  handle('tech:status', async () => {
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
      sync: { online: sync.online, pending: sync.pendingCount, failed: sync.failedCount, lastOrder, breakdown: sync.pendingBreakdown },
      build: getBuildInfo(),
    };
  });

  // A178: a REAL reachability probe — reaches the configured server and reports
  // the round-trip, unlike the "ONLINE" badge which is only net.isOnline().
  handle('tech:testConnection', async () => {
    return testConnection();
  });

  // A178: tail the durable log so a tech can read it on the device without
  // hunting for %APPDATA%. Read-only; last N lines; never exposes tokens because
  // the log itself never records them.
  handle('tech:logTail', async (_event, arg?: { lines?: number }) => {
    const lines = Math.min(Math.max(arg?.lines ?? 200, 1), 2000);
    try {
      const p = getSyncStatus().logPath;
      if (!p || !fs.existsSync(p)) return { path: p ?? null, text: '' };
      const all = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      return { path: p, text: all.slice(-lines).join('\n') };
    } catch (err: any) {
      return { path: null, text: `could not read log: ${err?.message ?? err}` };
    }
  });

  // ── Manager branch-wide report ──────────────────────────────────────────────
  // Any till can see ALL the branch's tills' data by reading from the aggregation
  // node. If the node is unreachable (or this device has none) it falls back to
  // this machine's own local data, flagged so the UI can say so.
  handle('manager:branchReport', async () => {
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
