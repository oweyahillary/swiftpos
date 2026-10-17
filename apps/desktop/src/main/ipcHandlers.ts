// IPC Handlers — registered in main process, called from renderer via preload.ts
//
// Channels:
//   auth:enrolDevice   → POST /api/auth/enrol/redeem, store session in SQLite
//                        (owner email/password login RETIRED — A158)
//   auth:getSession   → return current session row
//   pos:init          → return products + categories + branchId from SQLite
//   pos:getVariants   → return variant groups + options for a product
//   pos:getModifiers  → return modifier groups + options for a product
//   order:create      → write order to SQLite + enqueue for sync
//   sync:trigger      → run syncAll()
//   sync:status       → return { online, pendingCount }

import { offeredVersion, shareDir, shareProgress, tillVersions } from './updateShare';   // A443, A496
import { cleanOffer, type Offer } from './offers';   // A445
import { getMacAddressCached, identityHeaders } from './machineFingerprint';
import { app, ipcMain, net, dialog, BrowserWindow } from 'electron';
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
import { getUpdateDiagnostics, getUpdateStatus, installUpdateNow } from './autoUpdate';
import { noteActivity, noteRendererPing } from './activityTracker';   // A508
import { logLine, authLog, getLogPath, getAuthLogPath, KEEP_FILES, AUTH_KEEP_FILES } from './logFile';
import { buildSupportText, packSupportText, readLogFiles, rolledPaths, sendVerdict, syncSummary, type SupportHeader } from './supportLogs';   // A519
import { readSessionTokens, readStaffTokens, writeSessionTokens, writeStaffTokens, writeDeviceSecret } from './tokenStore';
import { getReceiptPay, setReceiptPay } from './receiptPay';   // A450 (+ A492: set from the till)
import { isSessionRefusal } from './sessionRecovery';   // A407
import { cloudFetch, nodeRefusal } from './cloudGateway';   // A410: a till on a branch reaches the cloud only through its branch server
import { saveRoutingLocally, overlayPending, readPending as readPendingRouting, mayRoute } from './stationRouting';   // A411
import { mayWaste, recordingProblem, queueRecording, readPending as readPendingWaste, readRefused as readRefusedWaste, dismissRefused, ITEMS_KEY as WASTE_ITEMS_KEY, type WasteItem } from './tillWastage';   // A414
import { cacheStaffCredential, verifyPinOffline } from './pinCache';
import { assertPinAllowed, recordPinFailure, notePinSuccess, PIN_CLOUD_BUSY } from './pinAttempts';   // A494: one limiter for every local PIN check
import { applyOffers } from './offers';   // A494: the offer discount a sale claims, re-checked on the till's own offers
import { setIdleSurface, clearIdleLock, suppressIdleLock } from './idleMonitor';
import { preloadAnswer, startupSettled, lastStartupLine } from './lowImpactStart';   // A517, A519
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';   // A516
import { tillSessionRefusedRecently, resetRenewalGate, configureSyncEngine, configureStaffSession, syncAll, syncPush, pushStationRoutingNow, pushWastageNow, retryFailedOrders, getSyncStatus, createLocalOrder, replicateToNode, refreshAccessToken, refreshStaffToken, testConnection, pullWebSales, getOpenShift, queueBrandingPush, learnBeforeLock } from './syncEngine';   // A523: learnBeforeLock
import { tillBranchId } from './deviceConfig';   // A446
import { MONEY_MOVEMENT_MANAGER_ONLY } from './posFeatures';   // A453
import { signedIn as sessionPerson, signedInCan, personCan, personKeys, backOffice as personBackOffice, mayMoveMoney, roleCeilingRefusal, roleMap, mayActOn, hasMarker, isOwnerRole, type PersonLike } from './tillAccess';   // A490: the till's one rule
import { maySetMpesa } from './permissions';   // A492
import { cleanMpesaReceive, mpesaLabel, mpesaReceiptNumber, type MpesaReceive } from './mpesaReceive';   // A492
import { getCloudUrl, getDeviceConfig, saveDeviceConfig, isConfigured, clearDeviceConfig, getPosFeatures, getReversalRules, setReversalRules, getSupportContact, getCashierHistoryMethods, setCashierHistoryMethods, getStockCountFreeze, getPaymentMethodsEnabled, setPaymentMethodsEnabled } from './deviceConfig';
import { isReversalSettingKey, reversalSettingValue } from './reversalRules';
import { reverseOffline, mayReverseLocal, type LocalPerson } from './offlineReversal';
import { parseNotePicks, cleanNote, ORDER_NOTE_MAX } from './orderNotes';
import { openShift, addFloat, recordExpense, closeShift, currentShiftReport, computeZReport, getStaleShift, forceCloseShift, adoptCloudShift, localShiftIds, listShifts, listExpenses, awaitingConfirmation, confirmShift, shiftCloseRights, historyScope, blindClose, blindReport, confirmView, type ForeignCash } from './shiftService';
import { resolveRange, getReportScope, type RangePreset } from './managerReports';
import { branchDay } from './branchDay';   // A431 / A432
import { cloudBranchOrders, mirrorTillRefund, reverseRiderPayout } from './webSales';
import { cleanExpenseMethod } from './expenseMethod';
import { cleanDeliveryFee } from './delivery';
import { recordKitchenSend, markKitchenPaid, recordKitchenVoid, openKitchenOrders, kitchenCloseBlock } from './kitchenService';
import { anySent, voidReasonLabel } from './kitchenLines';
import { exportReportCsv } from './reportExport';
import { exportDailySalesReport } from './dailySalesReport';

/** Range selection sent from the manager report screens. */
type RangeArg = { preset?: RangePreset; from?: string; to?: string; limit?: number };
import { checkDayGate, getOpenDay, getDayCloseSummary, closeDay, mayCloseDay, mayCloseBranch, getConflictedShifts, retryConflictedShift, businessDateNow } from './dayService';
import { branchCloseOverview, createCloseInstruction, executeCloseDay, createConfirmInstruction, executeConfirmShift, type PeerDayState } from './branchClose';
import { executeShiftMoney, createShiftMoneyInstruction, cancelShiftMoneyInstruction, SHIFT_MONEY_CLOSED, type ShiftMoneyPayload } from './branchClose';   // A465
import { forgetTill } from './branchClose';   // F4
import { hideTill, peerIsStale, unresolvedBlockers } from './branchClose';   // A521
/** A521: what the manager is told when something is sent to a till that is off — it waits for it (no expiry). */
const TILL_OFF_NOTE = 'The till is not connected — this applies when it reconnects.';
import { ownOpenShift } from './shiftService';   // A465
import { takeSnapshot, setBackupDir, maintenanceStatus } from './maintenance';
import { emitEvent, resetOutboxCursors, rearmNodeOutbox, rearmFailedNodeRows, rearmPeerQuarantine, retryPeerQuarantine, peerQuarantineSummary, nodeQueueDepth } from './nodeIngest';
import { channelHealth, serverInfo, protocolVerdict, NODE_PROTOCOL } from './nodeHealth';   // A501
import { lastFollowLook } from './nodeFollow';   // A501
import { setNodeDeviceToken, nodeDeviceToken, joinProofHeaders } from './nodeClient';   // F7, A503
import { nextBillNumber } from './billNumber';   // A500
import { sellRefusal, isOpenBill, createOpenBills } from './sellGate';   // A519: the till checks "Sell"
import { terminalCodeVerdict, normaliseCode, type CodeVerdict } from './terminalCodes';   // A519: no duplicate terminal codes
import { readServerCert, pinnedFetch, securityCode, setTillPin, tillPin, nodeTlsStatus, serverSecurityCode, forgetPinForRetrust } from './lanTls';   // A489
import { localOrderDetail } from './managerReports';   // A444
import { detailFromCloud, receiptPayloadFromDetail, type OrderDetail } from './orderDetail';   // A444
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy, getPriceList, setBranchPrice, clearBranchPrice } from './managerReports';
import { listPrinters, printHtmlSilent, openPrintPreview, probePrinter, probeGeometry } from './printService';
import { refreshTechConfig, checkRevealCode, openTechSession, getActiveSession, closeTechSession, logTechAction, flushTechAudit, runTechQuery, closeTechReadonlyDb, getRawTechToken } from './techService';
import { configSaveRefusal } from './tillGates';   // audit 2026-10-14
import { hasNode, isNodeReachable, fetchNodeReport, broadcastTechToken, fetchNodeTechToken, probeNode, verifyPinAtNodeClient, fetchRosterFromNode, relayBrandingToNode } from './nodeClient';
import { isUnreachableStatus } from './authTransport';
import { holdOfflinePin, clearOfflinePin, heldOfflinePin, upgradeOfflineSession, OFFLINE_SESSION_MESSAGE, NO_CONNECTION_MESSAGE, type ManageOfflineReason } from './offlineSession';
import { verifyPinAtNode, storeBranchStaff } from './branchStaff';
import { refreshStaffRosterNow, staffChangedHere } from './staffRoster';   // A446
import { overlayLocalChanges } from './localChanges';   // A448
import { recordTillChange, sendTillChangesNow, tillChangeStates, changeKeys, dismissRefusedChanges, mayChange } from './changeQueue';   // A448 (A490: changeKeys)
import { unpackRosterSnapshot } from './rosterSnapshot';
import { startNodeServer, stopNodeServer } from './nodeServer';
import { listenForServers } from './serverBeacon';   // A427
import { pendingJoins, answerJoin } from './serverJoin';   // A427
import os from 'os';
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

// A519: the bills this run numbered while their person could sell, and those recalled from hold (sellGate.ts) — an
// open bill can still be held, sent and paid when its person's permissions change mid-shift.
const openBills = createOpenBills();
// A519: the terminal codes the branch server said its tills use, from this run's join answer (terminalCodes.ts) — the
// fallback when the cloud cannot be asked.
let joinCodesInUse: string[] | null = null;
function noteJoinCodes(grant: { terminal_codes?: unknown }): void {
  if (Array.isArray(grant?.terminal_codes)) joinCodesInUse = grant.terminal_codes.map((c: unknown) => normaliseCode(c)).filter(Boolean);
}

