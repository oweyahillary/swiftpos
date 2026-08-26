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

import { app, ipcMain, net } from 'electron';
import { isNodeRole, ensureNodeSecret } from './deviceConfig';
import { printSale, escposEnabled, setEscposEnabled, kitchenExclusions, kitchenExclusionsState, setKitchenExclusions, clearKitchenExclusionsOverride } from './escposBridge';
import { expectStringArray, assertPayload } from './ipcValidate';
import { printerShares } from './printService';
import { kitchenPreset, dispatchPreset, receiptPreset } from '@swiftpos/printing';
import { assignments } from './print/printWorker';
import { getLocalDb, getDbPath, closeLocalDb } from './localDb';
import { logLine } from './logFile';
import { readSessionTokens, readStaffTokens, writeSessionTokens, writeStaffTokens } from './tokenStore';
import { cacheStaffCredential, verifyPinOffline, clearPinCache } from './pinCache';
import { setIdleSurface, clearIdleLock, suppressIdleLock } from './idleMonitor';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { configureSyncEngine, configureStaffSession, syncAll, syncPush, retryFailedOrders, getSyncStatus, createLocalOrder, refreshAccessToken, refreshStaffToken } from './syncEngine';
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
import { emitEvent, resetOutboxCursors } from './nodeIngest';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy, getPriceList, setBranchPrice, clearBranchPrice } from './managerReports';
import { listPrinters, printHtmlSilent, openPrintPreview, probePrinter, probeGeometry } from './printService';
import { refreshTechConfig, checkRevealCode, openTechSession, getActiveSession, closeTechSession, logTechAction, flushTechAudit, runTechQuery, closeTechReadonlyDb, getRawTechToken } from './techService';
import { hasNode, isNodeReachable, fetchNodeReport, broadcastTechToken, fetchNodeTechToken, probeNode, verifyPinAtNodeClient, fetchRosterFromNode } from './nodeClient';
import { isUnreachableStatus } from './authTransport';
import { verifyPinAtNode, storeBranchStaff } from './branchStaff';
import { unpackRosterSnapshot } from './rosterSnapshot';
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
  ipcMain.handle('auth:enrolDevice', async (_event, payload) => {
    // D7: both credentials must be present and non-empty before we call the server.
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    const res = await fetch(`${getServerUrl()}/api/auth/enrol/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: String(business_id ?? '').trim(),
        code:        String(code ?? '').trim(),
        // Same stable per-install device_id the login path sends, so the server
        // records THIS terminal and tells it apart from the rest of the fleet.
        device_id:   getDeviceConfig()?.device_id ?? undefined,
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

    if (data.business?.type) saveDeviceConfig({ business_type: String(data.business.type) });

    configureSyncEngine(getServerUrl(), data.token, data.refreshToken ?? '');
    refreshTechConfig(data.token).catch(() => {});
    await syncAll().catch(console.error);

    return { user: data.user, business: data.business, branchId: data.branchId ?? null };
  });

  ipcMain.handle('auth:logout', async () => {
    const db = getLocalDb();
    clearCatalogue(db);
    db.prepare(`DELETE FROM staff_session WHERE id=1`).run();
    db.prepare(`DELETE FROM session WHERE id=1`).run();
    // Signing the terminal out must also remove the offline way in, or a
    // decommissioned till keeps working credentials for another fortnight.
    clearPinCache();
    configureStaffSession('', '');
    configureSyncEngine(getServerUrl(), '');
    return true;
  });

  ipcMain.handle('auth:getSession', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
    if (!session) return null;

    // Re-hydrate sync engine in case app was restarted. Credentials are wrapped
    // at rest (D5), so they come from the store rather than off the row.
    const sessTok = readSessionTokens();
    configureSyncEngine(getServerUrl(), sessTok.token, sessTok.refreshToken);

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

  ipcMain.handle('held:list', async () => listHeld());

  ipcMain.handle('held:hold', async (_event, order: any) => {
    const db = getLocalDb();
    const held = {
      id: `held_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      heldAt: new Date().toISOString(),
      ...order,
    };
    db.prepare(`
      INSERT INTO held_orders (id, order_number, label, order_type, table_number, delivery_person, cart, held_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      held.id, held.orderNumber, held.label, held.orderType,
      held.tableNumber ?? '', held.deliveryPerson ?? null,
      JSON.stringify(held.cart ?? []), held.heldAt,
    );
    return { ...held, cart: held.cart ?? [] };
  });

  // Recall hands the tab back AND removes it, in one transaction. Read-then-
  // delete as two statements can hand the same tab to two recalls if the second
  // lands between them — two carts, one order number, one of them unbilled.
  ipcMain.handle('held:recall', async (_event, { id }: { id: string }) => {
    const db = getLocalDb();
    const take = db.transaction((tabId: string) => {
      const row = db.prepare(`SELECT * FROM held_orders WHERE id = ?`).get(tabId) as HeldRow | undefined;
      if (!row) return null;
      db.prepare(`DELETE FROM held_orders WHERE id = ?`).run(tabId);
      return toHeld(row);
    });
    return take(id);
  });

  ipcMain.handle('held:delete', async (_event, { id }: { id: string }) => {
    getLocalDb().prepare(`DELETE FROM held_orders WHERE id = ?`).run(id);
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
  ipcMain.handle('held:import', async (_event, { orders }: { orders: any[] }) => {
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

    const call = (t: string) => fetch(`${getServerUrl()}${path}`, {
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

  ipcMain.handle('auth:listBranches', async () => {
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

  ipcMain.handle('auth:verifyPin', async (_event, payload) => {
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
      return {
        staff: { id: staff.staffId, name: staff.name, role: staff.roleName },
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
    if (!res.ok) throw new Error(data.error ?? 'Invalid PIN');

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

  // ── Idle lock (A52) ────────────────────────────────────────────────────────
  // Suppression tokens are handed out rather than exposing the release closure,
  // because a renderer that reloads mid-print would otherwise strand a
  // suppression forever and the till would never lock again. Tokens are held
  // here, in the process that owns the counter.
  const _idleReleases = new Map<number, () => void>();
  let _idleToken = 0;

  ipcMain.handle('idle:setSurface', async (_e, surface: 'manager' | 'pos' | null) => {
    setIdleSurface(surface);
    return true;
  });
  ipcMain.handle('idle:clear', async () => { clearIdleLock(); return true; });
  ipcMain.handle('idle:suppress', async () => {
    const token = ++_idleToken;
    _idleReleases.set(token, suppressIdleLock());
    return token;
  });
  ipcMain.handle('idle:release', async (_e, token: number) => {
    const release = _idleReleases.get(token);
    if (!release) return false;   // already released, or never issued
    release();
    _idleReleases.delete(token);
    return true;
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
  ipcMain.handle('pos:paymentMethods', async () => {
    // Custom tenders cached from the last pull (A96). Available offline.
    return getLocalDb().prepare(
      `SELECT code, name FROM payment_methods ORDER BY sort_order, name`
    ).all();
  });

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
    // The receipt's header line 2 ("Juja — Till 1") wants the branch by NAME.
    const branchName = branch?.id
      ? ((db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branch.id) as any)?.name ?? null)
      : null;

    const shaped = products.map((p: any) => ({
      ...p,
      has_variants: p.has_variants === 1,
      has_modifiers: p.has_modifiers === 1,
      track_stock: p.track_stock === 1,
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
  ): { skipped: string[] } {
    try {
      if (!escposEnabled()) return { skipped: [] };

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
          cart:           payload.items ?? [],
          payments:       payload.payments ?? [],
          changeGiven:    Number(payload.change_given ?? 0),
          total:          Number(payload.total ?? 0),
          // "How many kitchen tickets did this order produce" — the number the
          // expeditor counts against what arrives at the pass. Counted from
          // stations that will ACTUALLY print here; a station with no printer
          // on this terminal produces no ticket. Receipts are not KOTs.
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
          footerCredit:    'Powered by SwiftPOS',
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

      return { skipped: saleResult?.skipped ?? [] };
    } catch (e) {
      console.error('[escpos] queueing tickets failed (non-blocking):', e);
      // NEVER THROWS — it runs after the money is taken. An empty list is not a
      // claim that everything printed; the console line above is the record.
      return { skipped: [] };
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
  ipcMain.handle('escpos:kitchenExclusions', () => {
    try { return kitchenExclusionsState(); }
    catch { return { terms: [] as string[], source: 'cloud' as const, cloudTerms: [] as string[] }; }
  });

  /**
   * Set this terminal's local override. Available on any till — a cloud till may
   * still override the business default for its own printer, and the override
   * survives every catalogue pull. See escposBridge.setKitchenExclusions.
   */
  ipcMain.handle('escpos:setKitchenExclusions', (_e, terms: unknown) => {
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
  ipcMain.handle('escpos:clearKitchenExclusions', () => {
    try { return { ok: true, terms: clearKitchenExclusionsOverride() }; }
    catch { return { ok: false, error: 'write failed', terms: kitchenExclusions() }; }
  });

  ipcMain.handle('escpos:printProduction', (_e, payload: any) => {
    // `skipped` reaches the renderer so the cashier is told which station
    // produced nothing. Previously this returned a bare { ok: true } and the
    // information was discarded here — D8.
    const { skipped } = queueThermal(payload, ['kitchen', 'dispatch']);
    return { ok: true, skipped };
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

  ipcMain.handle('escpos:reprintReceipt', () => {
    if (!lastOrderPayload) return { ok: false, error: 'nothing to reprint' };
    reprintCount += 1;
    // Marked as a duplicate on the paper itself. An unmarked second copy of a
    // receipt is the thing an auditor cannot tell from a second sale.
    queueThermal(lastOrderPayload, ['receipt'], { at: new Date(), count: reprintCount });
    return { ok: true };
  });

  // Reprint any recent order from Order History (A94). Replays the stored payload
  // through the same path as the original — byte-identical, marked "Duplicate
  // Print". Only orders created on THIS terminal (after the feature shipped) have
  // a stored payload; anything else reports honestly rather than printing wrong.
  ipcMain.handle('escpos:reprintReceiptForOrder', (_e, orderId: string) => {
    const row = getLocalDb()
      .prepare('SELECT payload FROM receipt_payloads WHERE order_id = ?')
      .get(orderId) as { payload?: string } | undefined;
    if (!row?.payload) {
      return { ok: false, error: 'No stored receipt for this order on this terminal.' };
    }
    try {
      queueThermal(JSON.parse(row.payload), ['receipt'], { at: new Date(), count: 1 });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not rebuild this receipt.' };
    }
  });

  ipcMain.handle('order:create', async (_event, orderPayload: any) => {
    const orderId = createLocalOrder(orderPayload);
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
    queueThermal(
      orderPayload,
      orderPayload?.kot_sent ? ['receipt'] : ['kitchen', 'dispatch', 'receipt'],
    );

    return { orderId };
  });

  // ── Printing (native — replaces QZ Tray on the desktop) ──

  ipcMain.handle('print:list', async () => {
    return await listPrinters();
  });

  /**
   * Which printers are SHARED, and under what name.
   *
   * The Printers screen needs this to build a working \\localhost\<share>
   * target. Without it the picker guessed the printer's own name, which is a
   * different field and is absent entirely on a printer nobody has shared.
   */
  ipcMain.handle('print:shares', async () => await printerShares());

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
    if (!token) throw new Error('Not signed in');

    const call = (t: string) => fetch(`${getServerUrl()}${path}`, {
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

  ipcMain.handle('manage:listCategories', async () => {
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
  ipcMain.handle('manage:listStations', async () => {
    try { return await manageFetch('/api/stations', 'GET'); }
    catch { return localStations(); }
  });

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
  ipcMain.handle('manage:listPaymentMethods', async () => manageFetch('/api/payment-methods', 'GET'));
  ipcMain.handle('manage:createPaymentMethod', async (_e, payload: any) => {
    const out = await manageFetch('/api/payment-methods', 'POST', payload);
    await refreshPaymentMethodsLocal();
    return out;
  });
  ipcMain.handle('manage:updatePaymentMethod', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/payment-methods/${id}`, 'PATCH', patch);
    await refreshPaymentMethodsLocal();
    return out;
  });
  ipcMain.handle('manage:deletePaymentMethod', async (_e, id: string) => {
    const out = await manageFetch(`/api/payment-methods/${id}`, 'DELETE');
    await refreshPaymentMethodsLocal();
    return out;
  });
  ipcMain.handle('manage:unassignedCategories', async () => {
    try { return await manageFetch('/api/stations/unassigned', 'GET'); }
    catch {
      const db = getLocalDb();
      return (db.prepare(`
        SELECT c.id, c.name FROM categories c
         WHERE c.status = 'active'
           AND c.id NOT IN (SELECT category_id FROM category_stations)
         ORDER BY c.name`).all() as any[]);
    }
  });
  ipcMain.handle('manage:createStation', async (_e, payload: any) => {
    const out = await manageFetch('/api/stations', 'POST', payload);
    await refreshStationsLocal();
    return out;
  });
  // One-click day-one seed: Kitchen + Packing + Till, categories routed by
  // is_kitchen server-side (A92). Refresh the local station cache so routing
  // works on this terminal immediately.
  ipcMain.handle('manage:seedDefaultStations', async () => {
    const out = await manageFetch('/api/stations/seed-defaults', 'POST', {});
    await refreshStationsLocal();
    return out;
  });
  ipcMain.handle('manage:updateStation', async (_e, { id, patch }: { id: string; patch: any }) => {
    const out = await manageFetch(`/api/stations/${id}`, 'PATCH', patch);
    await refreshStationsLocal();
    return out;
  });
  ipcMain.handle('manage:deleteStation', async (_e, id: string) => {
    const out = await manageFetch(`/api/stations/${id}`, 'DELETE');
    await refreshStationsLocal();
    return out;
  });
  ipcMain.handle('manage:setStationCategories', async (_e, { id, categoryIds }: { id: string; categoryIds: string[] }) => {
    const out = await manageFetch(`/api/stations/${id}/categories`, 'PUT', { category_ids: categoryIds });
    await refreshStationsLocal();
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

  // 24-hour / continuous operation (A104), per business. Read from the cached
  // config; written to business_settings so it reaches every till, and cached
  // locally at once so the day gate honours it before the next sync.
  ipcMain.handle('manage:getContinuousOperation', async () => {
    return { enabled: getDeviceConfig()?.continuous_operation === true };
  });
  ipcMain.handle('manage:setContinuousOperation', async (_e, enabled: boolean) => {
    const out = await manageFetch('/api/business/settings', 'POST', {
      key: 'continuous_operation', value: enabled ? 'true' : 'false',
    });
    saveDeviceConfig({ continuous_operation: !!enabled });
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
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
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
  ipcMain.handle('order:void', async (_event, payload) => {
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
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
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
    const staffRow = { token: readStaffTokens().token };
    const ownerRow = { token: readSessionTokens().token };
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
  ipcMain.handle('tech:setNodeUrl', async (_e, { url }: { url: string }) => {
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