export function registerIpcHandlers() {

  // D7: every channel below is registered through `handle`, which validates the
  // payload against ipcSchemas.ts before the handler runs (installValidatedHandle).
  // A channel with no registry entry throws at the boundary; check-ipc-validation
  // fails the build first, so it can't ship. This is why the handlers no longer
  // need per-channel payload boilerplate.
  const handle = installValidatedHandle(ipcMain);

  // A490: does the person signed in on this till hold ANY of these fine keys (staff_session, cached at PIN sign-in so it
  // works offline)? No one signed in → no. The rule itself is tillAccess.ts — the till's ONE rule (the owner's role holds
  // everything; an older cloud's broad keys are expanded). Back-office actions only: selling never asks.
  const requireKey = (keys: string[], refusal: string): void => {
    if (!sessionPerson()) throw new Error('Not signed in');
    if (!signedInCan(...keys)) throw new Error(refusal);
  };
  const NOT_ALLOWED = 'Your role does not allow this.';

  // ── Auth ────────────────────────────────────────────────

  // A till joins the business with a one-time code ZapTill issues in the admin portal (business id + code, redeemed
  // at /api/auth/enrol/redeem). A415 (owner, 2026-10-06: "never the owners session at all"): the session the cloud
  // hands back is the TILL's own — its device id, the business, the branch, no person. Nothing of the owner is kept on
  // the till: the session row names this till (user_id = its device id).
  //
  // `rejoin` (the technician console, "Rejoin this till"): the same till joins its business again with a fresh code —
  // after its sign-in was lost or the till was removed — and KEEPS everything on it: sales waiting to sync, shifts,
  // the menu, settings. Only a code for this till's own business and branch is accepted.
  const joinBusiness = async (businessId: string, code: string, rejoin: boolean) => {
    const cfg = getDeviceConfig();
    const db = getLocalDb();
    const current = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined;
    if (rejoin && current?.business_id && current.business_id !== businessId) {
      throw new Error('That business ID is not this till\'s business. Rejoin keeps this till\'s sales, so it only joins its own business.');
    }
    const res = await cloudFetch(`${getCloudUrl()}/api/auth/enrol/redeem`, {
      method: 'POST',
      // A477: which machine this is (MAC as A182; the MachineGuid and BIOS serial hashed) — the cloud binds the till's
      // key to it; a technician's rejoin records the machine it is done on.
      headers: { 'Content-Type': 'application/json', ...(await identityHeaders().catch(() => ({}))) },
      body: JSON.stringify({
        business_id: businessId,
        code,
        rejoin,
        // This till's stable device id: the cloud records THIS terminal (and, rejoining, recognises it).
        device_id:   cfg?.device_id ?? undefined,
        // A182: the machine's stable MAC, so if this box was enrolled before (a
        // reinstall) the server can hand back its previous terminal code/name.
        mac_address: getMacAddressCached() ?? undefined,
        // A273 follow-up: the till's code and the name typed at setup, so the web
        // POS's till picker shows THIS till's real name. Absent on a first enrolment before setup.
        terminal_code: getDeviceConfig()?.terminal_code ?? undefined,
        device_name:   getDeviceConfig()?.device_name ?? undefined,
        branch_id:     cfg?.branch_id ?? undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) { authLog(rejoin ? 'rejoin-refused' : 'join-refused', String(data?.code ?? `HTTP ${res.status}`)); throw new Error(data.error ?? (rejoin ? 'Rejoin failed' : 'Enrolment failed')); }

    if (!rejoin) clearCatalogue(db);
    db.prepare(`
      INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token=excluded.token, refresh_token=excluded.refresh_token, user_id=excluded.user_id, business_id=excluded.business_id,
        business_name=excluded.business_name, currency=excluded.currency, logged_in_at=excluded.logged_in_at
    `).run(
      data.token,
      data.refreshToken ?? null,
      String(data.till?.device_id ?? cfg?.device_id ?? ''),
      data.business.id,
      data.business.name,
      data.business.currency ?? 'KES',
      new Date().toISOString(),
    );

    // D5: wrap the credentials at rest.
    writeSessionTokens({ token: data.token, refreshToken: data.refreshToken ?? '' });
    // A407: the device secret — the till's own way back in if its session is ever refused.
    if (typeof data.deviceSecret === 'string' && data.deviceSecret) writeDeviceSecret(data.deviceSecret);

    if (data.business?.type) saveDeviceConfig({ business_type: String(data.business.type) });

    // A182: if the server recognised this machine (same MAC as a prior install),
    // restore its previous terminal code + name so a reinstalled till comes back
    // as itself instead of a blank "new till" that gets re-named T1 and collides
    // (A181). Only fills gaps — never overwrites a code the operator has set here.
    if (data.restore && (data.restore.terminal_code || data.restore.device_label)) {
      const now = getDeviceConfig();
      const patch: Record<string, unknown> = {};
      if (data.restore.terminal_code && !now?.terminal_code) patch.terminal_code = String(data.restore.terminal_code);
      if (data.restore.device_label && !now?.device_name)   patch.device_name   = String(data.restore.device_label);
      if (Object.keys(patch).length) { saveDeviceConfig(patch); logLine('enrol', `restored identity from a prior install: ${JSON.stringify(patch)}`); }
    }

    configureSyncEngine(getCloudUrl(), data.token, data.refreshToken ?? '');
    // A477: a technician's action — the renewal gate opens at once (a refused session waits 15 min otherwise).
    resetRenewalGate(rejoin ? 'a technician rejoined this till' : 'the till joined its business');
    authLog(rejoin ? 'rejoin' : 'join', `business ${data.business?.id ?? businessId}${data.deviceSecret ? ', device secret kept' : ''}`);
    refreshTechConfig(data.token).catch(() => {});
    logLine('enrol', rejoin ? 'the technician rejoined this till to its business — everything on it kept' : 'joined the business');
    await syncAll().catch(console.error);

    return { business: data.business, branchId: data.branchId ?? null };
  };

  handle('auth:enrolDevice', async (_event, payload) => {
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    // A490: a till already set up AND joined to its business joins again only from the technician console (as
    // auth:rejoin) — a first join clears the catalogue and replaces the till's session, so it is not anyone's button.
    const joined = !!(getLocalDb().prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined)?.business_id;
    if (isConfigured() && joined && !getActiveSession()) throw new Error('This till is already joined to its business. A technician rejoins it from the technician console.');
    return joinBusiness(String(business_id).trim(), String(code).trim(), false);
  });

  // A415: the technician rejoins this till to its business — only inside an open technician session (the tech console),
  // checked here in the main process, not just on the screen.
  handle('auth:rejoin', async (_event, payload) => {
    const { business_id, code } = assertPayload<{ business_id: string; code: string }>(
      { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } }, payload);
    if (!getActiveSession()) throw new Error('Open the technician console first.');
    const out = await joinBusiness(String(business_id).trim(), String(code).trim(), true);
    logTechAction('till.rejoin', { business_id: String(business_id).trim(), branch_id: out.branchId });
    return out;
  });

  // ── A427: join a branch server found on the shop network (serverBeacon.ts / serverJoin.ts) ──────────────────────
  // The new till: listen for servers, ask one to join, then — once someone at the server allows it — take the
  // server's answer (cloud, business, branch, server address and access code, a one-time code) and enrol with it.
  // Terminal code and the rest of setup stay on the setup screen as before.
  handle('install:findServers', async () => listenForServers(6000));

  // A436: `rejoin` — a till already set up but signed out (the sign-in-code screen, EnrolPage) asks the same way and,
  // once allowed, joins its business again KEEPING everything on it (joinBusiness rejoin), its setup untouched.
  // A489: `cert` — the server's certificate, read before the join; the join and its answer (which carries the branch
  // access code and this till's device key) then go over TLS pinned to it, and it is pinned when the join succeeds.
  let joinAsk: { url: string; id: string; token: string; rejoin: boolean; cert: string | null } | null = null;
  const joinFetch = (url: string, init: any, cert: string | null) => (cert ? pinnedFetch(url, init, cert) : fetch(url, init));
  // A494: a till already set up AND joined to its business is moved to another (a first join replaces its session and
  // clears its menu) only by a technician — the same rule as auth:enrolDevice; its own rejoin (keeps everything) stays.
  const joinedHere = (): boolean => isConfigured()
    && !!(getLocalDb().prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined)?.business_id;
  const ALREADY_JOINED = 'This till is already joined to its business. A technician moves it from the technician console.';
  const sameCloud = (a: string, b: string) => String(a ?? '').trim().replace(/\/+$/, '').toLowerCase() === String(b ?? '').trim().replace(/\/+$/, '').toLowerCase();
  handle('install:requestJoin', async (_event, payload) => {
    const { url, rejoin } = assertPayload<{ url: string; rejoin?: boolean }>({ url: { t: 'string', min: 1 }, rejoin: { t: 'boolean', optional: true } }, payload);
    if (!/^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(url)) throw new Error('That is not a branch server address.');
    // A494: this machine itself (or 0.0.0.0) is never a branch server for an installed till — only in development.
    if (app.isPackaged && /^http:\/\/(127\.|0\.)/.test(url)) throw new Error('That is not a branch server address.');
    if (!rejoin && joinedHere() && !getActiveSession()) throw new Error(ALREADY_JOINED);
    // A502: a former branch server becomes a till of another server only from the technician console (a technician's
    // session) — it stops serving once that server allows it. Never through itself.
    if (rejoin && isNodeRole(getDeviceConfig()?.device_role) && !getActiveSession()) throw new Error('This computer is the branch server — it joins another server from the technician console.');
    const deviceId = getDeviceConfig()?.device_id ?? saveDeviceConfig({ configured: false } as any).device_id;
    const { cert } = await readServerCert(url, 4000);   // null: a server on an older build — the join stays plain
    let res: Response;
    try {
      res = await joinFetch(`${url}/node/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...joinProofHeaders(deviceId, cert) },   // A503
        body: JSON.stringify({ device_id: deviceId, name: os.hostname() }), signal: AbortSignal.timeout(5000) }, cert);
    } catch { throw new Error('Could not reach that branch server. Check this till is on the same network.'); }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `The branch server refused (HTTP ${res.status}).`);
    joinAsk = { url, id: String(body.id), token: String(body.token), rejoin: !!rejoin, cert };
    const code = securityCode(cert);
    logLine('join', `asked the branch server at ${url} to join — ${code ? `encrypted, security code ${code}` : 'unencrypted (the server is on an older build)'}`);
    return { ok: true, name: os.hostname(), securityCode: code };
  });

  handle('install:joinStatus', async () => {
    if (!joinAsk) return { status: 'none' as const };
    const ask = joinAsk;
    let r: any;
    try {
      const res = await joinFetch(`${ask.url}/node/join/status?id=${encodeURIComponent(ask.id)}&token=${encodeURIComponent(ask.token)}`, { signal: AbortSignal.timeout(5000) }, ask.cert);
      r = await res.json();
    } catch { return { status: 'pending' as const }; }   // a blip — keep waiting
    if (r?.status === 'pending') return { status: 'pending' as const };
    joinAsk = null;
    if (r?.status !== 'approved' || !r.grant) {
      return { status: r?.status === 'denied' ? 'denied' as const : 'expired' as const };
    }
    const g = r.grant;
    noteJoinCodes(g);   // A519: the branch's codes in use, for the bind step's check
    // A494: checked again at the answer (a technician's session may have ended meanwhile), and a till already set up
    // takes a grant only for the cloud it is set up for — a server cannot point it at another cloud.
    if (!ask.rejoin && joinedHere() && !getActiveSession()) throw new Error(ALREADY_JOINED);
    if ((ask.rejoin || isConfigured()) && !sameCloud(String(g.cloud_url ?? ''), getCloudUrl())) {
      logLine('join', `A494: refused a join answer from ${ask.url} for another cloud (${String(g.cloud_url ?? '')})`);
      throw new Error('That branch server belongs to another cloud than this till. Ask your technician.');
    }
    const port = Number(new URL(ask.url).port);
    if (ask.rejoin) {
      // Already set up: only the way to the server changes (saved first, so the rejoin goes through it — A410); put
      // back as it was if the cloud refuses (another branch's server, say).
      const before = getDeviceConfig();
      const pinBefore = tillPin();
      const keyBefore = nodeDeviceToken();   // A503: restored with the address if the rejoin fails
      // A502: a former branch server stepping down (technician console) stops serving before it joins the other one.
      const wasServer = isNodeRole(before?.device_role);
      if (wasServer) { stopNodeServer(); logTechAction('role.stepdown', { from: before?.device_role, node_url: ask.url }); }
      saveDeviceConfig({ node_url: ask.url, node_secret: String(g.node_secret), ...(wasServer ? { device_role: 'till' } : {}) } as any);
      setTillPin(ask.cert);   // A489: the server's certificate goes with its address (null: an older server — plain)
      if (g.device_token) setNodeDeviceToken(String(g.device_token));   // F7: this till's own key at the server
      // F2: a rejoin is a (possibly new) server — everything this till holds is offered to it again.
      if ((before?.node_url ?? null) !== ask.url || (before?.node_secret ?? null) !== String(g.node_secret)) {
        rearmNodeOutbox();
        logLine('node', `rejoined through ${ask.url}; every row is offered to the branch server again`);
      }
      try {
        const joined = await joinBusiness(String(g.business_id), String(g.code), true);
        logLine('join', `rejoined ${joined.business?.name ?? 'the business'} through the branch server at ${ask.url}`);
        return { status: 'joined' as const, business: joined.business, branchId: String(g.branch_id), branchName: g.branch_name ?? null,
          cloudUrl: String(g.cloud_url), nodeIp: new URL(ask.url).hostname, nodePort: port, nodeSecret: String(g.node_secret) };
      } catch (e) {
        saveDeviceConfig({ node_url: before?.node_url ?? null, node_secret: before?.node_secret ?? null,
          ...(wasServer ? { device_role: before?.device_role } : {}) } as any);   // A502: serves again from its next start
        setTillPin(pinBefore);
        if (keyBefore) setNodeDeviceToken(keyBefore);   // A503
        throw e;
      }
    }
    // Where the server is and how to reach it — saved BEFORE enrolling, so the enrolment goes through the server
    // (A410) and works even when this till has no internet of its own. Not marked configured: setup finishes on screen.
    saveDeviceConfig({ deploy_mode: 'cloud', server_url: String(g.cloud_url), branch_id: String(g.branch_id),
      device_role: 'till', node_url: ask.url, node_secret: String(g.node_secret), configured: false } as any);
    setTillPin(ask.cert);   // A489: from here every request to the server is TLS, pinned to this certificate
    if (g.device_token) setNodeDeviceToken(String(g.device_token));   // F7: this till's own key at the server
    const joined = await joinBusiness(String(g.business_id), String(g.code), false);
    logLine('join', `joined ${joined.business?.name ?? 'the business'} through the branch server at ${ask.url}`);
    return {
      status: 'joined' as const, business: joined.business, branchId: String(g.branch_id), branchName: g.branch_name ?? null,
      cloudUrl: String(g.cloud_url), nodeIp: new URL(ask.url).hostname, nodePort: port, nodeSecret: String(g.node_secret),
    };
  });

  // The server: who is waiting, and the answer. Allow fetches a one-time code from the cloud for this branch.
  handle('node:joinRequests', async () => (isNodeRole(getDeviceConfig()?.device_role)
    ? pendingJoins().map((r) => ({ ...r, securityCode: serverSecurityCode() })) : []));   // A489: compared with the till's screen

  // A489: this till's connection to its branch server (Tech page), or — on the server — its own security code.
  handle('node:tlsStatus', async () => (isNodeRole(getDeviceConfig()?.device_role)
    ? { state: 'server' as const, code: serverSecurityCode(), error: null }
    : nodeTlsStatus()));
  // A489: the server's certificate changed (it was reinstalled) — a person trusts it again. A technician, or a manager
  // who may change settings; the next 60 s tick pins whatever certificate the server now hands out.
  handle('node:tlsRetrust', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can do that.');
    const was = securityCode(tillPin());
    forgetPinForRetrust();   // A503: nothing goes plain until a certificate is pinned again
    logLine('node', `A489: the branch server's certificate (security code ${was ?? 'none'}) was forgotten by a person — the next one it hands out is trusted`);
    return { ok: true };
  });
  // A501: the till's conversation with its branch server, channel by channel (Tech page › Branch sync): when each last
  // worked, its last error in the server's words, failures in a row; what this till still owes the server and what it
  // holds back from other tills; the server's version and branch. Read-only. A technician, or a manager who may change
  // settings — like the security row beside it.
  handle('node:syncHealth', async () => {
    if (!getActiveSession() && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can see that.');
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return { role: isNodeRole(cfg?.device_role) ? 'server' as const : 'none' as const };
    const info = serverInfo();
    return {
      role: 'till' as const,
      url: cfg.node_url,
      channels: channelHealth(),
      backlog: nodeQueueDepth(),
      quarantine: peerQuarantineSummary(),
      server: info,
      tillProtocol: NODE_PROTOCOL,
      ...protocolVerdict(info),
      branch: { till: cfg.branch_id ?? null, server: info?.branch_id ?? null,
        mismatch: !!(info?.branch_id && cfg.branch_id && info.branch_id !== cfg.branch_id) },
      refusal: nodeRefusal(),
      heard: lastFollowLook(),
    };
  });
  // A501: "Retry failed records" — the rows the server refused (after five tries) go to it again, and the rows held back
  // from other tills are tried again now. Same gate as the row above.
  handle('node:retryFailed', async () => {
    const tech = getActiveSession();
    if (!tech && !signedInCan('settings.business')) throw new Error('Only a technician or someone who manages the business settings can do that.');
    const requeued = rearmFailedNodeRows();
    const released = rearmPeerQuarantine();
    const applied = retryPeerQuarantine().applied;
    if (tech) logTechAction('node.retryFailed', { requeued, released, applied });
    logLine('node', `A501: retry failed records — ${requeued} record(s) offered to the branch server again, ${released} held-back record(s) from other tills tried again (${applied} applied)`);
    void replicateToNode();
    return { requeued, released, applied };
  });
  handle('node:answerJoin', async (_event, payload) => {
    const { id, allow } = assertPayload<{ id: string; allow: boolean }>({ id: { t: 'string', min: 1 }, allow: { t: 'boolean' } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) throw new Error('Only the branch server answers join requests.');
    // A490: adding a till to the branch is devices.approve (the cloud's Tills and devices), or a technician.
    if (!getActiveSession() && !signedInCan('devices.approve')) throw new Error('Only someone who approves tills (or a technician) can answer a till asking to join.');
    const out = await answerJoin(id, allow, async () => {
      let res: Response;
      try { res = await tillFetch('/api/pos/join-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      catch { throw new Error('The server needs the internet to add a till — check the connection and press Allow again.'); }
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error ?? `The cloud refused (HTTP ${res.status}).`);
      const cfg = getDeviceConfig();
      return { cloud_url: getCloudUrl(), business_id: String(d.businessId), branch_id: String(d.branchId),
        branch_name: d.branchName ?? null, code: String(d.code), node_secret: cfg?.node_secret || ensureNodeSecret() };
    });
    logLine('join', `${allow ? 'allowed' : 'refused'} a till asking to join (${id})`);
    return out;
  });

  handle('auth:getSession', async () => {
    const db = getLocalDb();
    const session = db.prepare(`SELECT * FROM session WHERE id=1`).get() as any;
    if (!session) return null;

    // Re-hydrate sync engine in case app was restarted. Credentials are wrapped
    // at rest (D5), so they come from the store rather than off the row.
    const sessTok = readSessionTokens();
    configureSyncEngine(getCloudUrl(), sessTok.token, sessTok.refreshToken);

    // A415: the session row names this till, never a person. A till that joined before A415 still held the owner's id
    // here — replaced by the till's own on its next start.
    const deviceId = getDeviceConfig()?.device_id ?? '';
    if (deviceId && session.user_id !== deviceId) db.prepare(`UPDATE session SET user_id=? WHERE id=1`).run(deviceId);

    return {
      till: { device_id: deviceId || null },
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

  // ── Staff PIN login (layered on the till session) ──────
  // verify-pin requires the owner bearer token (requireAuth) + a branch_id.
  // The till token lives in the session row; the renderer never sees it.

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
  // A446 (session audit): every call has a time limit — it had none, so a slow cloud (a cold start, a lossy line) or a
  // branch server that answered nothing left the PIN pad or the lock screen spinning for minutes. A timeout throws like
  // no connection, so the PIN check falls back to this till's own staff list.
  async function tillFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const db = getLocalDb();
    const readToken = () =>
      readSessionTokens().token || undefined;

    let token = readToken();
    if (!token) throw new Error('Not signed in');

    const call = (t: string) => cloudFetch(`${getCloudUrl()}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
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
      const res = await withinMs(tillFetch(`/api/shifts/${encodeURIComponent(shiftId)}/foreign-cash`, {
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
      const res = await withinMs(tillFetch('/api/shifts/current'), 4_000);
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
        tillFetch('/api/branches'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 4_000)),
      ]);
      const data = await (res as Response).json();
      if ((res as Response).ok && Array.isArray(data)) {
        return data.map((b: any) => ({ id: b.id, name: b.name, desktop_licensed: !!b.desktop_licensed }));
      }
    } catch { /* cold server, rate limit, no link — the local answer stands */ }

    if (local.length) return local;
    // Truly first run, nothing synced yet: only now is the server the answer.
    const res  = await tillFetch('/api/branches');
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

    // D5 - wrap at rest, same as the till session.
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
    assertPinAllowed();   // A494: too many wrong PINs on this till — nothing is checked until the lockout ends
    const db = getLocalDb();
    const session = db.prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as any;

    // Same expiry problem as listBranches: the PIN pad is the first thing
    // touched each morning, so this is exactly where a stale till token bites.
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
    // under the till's own token (syncEngine authHeaders) and cashier_id comes from
    // this staff_session row, so the sale queues, attributes correctly and syncs
    // when the line returns. Shared by the node, node-own-roster and cache paths.
    // A477: where the sign-in was decided, for auth.log — the branch server, or this till itself.
    let signInSource: 'node' | 'local' = 'local';
    const signInLocal = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }) => {
      notePinSuccess();   // A504: a right PIN clears the count of wrong ones
      authLog('sign-in', `source=${signInSource}`);
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
      // A446: a till that has only ever signed people in through its branch server (or offline) never recorded its
      // branch — "This till is not bound to a branch yet" on a manager's change, and the menu pulled for the main branch.
      // The branch its staff sign in to is its branch.
      if (!getDeviceConfig()?.branch_id) { saveDeviceConfig({ branch_id }); logLine('pin', `this till is now bound to branch ${branch_id}`); }
      return {
        staff: { id: staff.staffId, name: staff.name, role: staff.roleName },
        // The PIN screen routes on the TOP-LEVEL role (App.tsx hasManagerRights), exactly as the online answer gives it
        // (`role: data.staff?.role` below). Without it an offline manager — no '*' and, since migration 59, no
        // settings.manage — was sent to the cashier screen (owner, 2026-09-27; A339).
        role: staff.roleName,
        permissions: staff.permissions,
        branch: { id: branch_id, name: branchRowOff?.name ?? null },
        // A480 (owner, 2026-10-14: "No branch bound to this till … happens to all tills which are trying to update"): the
        // screens read `branchId` / `branchName`, as the online answer gives them — a local sign-in carried only `branch`,
        // so the update bar's Manager-PIN restart said "No branch bound" and the manager screen had no branch.
        branchId: branch_id,
        branchName: branchRowOff?.name ?? null,
        business: { name: session?.business_name ?? null, currency: session?.currency ?? null },
        offline: true,
      };
    };

    // AUTHORITY CHAIN (A17): node → cloud → last resort. Fall back only when an
    // authority could not be REACHED; a rejection from any of them is FINAL, or a
    // sacked cashier signs in by unplugging a cable — now with two to choose from.

    // 1. A peer asks its branch node over the LAN first.
    // A446: the node's "no" is NOT final any more. Its staff list can be a few seconds behind the cloud (a cashier just
    // created, a PIN just changed) — and the till then said "not recognised" until the app was restarted. The cloud is
    // asked next; only the cloud's "no" (or, offline, every local copy's) refuses. A deactivated cashier is still refused:
    // the cloud refuses them, and offline every copy has dropped them on its next refresh.
    let nodeSaidNo: string | null = null;
    if (hasNodeUrl) {
      const r = await verifyPinAtNodeClient(String(pin), branch_id);
      if (r.status === 'ok') { logLine('pin', `node sign-in: ${r.staff.name}`); signInSource = 'node'; return signInLocal(r.staff); }
      if (r.status === 'rejected') { nodeSaidNo = r.message; logLine('pin', `the branch server did not know that PIN (${r.message}) - asking the cloud`); }
      // transport failure → fall through to the cloud
    }

    // 3. Last resort. A NODE verifies against its OWN roster (never expires); a
    //    peer or standalone till uses the offline cache (which no longer expires
    //    on a node-configured peer — see pinCache, A17). Shared by BOTH the
    //    thrown-transport path and the 5xx path (A152) so a "down-but-answering"
    //    cloud rescues identically to an unreachable one.
    const fallbackToLocalAuthority = () => {
      // A446: EVERY till holds its branch's staff list now (staffRoster.ts) — checked first, then the person's own saved
      // sign-in. A PIN neither knows refreshes the list at once (the next try may know it).
      const v = verifyPinAtNode(String(pin), branch_id);
      if (v.ok) return signInLocal(v.staff);
      if (v.reason === 'ambiguous') throw new Error(v.message);
      logLine('pin', `this till's staff list: ${v.reason} - checking the PIN on this till's saved sign-ins`);
      const verdict = verifyPinOffline(String(pin), branch_id);
      if (verdict.ok) return signInLocal(verdict.staff);
      void refreshStaffRosterNow('a PIN this till did not know');
      // A494: a PIN some authority said no to counts toward this till's lockout (one that could not be checked does not).
      if (nodeSaidNo || v.reason === 'no_match' || verdict.reason === 'no_match') recordPinFailure();
      throw new Error(nodeSaidNo ?? (v.reason === 'no_match' ? 'Invalid PIN' : verdict.message));
    };

    // A473: the cloud has refused this till's own session in the last minute (a technician must rejoin it) — asking again
    // would only repeat the refusal after three round trips (the PIN, the renewal, the device sign-in). The answer is the
    // same as A407's below, without the wait.
    if (tillSessionRefusedRecently()) {
      logLine('pin', 'the cloud refused this till\'s session in the last minute - signing in on the till\'s own PIN check at once');
      return fallbackToLocalAuthority();
    }

    // 2. The cloud, exactly as before.
    // A473: a PIN this till already knows (its staff list or a saved sign-in) waits 4 s for the cloud (not 8) before the list decides —
    // a slow line no longer holds the cashier at the PIN pad. An unknown PIN still waits the full 8 s for the cloud.
    const knownHere = verifyPinAtNode(String(pin), branch_id).ok || verifyPinOffline(String(pin), branch_id).ok;
    let res: Awaited<ReturnType<typeof tillFetch>>;
    try {
      // A473: the whole exchange is bounded — the per-request limit did not cover the renewal after a 401.
      res = await withinMs(tillFetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // PIN, branch, the running build and this till's name (verifyPinBody).
      body: verifyPinBody(String(pin), branch_id),
      }, knownHere ? 4_000 : 8_000), knownHere ? 5_000 : 10_000);   // A446: 8 s, then this till's own staff list
    } catch (netErr: any) {
      logLine('pin', `server unreachable at sign-in (${netErr?.message ?? netErr}) - trying the local authority`);
      return fallbackToLocalAuthority();
    }

    // A152: a cloud that ANSWERS with a 5xx is UNREACHABLE, not a rejection.
    // Render process down behind a live edge returns 502/503; without this the
    // next two lines either threw an unhandled parse error on the gateway's HTML
    // body or read !res.ok as "Invalid PIN" — and the offline cache/node never
    // rescued a login it should have. A clean 4xx below stays FINAL.
    // A494: a 429 is the cloud's limit on wrong PINs from this till. A494 made the till wait it out (15 minutes) — which
    // locked EVERY cashier out of selling at that till, right PINs included. A504: the till's own check answers instead,
    // as A446 did — no longer an unlimited oracle, because the till's own limiter (assertPinAllowed above, 5 wrong →
    // 1 min, doubling to 15) bounds it.
    if (res.status === 429) {
      logLine('pin', 'cloud answered 429 at sign-in - too many tries there; checking the PIN on the till (its own limit applies)');
      return fallbackToLocalAuthority();
    }
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
    if (!res.ok) {
      if (res.status === 401) recordPinFailure();   // A494: a wrong PIN, whoever said so
      throw new Error(data.error ?? 'Invalid PIN');
    }

    // Online sign-in succeeded: an offline PIN held from an earlier sign-in is no longer needed (A345).
    authLog('sign-in', 'source=cloud');
    notePinSuccess();   // A504
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

  // A446: unlock the lock screen — is this the signed-in person's PIN? Checked where it is fastest and needs no network
  // (this till's own staff list, then its saved sign-ins), then the branch server, then the cloud. The person's session
  // is NOT replaced: unlocking used to go through auth:verifyPin, which re-signed them in — through the server or offline
  // that swapped a working cloud session for an offline one (manager screens then said "no connection" until it upgraded),
  // and any failure read "Cannot check that PIN right now" with no way out but closing the app.
  handle('auth:unlock', async (_e, payload) => {
    const { pin } = assertPayload<{ pin: string }>({ pin: { t: 'string', min: 1 } }, payload);
    const st = getLocalDb().prepare(`SELECT staff_id, branch_id FROM staff_session WHERE id=1`).get() as { staff_id?: string; branch_id?: string } | undefined;
    if (!st?.staff_id || !st.branch_id) throw new Error('Nobody is signed in on this till — sign in again.');
    assertPinAllowed();   // A494
    // A480: a session signed in on this till's own check (no cloud token — offline, a slow line, a refused till, or after a
    // restart lost the held PIN) becomes a cloud one again from the unlock: the PIN is held and the upgrade tried at once,
    // as after the offline sign-in itself (A345). The manager's Overview then shows the cloud's branch, not the
    // "Sign in as a manager" fallback, without signing out.
    // A494: ONE answer for "not a PIN" and "someone else's PIN" ('wrong') — 'other' confirmed that a guessed PIN was a
    // real one. Both count toward the lockout.
    const WRONG = { ok: false, reason: 'wrong' as const };
    const mine = (id: string | null | undefined) => {
      if (id !== st.staff_id) { recordPinFailure(); return WRONG; }
      notePinSuccess();   // A504: a right PIN clears the count of wrong ones
      if (!readStaffTokens().token) {
        holdOfflinePin({ staffId: st.staff_id!, branchId: st.branch_id!, pin: String(pin) });
        void tryUpgradeOfflineSession();
      }
      return { ok: true };
    };
    const local = verifyPinAtNode(String(pin), st.branch_id);
    if (local.ok) return mine(local.staff.staffId);
    const saved = verifyPinOffline(String(pin), st.branch_id);
    if (saved.ok) return mine(saved.staff.staffId);
    // Neither copy on this till knows it: a wrong PIN as far as the till can tell (counted if the cloud cannot be asked).
    const localNo = (!local.ok && local.reason === 'no_match') || (!saved.ok && saved.reason === 'no_match');
    const cfg = getDeviceConfig();
    if (cfg?.node_url && !isNodeRole(cfg.device_role)) {
      const r = await verifyPinAtNodeClient(String(pin), st.branch_id);
      if (r.status === 'ok') return mine(r.staff.staffId);
    }
    let res: Awaited<ReturnType<typeof tillFetch>>;
    try {
      res = await withinMs(tillFetch('/api/auth/verify-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: verifyPinBody(String(pin), st.branch_id) }), 8_000);
    } catch {
      void refreshStaffRosterNow('an unlock PIN this till did not know');
      // A494: offline, the till's own "no" is the answer — the same 'wrong' as a colleague's PIN, and counted (a
      // different message here told an unknown PIN from a real one). Only a till holding no list at all says it cannot check.
      if (localNo) { recordPinFailure(); return WRONG; }
      throw new Error('This till does not know that PIN and cannot reach the cloud to check it. Try again, or sign out.');
    }
    if (res.status === 429) throw new Error(PIN_CLOUD_BUSY);   // A494
    if (isUnreachableStatus(res.status)) {
      if (localNo) { recordPinFailure(); return WRONG; }
      throw new Error('This till does not know that PIN and the cloud is not answering. Try again, or sign out.');
    }
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) { void refreshStaffRosterNow('an unlock PIN this till did not know'); recordPinFailure(); return WRONG; }
    if (data.staff?.id !== st.staff_id) { recordPinFailure(); return WRONG; }
    notePinSuccess();   // A504
    persistCloudSignIn(data, st.branch_id);   // the same person, with a fresh cloud session — better than the one held
    void refreshStaffRosterNow('this till did not know a PIN the cloud did');
    return { ok: true };
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
  // A517: may the screens fetch the manager screens in the background now? Not while the start-up sequence runs (A513),
  // not on a low-memory machine — there they load when opened. Two cheap reads, no PowerShell.
  handle('idle:mayPreload', async () => preloadAnswer({ settled: startupSettled(), totalBytes: os.totalmem(), freeBytes: os.freemem() }));
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
      // tillFetch so an expired token refreshes rather than silently dropping
      // the option groups and letting the item be rung with no size chosen.
      try {
        const res = await tillFetch(`/api/variants/groups?product_id=${productId}`);
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
      // tillFetch so an expired token refreshes rather than silently dropping
      // the option groups and letting the item be rung with no size chosen.
      try {
        const res = await tillFetch(`/api/modifiers/groups?product_id=${productId}`);
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
  /** A456: how many receipts this sale prints (the till's Copies setting, carried on the sale): 1 or 2. */
  function receiptCopies(payload: any): 1 | 2 {
    return Number(payload?.receipt_copies) === 2 ? 2 : 1;
  }

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
          // A444: a reprint rebuilt from the order names who sold it; a live sale (and a stored payload) the person signed in.
          cashierName:    String(payload.cashier_name ?? staff?.staff_name ?? ''),
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
          // A445: the offers on the sale, by name (part of the discount above).
          offers:         Array.isArray(payload.offers) ? payload.offers : undefined,
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
          // A450: "Buy Goods: 123456" under the payments — set on the web; none when no number is set.
          tillLabel:       getReceiptPay()?.label,
          tillNumber:      getReceiptPay()?.number,
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
  // A490: what the kitchen leaves off is the print set-up's — stations.manage (it was open to anyone at the till).
  const STATIONS_REFUSED = 'Only someone who sets up printers and print stations can change that.';
  handle('escpos:setKitchenExclusions', (_e, terms: unknown) => {
    if (!signedInCan('stations.manage')) return { ok: false, error: STATIONS_REFUSED, terms: kitchenExclusions() };
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
    if (!signedInCan('stations.manage')) return { ok: false, error: STATIONS_REFUSED, terms: kitchenExclusions() };
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
  /** A490: who rang it — "print my receipt now" stays the cashier's own; anyone else's last sale is a reprint. */
  let lastOrderBy: string | null = null;

  handle('escpos:reprintReceipt', () => {
    if (!lastOrderPayload) return { ok: false, error: 'nothing to reprint' };
    // A490: sales.reprint — unless it is the sale the person signed in just completed.
    const me = sessionPerson();
    if (!me || (me.staffId !== lastOrderBy && !personCan(me, 'sales.reprint'))) return { ok: false, error: 'Reprinting a receipt needs the reprint permission.' };
    reprintCount += 1;
    // Marked as a duplicate on the paper itself. An unmarked second copy of a
    // receipt is the thing an auditor cannot tell from a second sale.
    const r = queueThermal(lastOrderPayload, ['receipt'], { at: new Date(), count: reprintCount });
    if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
    return { ok: true };
  });

  // A444: an order's detail — this till's records, else the cloud (GET /api/orders/:id, the branch's other tills).
  async function readOrderDetail(orderId: string): Promise<{ detail: OrderDetail; cashierId: string | null }> {
    const local = localOrderDetail(orderId);
    if (local) {
      const row = getLocalDb().prepare(`SELECT cashier_id FROM orders WHERE id = ?`).get(orderId) as { cashier_id?: string } | undefined;
      return { detail: local, cashierId: row?.cashier_id ?? null };
    }
    const cfg = getDeviceConfig();
    const token = readStaffTokens().token ?? readSessionTokens().token;
    if (!token) throw new Error('This order is not on this till, and the till is not signed in to the cloud.');
    let res: Response;
    try {
      res = await Promise.race([
        cloudFetch(`${getCloudUrl()}/api/orders/${encodeURIComponent(orderId)}`, {
          headers: { Authorization: `Bearer ${token}`, 'x-device-id': cfg?.device_id ?? '' },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The cloud took too long to answer.')), 8_000)),
      ]);
    } catch (e: any) {
      throw new Error(/took too long/.test(e?.message ?? '') ? e.message : 'This order is not on this till and the cloud cannot be reached.');
    }
    if (res.status === 404) throw new Error('Order not found.');
    if (!res.ok) throw new Error(`The cloud did not answer (HTTP ${res.status}).`);
    const body = await res.json() as any;
    return { detail: detailFromCloud(body), cashierId: body?.cashier_id ?? null };
  }

  // Reprint any recent order from Order History (A94). Replays the stored payload
  // through the same path as the original — byte-identical, marked "Duplicate
  // Print". Only orders created on THIS terminal (after the feature shipped) have
  // a stored payload; anything else reports honestly rather than printing wrong.
  handle('escpos:reprintReceiptForOrder', async (_e, orderId: string) => {
    // 0.6.27: History's Reprint is for managers when the client has 'cashier_no_reprint' on — refused here too.
    const scope = historyScope();
    if (!scope.canReprint) return { ok: false, error: 'Reprinting is for managers on this till.' };
    const NOT_YOURS = 'This sale is not yours.';
    const row = getLocalDb()
      .prepare('SELECT payload FROM receipt_payloads WHERE order_id = ?')
      .get(orderId) as { payload?: string } | undefined;
    // A444: no stored receipt (another till's sale, the web's, or older than the last 200) — rebuilt from the order
    // itself: this till's records, else the cloud's.
    let payload: any = null;
    if (row?.payload) {
      // A494: a person who sees only their own sales in History (ownOnly) reprints only their own — as order:detail.
      if (scope.ownOnly) {
        const o = getLocalDb().prepare(`SELECT cashier_id FROM orders WHERE id = ?`).get(String(orderId)) as { cashier_id?: string | null } | undefined;
        if (!scope.staffId || (o?.cashier_id ?? null) !== scope.staffId) return { ok: false, error: NOT_YOURS };
      }
      try { payload = JSON.parse(row.payload); } catch { return { ok: false, error: 'Could not rebuild this receipt.' }; }
    } else {
      const found = await readOrderDetail(String(orderId)).catch((e: any) => ({ error: e?.message ?? String(e) }));
      if ('error' in found) return { ok: false, error: found.error };
      if (scope.ownOnly && (!scope.staffId || found.cashierId !== scope.staffId)) return { ok: false, error: NOT_YOURS };   // A494
      payload = receiptPayloadFromDetail(found.detail);
    }
    try {
      const r = queueThermal(payload, ['receipt'], { at: new Date(), count: 1 });
      if (r.failed.length) return { ok: false, error: 'The receipt could not be produced — see the till log.' };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not rebuild this receipt.' };
    }
  });

  /** A494: what this till's offers (pulled with the menu) take off a sale's lines — timing not re-checked (the cart's clock
   *  decided it, as the cloud's check of a sale does), so a sale rung on the minute an offer ended is never refused. */
  function tillOfferDiscount(orderPayload: any): { total: number; applied: Array<{ offer_id: string; name: string; amount: number }> } {
    const none = { total: 0, applied: [] };
    try {
      const rows = getLocalDb().prepare(`SELECT data FROM offers`).all() as Array<{ data: string }>;
      const offers = rows.flatMap((r) => { try { const c = cleanOffer(JSON.parse(r.data)); return c.ok ? [(c as { offer: Offer }).offer] : []; } catch { return []; } });
      if (!offers.length) return none;
      const items: any[] = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
      const lines = items.map((i, n) => {
        const q = Number(i?.quantity) || 0;
        return { key: String(n), product_id: i?.product?.id ?? null, category_id: i?.product?.category_id ?? i?.product?.categories?.id ?? null,
          unit_price: q > 0 ? (Number(i?.lineTotal) || 0) / q : 0, quantity: q };
      });
      const r = applyOffers(lines, offers, { ignoreTiming: true, branchId: tillBranchId() });
      return { total: r.total, applied: r.applied };
    } catch { return none; }
  }

  handle('order:create', async (_event, orderPayload: any) => {
    // A519: paying a bill already open is never refused (finish what was started); a sale nobody opened needs "Sell".
    const refusedSale = sellRefusal('pay', sessionPerson(), isOpenBill(getLocalDb(), orderPayload?.order_number, openBills));
    if (refusedSale) { logLine('sale', `A519: refused a sale — ${sessionPerson()?.staffId ?? 'nobody'} has no Sell on this till`); throw new Error(refusedSale); }
    // A490: a discount given by hand needs sales.discount — the till is the authority here (offline too; the cloud never
    // refuses a till's sale for it). What offers took off is not the person's discount. Nothing else about selling asks.
    // A494: what the offers took is re-checked on THIS till's offers (the same engine the cart and the cloud use) — the
    // screen's figure is not trusted: a claimed offer discount above what the till's offers give is a hand discount.
    const claimed = Math.max(0, Number(orderPayload?.offer_discount) || 0);
    let offerOff = claimed;
    if (claimed > 0) {
      const till = tillOfferDiscount(orderPayload);
      if (claimed > till.total + 0.01) {
        logLine('sale', `A494: the screen claimed ${claimed} off for offers; this till's offers give ${till.total}`);
        offerOff = till.total;
        // The sale records what the till's offers gave, and which (the excess is part of the hand discount).
        if (till.total > 0) { orderPayload.offer_discount = till.total; orderPayload.offers = till.applied; }
        else { delete orderPayload.offer_discount; delete orderPayload.offers; }
      }
    }
    const manual = (Number(orderPayload?.discount_amount) || 0) - offerOff;
    if (manual > 0.004 && !signedInCan('sales.discount')) throw new Error('Your role does not give discounts. Remove the discount, or ask someone who may.');
    const askedNumber = orderPayload?.order_number ?? null;   // A503 (E1): A500 may renumber the sale
    const orderId = createLocalOrder(orderPayload);
    markKitchenPaid(orderPayload?.order_number);   // 0.6.28: its sent lines are paid for
    if (askedNumber && askedNumber !== orderPayload?.order_number) markKitchenPaid(askedNumber);
    // A299: event summary — id, total, method, item count. No line-item detail
    // or customer data (the DB + cloud are the record; this is the trail).
    logLine('sale', `created ${orderId} ${orderPayload?.total ?? '?'} `
      + `${orderPayload?.payments?.[0]?.method ?? orderPayload?.payment_method ?? ''} `
      + `x${orderPayload?.items?.length ?? 0}`.replace(/\s+/g, ' ').trim());
    lastOrderPayload = orderPayload;
    lastOrderBy = sessionPerson()?.staffId ?? null;   // A490
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
    // A456 (owner, 2026-10-12: "if i want to be printing 2 copies of a receipt that feature does not exist in the desktop
    // till"): the till's Copies setting reached only the Windows-printer route; a thermal receipt printed once. The
    // second copy (the merchant's) is queued after the first — the receipt only, never a second kitchen ticket.
    if (receiptCopies(orderPayload) === 2) {
      const second = queueThermal(orderPayload, ['receipt']);
      printed.failed.push(...second.failed.filter((x) => !printed.failed.includes(x)));
    }

    // A349: a ticket that could not be produced reaches the sale screen (a missing printer is not a failure — that is
    // "skipped", and a till with no receipt printer would otherwise be nagged on every sale).
    return { orderId, orderNumber: orderPayload?.order_number ?? null, printFailed: printed.failed };
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

  // A490: the branch access code (node_secret) only to a technician (or the install flow, before the till is set up) —
  // the screens never need it, and it opens the branch server to anyone holding it.
  handle('config:get', async () => {
    const cfg = getDeviceConfig();
    if (!cfg || !isConfigured() || getActiveSession()) return cfg;
    return { ...cfg, node_secret: null };
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
    // A490: the logo and colours are the receipt's and the business's look — receipt.manage or settings.business, or a
    // technician (who sets a till up before anyone signs in).
    if (!getActiveSession() && !signedInCan('receipt.manage', 'settings.business')) throw new Error('Only someone who manages the receipt or the business settings can change the branding.');
    const saved = setBranding(businessId, { accentHex, logoPng, logoRgba, receiptLogoEnabled });
    // A381: and to the branch server at once — the branch's other tills take it from there, with no internet too.
    if (hasNode() && !isNodeRole(getDeviceConfig()?.device_role ?? null)) {
      const b = getBranding();
      if (b) void relayBrandingToNode({ accentHex: b.accentHex, logoPng: b.logoPng, logoReceipt: b.logoReceipt, receiptLogoEnabled: b.receiptLogoEnabled });
    }
    // 0.6.25: and to the cloud (owner's decision), so the next pull does not put the old logo back. Never fails the save.
    const cloud = await queueBrandingPush().catch((e: any) => ({ state: 'pending' as const, message: String(e?.message ?? e) }));
    return { ...saved, cloud };
  });

  // A306: auto-update status for the renderer banner. Push is via update:status
  // (webContents.send from autoUpdate.ts); this is the poll the renderer runs on mount.
  handle('update:getStatus', async () => getUpdateStatus());
  // A496: why this till has (or has not) got its update — the status with its reason and the last 40 update log lines.
  handle('update:getDiagnostics', async () => getUpdateDiagnostics());
  // Apply a downloaded update now, NSIS progress visible + relaunch (A509's updater task where present); a no-op unless
  // an update is actually downloaded, so it can never half-restart a trading till.
  // A519 (owner, 2026-10-16, a manager asked for a PIN on the update bar: "its either we make it possible to restart
  // without the pin or we remove the ability totally … not needed pin confirmation and you are the manager"): ONE tap for
  // the person signed in when they are back office (manager, supervisor, owner — the A499 rule, isBackOffice of their
  // keys), or with a technician console open. Nobody else, and nobody signed in: refused here — their bar has no button
  // (it installs on close, and by itself when the till is idle, A508). The PIN path (the PIN restart channel and its
  // shifts.close_day rule, A490) is gone; the session is never switched. A restart closes no shift and no day (the
  // local database keeps them).
  handle('update:installNow', async () => {
    const me = sessionPerson();
    if (!getActiveSession() && !(me && personBackOffice(me.roleName, me.permissions))) {
      logLine('update', `A519: refused "Restart & update now" — ${me ? `${me.staffId} is not back office` : 'nobody signed in'}`);
      return { ok: false, reason: 'manager_required' };
    }
    logLine('update', `restart for the update by ${me ? (me.name ?? me.staffId) : 'the technician'}`);
    return installUpdateNow();
  });

  /**
   * A519: may this till take this terminal code at its branch? The cloud first (the branch's approved tills, this
   * machine's own earlier installs left out); else what the branch server's join answer said; else nothing refuses it.
   */
  async function checkTerminalCode(code: string, branchId: string): Promise<CodeVerdict> {
    let cloud: { in_use: string[]; suggestion?: string } | null = null;
    if (branchId) {
      try {
        const res = await tillFetch(`/api/support/terminal-codes?branch_id=${encodeURIComponent(branchId)}&code=${encodeURIComponent(normaliseCode(code))}`, {}, 8_000);
        if (res.ok) {
          const d: any = await res.json().catch(() => null);
          if (d && Array.isArray(d.in_use)) cloud = { in_use: d.in_use.map((c: unknown) => normaliseCode(c)), suggestion: typeof d.suggestion === 'string' ? d.suggestion : undefined };
        }
      } catch { /* offline / not signed in yet — the branch server's answer, or nothing */ }
    }
    return terminalCodeVerdict({ code, current: getDeviceConfig()?.terminal_code ?? null, cloud, server: joinCodesInUse });
  }
  // A519: the setup screen asks before it saves (and for the first free code to offer). Before the till is set up, or
  // with a technician console open — the same people who may write the till's identity (tillGates).
  handle('install:checkTerminalCode', async (_e, payload) => {
    const { code, branch_id } = assertPayload<{ code: string; branch_id?: string }>(
      { code: { t: 'string', min: 1 }, branch_id: { t: 'string', optional: true } }, payload);
    if (isConfigured() && !getActiveSession()) throw new Error('This till’s set-up changes only from the technician console.');
    return checkTerminalCode(code, branch_id || getDeviceConfig()?.branch_id || '');
  });

  handle('config:isConfigured', async () => {
    return isConfigured();
  });

  handle('config:save', async (_event, patch: any) => {
    // Audit 2026-10-14: the install flow writes the till's identity before anyone can sign in; once configured, that is
    // the technician console's, and each setting its own key's holder's (A490, tillGates.ts CONFIG_SETTING_KEY).
    const refusal = configSaveRefusal(patch ?? {}, {
      configured: isConfigured(),
      techSession: !!getActiveSession(),
      holds: (key) => signedInCan(key),   // A490: each setting by its own fine key
    });
    if (refusal) {
      logLine('config', `refused ${Object.keys(patch ?? {}).join(',') || '(empty)'}`);
      throw new Error(refusal);
    }
    // A519: a terminal code that CHANGES (setup's bind step, a technician) is checked against the branch's other tills;
    // a code that stays as it is is never refused — a till already trading keeps its code whatever a sibling uses.
    if (patch && patch.terminal_code !== undefined && patch.terminal_code !== null) {
      const v = await checkTerminalCode(String(patch.terminal_code), String(patch.branch_id ?? getDeviceConfig()?.branch_id ?? ''));
      if (!v.ok) {
        logLine('config', `A519: refused terminal code ${normaliseCode(patch.terminal_code)} — ${v.message}`);
        throw new Error(v.message ?? 'That terminal code cannot be used.');
      }
    }
    // A502: a till's branch server address and access code come only from Find my server (install:joinStatus saves
    // them before this) — never typed. A different address in a patch is dropped and logged; clearing it (null) stays.
    const cur = getDeviceConfig();
    const p = { ...(patch ?? {}) } as Record<string, unknown>;
    const roleAfter = String(p.device_role ?? cur?.device_role ?? 'till');
    if (!isNodeRole(roleAfter) && p.node_url != null && p.node_url !== (cur?.node_url ?? null)) {
      logLine('config', `A502: refused a typed branch server address (${String(p.node_url).slice(0, 60)}) — Find my server sets it`);
      delete p.node_url; delete p.node_secret;
    }
    const saved = saveDeviceConfig(p as any);
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
    // A500: never a number this machine already holds — a wiped / reinstalled till (its old code restored, its counter at
    // 0) carries on past the branch's copies of its earlier sales instead of minting T3--1 again (billNumber.ts).
    // No terminal code yet → the old unprefixed scheme, as before.
    // A519: a new bill number is a new sale — "Sell" (orders.create) on the person's own map; the number is then open.
    const refused = sellRefusal('number', sessionPerson(), false);
    if (refused) throw new Error(refused);
    const n = nextBillNumber(getLocalDb(), getDeviceConfig()?.terminal_code);
    openBills.note(n);
    return n;
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
  // A508: the screen is in use (a key, a click, a touch — the renderer sends at most one every 30 s, main takes at most
  // one every 30 s) and the sale screen's busy state (a cart, the payment screen). Fire-and-forget send/on like
  // log:renderer: no invoke, so no schema/parity entry; anything that is not that shape is ignored (activityTracker.ts).
  ipcMain.on('activity:ping', (_event, payload: unknown) => { try { noteRendererPing(payload); } catch { /* never */ } });

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
  // A490: the drawer's expected cash only to someone who may confirm drawers (shifts.confirm) — the banner still shows.
  handle('shift:stale', async () => {
    const s = getStaleShift();
    return s && !signedInCan('shifts.confirm') ? { ...s, expectedCash: null } : s;
  });

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
    try {
      let gate = checkDayGate();
      // A523: before telling the till it is locked, ask the cloud what it closed (a drawer force-closed on the web, a day
      // closed on the web or as abandoned) — adopted here, then the gate is read again. At most once a minute, at most
      // a few seconds' wait; offline the lock shows at once. An old day with nothing left to count already closed itself
      // inside checkDayGate (autoCloseEmptyDay).
      if (gate.needsManager && gate.staleDay && await learnBeforeLock()) gate = checkDayGate();
      return gate;
    }
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
  // A490: Close Branch is shifts.close_day — its overview (every till's figures) too.
  // A520: Close Branch is its own right, shifts.close_branch (a supervisor closes a till's day, not the branch). The
  // overview — every till's figures — is also read by the server's expense form (RecordExpenseForm), so close_day still
  // reads it; closing anything from it is close_branch.
  const CLOSE_REFUSED = 'Only someone who may close the branch can do this (Close the branch, in Roles and permissions).';
  handle('branchClose:overview', async () => {
    if (!mayCloseBranch() && !mayCloseDay()) return { error: CLOSE_REFUSED };
    try { return branchCloseOverview(); }
    catch (err: any) { return { error: err?.message ?? 'Could not read the branch state' }; }
  });
  handle('branchClose:closeTill', async (_e, { device_id, counted_cash, notes }:
    { device_id: string; counted_cash: number; notes?: string }) => {
    try {
      if (!mayCloseBranch()) return { ok: false, error: CLOSE_REFUSED };   // A520
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
      // A521 (#14): to a till that is not connected it is a close that waits for it (createCloseInstruction) — said so.
      const offline = peerIsStale(device_id);
      const { id } = createCloseInstruction(device_id, payload, staff?.staff_id ?? null);
      return { ok: true, instruction_id: id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not start the close' };
    }
  });
  // A452: a manager on the branch server confirms another till's shift — counted here, with the till's expected figures
  // on screen; the till itself records it (its own books), as when a manager confirms at that till.
  handle('branchClose:confirmShift', async (_e, payload) => {
    const { device_id, shift_id, counts, reasons } = assertPayload<{ device_id: string; shift_id: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { device_id: { t: 'string', min: 1 }, shift_id: { t: 'string', min: 1 }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    try {
      const confirmer = signedInConfirmer();
      if (!confirmer) return { ok: false, error: 'Only a manager (or the owner) signed in here can confirm a shift.' };
      const instr = { shift_id, counts, reasons: reasons ?? null, confirmer };
      if (device_id === getDeviceConfig()?.device_id) {
        const r = executeConfirmShift(instr);
        if (r.ok) pushNow();
        return r.ok ? { ok: true, self: true, summary: r.summary ?? null } : { ok: false, error: r.error };
      }
      const offline = peerIsStale(device_id);   // A521 (#13): kept for it however long it is off — and said so
      const { id } = createConfirmInstruction(device_id, instr, confirmer.id);
      logLine('branchClose', `A452 confirm of shift ${shift_id} sent to ${device_id} by ${confirmer.name ?? confirmer.id}${offline ? ' (not connected — applies when it reconnects)' : ''}`);
      return { ok: true, instruction_id: id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not confirm the shift' };
    }
  });
  // A465 (owner, 2026-10-13): a manager on the BRANCH SERVER records a cash in, cash out or expense on ANY running shift
  // of the branch. The server never writes another till's row: it queues an instruction that till collects (~15 s) and
  // records on its own books — its Z-report, its push and Close Branch stay one story. The server's own drawer: at once.
  handle('branchClose:shiftMoney', async (_e, payload) => {
    const p = assertPayload<{ device_id: string; shift_id: string; kind: 'float_in' | 'float_out' | 'expense'; amount: number;
      reason?: string; description?: string; expense_category_id?: string; category_name?: string; payment_method?: string }>({
      device_id: { t: 'string', min: 1 }, shift_id: { t: 'string', min: 1 }, kind: { t: 'enum', values: ['float_in', 'float_out', 'expense'] },
      amount: { t: 'number' }, reason: { t: 'string', optional: true }, description: { t: 'string', optional: true },
      expense_category_id: { t: 'string', optional: true }, category_name: { t: 'string', optional: true }, payment_method: { t: 'string', optional: true },
    }, payload);
    try {
      const cfg = getDeviceConfig();
      if (!isNodeRole(cfg?.device_role)) return { ok: false, error: 'Only the branch server records money on another till\'s shift.' };
      // A manager signed in here approves it as themselves (A388); A453's manager-only switch always lets a manager through.
      // A490: approving is shifts.confirm; recording money is shifts.cash_movements (before migration 134, the switch rule).
      const me = signedInConfirmer();
      if (!me || !mayMoveMoney(sessionPerson(), getPosFeatures().cashier_no_money_out)) return { ok: false, error: 'Only a manager who may approve and record cash movements, signed in here, can do this.' };
      const amount = Math.round(Number(p.amount) * 100) / 100;
      if (!(amount > 0)) return { ok: false, error: 'Enter an amount greater than zero.' };
      if (p.kind === 'expense' && !String(p.description ?? '').trim()) return { ok: false, error: 'Description is required.' };
      const isSelf = p.device_id === cfg?.device_id;
      if (isSelf) {
        if (!ownOpenShift(p.shift_id)) return { ok: false, error: SHIFT_MONEY_CLOSED };
      } else {
        // Only to a till whose last report shows this shift open. A521 (#13, owner 2026-10-17: "never wait on an absent
        // till … queue the rest for when it reconnects"): a till that is off is no longer refused — the row waits for it
        // (no 24-h expiry; Cancel withdraws it until the till picks it up) and the manager is told it applies on reconnect.
        // A till that closed that shift meanwhile refuses it with its reason (SHIFT_MONEY_CLOSED), shown on the screen.
        const row = getLocalDb().prepare(`SELECT state, updated_at FROM node_peer_state WHERE device_id = ?`).get(p.device_id) as { state: string; updated_at: string } | undefined;
        if (!row) return { ok: false, error: 'That till has never reported to this server — check it is on' };
        let st: PeerDayState | null = null;
        try { st = JSON.parse(row.state); } catch { /* unreadable */ }
        if (!st?.shifts) return { ok: false, error: 'That till is on an older version — update it to record money on it from here.' };
        if (!st.shifts.some((s) => s.id === p.shift_id && s.state === 'open')) return { ok: false, error: 'That shift is no longer open on its till.' };
      }
      const instr: ShiftMoneyPayload = {
        row_id: uuid(), shift_id: p.shift_id, kind: p.kind, amount,
        reason: p.kind === 'expense' ? null : (String(p.reason ?? '').trim().slice(0, 200) || null),
        description: p.kind === 'expense' ? String(p.description).trim().slice(0, 200) : null,
        expense_category_id: p.kind === 'expense' ? (p.expense_category_id || null) : null,
        category_name: p.kind === 'expense' ? (p.category_name ?? null) : null,
        payment_method: p.kind === 'expense' ? (p.payment_method || 'cash') : null,
        approver: me, recorded_by: me,
      };
      const what = `${p.kind === 'expense' ? 'expense' : p.kind === 'float_in' ? 'cash in' : 'cash out'} ${amount}`;
      if (isSelf) {
        const r = executeShiftMoney(instr);
        if (!r.ok) return { ok: false, error: r.error };
        pushNow();
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('shift:changedElsewhere', { id: p.shift_id, kind: p.kind });
        }
        logLine('branchClose', `A465 ${what} on this server's shift ${p.shift_id} by ${me.name ?? me.id}`);
        return { ok: true, row_id: instr.row_id, direct: true, summary: r.summary ?? null };
      }
      const offline = peerIsStale(p.device_id);   // A521
      const { id } = createShiftMoneyInstruction(p.device_id, instr, me.id);
      logLine('branchClose', `A465 ${what} on shift ${p.shift_id} sent to ${p.device_id} by ${me.name ?? me.id}${offline ? ' (not connected — applies when it reconnects)' : ''}`);
      return { ok: true, instruction_id: id, row_id: instr.row_id, ...(offline ? { queued_offline: true, message: TILL_OFF_NOTE } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not record it' };
    }
  });
  // F4 (2026-10-14): "Forget this till" — a till gone for good (replaced, moved) leaves Close Branch at once. Its history
  // stays (the branch's data). A521 (#3): named "Revoke this till" for what it does — its device key and its right to
  // reconnect go with it, so it is refused on every route until it joins again (Find my server). The screen said "it
  // comes back if it reports again"; it could not report. A till only off for a while is hidden instead (hideTill).
  handle('branchClose:forgetTill', async (_e, payload) => {
    const { device_id } = assertPayload<{ device_id: string }>({ device_id: { t: 'string', min: 1 } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) return { ok: false, error: 'Only the branch server revokes a till.' };
    if (!mayCloseBranch()) return { ok: false, error: 'Only someone who may close the branch can revoke a till.' };   // A520
    if (!forgetTill(device_id)) return { ok: false, error: 'That till cannot be revoked here.' };
    logLine('branchClose', `F4/A521 till ${device_id} revoked by a manager (its device key removed — it joins again to reconnect)`);
    return { ok: true };
  });
  // A521 (#3): "Hide from Close Branch" — off the list until it next reports; its key, its right to reconnect and what
  // waits for it are kept.
  handle('branchClose:hideTill', async (_e, payload) => {
    const { device_id } = assertPayload<{ device_id: string }>({ device_id: { t: 'string', min: 1 } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role)) return { ok: false, error: 'Only the branch server hides a till.' };
    if (!mayCloseBranch()) return { ok: false, error: 'Only someone who may close the branch can hide a till.' };
    if (!hideTill(device_id)) return { ok: false, error: 'That till cannot be hidden here.' };
    logLine('branchClose', `A521 till ${device_id} hidden from Close Branch by a manager (until it next reports)`);
    return { ok: true };
  });
  // A465: withdraw one the till has not answered yet.
  handle('branchClose:cancelShiftMoney', async (_e, payload) => {
    const { instruction_id } = assertPayload<{ instruction_id: number }>({ instruction_id: { t: 'number' } }, payload);
    if (!isNodeRole(getDeviceConfig()?.device_role) || !signedInConfirmer()) return { ok: false, error: 'Only a manager on the branch server can do this.' };
    const removed = cancelShiftMoneyInstruction(instruction_id);
    if (removed) logLine('branchClose', `A465 instruction ${instruction_id} withdrawn`);
    return removed ? { ok: true } : { ok: false, error: 'The till has already answered — it cannot be withdrawn now.' };
  });
  // A452: Close Branch — every till's day, once no drawer is open and no shift waits for a manager (owner: "when all
  // shifts are closed and confirmed they get a close branch"). No second count: each till closes with its confirmed
  // shifts' cash. The server's date is final — a till still on yesterday closes that day too.
  handle('branchClose:closeBranch', async (_e, payload) => {
    const { notes, totals_confirmed, without_tills } = assertPayload<{ notes?: string; totals_confirmed?: boolean; without_tills?: string[] }>(
      { notes: { t: 'string', optional: true }, totals_confirmed: { t: 'boolean', optional: true }, without_tills: { t: 'stringArray', optional: true } }, payload ?? {});
    try {
      if (!mayCloseBranch()) return { ok: false, error: CLOSE_REFUSED };   // A520: shifts.close_branch
      const ov = branchCloseOverview();
      // A520: one rule with the screen (branchClose.assessBranchClose). A till not heard from no longer holds the close
      // unless its last report shows money a person must deal with (a drawer open, a shift to confirm) — the KRUNCH
      // deadlock: switched-on tills locked on an old day were "not heard from" and nothing could close.
      // A521 (#1, owner 2026-10-17: "where money is involved a manager may go ahead with a clear warning naming whose cash
      // is not in tonight's totals"): another till's money no longer stops everything — the manager ticks its warning
      // (without_tills) and the branch closes without it: this terminal's own day and every other till close, and that
      // till is left a close that waits for its money (it answers "not yet" until the drawer is closed and confirmed).
      // This terminal's own money is never gone past. Nothing of another till's ever stops the server's own close.
      const { held, without } = ov.close;
      const ticked = new Set((without_tills ?? []).filter((id) => without.some((w) => w.device_id === id)));
      const blockers = unresolvedBlockers(ov.close, ticked);
      if (blockers.length) return { ok: false, error: `The branch cannot close yet: ${blockers.join('; ')}.`, blockers,
        ...(without.some((w) => !ticked.has(w.device_id)) ? { code: 'TILLS_WITH_MONEY', without: without.filter((w) => !ticked.has(w.device_id)) } : {}) };
      const heldBy = new Map(held.map((h) => [h.device_id, h]));
      // A458: then the manager confirms the day's totals per payment method (the confirmed shifts added up).
      if (totals_confirmed !== true) return { ok: false, error: 'Check the day\'s totals by payment method and tick that they are right before closing the branch.', code: 'TOTALS_NOT_CONFIRMED' };
      const staff = getLocalDb().prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as any;
      const base = { business_date: businessDateNow(), counted_cash: null, notes, closed_by_staff_id: staff?.staff_id ?? null, closed_by_name: staff?.staff_name ?? null };
      const results: Array<{ device_id: string; ok: boolean; sent?: boolean; held?: boolean; without?: boolean; skipped?: boolean; error?: string }> = [];
      // This terminal's own day first — whatever any other till's close does after it.
      for (const t of ov.tills.filter((x) => x.is_self)) {
        if (!(t.state as PeerDayState | null)?.day_open) continue;
        const r = executeCloseDay(base);
        results.push({ device_id: t.device_id, ok: r.ok, error: r.error });
      }
      for (const t of ov.tills.filter((x) => !x.is_self)) {
        const st = t.state as PeerDayState | null;
        const h = heldBy.get(t.device_id);
        if (ticked.has(t.device_id)) {
          // A521: closed WITHOUT it — a close that waits for its money (an older build is sent nothing: no `shifts`).
          if (st?.shifts) createCloseInstruction(t.device_id, { ...base, wait_for_till: true }, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, without: true, sent: !!st?.shifts, held: true });
          continue;
        }
        if (h && h.close === false) { results.push({ device_id: t.device_id, ok: true, held: true, skipped: true }); continue; }
        if (!st?.day_open) continue;
        if (h) {
          // A520: not connected — a close that waits for it (no 24-h expiry); it closes its open day(s) when it next polls.
          createCloseInstruction(t.device_id, { ...base, wait_for_till: true }, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, sent: true, held: true });
        } else {
          createCloseInstruction(t.device_id, base, staff?.staff_id ?? null);
          results.push({ device_id: t.device_id, ok: true, sent: true });
        }
      }
      const dayTotals = ov.totals.methods.map((l) => `${l.method} ${l.confirmed}`).join(', ');   // A458
      logLine('branchClose', `A452 branch close by ${staff?.staff_name ?? 'a manager'} (totals confirmed: ${dayTotals || 'none'}): ${results.map((r) => `${r.device_id.slice(0, 8)}=${r.ok ? (r.without ? 'closed WITHOUT it (money waits there)' : r.skipped ? 'not sent (older build / never reported)' : r.held ? 'held for when it connects' : r.sent ? 'sent' : 'closed') : 'refused'}`).join(', ') || 'nothing open'}`);
      for (const w of without.filter((x) => ticked.has(x.device_id))) logLine('branchClose', `A521 manager ${staff?.staff_name ?? '?'} went past: ${w.warning}`);
      return { ok: results.every((r) => r.ok), results };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not close the branch' };
    }
  });
  // A490: the day's figures — reports.sales, or someone who closes the day.
  handle('day:summary', async () => {
    requireKey(['reports.sales', 'shifts.close_day'], 'Your role does not see the day’s figures.');
    return getDayCloseSummary();
  });
  // The channel keeps its name (older screens ask it); it answers "may close the day" (shifts.close_day) — A490.
  handle('day:isManager', async () => mayCloseDay());
  handle('day:conflicts', async () => getConflictedShifts());
  handle('day:retryConflict', async (_e, { shiftId }: { shiftId: string }) => {
    if (!mayCloseDay()) return { ok: false, error: 'Only someone who may close the day can retry this.' };   // A490
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
    // Audit 2026-10-14: enforced HERE, not only by hiding the button. A490: shifts.force_close (the owner always).
    requireKey(['shifts.force_close'], 'Only someone who may force-close a drawer can do that.');
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
    // A490: shifts.cash_movements (before migration 134: A453's 'cashier_no_money_out' switch, unless they may confirm).
    if (!mayMoveMoney(sessionPerson(), getPosFeatures().cashier_no_money_out)) throw new Error(MONEY_MOVEMENT_MANAGER_ONLY);
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
  // Who may confirm: A490 — shifts.confirm (tillAccess; the owner's role always; an older map's orders.void / shifts.manage /
  // settings.manage expand to it) — the cloud's mayConfirm. The PIN goes to an AUTHORITY first (the branch node, then the cloud); only when none can be
  // reached does the till's own saved sign-in answer. A "no" from an authority is final (same chain as sign-in, A17).
  const mayConfirmLocal = (staff: PersonLike) => personCan(staff, 'shifts.confirm');
  const NOT_A_CONFIRMER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  // 0.6.37 (A388): a cash-out or an expense with no manager signed in and no PIN.
  const PAYOUT_APPROVAL_NEEDED = 'A manager must approve this — enter a manager’s PIN.';
  // A494: every manager-PIN prompt (shift confirmation, cash out, expenses, kitchen voids) asks the till's PIN limiter
  // first, and a PIN that does not approve counts toward its lockout — whoever said no (the server, the cloud, the till).
  async function identifyConfirmer(pin: string): Promise<{ id: string; name: string | null }> {
    assertPinAllowed();
    try { return await identifyConfirmerChecked(pin); }
    catch (e: any) { if (e?.message === NOT_A_CONFIRMER) recordPinFailure(); throw e; }
  }
  async function identifyConfirmerChecked(pin: string): Promise<{ id: string; name: string | null }> {
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
      res = await tillFetch('/api/shifts/confirmer', {
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
      const n = verifyPinAtNode(pin, branchId);
      if (n.ok) return local(n.staff);
      // A415: no roster yet → this till's saved sign-ins, as on any till.
      if (n.reason !== 'no_roster' && n.reason !== 'unavailable') throw new Error(n.reason === 'no_match' ? NOT_A_CONFIRMER : n.message);
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
  // A452: the expected figures only to a manager signed in here — never to the cashier whose shift it is (blind close).
  handle('shift:confirmView', async (_event, shiftId: string) => {
    const v = confirmView(String(shiftId));
    return signedInConfirmer() ? v : { ...v, expected: null };
  });

  // ── A433 (owner, 2026-10-10: "yes if they have logged in as the manager, and under sales report it should cover all
  // tills"): another till's shifts, from the cloud, with the manager's own sign-in (manageFetch — never the till's
  // session, A415). This till's own shifts keep the local calls above (they work offline and push as before).
  // A490: the branch's shifts and their reports — reports.shifts, or someone who confirms drawers.
  const SHIFTS_REFUSED = 'Your role does not see shift reports.';
  handle('manager:branchShifts', async () => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    const own = getDeviceConfig()?.device_id ?? null;
    const rows = await manageFetch('/api/shifts?limit=60', 'GET') as any[];
    return (rows ?? []).map((s) => ({
      id: s.id, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at ?? null,
      cashier_name: s.cashier_name ?? null, expected_cash: s.expected_cash ?? null, cash_variance: s.cash_variance ?? null,
      till: s.terminal_code || (s.device_id ? 'Till' : 'Web Till'),
      this_till: !!own && s.device_id === own,
      awaiting: !!s.awaiting_confirmation,
    }));
  });
  handle('manager:remoteZReport', async (_e, shiftId: string) => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    const z = await manageFetch(`/api/shifts/${encodeURIComponent(String(shiftId))}/zreport`, 'GET');
    const session = getLocalDb().prepare(`SELECT business_name, currency FROM session WHERE id=1`).get() as any;
    return { ...z, businessName: session?.business_name ?? '', currency: session?.currency ?? 'KES' };
  });
  handle('shift:remoteConfirmView', async (_e, shiftId: string) => {
    requireKey(['shifts.confirm'], 'Only someone who confirms drawers sees that.');   // A490: it carries the expected figures
    return manageFetch(`/api/shifts/${encodeURIComponent(String(shiftId))}/confirm-view`, 'GET');
  });
  handle('shift:remoteConfirm', async (_event, payload) => {
    const { shiftId, pin, counts, reasons } = assertPayload<{ shiftId: string; pin?: string; counts: Record<string, number>; reasons?: Record<string, string> }>(
      { shiftId: { t: 'string', min: 1 }, pin: { t: 'string', optional: true }, counts: { t: 'any' }, reasons: { t: 'any', optional: true } }, payload);
    const me = signedInConfirmer();
    if (!me && !String(pin ?? '').trim()) throw new Error('Enter the PIN of a manager (or the owner) on duty.');
    // manager-confirm: a person's sign-in only (never the device token), and never `confirmed_by` — that is the holding
    // till's replay of its OWN shift. The cloud takes the signed-in manager, or the PIN.
    const r = await manageFetch(`/api/shifts/${encodeURIComponent(shiftId)}/manager-confirm`, 'POST', {
      confirmed_methods: counts, ...(reasons ? { confirm_reasons: reasons } : {}), ...(String(pin ?? '').trim() ? { pin: String(pin).trim() } : {}),
    });
    logLine('shift', `A433 shift ${shiftId} (another till) confirmed on the cloud by ${r?.confirmer_name ?? me?.name ?? 'a manager'}`);
    return {
      shift_id: shiftId, confirmed_by: r?.confirmed_by ?? me?.id ?? '', confirmed_by_name: r?.confirmer_name ?? me?.name ?? null,
      confirmed_at: r?.confirmed_at ?? new Date().toISOString(), self: !!r?.confirm_self, lines: r?.lines ?? [],
    };
  });

  // ── 0.6.28: Send to kitchen is recorded; sent items come back only as a recorded kitchen void ────────────────────
  // Owner, 2026-10-01: a sent order cancelled after the customer paid in cash — "the cashier pockets the money". Every
  // sent item ends paid (order:create → markKitchenPaid) or voided here. See kitchenService.ts.
  handle('kitchen:sent', async (_event, payload) => {
    const { order_number, lines, order_type, table_number } = assertPayload<{
      order_number: string; lines: unknown; order_type?: string; table_number?: string;
    }>({ order_number: { t: 'string', min: 1 }, lines: { t: 'any' }, order_type: { t: 'string', optional: true },
         table_number: { t: 'string', optional: true } }, payload);
    const refusedSend = sellRefusal('kitchen', sessionPerson(), isOpenBill(getLocalDb(), order_number, openBills));   // A519
    if (refusedSend) throw new Error(refusedSend);
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

  // A490: any shift's report — reports.shifts or shifts.confirm. A cashier gets their OWN shift's report, blind when
  // their close is (the same report shift:close hands them).
  handle('shift:zreport', async (_event, shiftId: string) => {
    const me = sessionPerson();
    if (!me) throw new Error('Sign in to see a shift report.');
    const seesAny = personCan(me, 'reports.shifts', 'shifts.confirm');
    if (!seesAny) {
      const row = getLocalDb().prepare(`SELECT cashier_id, opened_by FROM shifts WHERE id = ?`).get(String(shiftId)) as { cashier_id?: string | null; opened_by?: string | null } | undefined;
      if (!row || (row.cashier_id !== me.staffId && row.opened_by !== me.staffId)) throw new Error(SHIFTS_REFUSED);
    }
    const z = computeZReport(shiftId, await fetchForeignCash(shiftId));   // A334
    return !seesAny && blindClose() ? blindReport(z) : z;
  });

  // 0.6.11 (owner: "I should be able to print previous shift reports") — this till's shifts, newest first.
  // Each opens through shift:zreport above, which already rebuilds any shift's report from local data. A490: the list of
  // every shift is reports.shifts / shifts.confirm.
  handle('shift:history', async () => {
    requireKey(['reports.shifts', 'shifts.confirm'], SHIFTS_REFUSED);
    return listShifts(60);
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
        const res = await withinMs(tillFetch('/api/auth/verify-pin', {
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
   * tillFetch has had exactly this branch since it was written. The two
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
  async function manageFetch(path: string, method: string, body?: any, opts?: { binary?: boolean }) {
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
      signal: AbortSignal.timeout(20_000),   // A446: a time limit — a manager's change never hangs
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

    // A466: a file from the cloud (the monthly pack's Excel) — its bytes and the name the cloud gave it.
    if (opts?.binary && res.ok) {
      return { bytes: Buffer.from(await res.arrayBuffer()), disposition: res.headers.get('content-disposition') };
    }

    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (!res.ok) {
      // A197: the cloud's code travels with the message (a screen offers the right next step — e.g. same_user_receipt).
      const err: Error & { code?: string | null; status?: number } = new Error(res.status === 403 && !data?.code
        ? 'Your role does not allow this change.' : (data?.error ?? `Request failed (${res.status})`));
      err.code = data?.code ?? null; err.status = res.status;
      throw err;
    }
    return data;
  }

  // A catalogue write is pointless until the till re-reads it, so pull straight
  // after. Failure here is non-fatal — the edit landed on the server and the
  // next scheduled sync will collect it.
  async function refreshCatalogue() {
    try { await syncAll(); } catch (e: any) { console.warn('[manage] post-edit sync failed:', e?.message); }
  }

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
  /** A list from the cloud (or this till), with this till's changes that still wait laid over it — so the screen shows
   *  what the till sells: a change made here, a new item made here, each marked (waiting / with the owner / refused). */
  function overlayOnList(entity: 'product' | 'category' | 'staff', rows: any[]): any[] {
    const list = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    const open = getLocalDb().prepare(`SELECT entity_id, op, data, state, message FROM local_changes WHERE entity = ? AND state IN ('pending', 'awaiting') ORDER BY made_at`)
      .all(entity) as Array<{ entity_id: string; op: string; data: string; state: string; message: string | null }>;
    for (const c of open) {
      const data = JSON.parse(c.data);
      delete data.pin; delete data.pin_hash_enc; delete data.permissions;
      const i = list.findIndex((r) => r.id === c.entity_id);
      if (c.op === 'delete') { if (i >= 0) { if (entity === 'product') list[i].status = 'inactive'; else list.splice(i, 1); } continue; }
      if (i >= 0) Object.assign(list[i], data, { change_state: c.state, change_message: c.message });
      else list.push({ id: c.entity_id, status: 'active', ...data, change_state: c.state, change_message: c.message });
    }
    return list;
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

  // A448: the menu is saved on this till first (it sells the new way at once, offline too) and reaches the cloud after
  // (changeQueue.ts). What the till cannot hold yet — a picture, sizes, extras, fuel, sold by the piece — still goes to
  // the cloud first, as before.
  // A490: the menu's screens — reading it is products.view (or any menu key); cost prices only to menu.costs / reports.costs
  // (taken out, not merely hidden). Each write asks its own key (changeQueue changeKeys) — here first, so a cashier gets
  // a clear refusal without a cloud round trip, and on the till-first path inside recordTillChange.
  const MENU_READ = ['products.view', 'menu.edit', 'menu.prices', 'menu.offers', 'menu.costs'];
  const MENU_REFUSED = 'Your role does not allow this menu change.';
  const COST_FIELDS = ['cost_price', 'cost', 'unit_cost', 'margin', 'margin_pct', 'food_cost', 'food_cost_pct'];
  const withoutCosts = (rows: any): any => {
    if (signedInCan('menu.costs', 'reports.costs') || !Array.isArray(rows)) return rows;
    return rows.map((r) => { if (!r || typeof r !== 'object') return r; const o = { ...r }; for (const k of COST_FIELDS) delete o[k]; return o; });
  };
  const requireMenuChange = (op: 'create' | 'update', data: any) => {
    const keys = changeKeys('product', op, data && typeof data === 'object' ? data : null);
    if (!keys.every((k) => signedInCan(k))) throw new Error(MENU_REFUSED);
  };
  handle('manage:listProducts', async () => {
    requireKey(MENU_READ, NOT_ALLOWED);
    try { return withoutCosts(overlayOnList('product', await manageFetch('/api/products', 'GET'))); }
    catch { return withoutCosts(overlayOnList('product', localProductsForScreen())); }
  });
  // A494: a cost price set on a new product is menu.costs (tillChanges.changeKeys asks it of an update only).
  const hasCost = (p: any) => !!p && typeof p === 'object' && p.cost_price !== undefined && p.cost_price !== null && p.cost_price !== '';
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
  // A490: the business's own payment methods — settings.payments.
  const PAYMENTS_REFUSED = 'Only someone who manages payment methods can change them.';
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

  // ── A414: wastage recorded on the till — saved here first, sent to the cloud now or at the next sync ──────────────
  // Items: the cloud's list (with what the branch holds) when it can be reached, kept for offline use; else the last one
  // kept; else this till's own products. Ingredients come only from the cloud's list.
  const WASTE_REFUSED = 'Your role does not allow recording wastage.';
  handle('wastage:items', async () => {
    requireKey(['inventory.waste'], WASTE_REFUSED);   // A490: the list carries what the branch holds and its cost
    const db = getLocalDb();
    const branch = (db.prepare(`SELECT branch_id FROM staff_session WHERE id = 1`).get() as { branch_id?: string } | undefined)?.branch_id
      ?? getDeviceConfig()?.branch_id ?? '';
    try {
      const items = await manageFetch(`/api/wastage/items?branch_id=${encodeURIComponent(branch)}`, 'GET') as any[];
      db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
        .run(WASTE_ITEMS_KEY, JSON.stringify(items ?? []), new Date().toISOString());
      return { source: 'cloud', items: withoutCosts(items ?? []) };
    } catch {
      const kept = db.prepare(`SELECT value, updated_at FROM maintenance_state WHERE key = ?`).get(WASTE_ITEMS_KEY) as { value: string; updated_at: string } | undefined;
      if (kept?.value) { try { return { source: 'saved', saved_at: kept.updated_at, items: withoutCosts(JSON.parse(kept.value)) }; } catch { /* fall through */ } }
      // branch-wide: this till's own product list (the catalogue is the business's)
      const rows = db.prepare(`SELECT id, name, track_stock FROM products WHERE status = 'active' ORDER BY name`).all() as Array<{ id: string; name: string; track_stock: number }>;
      return { source: 'till', items: rows.map((p) => ({ kind: 'product', id: p.id, name: p.name, unit: null, by_piece: false, stocked: p.track_stock === 1, held: null, cost: null })) };
    }
  });
  handle('wastage:record', async (_e, payload: { reason: string; note?: string; items: any[] }) => {
    requireOnlineLicence();   // A460
    const db = getLocalDb();
    const staff = db.prepare(`SELECT staff_name, role_name, permissions, branch_id FROM staff_session WHERE id = 1`).get() as
      { staff_name: string; role_name: string | null; permissions: string; branch_id: string } | undefined;
    if (!staff) throw new Error('Not signed in');
    if (!mayWaste(staff.role_name, staff.permissions)) throw new Error('Your role does not allow recording wastage.');
    const items: WasteItem[] = (payload.items ?? []).map((i: any) => ({
      kind: i?.kind === 'ingredient' ? 'ingredient' : 'product', id: String(i?.id ?? ''), name: String(i?.name ?? ''), quantity: Number(i?.quantity),
    }));
    const rec = { client_id: uuid(), branch_id: staff.branch_id, reason: String(payload.reason ?? ''), note: String(payload.note ?? '').trim().slice(0, 300),
      items, recorded_by_name: staff.staff_name, recorded_at: new Date().toISOString() };
    const problem = recordingProblem(rec);
    if (problem) throw new Error(problem);
    queueRecording(db, rec);
    const outcome = (await pushWastageNow())[rec.client_id];
    return { client_id: rec.client_id, ...(outcome ?? { state: 'pending', message: 'Saved on this till — it goes to the cloud at the next sync.' }) };
  });
  handle('wastage:state', async () => {
    const db = getLocalDb();
    return { pending: readPendingWaste(db), refused: readRefusedWaste(db) };
  });
  handle('wastage:dismiss', async (_e, clientId: string) => { requireKey(['inventory.waste'], WASTE_REFUSED); dismissRefused(getLocalDb(), String(clientId)); return { ok: true }; });
  // A413: expired / expiring batches at this branch — the cloud's list; offline it says so.
  handle('batches:expiring', async () => {
    if (!signedInCan('inventory.view')) return { online: false, message: 'Your role does not see stock.' };   // A490
    try { return { online: true, ...(await manageFetch('/api/batches?soon_days=7', 'GET') as object) }; }
    catch (e: any) { return { online: false, message: e?.message ?? 'Could not reach the cloud.' }; }
  });

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

  // A490: the staff list is staff.view; adding and changing staff staff.edit — never with more rights than the person
  // making the change holds (the A340 ceiling, by permission: keysBeyond), never the owner's role.
  const STAFF_REFUSED = 'Your role does not add or change staff.';
  const savedRoles = (): any[] => { try { const v = JSON.parse((getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as any)?.value ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  /** The person this till holds under that id (its staff list, else its saved sign-ins), for "never someone more powerful". */
  const heldPerson = (id: string): PersonLike | null => {
    const db = getLocalDb();
    const r = (db.prepare(`SELECT role_name, permissions FROM branch_staff WHERE staff_id = ?`).get(id)
      ?? db.prepare(`SELECT role_name, permissions FROM staff_pin_cache WHERE staff_id = ?`).get(id)) as { role_name?: string | null; permissions?: string | null } | undefined;
    return r ? { roleName: r.role_name ?? null, permissions: r.permissions ?? '{}' } : null;
  };
  const requireStaffChange = (opts: { roleId?: unknown; targetId?: string | null }) => {
    const me = sessionPerson();
    if (!me || !personCan(me, 'staff.edit')) throw new Error(STAFF_REFUSED);
    if (opts.roleId !== undefined && opts.roleId !== null && opts.roleId !== '') {
      const role = savedRoles().find((r) => r?.id === opts.roleId);
      if (role) { const why = roleCeilingRefusal(me, role); if (why) throw new Error(why); }
      // A role this till has not saved: the cloud decides (it checks the same ceiling).
    }
    if (opts.targetId && !mayActOn(me, heldPerson(String(opts.targetId)))) throw new Error('That person holds more rights than you — only the owner (or someone who holds as much) can change them.');
  };
  handle('manage:listStaff', async () => { requireKey(['staff.view', 'staff.edit'], 'Your role does not see the staff list.'); return overlayOnList('staff', await manageFetch('/api/staff', 'GET')); });
  // A448: the roles are kept on this till too, so a cashier can be added offline with their role's name and permissions.
  handle('manage:listRoles', async () => {
    requireKey(['staff.view', 'staff.edit'], 'Your role does not see the staff list.');   // A490
    try {
      const roles = await manageFetch('/api/staff/roles', 'GET');
      getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`)
        .run(JSON.stringify(roles ?? []), new Date().toISOString());
      return roles;
    } catch (e) {
      const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as { value?: string } | undefined;
      if (row?.value) return JSON.parse(row.value);
      throw e;
    }
  });
  // A448 (owner, 2026-10-12: "offline supersedes online when it comes to PIN change"): a staff member's PIN set on this
  // till works here at once (and on the branch's other tills through the branch server), and wins on the cloud — unless
  // another person has that PIN, when the owner is told.
  handle('manage:setStaffPin', async (_e, { id, pin }: { id: string; pin: string }) => {
    requireStaffChange({ targetId: String(id) });   // A490
    recordTillChange({ entity: 'staff_pin', op: 'update', entity_id: String(id), data: { pin: String(pin) } });
    return { ok: true };
  });
  // A446: a staff member created or changed here reaches this till's own list at once, and the branch server's (so its
  // other tills): the cashier signs in anywhere at the branch within seconds — not after the next menu pull.
  handle('manage:createStaff', async (_e, payload: any) => {
    // A448: a cashier (name, PIN, role) is added on this till first — they sign in here at once, offline too. An override
    // PIN or an email still needs the cloud first.
    // Only for a role this till has saved (it gives the new cashier their permissions here); otherwise the cloud, as before.
    // A490: staff.edit, and never a role that can do more than the person adding (nor the owner's role) — this closes the
    // hole where anyone who could manage staff created an owner on this till, signed in here at once, offline.
    requireStaffChange({ roleId: payload?.role_id });
    const roles = savedRoles();
    const role = payload?.role_id ? roles.find((r) => r?.id === payload.role_id) : null;
    if (role && !payload?.override_pin && !payload?.email) {
      const perms = roleMap(role);   // A490: the role's map as the cloud sends it (fine keys and the marker, or the older list)
      const ch = recordTillChange({ entity: 'staff', op: 'create', data: { name: payload?.name, role_id: payload?.role_id, pin: payload?.pin } },
        { roleName: role?.name ?? null, permissions: perms });
      return { id: ch.entity_id, name: ch.data.name, role_id: ch.data.role_id, change_state: 'pending' };
    }
    const out = await manageFetch('/api/staff', 'POST', payload);
    void staffChangedHere();
    return out;
  });
  // ── A197: stock transfers between branches, on the till (online licence; inventory.transfer) ──────────────────────
  // Owner, 2026-10-13: "A197 … add it yes but it's tied to the online licence just like stock … inside the stock tab".
  // The cloud does the work (routes/stock.ts: pending → in_transit → received / cancelled; stock moves on each step).
  const transferBranch = (): string | null => {
    const st = getLocalDb().prepare(`SELECT branch_id FROM staff_session WHERE id=1`).get() as { branch_id?: string } | undefined;
    return st?.branch_id || getDeviceConfig()?.branch_id || null;
  };
  const transferAnswer = async (fn: () => Promise<any>) => {
    try { return { ok: true, data: await fn() }; }
    catch (e: any) { return { ok: false, error: e?.message ?? 'Could not reach the cloud', code: e?.code ?? null }; }
  };
  // A490: stock transfers — inventory.transfer.
  const TRANSFER_REFUSED = 'Your role does not transfer stock.';
  handle('transfers:list', async () => {
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const branch = transferBranch();
    if (!branch) return { ok: false, error: 'This till is not bound to a branch.' };
    const r = await transferAnswer(() => manageFetch(`/api/stock/transfers?branch_id=${encodeURIComponent(branch)}&limit=100`, 'GET'));
    return r.ok ? { ...r, branch_id: branch } : r;
  });
  handle('transfers:branches', async () => {
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const branch = transferBranch();
    return transferAnswer(async () => ((await manageFetch('/api/branches', 'GET')) ?? []).filter((b: any) => b.id !== branch)
      .map((b: any) => ({ id: b.id, name: b.name })));
  });
  handle('transfers:create', async (_e, payload) => {
    const { to_branch_id, notes, items } = assertPayload<{ to_branch_id: string; notes?: string; items: Array<{ product_id: string; quantity: number }> }>(
      { to_branch_id: { t: 'string', min: 1 }, notes: { t: 'string', optional: true }, items: { t: 'any' } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    const from = transferBranch();
    if (!from) return { ok: false, error: 'This till is not bound to a branch.' };
    const clean = (Array.isArray(items) ? items : []).map((i) => ({ product_id: String(i?.product_id ?? ''), quantity: Number(i?.quantity) }))
      .filter((i) => i.product_id && Number.isFinite(i.quantity) && i.quantity > 0);
    if (!clean.length) return { ok: false, error: 'Add at least one item with a quantity.' };
    return transferAnswer(() => manageFetch('/api/stock/transfers', 'POST', { from_branch_id: from, to_branch_id, notes: notes?.trim() || undefined, items: clean }));
  });
  handle('transfers:status', async (_e, payload) => {
    const p = assertPayload<{ id: string; status: string; reason?: string; received_items?: unknown; receipt_note?: string; allow_same_user?: boolean }>(
      { id: { t: 'string', min: 1 }, status: { t: 'string', min: 1 }, reason: { t: 'string', optional: true }, received_items: { t: 'any', optional: true },
        receipt_note: { t: 'string', optional: true }, allow_same_user: { t: 'boolean', optional: true } }, payload);
    requireOnlineLicence();
    requireKey(['inventory.transfer'], TRANSFER_REFUSED);
    if (!['in_transit', 'received', 'cancelled'].includes(p.status)) return { ok: false, error: 'Unknown step.' };
    const { id, ...body } = p;
    const r = await transferAnswer(() => manageFetch(`/api/stock/transfers/${encodeURIComponent(id)}/status`, 'PATCH', body));
    if (r.ok && p.status !== 'cancelled') void syncAll().catch(() => { /* the stock levels follow on the next pull */ });
    return r;
  });

  // ── A466: the monthly pack on the till (Manager › Sales › Monthly pack) ─────────────────────────────────────────────
  // Owner, 2026-10-13: "desktop app does not have some reports I added yesterday, can you add them" — A455's monthly pack.
  // The cloud builds it from every till's records (routes/reports-monthly.ts), so it is online only; the manager's own
  // PIN sign-in reads it (reports.financial) and records for the books (expenses.manage), for this till's branch.
  const MONTHLY_OFFLINE = 'The monthly pack needs a connection — it is built from every till\'s records on the cloud.';
  const monthlyAnswer = async (fn: () => Promise<any>, refused = 'Your role does not open the monthly pack (it needs financial reports).') => {
    try { return { ok: true, data: await fn() }; }
    catch (e: any) {
      const offline = e?.message === NO_CONNECTION_MESSAGE || e?.message === OFFLINE_SESSION_MESSAGE;
      // A plain 403 (no code) is the person's permission; manageFetch words it for a change, this says which.
      const error = offline ? MONTHLY_OFFLINE : e?.status === 403 && !e?.code ? refused : (e?.message ?? MONTHLY_OFFLINE);
      return { ok: false, error, code: offline ? 'offline' : (e?.code ?? null), status: e?.status ?? null };
    }
  };
  const MONTHLY_RECORD_REFUSED = 'Your role does not record for the books (it needs expense management), or this is not your branch.';
  /** month=YYYY-MM&branch_id=… for this till's branch (or the one asked for), or why not. */
  const monthlyQuery = (month: string, branchId?: string): { q: string; branch: string } | { error: string } => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) return { error: 'Pick a month.' };
    const branch = (branchId && branchId.trim()) || transferBranch();
    if (!branch) return { error: 'This till is not bound to a branch.' };
    return { q: `month=${month}&branch_id=${encodeURIComponent(branch)}`, branch };
  };
  // A490: reading the pack is reports.monthly_pack or expenses.manage (A481); recording for the books expenses.manage.
  const MONTHLY_READ = ['reports.monthly_pack', 'expenses.manage'];
  handle('monthly:get', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    const r = await monthlyAnswer(() => manageFetch(`/api/reports/monthly?${mq.q}`, 'GET'));
    return r.ok ? { ...r, branch_id: mq.branch } : r;
  });
  handle('monthly:export', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    const got = await monthlyAnswer(() => manageFetch(`/api/reports/monthly/export?${mq.q}`, 'GET', undefined, { binary: true }));
    if (!got.ok) return got;
    const { bytes, disposition } = got.data as { bytes: Buffer; disposition: string | null };
    // The name the cloud gave it (the web's: zaptill-monthly-<branch>-<month>.xlsx).
    const named = /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1];
    const suggested = named && /^[\w.-]+\.xlsx$/i.test(named) ? named : `zaptill-monthly-branch-${p.month}.xlsx`;
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const choice = await dialog.showSaveDialog(win!, { title: 'Save the monthly pack', defaultPath: suggested,
        filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
      if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };   // cancelling is not a failure
      const target = /\.xlsx$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.xlsx`;
      fs.writeFileSync(target, bytes);
      return { ok: true, path: target };
    } catch (e: any) { return { ok: false, error: e?.message ?? 'Could not save the file.' }; }
  });
  handle('monthly:movements', async (_e, payload) => {
    const p = assertPayload<{ month: string; branch_id?: string }>({ month: { t: 'string', min: 7 }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan(...MONTHLY_READ)) return { ok: false, error: 'Your role does not open the monthly pack.' };
    const mq = monthlyQuery(p.month, p.branch_id);
    if ('error' in mq) return { ok: false, error: mq.error };
    return monthlyAnswer(async () => (await manageFetch(`/api/reports/monthly/movements?${mq.q}`, 'GET')) ?? []);
  });
  handle('monthly:addMovement', async (_e, payload) => {
    const p = assertPayload<{ movement_date: string; method: string; kind: string; amount: number; note?: string; branch_id?: string }>(
      { movement_date: { t: 'string', min: 10 }, method: { t: 'string', min: 1 }, kind: { t: 'string', min: 1 }, amount: { t: 'number' },
        note: { t: 'string', optional: true }, branch_id: { t: 'string', optional: true } }, payload);
    if (!signedInCan('expenses.manage')) return { ok: false, error: MONTHLY_RECORD_REFUSED };   // A490
    const branch = (p.branch_id && p.branch_id.trim()) || transferBranch();
    if (!branch) return { ok: false, error: 'This till is not bound to a branch.' };
    // The cloud checks the rest (kind, amount, a note for other income / personal) and the person's expenses.manage.
    return monthlyAnswer(() => manageFetch('/api/reports/monthly/movements', 'POST', { branch_id: branch, movement_date: p.movement_date,
      method: p.method, kind: p.kind, amount: p.amount, note: p.note?.trim() || undefined }), MONTHLY_RECORD_REFUSED);
  });
  handle('monthly:removeMovement', async (_e, payload) => {
    const p = assertPayload<{ id: string }>({ id: { t: 'string', min: 1 } }, payload);
    if (!signedInCan('expenses.manage')) return { ok: false, error: MONTHLY_RECORD_REFUSED };   // A490
    return monthlyAnswer(() => manageFetch(`/api/reports/monthly/movements/${encodeURIComponent(p.id)}`, 'DELETE'), MONTHLY_RECORD_REFUSED);
  });

  // A460: premium writes (combos, variants, modifiers, offers, wastage) refuse without the online licence — the screens
  // are hidden then, and a screen hidden is not a door locked.
  const requireOnlineLicence = (): void => {
    if (getDeviceConfig()?.web_pos_enabled !== true) throw new Error('This is part of the online licence — ask ZapTill to turn it on for your business.');
  };
  handle('manage:updateStaff', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireStaffChange({ roleId: patch?.role_id, targetId: String(id) });   // A490
    // A459: the screen's Deactivate sent { is_active } — a field the cloud does not know (it never deactivated anyone).
    const p: Record<string, unknown> = { ...(patch ?? {}) };
    if (typeof p.is_active === 'boolean') { p.status = p.is_active ? 'active' : 'inactive'; delete p.is_active; }
    // A459 (owner, 2026-10-13: rename, role and deactivate on the till, offline too): these go on this till first — at
    // once, offline too — and reach the branch server and the cloud later (A448). Anything else (an override PIN, branches,
    // an email) still needs the cloud first.
    const tillFirst = Object.keys(p).length > 0 && Object.keys(p).every((k) => ['name', 'role_id', 'status'].includes(k));
    if (tillFirst) {
      try {
        const ch = recordTillChange({ entity: 'staff', op: 'update', entity_id: String(id), data: p });
        void staffChangedHere();
        return { id: ch.entity_id, ...p, change_state: 'pending' };
      } catch (e: any) {
        if (!/not on this till/.test(String(e?.message ?? ''))) throw e;   // someone this till does not hold: the cloud, as before
      }
    }
    const out = await manageFetch(`/api/staff/${id}`, 'PATCH', p);
    void staffChangedHere();
    return out;
  });

  handle('manage:getReceiptText', async () => {
    const cfg = getDeviceConfig();
    return { header: cfg?.receipt_header ?? '', footer: cfg?.receipt_footer ?? '' };
  });
  handle('manage:setReceiptText', async (_e, { header, footer }: { header: string; footer: string }) => {
    requireKey(['receipt.manage'], 'Your role does not change the receipt text.');   // A490
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
    requireKey(['settings.business'], 'Only someone who manages the business settings can change that.');   // A490
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
    // The owner's own rules (void window, offline refunds, free delivery) — the owner only, as the cloud (A490: '*').
    if (!personKeys(sessionPerson()?.roleName, sessionPerson()?.permissions).has('*')) throw new Error('Only the owner sets these rules.');
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
  // A429: the payment methods this branch takes — the payment screen reads them (null = not told yet = the catalogue's
  // defaults); a manager switches them for the branch (the cloud checks settings.manage and the codes), and this till uses
  // the new list at once, the branch's other tills on their next pull.
  handle('pos:paymentMethodsEnabled', async () => ({ enabled: getPaymentMethodsEnabled() }));
  // A443: on the branch server — the version it holds for its tills, and which version each till said it runs.
  handle('node:tillVersions', async () => {
    // A496: the version the server offers its tills is the approved one it holds (never a copy left from before a
    // roll-back), with how its own fetch of that version is going (fetching / failed, why, bytes).
    const ready = offeredVersion(shareDir());
    return { serverVersion: app.getVersion(), ready, share: shareProgress(), tills: tillVersions(ready ?? app.getVersion()) };
  });
  // A445: the branch's offers, as the till holds them (pulled with the menu) — the cart applies them by this clock.
  handle('pos:offers', async () => {
    const rows = getLocalDb().prepare(`SELECT data FROM offers`).all() as Array<{ data: string }>;
    const offers = rows.flatMap((r) => { try { const c = cleanOffer(JSON.parse(r.data)); return c.ok ? [(c as { offer: Offer }).offer] : []; } catch { return []; } });
    return { offers, branchId: tillBranchId() };
  });
  // A445: Manager › Offers — read and change the cloud's (online only; the till learns of a change on its next pull,
  // which is asked for at once).
  // A490: discounts, promotions and offers — menu.offers.
  const OFFERS_REFUSED = 'Your role does not set up offers.';
  handle('manage:offers', async () => { requireKey(['menu.offers'], OFFERS_REFUSED); return manageFetch('/api/offers', 'GET'); });
  handle('manage:saveOffer', async (_e, raw) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.offers'], OFFERS_REFUSED);   // A490
    const c = cleanOffer(raw);
    if (!c.ok) throw new Error((c as { error: string }).error);
    const id = String((raw as any)?.id ?? '');
    const out = await manageFetch(id ? `/api/offers/${encodeURIComponent(id)}` : '/api/offers', id ? 'PATCH' : 'POST', (c as { offer: Offer }).offer);
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:deleteOffer', async (_e, id: string) => {
    requireOnlineLicence();   // A460
    requireKey(['menu.offers'], OFFERS_REFUSED);   // A490
    const out = await manageFetch(`/api/offers/${encodeURIComponent(String(id))}`, 'DELETE');
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:setPaymentMethodsEnabled', async (_e, codes) => {
    requireKey(['settings.payments'], PAYMENTS_REFUSED);   // A490
    const list = (Array.isArray(codes) ? codes : []).map((c) => String(c).trim().toLowerCase());
    const branchId = tillBranchId();   // A446: the signed-in person's branch when the till never recorded one
    if (!branchId) throw new Error('This till does not know its branch yet — sign in once with a staff PIN, then try again.');
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/settings`, 'POST', { key: 'payment_methods_enabled', value: list });
    setPaymentMethodsEnabled(list);
    return out;
  });
  // A492: the branch's M-Pesa number (Buy Goods till number, or Paybill + account) — set HERE, on the till, by its manager
  // (owner, 2026-10-15). settings.mpesa (or, on a map from before the catalogue, receipt.manage — who set the receipt's
  // payment line before). The cloud checks again, keeps it per branch and tells the owner of every change.
  const MPESA_REFUSED = 'Your role may not change the branch\'s M-Pesa number.';
  const mayMpesa = (): boolean => {
    const me = sessionPerson();
    if (!me) return false;
    return isOwnerRole(me.roleName) || maySetMpesa(personKeys(me.roleName, me.permissions), !hasMarker(me.permissions));
  };
  handle('manage:getMpesa', async () => {
    if (!sessionPerson()) throw new Error('Not signed in');
    const branchId = tillBranchId();
    if (!branchId) throw new Error('This till does not know its branch yet — sign in once with a staff PIN, then try again.');
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/mpesa`, 'GET') as
      { own: MpesaReceive | null; inherited: MpesaReceive | null; canEdit?: boolean };
    return { own: out?.own ?? null, inherited: out?.inherited ?? null, canEdit: mayMpesa() && out?.canEdit !== false };
  });
  handle('manage:setMpesa', async (_e, raw) => {
    if (!sessionPerson()) throw new Error('Not signed in');
    if (!mayMpesa()) throw new Error(MPESA_REFUSED);
    const branchId = tillBranchId();
    if (!branchId) throw new Error('This till does not know its branch yet — sign in once with a staff PIN, then try again.');
    const clear = (raw as any)?.clear === true;
    const c = clear ? null : cleanMpesaReceive(raw as any);
    if (c && 'error' in c) throw new Error(c.error);
    const value = c && 'value' in c ? c.value : null;
    const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/mpesa`, 'PUT', value ?? { clear: true });
    // This till prints the new line at once (the branch's other tills take it within 20 s — the cloud's version moves).
    setReceiptPay(value ? { label: mpesaLabel(value.kind), number: mpesaReceiptNumber(value) } : null);
    syncAll().catch(console.error);
    return out;
  });
  handle('manage:getCashierHistoryMethods', async () => ({ methods: getCashierHistoryMethods() }));
  handle('manage:setCashierHistoryMethods', async (_e, methods) => {
    requireKey(['settings.business'], 'Only someone who manages the business settings can change that.');   // A490
    const clean = historyMethodsSettingValue(methods);
    if (clean === null) throw new Error('Choose payment methods from the list.');
    const out = await manageFetch('/api/business/settings', 'POST', { key: CASHIER_HISTORY_METHODS_KEY, value: JSON.parse(clean) });
    setCashierHistoryMethods(clean);
    return out;
  });

  // ── Manager dashboard reports (local SQLite — D9 tiered depth) ────────────

  // A490: every report read names its key (the Overview reads several — reports.overview opens those too). A refusal
  // throws: the screen shows its own "not available" line, and the figures are never sent.
  const REPORT_REFUSED = 'Your role does not see this report.';
  // Range is optional so existing callers keep today's behaviour untouched.
  handle('manager:salesSummary',  async (_e, r?: RangeArg) => {
    requireKey(['reports.sales', 'reports.overview'], REPORT_REFUSED);
    return getSalesSummary(r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });
  handle('manager:topProducts',   async (_e, r?: RangeArg) => {
    requireKey(['reports.items', 'reports.overview'], REPORT_REFUSED);
    return getTopProducts(r?.limit ?? 8, r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });
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
  // A444: one order's items, sizes, extras, notes and payments — this till's records first, else the cloud's (another
  // till's sale at the branch). A cashier only sees what their History already shows them.
  handle('order:detail', async (_e, orderId: string) => {
    const scope = historyScope();
    if (!scope.staffId) return { ok: false, error: 'Sign in to see an order.' };
    let found: { detail: OrderDetail; cashierId: string | null };
    try { found = await readOrderDetail(String(orderId)); }
    catch (e: any) { return { ok: false, error: e?.message ?? 'Could not read this order.' }; }
    if (!scope.manager) {
      if (scope.ownOnly && found.cashierId !== scope.staffId) return { ok: false, error: 'This sale is not yours.' };
      if (scope.methods.length) {
        const allowed = new Set(scope.methods);
        found.detail = { ...found.detail, payments: found.detail.payments.filter((p) => allowed.has(p.method)) };
      }
    }
    return { ok: true, detail: found.detail, canReprint: scope.canReprint };
  });
  handle('manager:recentOrders',  async (_e, r?: RangeArg) => {
    requireKey(['orders.view_all', 'reports.overview'], REPORT_REFUSED);
    return getRecentOrders(r?.limit ?? 30, r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });

  // Cross-sync stage 1 (2026-09-27): every till's sales at this branch, read from the cloud (owner: "Branch
  // view, read from cloud"). Online only — the caller falls back to this till's own list and says so.
  handle('manager:branchOrders', async (_e, r?: RangeArg) => {
    requireKey(['orders.view_all'], REPORT_REFUSED);   // A490
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

  // A431 / A432: the Overview — every till's sales and every shift at the branch, from the cloud (a manager's sign-in);
  // this till's own rows when the cloud cannot be reached, saying so. Read-only.
  handle('manager:branchDay', async (_e, r?: RangeArg) => {
    requireKey(['reports.overview', 'orders.view_all'], REPORT_REFUSED);   // A490: the Overview's own read
    const day = await branchDay(resolveRange(r?.preset ?? 'today', r?.from, r?.to));
    // A494: each drawer's expected cash and difference only to reports.shifts / shifts.confirm (as shift:stale) —
    // taken out, not merely hidden on the screen.
    if (signedInCan('reports.shifts', 'shifts.confirm')) return day;
    return { ...day, shifts: (day.shifts ?? []).map((s) => ({ ...s, expected_cash: null, variance: null })) };
  });

  // What the figures cover. Paired with every range query so a till's partial
  // view can never be read as the branch's takings.
  handle('manager:reportScope', async () => getReportScope());
  handle('manager:resolveRange', async (_e, r: RangeArg) =>
    resolveRange(r?.preset, r?.from, r?.to));
  // A490: a download is reports.export AND the report's own key (orders → orders.view_all, products → reports.items,
  // sales → reports.sales), as the cloud's exports.
  handle('manager:exportCsv', async (_e, req: any) => {
    const own = req?.kind === 'orders' ? 'orders.view_all' : req?.kind === 'products' ? 'reports.items' : 'reports.sales';
    if (!signedInCan('reports.export') || !signedInCan(own)) return { ok: false, error: 'Your role does not download this report.' };
    return exportReportCsv(req);
  });
  handle('manager:dailyReport', async (_e, req: any) => {
    if (!signedInCan('reports.export') || !signedInCan('reports.sales')) return { ok: false, error: 'Your role does not download this report.' };
    return exportDailySalesReport(req ?? {});
  });
  handle('manager:stockLevels',   async () => { requireKey(['inventory.view'], REPORT_REFUSED); return withoutCosts(getStockLevels()); });
  handle('manager:fuelSales',     async () => { requireKey(['reports.fuel', 'reports.overview'], REPORT_REFUSED); return getFuelSalesToday(); });
  handle('manager:pumpStatus',    async () => { requireKey(['reports.fuel', 'reports.overview', 'fuel.manage'], REPORT_REFUSED); return getPumpStatus(); });
  handle('manager:tableOccupancy',async () => { requireKey(['orders.view_all', 'reports.overview'], REPORT_REFUSED); return getTableOccupancy(); });

  // ── Branch price management (manager = branch authority, local-first) ──────
  handle('manager:priceList',      async () => { requireKey(MENU_READ, NOT_ALLOWED); return withoutCosts(getPriceList()); });
  // Audit 2026-10-14: checked here, not only on the screen. A490: menu.prices (the cloud's /branch-prices rule).
  const mayPrice = () => signedInCan('menu.prices');
  const PRICE_REFUSED = 'Only someone who may change prices can change a price.';
  handle('manager:setBranchPrice', async (_e, { product_id, price }) => {
    if (!mayPrice()) throw new Error(PRICE_REFUSED);
    return setBranchPrice(product_id, price);
  });
  handle('manager:clearBranchPrice', async (_e, { product_id }) => {
    if (!mayPrice()) throw new Error(PRICE_REFUSED);
    return clearBranchPrice(product_id);
  });

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
  handle('expense:addCategory', async (_e, { name }: { name: string }) => {
    requireKey(['expenses.manage'], 'Your role does not add expense types.');   // A490
    return manageFetch('/api/expenses/categories', 'POST', { name: String(name ?? '').trim() });
  });

  // Save expense locally (syncs up on next push pass)
  handle('expense:create', async (_event, {
    description, amount, expense_category_id, paid_by, payment_method, category_name, pin, no_drawer,
  }: { description: string; amount: number; expense_category_id?: string; paid_by?: string;
       payment_method?: string; category_name?: string; pin?: string; no_drawer?: boolean }) => {
    // A490: shifts.cash_movements (before migration 134: A453's 'cashier_no_money_out' switch, unless they may confirm).
    if (!mayMoveMoney(sessionPerson(), getPosFeatures().cashier_no_money_out)) throw new Error(MONEY_MOVEMENT_MANAGER_ONLY);
    const approver = await payoutApprover(pin);   // 0.6.37 (A388): every expense needs a manager
    // the till's own open drawer (none: paid outside any drawer). A466: on the branch server a manager may record it
    // "Not from a drawer" even while this terminal has a shift open (owner: "the manager can fail to choose a drawer").
    const outside = no_drawer === true && isNodeRole(getDeviceConfig()?.device_role) && signedInConfirmer() !== null;
    const shift = outside ? null : getOpenShift();
    // A465: the insert lives in shiftService.recordExpense — the branch server's instruction records the same way.
    const { id } = recordExpense({
      shiftId: shift?.id ?? null, description, amount, expense_category_id: expense_category_id ?? null,
      category_name: category_name ?? null, payment_method: payment_method ?? null, paid_by: paid_by ?? null, approver,
    });
    logLine('shift', `expense ${Number(amount)} approved by ${approver.name ?? approver.id}`);
    return { id, approvedBy: approver.name };
  });

  // 0.6.11 (owner: "I should be able to see expenses") — the manager's Expenses screen, by date range.
  handle('expense:range', async (_e, r?: RangeArg) => {
    requireKey(['expenses.view', 'expenses.manage'], 'Your role does not see expenses.');   // A490
    const range = resolveRange(r?.preset ?? 'today', r?.from, r?.to);
    return { ...listExpenses(range.from, range.to), label: range.label };
  });

  // Recent expenses for the current shift (for display in ShiftPanel)
  handle('expense:list', async () => {
    // A490: expenses.view — or the person recording money on this drawer (they see what they recorded on it).
    const me = sessionPerson();
    if (!me || !(personCan(me, 'expenses.view', 'expenses.manage') || mayMoveMoney(me, getPosFeatures().cashier_no_money_out))) return [];
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
    const st = sessionPerson();
    return st ? { id: st.staffId, name: st.name, roleName: st.roleName, permissions: st.permissions } : null;
  };
  const NOT_AN_APPROVER = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';
  async function identifyApproverOffline(pin: string, kind: 'void' | 'refund' | 'frozen'): Promise<LocalPerson> {
    assertPinAllowed();   // A494: the till's PIN limiter, and a PIN that does not approve counts
    try { return await identifyApproverOfflineChecked(pin, kind); }
    catch (e: any) { if (e?.message === NOT_AN_APPROVER) recordPinFailure(); throw e; }
  }
  async function identifyApproverOfflineChecked(pin: string, kind: 'void' | 'refund' | 'frozen'): Promise<LocalPerson> {
    const cfg = getDeviceConfig();
    const branchId = cfg?.branch_id ?? '';
    const asPerson = (staff: { staffId: string; name: string; roleName: string | null; permissions: unknown }): LocalPerson => {
      const p = { id: staff.staffId, name: staff.name ?? null, roleName: staff.roleName, permissions: staff.permissions };
      if (!(kind === 'frozen' ? mayReleaseFrozen(p) : mayReverseLocal(p, kind))) throw new Error(NOT_AN_APPROVER);   // A490: sales.void / sales.refund, or the owner
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
      ? await identifyApproverOffline(String(pin).trim(), kind)
      : (mayReverseLocal(actor, kind) ? actor : null);
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

  // A521 (#7): a manager may sell an item a stock count freezes — the till's offline list can be hours behind the count
  // (and the cloud accepts a till's sale of a frozen item, counting it into the count: orders.ts A394). Who: the owner, or
  // a person who adjusts stock or confirms shifts (a manager). Checked on this till (its server, its saved sign-ins).
  function mayReleaseFrozen(p: PersonLike | null | undefined): boolean {
    return !!p && (isOwnerRole(p.roleName ?? null) || personCan(p, 'inventory.adjust', 'shifts.confirm'));
  }
  handle('pos:approveFrozenSale', async (_e, payload) => {
    const { pin, product_id } = assertPayload<{ pin: string; product_id: string }>({ pin: { t: 'string', min: 1 }, product_id: { t: 'string', min: 1 } }, payload);
    if (!getStockCountFreeze().productIds.includes(product_id)) return { ok: true, approvedBy: null };   // not frozen (any more)
    try {
      const me = signedInPerson();
      const approver = await identifyApproverOffline(String(pin).trim(), 'frozen');
      logLine('sale', `A521 frozen item ${product_id} (count ${getStockCountFreeze().ref ?? '?'}) released for sale by ${approver.name ?? approver.id}${me?.name ? ` for ${me.name}` : ''}`);
      return { ok: true, approvedBy: approver.name ?? null };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? NOT_AN_APPROVER };
    }
  });

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
    // A490: sales.void — checked here first (the cloud checks again online; offline this till is the authority).
    requireKey(['sales.void'], 'Your role does not void sales.');
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
          'This role cannot void sales. The owner needs to give it "Void sales" (Roles and permissions).',
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
    requireKey(['sales.refund'], 'Your role does not refund sales.');   // A490
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
        throw new Error('This role cannot refund sales. The owner needs to give it "Refund sales" (Roles and permissions).');
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
  // A494: when the reveal code was last entered at THIS till — a peer adopts the branch's technician session only after it.
  let revealPassedAt = 0;
  const REVEAL_FRESH_MS = 5 * 60_000;
  handle('tech:checkReveal', async (_event, code: string) => {
    const ok = checkRevealCode(code);
    if (ok) revealPassedAt = Date.now();
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
    // A494: never a bare call — the technician's code is entered at this till first (tech:checkReveal).
    if (!revealPassedAt || Date.now() - revealPassedAt > REVEAL_FRESH_MS) return { ok: false, error: 'Enter the technician code on this till first.' };
    const token = await fetchNodeTechToken().catch(() => null);
    if (!token) return { ok: false };
    const result = openTechSession(token);
    return result.ok ? { ok: true, session: result.session } : { ok: false };
  });

  handle('tech:getSession', async () => getActiveSession());

  // A494: closing ends it at the branch too — the token the branch server holds for its tills to adopt is cleared (a till
  // that already adopted it keeps its own session until it is closed there or it expires).
  handle('tech:closeSession', async () => {
    closeTechSession();
    revealPassedAt = 0;
    broadcastTechToken('').catch(() => {});
    return { ok: true };
  });

  handle('tech:logAction', async (_event, { action, detail }: { action: string; detail?: any }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };   // A494
    // A490: kept for the screens' audit lines, but bounded — the audit is a queue the cloud receives.
    const act = String(action ?? '').slice(0, 80);
    let d: any = detail;
    try { const t = JSON.stringify(detail ?? null); if (t && t.length > 2000) d = { truncated: t.slice(0, 2000) }; } catch { d = null; }
    logTechAction(act, d);
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
    setTillPin(null);   // A489: a server pins no server
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
  // A502: 'tech:setNodeUrl' (a branch server address typed on the Tech page) is gone — owner, 2026-10-15: "we remove the
  // address totally and use find my server". A till is pointed at its server only by finding it and being allowed there
  // (install:requestJoin with rejoin — TechFindServer), which keeps everything on the till, as the typed address did.

  handle('tech:backupNow', async () => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('backup.manual', {});
    return await takeSnapshot();
  });

  // A516: the graphics mode a technician sets on the Tech page (low-memory mode, A513) — the same gpu-mode.json the
  // start gate reads before ZapTill loads (startGate.ts readGpuMode); it takes effect at the next start.
  const GPU_FILE = () => path.join(app.getPath('userData'), 'gpu-mode.json');
  handle('tech:getGpuMode', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    try { const m = JSON.parse(fs.readFileSync(GPU_FILE(), 'utf8'))?.mode; return { mode: m === 'on' || m === 'off' ? m : 'auto' }; }
    catch { return { mode: 'auto' }; }
  });
  handle('tech:setGpuMode', async (_e, payload) => {
    const { mode } = assertPayload<{ mode: string }>({ mode: { t: 'string', min: 2 } }, payload);
    if (!getActiveSession()) throw new Error('Tech session required');
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new Error('Graphics mode is auto, on or off.');
    fs.writeFileSync(GPU_FILE(), JSON.stringify({ mode }));
    logTechAction('graphics.mode', { mode });
    logLine('startup', `graphics mode set to "${mode}" by a technician — takes effect when ZapTill next starts`);
    return { ok: true, mode };
  });

  handle('tech:maintenance', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');   // A494
    return maintenanceStatus();
  });
  // A380: the technician chooses where the branch server's backups go — proven by writing one there at once.
  handle('tech:chooseBackupDir', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { title: 'Choose the backup folder (a USB drive or a second disk)',
      properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths?.[0] ? null : res.filePaths[0];
  });
  handle('tech:setBackupDir', async (_e, payload) => {
    const { dir } = assertPayload<{ dir: string | null }>({ dir: { t: 'any' } }, payload ?? {});
    if (!getActiveSession()) throw new Error('Tech session required');
    const clean = typeof dir === 'string' && dir.trim() ? dir.trim() : null;
    logTechAction('backup.dir', { dir: clean ?? '(default)' });
    return setBackupDir(clean);
  });

  handle('tech:query', async (_event, { sql }: { sql: string }) => {
    if (!getActiveSession()) return { ok: false, error: 'No active tech session.' };
    logTechAction('db_query', { sql: String(sql ?? '').slice(0, 2000) });
    return runTechQuery(sql);
  });

  // Local, offline-safe diagnostics for the tech screen.
  handle('tech:status', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');   // A494: the till's addresses and build
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
  // A519: "Send logs to support" — the last 24 hours of this till's log, every secret removed (supportLogs.ts,
  // logRedact.ts), with a short header, to the cloud (POST /api/support/logs, under this till's own session); the admin
  // portal shows it on the client's page. A technician's session only (the log names staff and sales). Offline: the
  // Tech page offers "Save log to file" (tech:saveLog) instead.
  const supportText = (): string => {
    const cfg = getDeviceConfig();
    const db = getLocalDb();
    const sess = db.prepare(`SELECT business_id, business_name FROM session WHERE id=1`).get() as any;
    let branch: string | null = null;
    try { branch = (db.prepare(`SELECT name FROM branches WHERE id = ?`).get(cfg?.branch_id ?? '') as any)?.name ?? null; } catch { /* no table */ }
    const tech = getActiveSession();
    const header: SupportHeader = {
      business: sess?.business_name ?? null, businessId: sess?.business_id ?? null, branch, branchId: cfg?.branch_id ?? null,
      terminal: cfg?.terminal_code ?? null, deviceId: cfg?.device_id ?? null, deviceName: cfg?.device_name ?? null,
      role: cfg?.device_role ?? 'till', version: app.getVersion(),
      os: `${os.platform()} ${typeof (os as any).version === 'function' ? (os as any).version() : ''} ${os.release()} ${os.arch()}`.replace(/\s+/g, ' ').trim(),
      ramGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, freeGb: Math.round(os.freemem() / 1024 ** 3 * 10) / 10,
      startup: lastStartupLine(),
      sync: cfg?.node_url && !isNodeRole(cfg.device_role) ? syncSummary(channelHealth()) : [],
      tech: tech ? `${tech.techName} (${tech.techId})` : null, at: new Date().toISOString(),
    };
    return buildSupportText(header, readLogFiles(rolledPaths(getLogPath(), KEEP_FILES)),
      readLogFiles(rolledPaths(getAuthLogPath(), AUTH_KEEP_FILES)), Date.now()).text;
  };
  handle('tech:sendLogs', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const packed = packSupportText(supportText());
    let status: number | null = null; let body: any = null;
    try {
      const raw = getRawTechToken();
      const res = await tillFetch('/api/support/logs', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(raw ? { 'X-Tech-Token': raw } : {}) },
        body: JSON.stringify({ log_gz_b64: packed.b64, bytes: packed.bytes, trimmed: packed.trimmed,
          terminal_code: getDeviceConfig()?.terminal_code ?? null, app_version: app.getVersion() }) }, 30_000);
      status = res.status; body = await res.json().catch(() => null);
    } catch { status = null; }
    const v = sendVerdict(status, body);
    logLine('tech', v.ok ? `A519: log sent to support — reference ${v.reference}` : `A519: log not sent — ${v.message}`);
    return v;
  });
  handle('tech:saveLog', async () => {
    if (!getActiveSession()) throw new Error('Tech session required');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const name = `zaptill-log-${getDeviceConfig()?.terminal_code ?? 'till'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
    const choice = await dialog.showSaveDialog(win!, { title: 'Save the log for support', defaultPath: name,
      filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(choice.filePath, supportText(), 'utf8');
    logLine('tech', `A519: log saved to a file for support`);
    return { ok: true, path: choice.filePath };
  });

  handle('tech:logTail', async (_event, arg?: { lines?: number }) => {
    if (!getActiveSession()) return { path: null, text: 'Tech session required.' };   // A494: the log names staff and sales
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
    requireKey(['reports.sales', 'reports.overview'], REPORT_REFUSED);   // A490
    // A494: each part asks its own key — the orders list orders.view_all (or the Overview), stock inventory.view (costs
    // only to menu.costs / reports.costs) — as their own handlers do. A part not allowed is null.
    const seesOrders = signedInCan('orders.view_all', 'reports.overview');
    const seesStock = signedInCan('inventory.view');
    const parts = (rep: any) => ({ ...rep,
      recentOrders: seesOrders ? rep?.recentOrders ?? null : null,
      stockLevels: seesStock ? withoutCosts(rep?.stockLevels ?? null) : null });
    if (hasNode()) {
      const report = await fetchNodeReport().catch(() => null);
      if (report) return { ...parts(report), source: 'node' as const };
    }
    // Fallback: local-only view of this device.
    return {
      salesSummary: getSalesSummary(),
      topProducts:  getTopProducts(),
      recentOrders: seesOrders ? getRecentOrders() : null,
      stockLevels:  seesStock ? withoutCosts(getStockLevels()) : null,
      source: hasNode() ? ('local_fallback' as const) : ('local' as const),
    };
  });
}
