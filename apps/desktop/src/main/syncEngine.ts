// Sync Engine — runs in Electron main process
//
// PULL: products, categories, variants, modifiers, stock_levels → SQLite  (remote wins)
// PUSH: pending sync_queue rows → POST /api/orders                         (local wins)
//
// Stock conflict resolution:
//   Remote pull    → overwrites local quantity (remote wins for price/stock reference)
//   Local sale     → delta deduction (quantity - sold), never absolute overwrite
//   This means an offline sale is always applied on top of whatever quantity is current

import { overlayLocalChanges } from './localChanges';   // A448
import { nodeChangeVersion } from './nodeClient';   // A448
import { cleanOffer, type Offer } from './offers';   // A445
import { net } from 'electron';
import { getLocalDb, LOCAL_SCHEMA_VERSION, applyPulledBranding, applyPulledTheme } from './localDb';
import { logLine, describeResponse, getLogPath, authLog } from './logFile';
import { getMacAddressCached, identityHeaders } from './machineFingerprint';
import { readSessionTokens, readStaffTokens, writeSessionTokens, writeStaffTokens, readDeviceSecret, writeDeviceSecret } from './tokenStore';
import { deviceGrantBody } from './sessionRecovery';   // A407
import { cleanNote, ORDER_NOTE_MAX } from './orderNotes';
import { cleanDeliveryFee, riderPayoutReason, isFreeDelivery } from './delivery';
import { getDeviceConfig, saveDeviceConfig, getCloudUrl, canSell, isNodeRole, setWebPosEnabled, setOrderNotePicks, setPosFeatures, setReversalRules, setBusinessDayCutoff, setSupportContact, setCashierHistoryMethods, setStockCountFreeze, setCashierSeesShiftSales, setCashierHistoryTotals, setPaymentMethodsEnabled } from './deviceConfig';
import { selectPushRefresh } from './authTransport';
import { storeBranchStaff } from './branchStaff';
import { refreshTechConfig } from './techService';
import { hasNode, pushRowsToNode, measureNodeClock, refreshViaNode, ackViaNode, fetchReferenceFromNode, fetchNodeCursors, checkNodeHealth } from './nodeClient';
import { tillPin, securityCode } from './lanTls';   // A501
import { followMovedServer } from './nodeFollow';   // A501
import { nodeRefusal, cloudFetch } from './cloudGateway';
import { setReceiptPay } from './receiptPay';   // A450   // A410
import { readPending as readPendingWaste, pushPendingWastage, type WasteOutcome } from './tillWastage';   // A414
import { readPending as readPendingRouting, overlayPending as overlayPendingRouting, pushPendingRouting, type PushOutcome } from './stationRouting';   // A411
// A275: reuse the SAME local close the branch-LAN central close uses, so remote
// and on-prem closes run identical cash arithmetic. Called only at runtime (during
// sync), so the branchClose ↔ syncEngine import cycle resolves safely.
import { executeCloseDay } from './branchClose';
import { unpackNodeBundle, numOrNull, type AcquiredReference, identityFromWire } from './referenceBundle';
import { buildCloudOrderPayload } from './peerRelay';
import { ownOrderIds, webSaleShifts, applyWebOrders, applyOwnReversals, type WebOrder, type OwnReversal } from './webSales';
import { replayOutcome } from './offlineReversal';
import { closesToAdopt, type CloudShiftState, type LocalClose } from './remoteShiftClose';   // A401
import { applyTestDataClear, applyMenuClear, dropPurgedMenu, type ClearPeriod } from './testDataClear';   // A404, A482
import {
  fillNodeOutbox, takeNodeQueueBatch, markNodeQueueDelivered, markNodeQueueFailed,
  nodeQueueDepth, emitEvent,
  settleNodeBatch, noteNodeTarget, nodeTargetKey, nodeRearmSkipOwed, skipHeldByNode, NODE_BATCH_BYTES,   // F1/F2/F14
  numberOwnRows, backfillOwnSeq, emitRefundEvents, applyPendingEvents, pruneNodeQueue,                  // F8/F9/F10/P3
  repairBillNumberRefusals,                                                                              // A500
  noteNodeIdentity, nodeIdentityKey,                                                                     // A501
} from './nodeIngest';
import { pruneNodeInstructions } from './branchClose';   // P3
import { v4 as uuid } from 'uuid';
import { cleanShowDays } from './productDays';
import { pruneChoices, VARIANT_TABLES, MODIFIER_TABLES } from './choicePrune';   // A425
import { storeSessionPermissions } from './tillAccess';   // A490
import { claimOrderNumberForOwnSale } from './billNumber';   // A500
import { noteActivity } from './activityTracker';   // A508
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
  print_stations: 'pull', category_stations: 'pull',
  variant_groups: 'pull', variant_options: 'pull',
  modifier_groups: 'pull', modifier_options: 'pull',
  stock_levels: 'pull', branches: 'pull', users: 'pull', tables: 'pull', pumps: 'pull',
  // Push-up, local origin
  orders: 'push', order_items: 'push',
  order_item_variants: 'push', order_item_modifiers: 'push',
  payments: 'push', customer_credit_transactions: 'push',
  shifts: 'push', float_transactions: 'push', expenses: 'push',
  business_days: 'push',
  kitchen_voids: 'push',   // 0.6.28 (migration 112)
};

/**
 * The tables /api/sync/push can reject a row from. The server names one of these
 * in every `rejected[].table`; the client refuses to act on anything else rather
 * than guessing, because guessing "shifts" is exactly how a refused trading day
 * came to be marked synced and lost. Keep in step with the server's `rejected`
 * union in apps/server/src/routes/sync.ts.
 */
type RejectableTable = 'shifts' | 'business_days' | 'float_transactions' | 'expenses' | 'kitchen_voids';

let _serverUrl   = '';
let _accessToken  = '';   // till's own token — used for catalogue pull
let _refreshToken = '';
let _staffToken   = '';   // per-shift staff token — used for order push
let _staffRefresh = '';
let _isSyncing    = false;
// Till sync audit (F13): which pass holds _isSyncing. Only the pass that set it clears it — a pass declared stale and
// overtaken used to clear the flag in its finally while the newer pass still ran, letting a third start beside it.
let _syncOwner: symbol | null = null;
let _kvWaitingLogged = 0;   // 0.6.28: kitchen voids an older cloud would not take (logged once per count)
// A177: when the current sync started, so a wedged _isSyncing can't block forever.
let _syncStartedAt = 0;
// A sync running longer than this is presumed wedged and no longer blocks a new
// pass. Generous: a legitimate pass of many timed-out fetches must not trip it. Till sync audit (F13): 3 min was shorter
// than a real pull on a weak line (a menu of N products is 7 + N fetches of up to 2 × 20 s each), so a second pass ran
// beside the first. 10 min, and the push stages are single-flight besides (runPushStages), so even an overlap is safe.
const SYNC_STALE_MS = 10 * 60_000;
function takeSyncFlag(): symbol | null {
  if (_isSyncing && Date.now() - _syncStartedAt < SYNC_STALE_MS) return null;
  const me = Symbol('sync-pass');
  _syncOwner = me;
  _isSyncing = true;
  _syncStartedAt = Date.now();
  return me;
}
function releaseSyncFlag(me: symbol): void {
  if (_syncOwner !== me) return;   // overtaken as stale: the newer pass owns the flag now
  _syncOwner = null;
  _isSyncing = false;
}

// A177: every sync fetch gets a hard timeout. Without one, a connection that
// opens but never responds — a black-holed socket, a cold-starting host, a proxy
// that drops the stream — hangs the await forever. Because _isSyncing is cleared
// only in `finally`, that finally never runs, so EVERY later sync (the 60s flush,
// the post-sale flush, reconnect, and Force sync) returns "Sync already in
// progress" and the queue never drains: orders sit pending, 0 attempts, 0 failed,
// invisible, until the app restarts. A timed-out fetch REJECTS instead, which the
// existing per-call catch already handles (attempts++, escalate to failed).
// Env-overridable so tests can use a short timeout.
const SYNC_FETCH_TIMEOUT_MS = Number(process.env.SYNC_FETCH_TIMEOUT_MS) || 20_000;
async function syncFetch(url: string, opts: any = {}): Promise<Response> {
  const ctrl = new AbortController();
  let timer = setTimeout(
    () => ctrl.abort(new Error(`sync fetch timed out after ${SYNC_FETCH_TIMEOUT_MS}ms`)),
    SYNC_FETCH_TIMEOUT_MS);
  try {
    // A410: on a till with a branch server, through the server — the only machine on the branch that talks to the cloud.
    const res = await cloudFetch(url, { ...opts, signal: ctrl.signal });
    if (typeof (res as any)?.arrayBuffer !== 'function') return res;
    // A448: the body too has a time limit. Before, the limit ended with the headers — a line that stalled mid-answer (a
    // big menu on a weak link) held the pull, and every pull queued behind it, for good. Read here, handed back whole.
    clearTimeout(timer);
    timer = setTimeout(
      () => ctrl.abort(new Error(`sync fetch body timed out after ${SYNC_FETCH_TIMEOUT_MS}ms`)),
      SYNC_FETCH_TIMEOUT_MS);
    const nullBody = [101, 204, 205, 304].includes(res.status);
    const body = nullBody ? null : await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}
// A20: last roster version this peer applied, in-memory. Skips re-wrapping an
// unchanged roster every pull; on restart it re-applies once, which is harmless.

export function configureSyncEngine(serverUrl: string, accessToken: string, refreshToken = '') {
  _serverUrl    = serverUrl;
  _accessToken  = accessToken;
  _refreshToken = refreshToken;
}

// Set/clear the active staff token. Called on PIN login and shift end.
/** A448: send this till's queued changes / ask after the ones with the owner — with the till's OWN session (the person who
 *  made each may have signed out; the cloud checks their permission), through the branch server on a till behind one. */
export async function tillChangesPost(changes: Record<string, unknown>[]): Promise<Response> {
  if (!_serverUrl || !_accessToken) throw new Error('not signed in');
  const branch = getDeviceConfig()?.branch_id ?? '';
  const go = () => syncFetch(`${_serverUrl}/api/changes`, { method: 'POST', headers: { ...authHeaders(), ...(branch ? { 'X-Branch-Id': branch } : {}) },
    body: JSON.stringify({ changes }) });
  let res = await go();
  if (res.status === 401 && await refreshAccessToken()) res = await go();
  return res;
}
export async function tillChangesState(ids: string[]): Promise<Array<{ id: string; status: string; message?: string | null }>> {
  const res = await rosterCloudGet(`/api/changes/state?ids=${encodeURIComponent(ids.join(','))}`);
  return res.ok ? await res.json() as any : [];
}

/** A446: a signed-in GET to the cloud for the staff list (through the branch server on a till behind one); one renewal
 *  on a 401. Kept here because the sync engine owns the till's tokens. */
export async function rosterCloudGet(path: string): Promise<Response> {
  if (!_serverUrl || !_accessToken) throw new Error('not signed in');
  let res = await syncFetch(`${_serverUrl}${path}`, { headers: authHeaders() });
  if (res.status === 401 && await refreshAccessToken()) res = await syncFetch(`${_serverUrl}${path}`, { headers: authHeaders() });
  return res;
}

export function configureStaffSession(staffToken: string, staffRefresh = '') {
  _staffToken   = staffToken;
  _staffRefresh = staffRefresh;
  // F6: a new sign-in starts its own renewal pace (the last person's "renewed a moment ago" is not this one's).
  _staffRenewedAt = 0; _staffRenewalFailedAt = 0;
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    // Same spelling as pushAuthHeaders. These two builders disagreed —
    // 'x-device-id' here, 'X-Device-Id' there — and when a copy-paste brought
    // both spellings into ONE object, fetch sent the header twice and the
    // server received them comma-joined. Header names are case-insensitive to
    // HTTP but not to an object literal, so consistency here is what stops that
    // recurring.
    'X-Device-Id': getDeviceConfig()?.device_id ?? '',
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
// meantime. Anything holding the till's own token must be able to refresh and retry.
/**
 * SINGLE-FLIGHT. Three call sites reach this — tillFetch (the PIN pad), the
 * sync loop, and the order push — and they overlap at boot.
 *
 * Refresh tokens ROTATE. Before A477 auth.ts revoked the consumed one before
 * issuing the replacement, so two concurrent refreshes presenting the same token
 * raced and the loser was handed a 401 for a token that was valid when it read
 * it. A477's handshake re-asks instead, but one renewal at a time is still what
 * keeps the chain single-headed — and it is what the A477 gate hangs on.
 *
 * While a refresh is in flight every other caller awaits the same promise.
 */
let _refreshInFlight: Promise<boolean> | null = null;

// A473 (owner, 2026-10-14: "sometimes it takes up to 8-12 sec for the desktop app to unlock"): when the cloud has
// REFUSED this till's session (the renewal and the device secret both said no — a technician must rejoin it), every PIN
// sign-in still asked the cloud, waited for the same doomed renewal and device sign-in, and only then checked the PIN on
// the till: three round trips per sign-in. The refusal is remembered and the PIN pad goes straight to the till's own
// check while it holds. Any successful renewal clears it. A477: it also drives the renewal gate — after a refusal no
// caller asks the cloud again for 15 minutes (renewalHeldUntil), unless a technician acts (resetRenewalGate).
let _sessionRefusedAt: number | null = null;
export function tillSessionRefusedRecently(windowMs = 60_000, now = Date.now()): boolean {
  return _sessionRefusedAt !== null && now - _sessionRefusedAt < windowMs;
}
/** Test seam. */
export function _setSessionRefusedAt(at: number | null): void { _sessionRefusedAt = at; }

export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = doRefreshAccessToken().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

// ── A477: one gate for every caller ──────────────────────────────────────────
// Owner, 2026-10-14: on 2026-10-12 several callers (the sync loop, the shift push, the web-sales poll, the version
// check, the PIN pad) asked the cloud to renew a refused session many times a minute — 429 "Too many renewals" — and
// the log rotated away how it started. Now, after a definitive refusal (the renewal AND the device grant said no:
// TOKEN_STALE, TOKEN_REPLAYED, DEVICE_MISMATCH, DEVICE_NO_SECRET, any 401) no caller asks again for 15 minutes; after
// a 429 none asks before its Retry-After (else 15 minutes). Only a technician's action (a rejoin) opens it early. The
// till keeps selling meanwhile — nothing is shown to the cashier (the owner is emailed by the cloud).
export const RENEWAL_BACKOFF_MS = 15 * 60_000;
const RETRY_AFTER_CAP_MS = 60 * 60_000;
let _renewalRetryAt = 0;
let _renewalHeldLogged = 0;

/** Until when no renewal may be attempted (ms since epoch), or null when one may. */
export function renewalHeldUntil(now = Date.now()): number | null {
  const refused = _sessionRefusedAt !== null ? _sessionRefusedAt + RENEWAL_BACKOFF_MS : 0;
  const until = Math.max(refused, _renewalRetryAt);
  return until > now ? until : null;
}

/** A technician's action (a rejoin, a new enrolment code): the gate opens at once. */
export function resetRenewalGate(reason: string): void {
  _sessionRefusedAt = null;
  _renewalRetryAt = 0;
  _renewalHeldLogged = 0;
  authLog('gate-open', reason);
}

/** How long a 429 asks the till to wait: Retry-After (seconds or an HTTP date), else RateLimit-Reset, else 15 min. */
export function retryAfterMs(headers: { get(name: string): string | null } | null | undefined, now = Date.now()): number {
  const ra = String(headers?.get('retry-after') ?? '').trim();
  let ms: number | null = null;
  if (/^\d+$/.test(ra)) ms = Number(ra) * 1000;
  else if (ra) { const t = Date.parse(ra); if (Number.isFinite(t)) ms = t - now; }
  if (ms === null) { const reset = String(headers?.get('ratelimit-reset') ?? '').trim(); if (/^\d+$/.test(reset)) ms = Number(reset) * 1000; }
  if (ms === null || ms <= 0) ms = RENEWAL_BACKOFF_MS;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

function noteTooManyRenewals(res: Response, what: string): void {
  const wait = retryAfterMs(res.headers);
  _renewalRetryAt = Date.now() + wait;
  authLog('renewal-limited', `${what}: HTTP 429 - no renewal for ${Math.round(wait / 1000)} s`);
}

/** A refusal's code and a log-safe description, reading the body once. */
async function readRefusal(res: Response): Promise<{ code: string; detail: string }> {
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let code = '';
  try { code = String(JSON.parse(text)?.code ?? ''); } catch { code = ''; }
  const detail = await describeResponse({ status: res.status, statusText: res.statusText, text: async () => text });
  return { code, detail };
}

/** The headers that say which machine this is (A477, hashed) and whether the till lost its device secret. */
async function renewalHeaders(): Promise<Record<string, string>> {
  let ident: Record<string, string> = {};
  try { ident = await identityHeaders(); } catch { ident = {}; }
  let missing = false;
  try { missing = !readDeviceSecret(); } catch { missing = false; }
  return { ...ident, ...(missing ? { 'X-Device-Secret-Missing': '1' } : {}) };
}

/** A477: the ack in flight (test seam: await it). */
let _ackInFlight: Promise<void> | null = null;
export function _awaitAck(): Promise<void> { return _ackInFlight ?? Promise.resolve(); }

/** A477: tell the cloud the new token is kept (written to disk) — it then retires the old one. A failure is harmless:
 *  the next renewal presents the new token, which confirms it. */
async function confirmRenewal(token: string, viaNode: boolean): Promise<void> {
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceConfig()?.device_id ?? '', ...(await identityHeaders().catch(() => ({}))) };
    const ok = viaNode
      ? await ackViaNode(token, headers)
      : (await syncFetch(`${_serverUrl || getCloudUrl()}/api/auth/refresh/ack`, { method: 'POST', headers, body: JSON.stringify({ refreshToken: token }) })).ok;
    authLog(ok ? 'ack' : 'ack-failed', ok ? (viaNode ? 'via the branch server' : '') : 'not confirmed now - the next renewal confirms it');
  } catch (e: any) {
    authLog('ack-failed', `${e?.message ?? e} - the next renewal confirms it`);
  }
}

/** A477: keep a new pair — disk FIRST (the only source of the token at the next renewal), then memory, then the ack. */
function keepRenewedPair(pair: { accessToken: string; refreshToken: string; ack?: boolean }, viaNode: boolean): void {
  let kept = true;
  try { writeSessionTokens({ token: pair.accessToken, refreshToken: pair.refreshToken }); }
  catch (e: any) { kept = false; logLine('auth', `the renewed sign-in could not be written to disk (${e?.message ?? e}) - the next renewal asks again`); }
  _accessToken  = pair.accessToken;
  _refreshToken = pair.refreshToken;
  // Unconfirmed until it is on disk: an ack for a token the till could lose would retire the one it still holds.
  if (kept && pair.ack) _ackInFlight = confirmRenewal(pair.refreshToken, viaNode);
}

// Reads the persisted refresh token. A477: the ONLY source of the token at renewal time — the in-memory copy is a cache
// that can lag what is on disk (the 2026-10-12 sign-out: a stale copy presented to a rotating endpoint).
function persistedRefresh(): string {
  try { return readSessionTokens().refreshToken; } catch { return ''; }
}

async function doRefreshAccessToken(): Promise<boolean> {
  // A477: the gate every caller shares.
  const held = renewalHeldUntil();
  if (held !== null) {
    if (Date.now() - _renewalHeldLogged > 60_000) {
      _renewalHeldLogged = Date.now();
      logLine('auth', `renewal held back until ${new Date(held).toISOString()} (the cloud refused it, or asked the till to wait)`);
    }
    return false;
  }
  // A477: disk first, read right before the attempt. Memory only when nothing is on disk (configureSyncEngine ran
  // before the first write).
  let refresh = persistedRefresh() || _refreshToken;
  if (!refresh) return false;

  // A160: when the cloud can't be reached (thrown) or answers a 5xx (down but
  // responding), a peer refreshes THROUGH its node instead of falling to a login.
  // The node brokers the refresh upstream and hands back a fresh pair — so an
  // offline peer keeps its session as long as the node has internet. A clean 401
  // (revoked) is NOT retried here: the node returns null and the session ends.
  const tryNodeRefresh = async (): Promise<boolean> => {
    if (!hasNode()) return false;
    const pair = await refreshViaNode(refresh, await renewalHeaders());
    if (!pair) return false;
    keepRenewedPair(pair, true);   // A477: disk, memory, then the ack (through the branch server)
    if (pair.deviceSecret) { writeDeviceSecret(pair.deviceSecret); authLog('device-secret', 'received through the branch server and kept'); }
    clearInboundFailure('auth'); _sessionRefusedAt = null;
    logLine('auth', 'access token refreshed via the branch node (cloud unreachable)');
    authLog('renewal-ok', 'via the branch server');
    return true;
  };

  const attempt = async (token: string) => {
    const res = await syncFetch(`${_serverUrl || getCloudUrl()}/api/auth/refresh`, {
      method: 'POST',
      // A407: the device id lets the cloud hand this till a device secret if it has none yet.
      // A477: and which machine this is (hashed), and whether the till lost its device secret.
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceConfig()?.device_id ?? '', ...(await renewalHeaders()) },
      body: JSON.stringify({ refreshToken: token }),
    });
    return res;
  };

  // A407: the cloud refused the session (revoked, or expired after 30+ days off) — sign back in with the device secret.
  // With no secret the cloud is still told (it records the till as signed out, and ZapTill is emailed).
  const tryDeviceGrant = async (): Promise<boolean> => {
    let businessId: string | null = null;
    try { businessId = (getLocalDb().prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined)?.business_id ?? null; }
    catch { businessId = null; }
    const body = deviceGrantBody(businessId, getDeviceConfig()?.device_id, readDeviceSecret());
    if (!body) return false;
    try {
      const res = await syncFetch(`${_serverUrl || getCloudUrl()}/api/auth/device-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(await identityHeaders().catch(() => ({}))) }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429) noteTooManyRenewals(res, 'device sign-in');
        const r = await readRefusal(res);
        authLog('device-grant-refused', `${r.code || `HTTP ${res.status}`}`);
        noteInboundFailure('auth', `the till could not sign itself back in: ${r.detail}`);
        return false;
      }
      const pair = await res.json() as { accessToken: string; refreshToken: string };
      keepRenewedPair(pair, false);   // a new session: nothing to confirm
      clearInboundFailure('auth'); _sessionRefusedAt = null;
      logLine('auth', 'session refused - the till signed itself back in with its device secret');
      authLog('device-grant-ok', 'signed back in with the device secret');
      return true;
    } catch (e: any) {
      logLine('auth', `device sign-in error: ${e?.message ?? e}`);
      return false;
    }
  };

  try {
    let res = await attempt(refresh);

    // One retry, and only when disk holds a DIFFERENT token from the one just
    // rejected — that means something rotated it while the request was in flight,
    // so the rejection is bookkeeping rather than a revoked session.
    // Retrying the SAME token would just re-ask a question already answered.
    if (res.status === 401) {
      const onDisk = persistedRefresh();
      if (onDisk && onDisk !== refresh) {
        logLine('auth', 'refresh rejected on a stale token; retrying with the persisted one');
        refresh = onDisk;
        res = await attempt(refresh);
      }
    }

    if (!res.ok) {
      // A477: too many renewals — wait as asked; asking again only extends the wait.
      if (res.status === 429) {
        noteTooManyRenewals(res, 'renewal');
        noteInboundFailure('auth', `till token refresh failed: ${(await readRefusal(res)).detail}`);
        return false;
      }
      // A160: a 5xx means the cloud answered but can't serve — treat it like
      // unreachable and let the node broker the refresh before giving up.
      if (res.status >= 500 && await tryNodeRefresh()) return true;
      const refusal = res.status === 401 ? await readRefusal(res) : null;
      if (refusal) authLog('renewal-refused', `${refusal.code || 'HTTP 401'} - trying the device secret`);
      // A407: refused (401) — the till signs itself back in with its device secret before giving up.
      if (res.status === 401 && await tryDeviceGrant()) return true;
      if (res.status === 401) _sessionRefusedAt = Date.now();   // A473: refused for good until rejoined
      if (refusal) authLog('renewal-held', `no renewal for ${RENEWAL_BACKOFF_MS / 60_000} min (${refusal.code || 'HTTP 401'})`);
      // Rotation means a revoked token can never be recovered: the owner must
      // sign in again, and with no internet they cannot. Recording it is the
      // difference between "it logged me out again" and knowing which refresh
      // was rejected and when.
      noteInboundFailure('auth', `till token refresh failed: ${refusal ? refusal.detail : await describeResponse(res)}`);
      return false;
    }
    const { accessToken, refreshToken, deviceSecret, ack } = (await res.json()) ?? {};
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
      noteInboundFailure('auth', 'till token refresh: the answer carried no sign-in');
      return false;
    }
    // A477: disk first, then memory, then the ack (keepRenewedPair). With the handshake the cloud has NOT retired the
    // old token yet — a crash before the write leaves the till holding the old one, and presenting it again simply
    // re-asks (register D13, A477).
    keepRenewedPair({ accessToken, refreshToken, ack: ack === true }, false);
    // A407: a till enrolled before it kept a device secret is given one on an ordinary renewal — keep it (after the
    // tokens: their write stays first).
    if (typeof deviceSecret === 'string' && deviceSecret) { writeDeviceSecret(deviceSecret); logLine('auth', 'device secret received and kept'); authLog('device-secret', 'received and kept'); }
    clearInboundFailure('auth'); _sessionRefusedAt = null;
    _renewalRetryAt = 0;
    authLog('renewal-ok', ack === true ? 'confirming the new key' : '');
    return true;
  } catch (err: any) {
    // A160: the cloud is unreachable (DNS/refused/timeout). Before giving up,
    // ask the node to broker the refresh — only the node needs internet.
    if (await tryNodeRefresh()) return true;
    noteInboundFailure('auth', `till token refresh error: ${err?.message ?? err}`);
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

/**
 * A504: the signed-in person's token, or '' once the cloud has refused its renewal for good (401 — the person was
 * deactivated, re-roled or moved, or the session revoked; A494 ends sessions on each). Before, the dead token was sent on
 * every push until the person signed out: drawers, trading days, expenses, closes, confirmations and price edits waited
 * all shift (orders alone fell back to the till's session). Every one of those carries who did it in its body, and the
 * cloud takes the till's own session for each (/api/sync/push: req.isTill).
 */
function liveStaffToken(): string {
  if (!_staffToken) return '';
  if (_staffRefusedToken && (persistedStaffRefresh() || _staffRefresh) === _staffRefusedToken) return '';
  return _staffToken;
}

// Auth header for order push — uses the staff token if a shift is active,
// otherwise falls back to the till's own token (no one signed in online).
function pushAuthHeaders() {
  const token = liveStaffToken() || _accessToken;   // A504: never a staff token whose renewal was refused
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    // Which local schema this build carries. Tills are updated by installing an
    // .exe by hand, so one is always behind; sending this lets the server say so
    // instead of the mismatch surfacing as an opaque column error mid-service.
    'X-Schema-Version': String(LOCAL_SCHEMA_VERSION),
    // Stable per-install identity, so the fleet view can attribute sync recency
    // to a specific terminal rather than to a User-Agent hash shared by all three.
    //
    // ONE key only. This object carried BOTH 'x-device-id' and 'X-Device-Id'.
    // HTTP header names are case-insensitive, so fetch sent the pair and the
    // server received them JOINED WITH A COMMA — then `.slice(0, 64)` chopped
    // the result mid-uuid. Observed in production 2026-08-09:
    //
    //   [fleet] no user_devices row for device
    //     24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
    //
    // `WHERE device_id = ?` could never match that, so fleet telemetry would
    // have stayed broken even after registration started creating rows. Two
    // independent faults producing one symptom, which is why the first fix
    // appeared to do nothing.
    'X-Device-Id': getDeviceConfig()?.device_id ?? '',
    // What this terminal IS — 'till', 'node' or 'office'. The server had no way
    // to know: it saw a device id, a schema version and a build number, and every
    // machine looked like a counter terminal. That blocks two things — activation
    // seats (an office machine is explicitly not meant to consume one) and
    // PHASE5's credential distribution, which must not hand the branch roster to
    // anything that cannot be shown to serve the branch (register A25).
    //
    // A CLAIM, not a credential. The server records it so it can be seen and
    // audited; it must not on its own authorise anything, exactly as branch_id
    // was a claim until migration 52 gave the server something to check it
    // against.
    'X-Device-Role': getDeviceConfig()?.device_role ?? '',
    // A182: a stable machine MAC so the cloud can bind terminal identity to the
    // physical box, and hand a reinstalled till its old terminal code/name back
    // instead of a blank slate that gets re-named "T1" and collides (A181). A
    // hint, never a credential — device_id stays the hard key.
    ...(getMacAddressCached() ? { 'X-Device-Mac': getMacAddressCached() as string } : {}),
  };
}

// Refresh the active STAFF token (each shift independent) and persist to
// staff_session. Returns false if there's no staff refresh token or it failed.
//
// Same single-flight reasoning as the owner path, and four call sites here
// rather than three — the push loop, the node push, order create and the shift
// path all reach it, and a busy till runs them together.
let _staffRefreshInFlight: Promise<boolean> | null = null;

export async function refreshStaffToken(): Promise<boolean> {
  if (_staffRefreshInFlight) return _staffRefreshInFlight;
  _staffRefreshInFlight = doRefreshStaffToken().finally(() => { _staffRefreshInFlight = null; });
  return _staffRefreshInFlight;
}

function persistedStaffRefresh(): string {
  return readStaffTokens().refreshToken;
}

/** A446: who is signed in on this till right now (staff_session), or null. */
function signedInStaffId(): string | null {
  try { return (getLocalDb().prepare(`SELECT staff_id FROM staff_session WHERE id = 1`).get() as { staff_id?: string } | undefined)?.staff_id ?? null; }
  catch { return null; }
}

// A477: a staff token the cloud refused for good is never presented again (it can only be refused again) — the person
// signs in with their PIN anew.
let _staffRefusedToken = '';
// Till sync audit (F6): the staff renewal's own pace. The 20-s pollers (web sales, shift state, confirmations) each
// renewed on every 401 — with a staff token the cloud keeps refusing for another reason, that was a rotation every
// 20 s per poller, all from one shop IP that the cloud's limiter allows 120 per 15 minutes. Now:
//   - renewed in the last minute → no new renewal: the caller retries with the token it has (true), once;
//   - a renewal that failed for a passing reason (5xx, unreachable) → none for a minute;
//   - a 429 → the shared A477 gate (Retry-After), which also holds the till's own renewal.
export const STAFF_RENEWAL_FRESH_MS = 60_000;
const STAFF_RENEWAL_RETRY_MS = 60_000;
let _staffRenewedAt = 0;
let _staffRenewalFailedAt = 0;
/** Test seam. */
export function _resetStaffRenewalPace(): void { _staffRenewedAt = 0; _staffRenewalFailedAt = 0; _staffRefusedToken = ''; }

async function doRefreshStaffToken(): Promise<boolean> {
  // A477: disk first, as the till's own session.
  let refresh = persistedStaffRefresh() || _staffRefresh;
  if (!refresh) return false;
  if (refresh === _staffRefusedToken) return false;
  // F6: the same gate as the till's own renewal — a 429's Retry-After, or a refused till session, holds this one too.
  if (renewalHeldUntil() !== null) return false;
  const now = Date.now();
  if (_staffRenewedAt && now - _staffRenewedAt < STAFF_RENEWAL_FRESH_MS && _staffToken) return true;
  if (_staffRenewalFailedAt && now - _staffRenewalFailedAt < STAFF_RENEWAL_RETRY_MS) return false;
  // A446 (session audit): a renewal that finishes after its cashier signed out and another signed in must not write the
  // first cashier's session over the second's — the second's sales would go out under the first's name.
  const who = signedInStaffId();
  // F6: which till asks (the cloud's limiter keys a till by its device id, not the shop's shared IP), and the machine.
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceConfig()?.device_id ?? '', ...(await renewalHeaders()) };
  const attempt = (token: string) => syncFetch(`${_serverUrl}/api/auth/refresh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refreshToken: token }),
  });
  try {
    let res = await attempt(refresh);
    if (res.status === 401) {
      const onDisk = persistedStaffRefresh();
      if (onDisk && onDisk !== refresh) {
        logLine('auth', 'staff refresh rejected on a stale token; retrying with the persisted one');
        refresh = onDisk;
        res = await attempt(refresh);
      }
    }
    if (!res.ok) {
      if (res.status === 401) { _staffRefusedToken = refresh; authLog('staff-renewal-refused', `HTTP ${res.status}`); }
      else if (res.status === 429) noteTooManyRenewals(res, 'staff renewal');   // F6: wait as asked (the shared gate)
      else _staffRenewalFailedAt = Date.now();                                   // F6: a passing failure — not for a minute
      noteInboundFailure('auth', `staff token refresh failed: ${await describeResponse(res)}`);
      return false;
    }
    const { accessToken, refreshToken, ack, permissions } = await res.json();
    if (signedInStaffId() !== who) {
      logLine('auth', 'staff token renewed after a different person signed in — discarded');
      return false;
    }
    // A490: a cloud that knows the catalogue answers a person's renewal with their CURRENT permissions — kept for the
    // person still signed in (the screens re-read them), so a key taken away goes at the next renewal, not the next sign-in.
    if (permissions && typeof permissions === 'object' && storeSessionPermissions(who, permissions)) {
      logLine('auth', 'the signed-in person’s permissions changed at the staff renewal — the screens follow');
    }
    // A477: disk first, then memory, then the ack.
    const nextRefresh = refreshToken ?? _staffRefresh;
    let kept = true;
    try { writeStaffTokens({ token: accessToken, refreshToken: nextRefresh }); }
    catch (e: any) { kept = false; logLine('auth', `the renewed staff sign-in could not be written to disk (${e?.message ?? e})`); }
    _staffToken   = accessToken;
    _staffRefresh = nextRefresh;
    if (kept && ack === true && refreshToken) _ackInFlight = confirmRenewal(refreshToken, false);
    clearInboundFailure('auth');
    _staffRenewedAt = Date.now(); _staffRenewalFailedAt = 0;
    return true;
  } catch (err: any) {
    _staffRenewalFailedAt = Date.now();   // F6: unreachable — not again for a minute
    noteInboundFailure('auth', `staff token refresh error: ${err?.message ?? err}`);
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────

// A178: run each push stage independently so a throw in one — a schema error in a
// SELECT, a node timeout — can NEVER skip the others. The order push in particular
// must not be gated behind the shift push (that coupling is how 6 cash records
// could sit pending while orders were fine, or vice versa). Each stage already
// handles its own expected failures; this is the backstop for an unexpected throw.
// Till sync audit (F13): single-flight. Two passes (a stale one overtaken, the post-sale flush beside the timer) must
// never push the same rows side by side — a second caller waits for the pass running and takes its result.
let _pushStagesInFlight: Promise<{ orders: number; errors: string[] }> | null = null;
let _pushStagesStartedAt = 0;   // A508: the idle install waits for a push that has just started
async function runPushStages(errors: string[]): Promise<number> {
  if (!_pushStagesInFlight) {
    const mine: string[] = [];
    _pushStagesStartedAt = Date.now();
    _pushStagesInFlight = runPushStagesOnce(mine).then((orders) => ({ orders, errors: mine }))
      .finally(() => { _pushStagesInFlight = null; });
  }
  const r = await _pushStagesInFlight;
  errors.push(...r.errors);
  return r.orders;
}

/** A508: since when a sync push has been in flight (ms), or null — the idle install never cuts one that has just begun. */
export function syncPushSince(): number | null {
  if (_pushStagesInFlight) return _pushStagesStartedAt;
  if (_isSyncing && Date.now() - _syncStartedAt < SYNC_STALE_MS) return _syncStartedAt;
  return null;
}

/**
 * A508: before an idle install — one push pass (the outbox: sales, drawers, days, expenses, closes), at most `timeoutMs`
 * (a pass already running is waited for, then one more). Never throws and never holds the install longer than the cap:
 * whatever is still queued stays queued in the local database and goes up after the restart.
 */
export async function flushBeforeInstall(timeoutMs = 60_000): Promise<{ pushed: number; errors: string[]; timedOut: boolean }> {
  let timer: NodeJS.Timeout | null = null;
  const pass = (async () => {
    if (_pushStagesInFlight) await _pushStagesInFlight.catch(() => undefined);
    const r = await syncPush();
    return { ...r, timedOut: false };
  })().catch((e: any) => ({ pushed: 0, errors: [String(e?.message ?? e)], timedOut: false }));
  const cap = new Promise<{ pushed: number; errors: string[]; timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ pushed: 0, errors: [`no answer in ${Math.round(timeoutMs / 1000)} s`], timedOut: true }), timeoutMs);
  });
  try { return await Promise.race([pass, cap]); }
  finally { if (timer) clearTimeout(timer); }
}
async function runPushStagesOnce(errors: string[]): Promise<number> {
  let orders = 0;
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | 0> => {
    try { return await fn(); }
    catch (err: any) {
      errors.push(`${name}: ${err?.message ?? err}`);
      logLine('sync', `${name} stage threw: ${err?.message ?? err}`);
      return 0;
    }
  };
  // A338: first, give back to the queue what a sibling drawer's clash parked (0.6.10 and earlier), so it goes in this pass.
  // A363: then what a trading-day clash parked (an offline close-and-reopen), once.
  await stage('requeue', async () => { requeueAfterDayClash(); requeueTransientConflicts(); return requeueAfterDrawerClash(); });
  await stage('shift push', () => pushLocalRecords(errors));
  await stage('price push', () => pushBranchPriceEdits(errors));
  // A411: station routing saved on this till while the cloud could not be reached.
  await stage('station routing', async () => { await pushStationRoutingNow(); return 0; });
  // A414: wastage recorded on this till while the cloud could not be reached.
  await stage('wastage', async () => { await pushWastageNow(); return 0; });
  orders = (await stage('order push', () => pushPendingOrders(errors))) || 0;
  // 0.6.30 (A336 stage 3): then the voids and refunds made while offline — after the order push, so the sale is there.
  // Till sync audit (F2): and BEFORE the shift close — a close that reached the cloud ahead of its drawer's offline voids
  // and refunds was computed on the unvoided sales and showed a shortage that was not there.
  await stage('reversals', () => pushOfflineReversals(errors));
  await stage('reconcile', () => reconcileClosedShifts(errors));
  // A365: then a manager's confirmation of a shift whose close is on the cloud.
  await stage('confirm', () => pushShiftConfirmations(errors));
  await stage('node push', () => pushToNode(errors));
  // A363: the manager's "Last synced" — stamped only when this pass left nothing waiting for the cloud.
  await stage('last synced', async () => noteSyncedIfClear());
  return orders;
}

// A178: a REAL reachability probe the tech screen can run. Unlike the "ONLINE"
// badge (which is only net.isOnline() — "this machine has a network"), this
// actually reaches the configured server and reports the round-trip. Uses the
// same timeout as every other sync fetch.
export async function testConnection(): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }> {
  const url = `${_serverUrl || getCloudUrl()}/api/health`;
  const t0 = Date.now();
  try {
    const res = await syncFetch(url, { method: 'GET' });
    const ms = Date.now() - t0;
    logLine('sync', `connection test: HTTP ${res.status} in ${ms}ms`);
    return { ok: res.ok || res.status === 401 || res.status === 404, status: res.status, ms };
  } catch (err: any) {
    const ms = Date.now() - t0;
    logLine('sync', `connection test FAILED in ${ms}ms: ${err?.message ?? err}`);
    return { ok: false, status: null, ms, error: err?.message ?? String(err) };
  }
}

// ── A411: station routing saved on the till first, sent to the cloud after (stationRouting.ts) ─────────────────────
export function stationRoutingPending(): boolean {
  try { return Object.keys(readPendingRouting(getLocalDb())).length > 0; } catch { return false; }
}
let _routingPushInFlight: Promise<Record<string, PushOutcome>> | null = null;
/** Send what is waiting (single-flight: a tap and the sync timer must not send one set twice). Never throws. */
// ── A414: wastage recorded on the till, sent to the cloud after (tillWastage.ts) ─────────────────────────────────────
export function wastagePending(): boolean {
  try { return readPendingWaste(getLocalDb()).length > 0; } catch { return false; }
}
let _wastePushInFlight: Promise<Record<string, WasteOutcome>> | null = null;
/** Send what is waiting (single-flight: a recording and the sync timer must not send one twice). Never throws. */
export function pushWastageNow(): Promise<Record<string, WasteOutcome>> {
  if (_wastePushInFlight) return _wastePushInFlight;
  _wastePushInFlight = (async () => {
    const db = getLocalDb();
    const waiting = readPendingWaste(db);
    if (!waiting.length) return {};
    if (!_accessToken || !_serverUrl || !isOnline()) {
      const out: Record<string, WasteOutcome> = {};
      for (const w of waiting) out[w.client_id] = { state: 'pending', message: 'Saved on this till — it goes to the cloud when the connection is back.' };
      return out;
    }
    const outcomes = await pushPendingWastage(db, async (rec) => {
      const post = () => syncFetch(`${_serverUrl}/api/wastage`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ branch_id: rec.branch_id, reason: rec.reason, note: rec.note, items: rec.items,
          client_id: rec.client_id, recorded_by_name: rec.recorded_by_name, recorded_at: rec.recorded_at }),
      });
      let res = await post();
      if (res.status === 401 && await refreshAccessToken()) res = await post();
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }, describeServerError);
    for (const [id, o] of Object.entries(outcomes)) {
      if (o.state === 'saved') logLine('sync', `wastage ${id}: saved as ${o.ref}`);
      else if (o.state === 'refused') logLine('sync', `wastage ${id}: refused — ${o.message}`);
    }
    return outcomes;
  })().finally(() => { _wastePushInFlight = null; });
  return _wastePushInFlight;
}

export function pushStationRoutingNow(): Promise<Record<string, PushOutcome>> {
  if (_routingPushInFlight) return _routingPushInFlight;
  _routingPushInFlight = (async () => {
    const db = getLocalDb();
    if (!Object.keys(readPendingRouting(db)).length) return {};
    if (!_accessToken || !_serverUrl || !isOnline()) {
      const out: Record<string, PushOutcome> = {};
      for (const id of Object.keys(readPendingRouting(db))) out[id] = { state: 'pending', message: 'Saved on this till — it goes to the cloud when the connection is back.' };
      return out;
    }
    const outcomes = await pushPendingRouting(db, async (stationId, categoryIds) => {
      const put = () => syncFetch(`${_serverUrl}/api/stations/${encodeURIComponent(stationId)}/categories`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ category_ids: categoryIds }),
      });
      let res = await put();
      if (res.status === 401 && await refreshAccessToken()) res = await put();
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }, describeServerError);
    for (const [id, o] of Object.entries(outcomes)) {
      if (o.state !== 'pending') logLine('sync', `station routing ${id}: ${o.state}${o.state === 'refused' ? ` — ${o.message}` : ''}`);
    }
    return outcomes;
  })().finally(() => { _routingPushInFlight = null; });
  return _routingPushInFlight;
}

// ── 0.6.25: a logo uploaded on this till is saved to the cloud too ─────────────────────────────────────────────
// Owner, 2026-09-30: "when u upload the logo in the desktop app it removes it after a while … is it that the web config
// overrides it?" — yes: branding is remote-wins, and the tech upload was local only, so the next catalogue pull put the
// cloud's logo back. Decided: the till's upload ALSO saves to the cloud (PUT /api/business/branding, the till session).
// Until it lands the till keeps its own (the pull skips branding while pending); offline → it goes with the next sync.
const BRANDING_PENDING_KEY = 'branding_push_pending';
// Till sync audit (F8): the pending mark carries a VERSION (a new one per upload; '1' from a build before it still
// counts). The push clears only the version it sent — a logo uploaded again while the first was on its way stays pending.
function brandingPendingVersion(): string | null {
  try {
    const v = (getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(BRANDING_PENDING_KEY) as
      { value: string } | undefined)?.value;
    return v ? v : null;
  } catch { return null; }
}
export function brandingPushPending(): boolean {
  return brandingPendingVersion() !== null;
}
function setBrandingPending(on: boolean, version?: string | null): void {
  const db = getLocalDb();
  if (on) db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(BRANDING_PENDING_KEY, `${Date.now()}-${uuid()}`, new Date().toISOString());
  else if (version) db.prepare(`DELETE FROM maintenance_state WHERE key = ? AND value = ?`).run(BRANDING_PENDING_KEY, version);
  else db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(BRANDING_PENDING_KEY);
}
export type BrandingPushResult = { state: 'saved' | 'pending' | 'refused'; message?: string };
/** Mark this till's branding as needing the cloud, then try now. Called by branding:set after the local save. */
export async function queueBrandingPush(): Promise<BrandingPushResult> {
  setBrandingPending(true);
  return pushBrandingNow();
}
/** Send the till's branding row to the cloud. saved → pulls resume; pending → retried each sync; refused → pulls resume
 *  (the cloud's copy will come back) and the editor says why. */
export async function pushBrandingNow(): Promise<BrandingPushResult> {
  const version = brandingPendingVersion();
  if (!version) return { state: 'saved' };
  const db = getLocalDb();
  const sess = db.prepare(`SELECT business_id FROM session WHERE id = 1`).get() as { business_id: string } | undefined;
  const row = sess?.business_id ? db.prepare(
    `SELECT accent_hex, logo_png, logo_receipt, receipt_logo_enabled FROM branding WHERE business_id = ?`,
  ).get(sess.business_id) as { accent_hex: string | null; logo_png: string | null; logo_receipt: string | null; receipt_logo_enabled: number } | undefined : undefined;
  if (!row) { setBrandingPending(false, version); return { state: 'refused', message: 'No business on this till yet.' }; }
  if (!_accessToken || !_serverUrl || !isOnline()) return { state: 'pending', message: 'Offline — it will be saved to the cloud at the next sync.' };
  const body = JSON.stringify({
    accent_hex: row.accent_hex, logo_png: row.logo_png, logo_receipt: row.logo_receipt,
    receipt_logo_enabled: row.receipt_logo_enabled === 1,
  });
  const put = () => syncFetch(`${_serverUrl}/api/business/branding`, { method: 'PUT', headers: authHeaders(), body });
  try {
    let res = await put();
    if (res.status === 401 && await refreshAccessToken()) res = await put();
    if (res.ok) {
      setBrandingPending(false, version);
      logLine('sync', 'branding saved to the cloud');
      return { state: 'saved' };
    }
    // F8: the cloud down (5xx), the till's session not renewable right now (401 — the A477 gate may be holding it), a
    // timeout (408) or too many requests (429) is not a refusal of the logo: it stays pending (as stationRouting.ts).
    if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) {
      return { state: 'pending', message: `The cloud did not take it yet (HTTP ${res.status}) — it will retry at the next sync.` };
    }
    const err = await res.json().catch(() => ({} as any));
    setBrandingPending(false, version);
    const message = describeServerError(err, res.status);
    logLine('sync', `branding refused by the cloud (HTTP ${res.status}): ${message}`);
    return { state: 'refused', message };
  } catch (e: any) {
    return { state: 'pending', message: `Could not reach the cloud (${e?.message ?? e}) — it will retry at the next sync.` };
  }
}

export async function syncAll(): Promise<{ pulled: boolean; pushed: number; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pulled: false, pushed: 0, errors: ['Not configured'] };
  if (!isOnline()) return { pulled: false, pushed: 0, errors: ['Offline'] };
  const me = takeSyncFlag();
  if (!me) return { pulled: false, pushed: 0, errors: ['Sync already in progress'] };
  const errors: string[] = [];
  let pulled = false;
  let pushed = 0;

  try {
    // Refresh the DEVICE token before it expires rather than after (A51). The
    // reactive branch below is untouched and stays the backstop — this only
    // stops the 10-minute tick colliding with the 15-minute lifetime and
    // 401'ing every second pull by construction.
    await refreshDeviceTokenIfExpiring();

    // 0.6.25: this till's own logo upload goes up BEFORE the pull, so the pull brings back the same logo.
    if (brandingPushPending()) { try { await pushBrandingNow(); } catch { /* stays pending */ } }
    // A411: routing saved on this till goes up before the pull, so the pull brings it back rather than the old one.
    if (stationRoutingPending()) { try { await pushStationRoutingNow(); } catch { /* stays pending */ } }
    // F13: a pull that throws (any fetch in it) is the pull's failure alone — the push stages below still run.
    const pullSafely = () => pullCatalogueOnce().catch((e: any) => {
      errors.push(`Catalogue pull: ${e?.message ?? e}`);
      logLine('sync', `catalogue pull threw: ${e?.message ?? e}`);
      return false;
    });
    pulled = await pullSafely();
    // Till sync audit (F7): renew only when the pull was refused with a 401. Renewing after ANY failed pull (a 403, a
    // 5xx, the cloud out of reach) rotated the till's key about three times a minute while a catalogue version waited.
    if (!pulled && _lastPullStatus === 401 && (_refreshToken || persistedRefresh())) {
      const refreshed = await refreshAccessToken();
      if (refreshed) pulled = await pullSafely();
    }
    // A321: tell the open screens. Every pull path — the 10-min floor, startup, enrol, branch change,
    // manual sync, post-edit sync and the 20-s freshness check — goes through here, so this is the
    // ONE place the signal is raised. It used to be raised only by the 20-s check (index.ts), so a
    // change brought in by any other path sat in the local DB until a screen was re-opened (owner,
    // 2026-09-23: "the changes reflect but I have to login first then log out").
    if (pulled) notifyCataloguePulled();
    // A114: refresh the branch reveal code + tech public key on every online
    // sync, not just at owner login (which the till UI can't reach). This is what
    // lets a cashier-only till pick up a freshly-generated/backfilled reveal code.
    // Best-effort — a failure here must never affect the sync result.
    try { await refreshTechConfig(_accessToken); } catch { /* non-fatal */ }
    pushed = await runPushStages(errors);
    // A275: after pushing local state up, pull any remote day-close instruction
    // and execute it locally. Best-effort — must never affect the sync result.
    try { await runDayCloseInstructions(errors); } catch { /* non-fatal */ }
    // Cross-sync stage 1: the web's sales on this till's drawers. Best-effort, like the above.
    try { await pullWebSales(); } catch { /* non-fatal */ }
    // A404: test data ZapTill cleared on the cloud is cleared here too. Best-effort, like the above.
    try { await runTestDataClears(); } catch { /* non-fatal */ }
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    releaseSyncFlag(me);
  }

  return { pulled, pushed, errors };
}

/**
 * A513: the start-up sequence's first step — syncAll's pull and nothing else: this till's own logo / routing go up
 * first (so the pull does not put the old ones back), then the catalogue (menu, prices, offers, payment methods,
 * M-Pesa, business settings — one /api/pos/init), renewed once on a 401, and the screens told. The pushes and the
 * other pulls are later steps of their own (index.ts).
 */
export async function pullCatalogueNow(): Promise<{ pulled: boolean; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pulled: false, errors: ['Not configured'] };
  if (!isOnline()) return { pulled: false, errors: ['Offline'] };
  const me = takeSyncFlag();
  if (!me) return { pulled: false, errors: ['Sync already in progress'] };
  const errors: string[] = [];
  let pulled = false;
  try {
    await refreshDeviceTokenIfExpiring();
    if (brandingPushPending()) { try { await pushBrandingNow(); } catch { /* stays pending */ } }
    if (stationRoutingPending()) { try { await pushStationRoutingNow(); } catch { /* stays pending */ } }
    const pullSafely = () => pullCatalogueOnce().catch((e: any) => {
      errors.push(`Catalogue pull: ${e?.message ?? e}`);
      logLine('sync', `catalogue pull threw: ${e?.message ?? e}`);
      return false;
    });
    pulled = await pullSafely();
    if (!pulled && _lastPullStatus === 401 && (_refreshToken || persistedRefresh())) {
      if (await refreshAccessToken()) pulled = await pullSafely();
    }
    if (pulled) notifyCataloguePulled();
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    releaseSyncFlag(me);
  }
  return { pulled, errors };
}

/** A513: the branch's technician settings (reveal code, verification key) — syncAll's, as a start-up step of its own. */
export async function refreshTechConfigNow(): Promise<void> {
  if (!_accessToken || !_serverUrl || !isOnline()) return;
  try { await refreshTechConfig(_accessToken); } catch { /* non-fatal */ }
}

/** A513: syncAll's remote instructions (a day close from the web, test data cleared) — a start-up step of their own. */
export async function runRemoteInstructionsNow(): Promise<void> {
  if (!_accessToken || !_serverUrl || !isOnline()) return;
  try { await runDayCloseInstructions([]); } catch { /* non-fatal */ }
  try { await runTestDataClears(); } catch { /* non-fatal */ }
}

// A275 — pull any remote day-close instruction and execute it LOCALLY, then ack.
// The till is the cash authority: executeCloseDay computes this till's own expected
// cash + variance. Idempotent — a day already closed acks success (already_closed),
// and an instruction is re-offered until acked, so a crash between execute and ack
// is safe (the re-run no-ops). Best-effort: never throws into the sync result.
async function runDayCloseInstructions(errors: string[]): Promise<void> {
  const deviceId = getDeviceConfig()?.device_id ?? '';
  if (!deviceId) return;
  let pending: Array<{ id: string; kind: string; payload: any }> = [];
  try {
    const res = await syncFetch(`${_serverUrl}/api/day-close/pending`, { headers: authHeaders() });
    if (!res.ok) return;                 // 401/5xx — re-offered next cycle
    pending = await res.json();
  } catch {
    return;                              // offline/timeout — re-offered next cycle
  }
  for (const ins of pending ?? []) {
    if (ins.kind !== 'close_day') continue;
    const ack = executeCloseDay(ins.payload);
    try {
      await syncFetch(`${_serverUrl}/api/day-close/ack`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          instruction_id: ins.id,
          ok:      ack.ok,
          error:   ack.error ?? null,
          summary: ack.summary ?? null,
        }),
      });
    } catch (e: any) {
      // Close succeeded locally but the ack didn't land — leave it pending; the
      // idempotent re-run next cycle will ack success.
      errors.push(`day-close ack failed: ${e?.message ?? 'unknown'}`);
    }
  }
}

// Push-only pass — cheap (no catalogue pull), safe to run frequently.
// Used by the background interval, the post-sale flush, and online-reconnect.
export async function syncPush(): Promise<{ pushed: number; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pushed: 0, errors: ['Not configured'] };
  if (!isOnline()) return { pushed: 0, errors: ['Offline'] };
  const me = takeSyncFlag();
  if (!me) return { pushed: 0, errors: ['Sync already in progress'] };
  const errors: string[] = [];
  let pushed = 0;
  try {
    pushed = await runPushStages(errors);
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    releaseSyncFlag(me);
  }
  return { pushed, errors };
}

// Cross-sync stage 1 (2026-09-27): download the web POS's sales on this till's drawers (webSales.ts).
// Runs on the 20-s poll (index.ts), after every full sync and at sign-in — so a sale rung on the web as this
// till shows in its orders, shift panel and Z-report within ~20 s. Read-only on the cloud; fail-soft: any
// error skips this pass (the close still includes the web's cash through foreign-cash).
let _pullingWebSales = false;
export async function pullWebSales(): Promise<number> {
  if (!_serverUrl || !(_staffToken || _accessToken) || !isOnline() || _pullingWebSales) return 0;
  _pullingWebSales = true;
  let changed = 0;
  let failed = false;
  try {
    for (const shift of webSaleShifts()) {
      const doPull = () => syncFetch(`${_serverUrl}/api/shifts/${encodeURIComponent(shift.id)}/foreign-orders`, {
        method: 'POST',
        headers: pushAuthHeaders(),
        body: JSON.stringify({ own_ids: ownOrderIds(shift.id) }),
      });
      let res = await doPull();
      // A363: the signed-in cashier's token expires; the pushes renew it on a 401 and retry, this pull never did — so it
      // failed every 20 s for hours (T1, 2026-09-28: 250+ "HTTP 401" lines) until some push happened to renew it.
      if (res.status === 401 && await refreshStaffToken()) res = await doPull();
      if (res.status === 404) continue;   // not on the cloud yet (the shift push has not landed) — next pass
      if (!res.ok) { failed = true; noteInboundFailure('web-sales', `web sales pull failed: HTTP ${res.status}`); continue; }
      const body = await res.json() as { orders?: WebOrder[]; own_reversals?: OwnReversal[] };
      changed += applyWebOrders(shift, body.orders ?? []);
      // 0.6.26 (A336 follow-up): a void or refund made on the web of a sale THIS till rang.
      changed += applyOwnReversals(body.own_reversals ?? [], undefined, (id, at, reason) =>
        emitEvent('order_voided', id, { status: 'voided', voided_at: at, void_reason: reason }));
    }
    // A363: only a clean pass recovers — this used to run after a failed one too, so every failure was followed a
    // millisecond later by "recovered after: …" and the log could not show a real outage.
    if (!failed) clearInboundFailure('web-sales');
    if (changed) logLine('sync', `web sales: ${changed} downloaded or updated`);
  } catch (err: any) {
    noteInboundFailure('web-sales', `web sales pull error: ${err?.message ?? err}`);
  } finally {
    _pullingWebSales = false;
  }
  return changed;
}

// A401 — a drawer closed on the web (force-close, or a close with a count) closes on this till too. On the ~20 s beat
// (index.ts): the ids of this till's open shifts go to GET /api/shifts/state; each one the cloud has closed is closed
// here the same way and marked synced (the cloud already holds the close — the till never pushes a second one), then
// the screens are told so the cashier sees why selling stopped. Fail-soft: offline or an error → the next beat.
const _shiftClosedListeners = new Set<(c: LocalClose) => void>();
export function onShiftClosedElsewhere(cb: (c: LocalClose) => void): () => void {
  _shiftClosedListeners.add(cb);
  return () => { _shiftClosedListeners.delete(cb); };
}
let _pullingShiftCloses = false;
export async function pullShiftCloses(): Promise<number> {
  if (!_serverUrl || !(_staffToken || _accessToken) || !isOnline() || _pullingShiftCloses) return 0;
  _pullingShiftCloses = true;
  try {
    const db = getLocalDb();
    const open = db.prepare(
      `SELECT id FROM shifts WHERE status = 'open' AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).all(getDeviceConfig()?.device_id ?? null) as Array<{ id: string }>;
    if (!open.length) return 0;
    const url = `${_serverUrl}/api/shifts/state?ids=${encodeURIComponent(open.map((r) => r.id).join(','))}`;
    let res = await syncFetch(url, { headers: pushAuthHeaders() });
    if (res.status === 401 && await refreshStaffToken()) res = await syncFetch(url, { headers: pushAuthHeaders() });
    if (res.status === 404) return 0;   // an older cloud without the route — nothing to learn
    if (!res.ok) { noteInboundFailure('shift-state', `shift state check failed: HTTP ${res.status}`); return 0; }
    const closes = closesToAdopt(open.map((r) => r.id), await res.json() as CloudShiftState[]);
    clearInboundFailure('shift-state');
    const apply = db.prepare(`
      UPDATE shifts SET status = @status, closed_at = @closed_at, close_method = @close_method, closed_by = @closed_by,
        closing_float = @closing_float, cash_variance = @cash_variance,
        expected_cash = COALESCE(@expected_cash, expected_cash),
        notes = TRIM(COALESCE(notes, '') || char(10) || @note), sync_status = 'synced'
      WHERE id = @id AND status = 'open' AND COALESCE(device_id,'') = COALESCE(@dev,'')`);
    let n = 0;
    const dev = getDeviceConfig()?.device_id ?? null;
    for (const c of closes) {
      if (apply.run({ ...c, dev }).changes !== 1) continue;
      n++;
      logLine('sync', `shift ${c.id} closed on the cloud — closed here too (${c.status})`);
      // Branch LAN: the replicas learn the close as they do any other.
      emitEvent('shift_closed', c.id, {
        status: c.status, closed_at: c.closed_at, closing_float: c.closing_float, cash_variance: c.cash_variance,
        expected_cash: c.expected_cash, close_method: c.close_method, closed_by: c.closed_by,
      });
      for (const cb of _shiftClosedListeners) { try { cb(c); } catch { /* a screen listener never stops the close */ } }
    }
    return n;
  } catch (err: any) {
    noteInboundFailure('shift-state', `shift state check error: ${err?.message ?? err}`);
    return 0;
  } finally {
    _pullingShiftCloses = false;
  }
}

// A433 — a shift THIS till holds, confirmed by a manager somewhere else (the web, or another till: owner, 2026-10-10 —
// "yes, if they have logged in as the manager"), is confirmed here too: the confirmation is the cloud's, so the till takes
// it as it stands (no push back). Without this the till's Close Day kept waiting for a confirmation that had been made.
let _pullingConfirms = false;
export async function pullShiftConfirmations(): Promise<number> {
  if (!_serverUrl || !(_staffToken || _accessToken) || !isOnline() || _pullingConfirms) return 0;
  _pullingConfirms = true;
  try {
    const db = getLocalDb();
    const dev = getDeviceConfig()?.device_id ?? null;
    const waiting = db.prepare(`
      SELECT id FROM shifts
       WHERE status = 'closed' AND declared_methods IS NOT NULL AND confirmed_at IS NULL
         AND COALESCE(confirm_sync, '') <> 'pending' AND sync_status = 'synced'
         AND COALESCE(device_id,'') = COALESCE(?,'')
       ORDER BY closed_at DESC LIMIT 20`).all(dev) as Array<{ id: string }>;
    if (!waiting.length) return 0;
    const url = `${_serverUrl}/api/shifts/state?ids=${encodeURIComponent(waiting.map((r) => r.id).join(','))}`;
    let res = await syncFetch(url, { headers: pushAuthHeaders() });
    if (res.status === 401 && await refreshStaffToken()) res = await syncFetch(url, { headers: pushAuthHeaders() });
    if (!res.ok) return 0;   // an older cloud, or a hiccup — asked again on the next beat
    const rows = await res.json() as Array<{ id: string; confirmed_at?: string | null; confirmed_by?: string | null;
      confirmed_methods?: unknown; expected_methods?: unknown; confirm_reasons?: unknown; confirm_self?: boolean | null;
      confirmed_by_name?: string | null }>;
    const json = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    const apply = db.prepare(`
      UPDATE shifts SET confirmed_at = @at, confirmed_by = @by, confirmed_methods = @confirmed, expected_methods = @expected,
        confirm_reasons = @reasons, confirm_self = @self, confirm_sync = 'synced'
       WHERE id = @id AND confirmed_at IS NULL AND COALESCE(device_id,'') = COALESCE(@dev,'')`);
    let n = 0;
    for (const r of rows) {
      if (!r.confirmed_at || !waiting.some((w) => w.id === r.id)) continue;
      const changed = apply.run({
        id: r.id, dev, at: r.confirmed_at, by: r.confirmed_by ?? null, confirmed: json(r.confirmed_methods),
        expected: json(r.expected_methods), reasons: json(r.confirm_reasons), self: r.confirm_self ? 1 : 0,
      }).changes;
      if (changed === 1) { n++; logLine('sync', `shift ${r.id} confirmed elsewhere by ${r.confirmed_by_name ?? 'a manager'} — confirmed here too`); }
    }
    return n;
  } catch (err: any) {
    logLine('sync', `shift confirmation check failed: ${err?.message ?? err}`);
    return 0;
  } finally {
    _pullingConfirms = false;
  }
}

// A404 — the cloud's test-data clears (admin portal), applied here in order; each one once (the last applied is kept
// in maintenance_state). The day gate is re-read by the screens on their next check.
const TEST_CLEAR_KEY = 'test_data_clear_seen';
export async function runTestDataClears(): Promise<number> {
  if (!_serverUrl || !_accessToken || !isOnline()) return 0;
  const db = getLocalDb();
  const seen = (db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(TEST_CLEAR_KEY) as { value?: string } | undefined)?.value ?? '';
  const res = await syncFetch(`${_serverUrl}/api/pos/test-data-clears${seen ? `?after=${encodeURIComponent(seen)}` : ''}`, { headers: authHeaders() });
  if (!res.ok) return 0;
  const clears = await res.json() as Array<ClearPeriod & { created_at: string }>;
  let n = 0, menuCleared = false;
  for (const c of clears ?? []) {
    const r = applyTestDataClear(db, c);
    // A482: that clear deleted the whole menu on the cloud — the till's goes too (the pull only upserts, so it never would)
    if (c.menu === true) {
      const m = applyMenuClear(db);
      menuCleared = true;
      logLine('sync', `menu deleted by ZapTill: ${m.products} products, ${m.categories} categories, ${m.variants} variant rows, ${m.modifiers} add-on rows, ${m.combos} combo lines, ${m.offers} offers, ${m.stock} stock levels removed here too`);
    }
    db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(TEST_CLEAR_KEY, c.created_at, new Date().toISOString());
    logLine('sync', `test data cleared by ZapTill (${c.from_at} → ${c.to_at}): ${r.sales} sales, ${r.shifts} shifts, ${r.days} trading days removed here too${r.kept_shifts ? ` (${r.kept_shifts} shift(s) kept — sold on after the period)` : ''}`);
    n++;
  }
  // A482: then the menu as the cloud has it now (empty, or what was added since) — from the cloud, not a branch server
  // that may not have applied the clear yet.
  if (menuCleared) {
    _preferCloudPull = true;
    try { await pullCatalogue(); } catch { /* the next sync pulls */ } finally { _preferCloudPull = false; }
  }
  if (n) notifyCataloguePulled();   // the screens re-read (History, shift, day gate, the menu)
  return n;
}

// A291: cheap catalogue-freshness poll. Ask the server for the newest updated_at
// across the reference tables (GET /api/pos/catalogue-version) and refresh only
// when it has moved since our last successful pull. This is what makes a web edit
// reach the till in ~20s instead of waiting for the 10-min full-pull floor, which
// stays as the safety net (and covers the tables without an updated_at trigger).
// Fail-soft throughout: any error just skips this tick — the floor still runs.
let _lastCatalogueVersion: string | null = null;
// A321: who to tell when a pull lands. index.ts registers one listener that messages every window;
// kept here (not an Electron import) so the engine stays testable under node.
const _cataloguePulledListeners = new Set<() => void>();
export function onCataloguePulled(cb: () => void): () => void {
  _cataloguePulledListeners.add(cb);
  return () => { _cataloguePulledListeners.delete(cb); };
}
function notifyCataloguePulled(): void {
  for (const cb of _cataloguePulledListeners) {
    try { cb(); } catch (e: any) { logLine('sync', `catalogue-pulled listener threw: ${e?.message ?? e}`); }
  }
}

export async function pullIfCatalogueChanged(o: { pullOnly?: boolean } = {}): Promise<{ changed: boolean; pulled: boolean }> {
  // A513: at start-up the pull alone (pullCatalogueNow) — the pushes and the other pulls are the sequence's later steps.
  const run = o.pullOnly ? pullCatalogueNow : syncAll;
  if (!_accessToken || !_serverUrl) return { changed: false, pulled: false };
  if (!isOnline()) return { changed: false, pulled: false };

  const branch = getDeviceConfig()?.branch_id ?? null;
  const url = `${_serverUrl}/api/pos/catalogue-version${branch ? `?branch_id=${encodeURIComponent(branch)}` : ''}`;

  // A321: this check used to treat ANY non-OK answer as "nothing changed" and never reached syncAll's
  // token refresh — so an expired device token (15-min lifetime) made the 20-s path fail silently and
  // changes only arrived via the 10-min floor. Now: renew ahead of expiry exactly as syncAll does,
  // retry once after a refresh on 401, and record any other failure where the tech screen's sync
  // status already shows inbound failures, instead of dropping it.
  let version: string | null = null;
  try {
    await refreshDeviceTokenIfExpiring();
    let res = await syncFetch(url, { headers: authHeaders() });
    if (res.status === 401 && _refreshToken && await refreshAccessToken()) {
      res = await syncFetch(url, { headers: authHeaders() });
    }
    if (!res.ok) {
      noteInboundFailure('version', `catalogue-version check failed: HTTP ${res.status} — changes will arrive with the 10-minute sync instead`);
      return { changed: false, pulled: false };
    }
    version = ((await res.json()) as any)?.version ?? null;
    clearInboundFailure('version');
  } catch (e: any) {
    noteInboundFailure('version', `catalogue-version check failed: ${e?.message ?? 'unreachable'} — changes will arrive with the 10-minute sync instead`);
    // A448: no cloud — a change made on another till of this branch reached the branch server: pull it from there.
    const nodeVersion = await nodeChangeVersion().catch(() => null);
    if (nodeVersion && nodeVersion !== _lastNodeChangeVersion) {
      const r = await run();
      if (r.pulled) _lastNodeChangeVersion = nodeVersion;
      return { changed: true, pulled: r.pulled };
    }
    return { changed: false, pulled: false };
  }
  if (!version || version === _lastCatalogueVersion) return { changed: false, pulled: false };

  // Something changed (or first observation). syncAll self-guards against a
  // concurrent/offline run; only adopt the new version once a pull actually lands,
  // so a skipped run is retried on the next tick rather than silently swallowed.
  // (The screens are told by syncAll itself — A321.)
  // A446: the cloud just said something changed — take it from the CLOUD (through the branch server's gateway on a till
  // behind one), not from the branch server's copy, which may not have caught up yet: the till then pulled the old copy,
  // adopted the new version, and kept the old menu (a station added on the web: "No station …" on Test print) until the
  // 10-minute sync. If the cloud cannot be reached the version is not adopted, so the next tick tries again.
  _preferCloudPull = true;
  let r: { pulled: boolean };
  try { r = await run(); } finally { _preferCloudPull = false; }
  if (r.pulled) _lastCatalogueVersion = version;
  return { changed: true, pulled: r.pulled };
}

export function getSyncStatus(): {
  online: boolean; pendingCount: number; failedCount: number;
  /** A178: the pending count split by table, so the tech screen shows what's stuck. */
  pendingBreakdown?: { orders: number; shifts: number; floats: number; expenses: number; days: number; reversals?: number;
    kitchenVoids?: number; prices?: number; confirmations?: number; wastage?: number };
  /** Why the failed ones failed. A count alone gives the cashier nothing to act on. */
  failedReason?: string;
  failedSince?: string;
  /**
   * The INBOUND half: why the catalogue pull or a token refresh is failing.
   *
   * failedReason covers rows this till is trying to push. It says nothing when
   * the till cannot pull — an unlicensed branch, a rejected token — and that
   * half used to be entirely silent. A till can have zero failed rows and still
   * be completely cut off.
   */
  pullError?: string;
  pullErrorSince?: string;
  /** Where the durable log is, so a tech can be pointed at it over the phone. */
  logPath?: string;
  /**
   * Rows this till still owes the BRANCH NODE, kept separate from pendingCount.
   *
   * The cashier's badge answers one question — is my sale safe on the server —
   * and the answer is about the cloud. The node is a LAN replica; a node that is
   * off does not put a sale at risk and must not colour that badge red, or the
   * indicator stops meaning anything and gets ignored on the day it matters.
   */
  nodeBacklog?: { pending: number; failed: number };
  /** A363: records the cloud REFUSED and this till parked ('conflict'), and the first reason it gave. */
  parkedCount?: number;
  parkedReason?: string;
  /** Till sync audit (F5): sales waiting for a drawer the cloud refused — they go with it, so they are not "pending". */
  parkedSales?: number;
  /** A363: the last moment this till had nothing waiting for the cloud (ISO), null if never recorded. */
  lastSyncedAt?: string | null;
  /** A448: the branch server refused this till's access code (recently) — nothing reaches the cloud through it. */
  nodeRefused?: { status: number; since: string } | null;
} {
  const db = getLocalDb();
  // Till sync audit (F5): a sale whose drawer the cloud refused (shift parked 'conflict') is not sent until the drawer is
  // resolved — it is parked with it, not "pending" (pushPendingOrders skips it the same way, PARKED_DRAWER_SQL).
  const pending = db.prepare(`SELECT COUNT(*) as count FROM sync_queue q WHERE q.status = 'pending' AND NOT ${PARKED_DRAWER_SQL}`).get() as { count: number };
  let parkedSales = 0;
  try { parkedSales = (db.prepare(`SELECT COUNT(*) as count FROM sync_queue q WHERE q.status = 'pending' AND ${PARKED_DRAWER_SQL}`).get() as { count: number }).count; }
  catch { /* keep the zero */ }
  const failed  = db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = 'failed'`).get() as { count: number };

  // The most common reason, and how long it has been stuck.
  //
  // "9 failed" sat in the header for over a week with no way to find out why —
  // the retry button re-armed them, they failed again for the same reason, and
  // the count never moved. A number nobody can act on is decoration; the reason
  // is the part that gets it fixed.
  const failureRow = failed.count > 0
    ? db.prepare(`
        SELECT last_error, MIN(created_at) AS since, COUNT(*) AS n
          FROM sync_queue WHERE status = 'failed' AND last_error IS NOT NULL
         GROUP BY last_error ORDER BY n DESC LIMIT 1
      `).get() as { last_error: string; since: string; n: number } | undefined
    : undefined;
  // Offline-origin records (shifts/floats/expenses) waiting to push count too, so
  // the till's "N pending" reflects everything not yet on the server.
  // own: the badge a cashier reads. Another terminal's backlog is not theirs to
  // clear, and on a node an unscoped count would read three times the truth and
  // turn the indicator into noise. Named parameter, bound once — four positional
  // placeholders in one statement is how the wrong value ends up in the wrong
  // subquery.
  const ownDevice = getDeviceConfig()?.device_id ?? null;
  // A178: break the count down by table, so the tech screen can show WHAT is
  // pending ("2 shifts, 2 days, 1 float, 1 expense") instead of a bare "6".
  const bd = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM shifts             WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS shifts,
      (SELECT COUNT(*) FROM float_transactions WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS floats,
      (SELECT COUNT(*) FROM expenses           WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS expenses,
      (SELECT COUNT(*) FROM business_days      WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS days
  `).get({ dev: ownDevice }) as { shifts: number; floats: number; expenses: number; days: number };
  // 0.6.30: an offline void/refund still to reach the cloud is waiting too (a status read never throws — schema 61).
  let reversals = 0;
  try {
    reversals = (db.prepare(`SELECT COUNT(*) AS n FROM pending_reversals WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')`)
      .get(ownDevice) as { n: number }).n;
  } catch { /* keep the zero */ }
  // Till sync audit (F17): everything else this till still owes the cloud. The 30-s push timer (index.ts) only runs
  // while this count is above 0, and "Last synced" is stamped only at 0 — leaving these out let them wait unsent and
  // the manager read "Last synced: now" over them.
  const extra = { kitchenVoids: 0, prices: 0, confirmations: 0, wastage: 0 };
  const tryCount = (sql: string, ...args: unknown[]) => { try { return (db.prepare(sql).get(...args) as { n: number }).n; } catch { return 0; } };
  extra.kitchenVoids  = tryCount(`SELECT COUNT(*) AS n FROM kitchen_voids WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, ownDevice);
  extra.prices        = tryCount(`SELECT COUNT(*) AS n FROM local_price_edits WHERE synced = 0`);
  extra.confirmations = tryCount(`SELECT COUNT(*) AS n FROM shifts WHERE confirm_sync='pending' AND confirmed_at IS NOT NULL AND COALESCE(device_id,'') = COALESCE(?,'')`, ownDevice);
  try { extra.wastage = readPendingWaste(db).length; } catch { /* keep the zero */ }
  const localPending = { count: bd.shifts + bd.floats + bd.expenses + bd.days + reversals
    + extra.kitchenVoids + extra.prices + extra.confirmations + extra.wastage };
  // A363: a status read never throws — the badge must render even on a database missing a newer table.
  let parked: { count: number; reason: string | null } = { count: 0, reason: null };
  try { parked = parkedSummary(ownDevice); } catch { /* keep the zero */ }
  return {
    parkedSales,
    online: isOnline(),
    pendingCount: pending.count + localPending.count,
    failedCount: failed.count,
    pendingBreakdown: { orders: pending.count, shifts: bd.shifts, floats: bd.floats, expenses: bd.expenses, days: bd.days, reversals, ...extra },
    failedReason: failureRow?.last_error ?? undefined,
    failedSince: failureRow?.since ?? undefined,
    pullError: currentInboundFailure()?.message ?? undefined,
    pullErrorSince: currentInboundFailure()?.since ?? undefined,
    logPath: getLogPath(),
    nodeBacklog: hasNode() ? nodeQueueDepth() : undefined,
    parkedCount: parked.count,
    parkedReason: parked.reason ?? undefined,
    lastSyncedAt: lastSyncedAt(),
    nodeRefused: hasNode() ? nodeRefusal() : null,
  };
}

// ── A363: parked records and "last synced" ─────────────────────────────────────
// Parked = refused by the cloud and set aside ('conflict'); only a shift or a trading day carries the reason (notes).
function parkedSummary(ownDevice: string | null): { count: number; reason: string | null } {
  const db = getLocalDb();
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM shifts             WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM business_days      WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM float_transactions WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM expenses           WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM kitchen_voids      WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS n
  `).get({ dev: ownDevice }) as { n: number };
  // 0.6.30: an offline void/refund the cloud refused is parked too, with the cloud's words.
  let refused: { n: number; why: string | null } = { n: 0, why: null };
  try {
    refused = db.prepare(`SELECT COUNT(*) AS n, MAX(last_error) AS why FROM pending_reversals WHERE sync_status='refused' AND COALESCE(device_id,'') = COALESCE(?,'')`)
      .get(ownDevice) as { n: number; why: string | null };
  } catch { /* a database before schema 61 */ }
  if (!row.n) return refused.n ? { count: refused.n, reason: refused.why ? `Offline void/refund refused: ${refused.why}` : null } : { count: 0, reason: null };
  const note = db.prepare(`
    SELECT notes FROM (
      SELECT notes, created_at FROM shifts        WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')
      UNION ALL
      SELECT notes, created_at FROM business_days WHERE sync_status='conflict' AND COALESCE(device_id,'') = COALESCE(:dev,'')
    ) WHERE notes LIKE '%Sync rejected:%' ORDER BY created_at DESC LIMIT 1
  `).get({ dev: ownDevice }) as { notes: string } | undefined;
  const m = note?.notes.match(/Sync rejected:\s*([^\n]+)/);
  return { count: row.n + refused.n, reason: m ? m[1].trim() : (refused.why ? `Offline void/refund refused: ${refused.why}` : null) };
}

const LAST_SYNCED_KEY = 'last_synced_at';
function lastSyncedAt(): string | null {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(LAST_SYNCED_KEY) as { value: string | null } | undefined;
    return row?.value ?? null;
  } catch { return null; }   // a status read never throws (see getSyncStatus)
}
/** After a push pass: if nothing waits for the cloud (queued, failed or parked) and the cloud was reachable, stamp now. */
export function noteSyncedIfClear(now: Date = new Date()): boolean {
  if (!isOnline()) return false;
  const s = getSyncStatus();
  if (s.pendingCount > 0 || s.failedCount > 0 || (s.parkedCount ?? 0) > 0) return false;
  getLocalDb().prepare(`
    INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(LAST_SYNCED_KEY, now.toISOString(), now.toISOString());
  return true;
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

// ── Last inbound failure ─────────────────────────────────────────────────────
//
// Push failures already carry their reason: sync_queue.last_error is written
// per row and getSyncStatus() surfaces the commonest one as failedReason. The
// INBOUND half — catalogue pull and token refresh — had no equivalent. It
// returned false and said nothing, which is how a dead catalogue pull went
// undiagnosed while "9 failed" sat readable in the same header.
//
// Deliberately in memory, not SQLite. This is current state, not history: the
// sync loop re-runs within seconds of a restart and repopulates it, so
// persisting it would buy nothing and cost a LOCAL_SCHEMA_VERSION bump — which
// on a fleet with no auto-update means visiting every till. The durable record
// lives in swiftpos.log instead.
//
// ONE SLOT PER SCOPE, not one slot overall. The first cut of this used a single
// field and a test caught it immediately: syncAll() drives a catalogue pull AND
// a token refresh, both fail together, and whichever finished last overwrote the
// other. The status field reported "till token refresh failed" while the actual
// cause was BRANCH_NOT_LICENSED on the pull — a confident wrong message, which
// is the thing this whole change exists to stop.
const _inbound = new Map<string, { message: string; since: string }>();

// Order matters when both are set. A dead token explains a dead catalogue pull;
// a dead catalogue pull does not explain a dead token. Report the cause, not the
// symptom.
const SCOPE_PRIORITY = ['auth', 'sync', 'version'];   // A321: the 20-s freshness check reports last — a dead token or pull explains it

function noteInboundFailure(scope: string, message: string): void {
  const prev = _inbound.get(scope);
  // First failure wins the timestamp: "since" should say how long this has been
  // broken, not when it last retried.
  if (!prev || prev.message !== message) {
    _inbound.set(scope, { message, since: new Date().toISOString() });
  }
  logLine(scope, message);
}

function clearInboundFailure(scope: string): void {
  const prev = _inbound.get(scope);
  if (prev) {
    logLine(scope, `recovered after: ${prev.message}`);
    _inbound.delete(scope);
  }
}

function currentInboundFailure(): { message: string; since: string } | null {
  for (const scope of SCOPE_PRIORITY) {
    const hit = _inbound.get(scope);
    if (hit) return hit;
  }
  return null;
}

/**
 * Seconds until this JWT expires, or null if it cannot be read.
 *
 * Payload only — no signature check. That is deliberate and safe here: this is
 * used to decide WHEN TO REFRESH EARLY, never to decide whether a token is
 * trusted. The server verifies every token on every request; a tampered `exp`
 * would at worst make the till refresh sooner than needed. Same base64url
 * decode as techService.ts:120.
 */
function secondsUntilExpiry(jwt: string): number | null {
  try {
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return null;
    const { exp } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (typeof exp !== 'number') return null;
    return exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;   // unreadable → fall through to the reactive 401 path
  }
}

/**
 * Refresh the DEVICE token before it expires, rather than after.
 *
 * ── THE SAWTOOTH THIS ENDS (register A51) ────────────────────────────────────
 * Beryl's till log was 90 lines and every one of them was the same pair, exactly
 * twenty minutes apart, all day:
 *
 *     [sync] catalogue pull failed: HTTP 401 Unauthorized
 *     [sync] recovered after: catalogue pull failed: HTTP 401 Unauthorized
 *
 * Deterministic, not intermittent. syncAll() runs every 10 minutes
 * (index.ts:226); the access token lives 15 minutes (auth.ts:51); refresh was
 * purely reactive. So after a refresh at T the pull at T+10 succeeded and the
 * pull at T+20 COULD NOT — 20 > 15. Every other pull 401'd by construction.
 *
 * Three costs, and the third is why this is worth code rather than a shrug:
 *   1. every other catalogue pull was 3-5 seconds slower than it needed to be;
 *   2. ~72 refresh-token rotations per day per till, each one a chance for two
 *      refreshes to race — and validateRefreshToken answers a REUSED refresh
 *      token by revoking EVERY session for that user;
 *   3. the till log stopped being usable. A revoked till, a rotated service key
 *      or a genuine expiry all looked identical to routine noise. An error that
 *      always fires is an error nobody reads — and this log is the first thing
 *      we ask for when a till misbehaves (RUNBOOK §0.1).
 *
 * ── WHY THIS TOUCHES THE DEVICE TOKEN ONLY ───────────────────────────────────
 * The catalogue pull uses authHeaders() → _accessToken. pushAuthHeaders()
 * prefers _staffToken. Those are different tokens with different lifecycles,
 * and the distinction is load-bearing:
 *
 * A GENERIC proactive refresh across both would have refreshed the staff token
 * too — and the staff token expiring on an IDLE till is exactly the condition
 * A47 was reported under. Refreshing it ahead of time would have made A47's
 * field test pass whether or not manageFetch was fixed, in the same way a
 * 3-minute auto-lock would. So this is scoped, and must stay scoped.
 *
 * ── WHY NOT JUST SHORTEN THE PULL INTERVAL ───────────────────────────────────
 * A pull inside 15 minutes would hide the sawtooth without removing it: the
 * token would still expire mid-gap whenever a pull was skipped for being
 * offline, and the 401 would come back the moment anything perturbed the
 * cadence. Refreshing against the token's OWN expiry is independent of how
 * often anything happens to run.
 *
 * Returns true if a refresh was performed. The reactive 401 path in every
 * caller is untouched and remains the backstop — an unreadable `exp`, a clock
 * skew, or a token rotated elsewhere all still land there.
 */
const REFRESH_SKEW_SECONDS = 120;

async function refreshDeviceTokenIfExpiring(): Promise<boolean> {
  if (!_accessToken || !_serverUrl) return false;

  const remaining = secondsUntilExpiry(_accessToken);
  // null → cannot read the token; leave it to the 401 path rather than
  // refreshing blindly on every tick and burning rotations for no reason.
  if (remaining === null) return false;
  if (remaining > REFRESH_SKEW_SECONDS) return false;

  logLine('auth', `device token expires in ${remaining}s — refreshing ahead of the 401`);
  return refreshAccessToken();
}

// Persist the business-wide config the reference source carries — VAT, CTL,
// discount ceiling, business type, receipt header/footer, kitchen-exclusion
// baseline and the 24h flag. Applied for BOTH the node and cloud paths so a
// node-fed peer updates these too (a stale VAT prints a receipt the database
// disagrees with — the exact bug the inline cloud version existed to prevent).
// Each field is guarded so a missing value leaves the last-known-good untouched;
// numeric fields arrive pre-coerced (numOrNull), so `!== null` is enough here.
function applyReferenceConfig(c: AcquiredReference['config']): void {
  if (c.vatRate !== null) saveDeviceConfig({ vat_rate: c.vatRate });
  if (c.ctlRate !== null) saveDeviceConfig({ ctl_rate: c.ctlRate });
  if (c.maxDiscountPct !== null) saveDeviceConfig({ max_discount_pct: c.maxDiscountPct });
  if (c.businessType) saveDeviceConfig({ business_type: c.businessType });
  if (typeof c.receiptHeader === 'string') saveDeviceConfig({ receipt_header: c.receiptHeader });
  if (typeof c.receiptFooter === 'string') saveDeviceConfig({ receipt_footer: c.receiptFooter });
  if (typeof c.continuousOperation === 'boolean') saveDeviceConfig({ continuous_operation: c.continuousOperation });
  setBusinessDayCutoff(c.businessDayCutoff);   // 0.6.34: undefined (older cloud / node) keeps the till's value
  setSupportContact(c.support);                // 0.6.35: undefined keeps; null = no tech (ZapTill support)
  setCashierHistoryMethods(c.cashierHistoryMethods);   // 0.6.37: undefined (older cloud / node) keeps
  setStockCountFreeze(c.stockCount);                   // A394: undefined (older cloud / node) keeps; null = nothing frozen
  setCashierSeesShiftSales(c.cashierSeesShiftSales);   // A416: undefined (older cloud / node) keeps
  setCashierHistoryTotals(c.cashierHistoryTotals);     // A418: undefined (older cloud / node) keeps
  setPaymentMethodsEnabled(c.paymentMethodsEnabled);   // A429: undefined (older cloud / node) keeps
  if (Array.isArray(c.kitchenExclusions)) saveDeviceConfig({ kitchen_exclusions: JSON.stringify(c.kitchenExclusions) });
  // A304: remote-wins branding. Only when the cloud returned a row (c.branding set);
  // undefined (node path) or null (no cloud row) leaves the local mirror untouched, so a
  // tech-set value (A302) survives until the business actually has cloud branding.
  // 0.6.25: NOT while this till's own upload is still on its way to the cloud — the pull would put the old logo back
  // (the owner's "it removes it after a while"). The upload goes first (syncAll → pushBrandingNow), then pulls resume.
  if (c.branding && !brandingPushPending()) applyPulledBranding(c.branding);
  // A325: the effective action theme — its own field (see applyPulledTheme); undefined = older cloud → keep.
  if (c.themeId !== undefined) applyPulledTheme(c.themeId);
  // A346: the web POS switch (decides the manager screen's Stock). undefined = not said → keep.
  setWebPosEnabled(c.webPosEnabled);
  // A367: the quick picks for order notes. undefined = not said → keep.
  setOrderNotePicks(c.noteQuickPicks);
  // 0.6.27: the per-client POS switches. undefined = not said → keep.
  setPosFeatures(c.posFeatures);
  // 0.6.30: the owner's void window and offline void/refund rules. undefined = not said → keep.
  setReversalRules(c.reversalRules);
  // A450: the business's name and currency follow the cloud (owner: "I changed a business name on the web but the till"
  // kept the old one — it was written only at sign-in). Receipts, reports and the screens read them from `session`.
  applyBusinessIdentity(c.businessName, c.currency);
  setReceiptPay(c.receiptPay);   // A450: undefined = not said → keep
}

/** A450: the business's name / currency as the last pull said; nothing when not said or unchanged. */
export function applyBusinessIdentity(name: string | undefined, currency: string | undefined): void {
  try {
    const db = getLocalDb();
    if (name) db.prepare(`UPDATE session SET business_name = ? WHERE id = 1 AND business_name IS NOT ?`).run(name, name);
    if (currency) db.prepare(`UPDATE session SET currency = ? WHERE id = 1 AND currency IS NOT ?`).run(currency, currency);
  } catch { /* the next pull */ }
}

let _preferCloudPull = false;
let _lastNodeChangeVersion: string | null = null;   // A448: the branch server's own change counter, last seen   // A446: set while a pull answers the cloud's own "something changed"
// Till sync audit (F7): the HTTP status of the last catalogue pull's /api/pos/init (0 = not asked or out of reach), so
// syncAll renews the till's key only on a 401.
let _lastPullStatus = 0;
// Till sync audit (F13): one pull at a time from syncAll — a second pass joins the pull running.
let _pullInFlight: Promise<boolean> | null = null;
function pullCatalogueOnce(): Promise<boolean> {
  if (_pullInFlight) return _pullInFlight;
  _pullInFlight = pullCatalogue().finally(() => { _pullInFlight = null; });
  return _pullInFlight;
}

async function pullCatalogue(): Promise<boolean> {
  const db = getLocalDb();
  const now = new Date().toISOString();
  _lastPullStatus = 0;

  // The branch this till operates on. The device is BOUND to a branch at
  // install / first PIN login; /api/pos/init's branchId is only a fallback.
  // Pulling stock/tables for the wrong branch was the "tables on web but not on
  // the till" bug — staff pick branch X at the PIN pad while sync pulled main.
  const boundBranchId: string | null = getDeviceConfig()?.branch_id ?? null;

  // Reference data, populated from the branch NODE (a peer with a reachable
  // node) or, failing that, the CLOUD exactly as before — then written by the
  // SINGLE transaction below, fed identically by either source. Hoisted here so
  // both paths assign the same variables. `tablesFetched`/`pumpsFetched` and a
  // nullable `stations`/`paymentMethods` are the DON'T-WIPE guards: a source
  // that did not supply them must never clear good local data.
  let products: any[] = [], categories: any[] = [];
  let comboItems: Record<string, any[]> | undefined;
  let paymentMethods: Array<{ code: string; name: string }> | null = null;
  let offers: any[] | null = null;   // A445: null = the source sent none — the till keeps its offers
  let stations: any[] | null = null;
  let variantGroups: any[] = [], variantOptions: any[] = [];
  let modifierGroups: any[] = [], modifierOptions: any[] = [];
  // A425: the products whose choices this pull really received — only theirs are replaced (choicePrune.ts)
  let variantScope: string[] = [], modifierScope: string[] = [];
  let stockLevels: any[] = [], users: any[] = [];
  let diningTables: any[] = [], pumps: any[] = [];
  let tablesFetched = false, pumpsFetched = false;
  let branchId: string | null = null;
  let effectiveBranchId: string | null = null;

  // ── A24 (batch -b): read reference from the NODE first ─────────────────────
  // A peer whose node answers takes the node's snapshot and skips the cloud's
  // 7 + N calls, so an offline peer stays current. fetchReferenceFromNode()
  // returns null for a node device, a till with no node_url, or ANY node problem
  // (unreachable / refused / malformed) — and then we fall through to the cloud
  // path below, unchanged. So this is additive: only a peer with a live node
  // behaves any differently than it did before.
  const nodeBundle = _preferCloudPull ? null : await fetchReferenceFromNode();   // A446
  if (nodeBundle) {
    const r: AcquiredReference = unpackNodeBundle(nodeBundle);
    ({ products, categories, comboItems, paymentMethods, offers, stations,
       variantGroups, variantOptions, modifierGroups, modifierOptions,
       stockLevels, users, diningTables, tablesFetched, pumps, pumpsFetched } = r);
    // the branch server's snapshot is its whole catalogue — every product's choices are in it
    variantScope = products.map((p: any) => String(p.id));
    modifierScope = variantScope;
    branchId = r.config.branchId;
    effectiveBranchId = boundBranchId || branchId || null;
    applyReferenceConfig(r.config);
    clearInboundFailure('sync');
    logLine('sync', `catalogue pulled from node — ${products.length} products`);
  } else {
    // ── CLOUD path — behaviour unchanged from before batch -b ────────────────
    // Per-branch pricing: ?branch_id makes /api/pos/init return branch_price.
    const initUrl = boundBranchId
      ? `${_serverUrl}/api/pos/init?branch_id=${encodeURIComponent(boundBranchId)}`
      : `${_serverUrl}/api/pos/init`;
    // /api/pos/init fails closed on conditions that look identical from the till
    // — an unlicensed branch (403 BRANCH_NOT_LICENSED), no branch flagged
    // is_main, an expired token. The server's `ref` travels in the body and
    // keys the full detail in the server log.
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await syncFetch(initUrl, { headers: authHeaders() });
    } catch (err: any) {
      noteInboundFailure('sync', `catalogue pull unreachable: ${err?.message ?? err}`);
      return false;
    }
    _lastPullStatus = res.status;
    if (!res.ok) {
      noteInboundFailure('sync', `catalogue pull failed: ${await describeResponse(res)}`);
      return false;
    }

    const _j = await res.json();
    clearInboundFailure('sync');
    products = _j.products; categories = _j.categories;
    comboItems = _j.comboItems; paymentMethods = _j.paymentMethods ?? null;
    offers = Array.isArray(_j.offers) ? _j.offers : null;   // A445 (an older cloud sends none: keep what the till has)
    branchId = _j.branchId ?? null;
    effectiveBranchId = boundBranchId || branchId || null;
    // Business-wide config (VAT, CTL, discount ceiling, business type, receipt
    // header/footer, kitchen-exclusion CLOUD BASELINE, 24h flag) — persisted for
    // BOTH paths by applyReferenceConfig; the per-field guards that were inline
    // here now live there (each leaves the last-known-good on a missing value).
    // The kitchen-exclusion baseline is business-wide and never touches
    // kitchen_exclusions_override, so "local is final" still holds under it.
    applyReferenceConfig({
      branchId,
      vatRate: numOrNull(_j.vatRate),
      ctlRate: numOrNull(_j.ctlRate),
      maxDiscountPct: numOrNull(_j.maxDiscountPct),
      businessType: typeof _j.businessType === 'string' && _j.businessType ? _j.businessType : null,
      receiptHeader: typeof _j.receiptHeader === 'string' ? _j.receiptHeader : null,
      receiptFooter: typeof _j.receiptFooter === 'string' ? _j.receiptFooter : null,
      kitchenExclusions: Array.isArray(_j.kitchenExclusions) ? _j.kitchenExclusions : null,
      continuousOperation: typeof _j.continuousOperation === 'boolean' ? _j.continuousOperation : null,
      businessDayCutoff: typeof _j.businessDayCutoff === 'number' ? _j.businessDayCutoff : undefined,   // 0.6.34
      support: 'support' in _j ? (_j.support ?? null) : undefined,   // 0.6.35: an older cloud sends no key → keep
      cashierHistoryMethods: Array.isArray(_j.cashierHistoryMethods) ? _j.cashierHistoryMethods : undefined,   // 0.6.37
      stockCount: 'stockCount' in _j ? (_j.stockCount ?? null) : undefined,   // A394: an older cloud sends no key → keep
      cashierSeesShiftSales: typeof _j.cashierSeesShiftSales === 'boolean' ? _j.cashierSeesShiftSales : undefined,   // A416
      cashierHistoryTotals: typeof _j.cashierHistoryTotals === 'boolean' ? _j.cashierHistoryTotals : undefined,   // A418
      paymentMethodsEnabled: Array.isArray(_j.paymentMethodsEnabled) ? _j.paymentMethodsEnabled : undefined,   // A429
      // A304: null when the business has no branding row → applyReferenceConfig skips it,
      // keeping any local value. A row (even with null fields) is remote-wins.
      branding: (_j.branding && typeof _j.branding === 'object')
        ? {
            accentHex: _j.branding.accentHex ?? null, logoPng: _j.branding.logoPng ?? null,
            // A311: undefined (not null) when the cloud predates migration 105, so the
            // local value is kept rather than cleared — see applyPulledBranding.
            logoReceipt: 'logoReceipt' in _j.branding ? (_j.branding.logoReceipt ?? null) : undefined,
            receiptLogoEnabled: 'receiptLogoEnabled' in _j.branding ? (_j.branding.receiptLogoEnabled === true) : undefined,
          }
        : null,
      // A325: top-level; absent on a cloud before A325 → undefined (keep the local value).
      themeId: 'themeId' in _j ? (typeof _j.themeId === 'string' ? _j.themeId : null) : undefined,
      // A346: does the business have the web POS? Absent on an older cloud → undefined (keep the local value).
      webPosEnabled: typeof _j.webPosEnabled === 'boolean' ? _j.webPosEnabled : undefined,
      noteQuickPicks: Array.isArray(_j.noteQuickPicks) ? _j.noteQuickPicks.map(String) : undefined,   // A367
      posFeatures: _j.posFeatures && typeof _j.posFeatures === 'object' ? _j.posFeatures : undefined,   // 0.6.27
      reversalRules: _j.reversalRules && typeof _j.reversalRules === 'object' ? _j.reversalRules : undefined,   // 0.6.30
      // A450: the business's name and currency (a rename on the web), and the receipt's Buy Goods / Paybill line.
      businessName: identityFromWire(_j).businessName,
      currency: identityFromWire(_j).currency,
      receiptPay: identityFromWire(_j).receiptPay,
    });

    // Fetch variants + modifiers (per product — the N in the cloud's 7 + N).
    // A425: a product with no variants has none to keep; one whose fetch failed is left out (keeps what it has).
    variantScope = products.filter((p: any) => !p.has_variants).map((p: any) => String(p.id));
    modifierScope = products.filter((p: any) => !p.has_modifiers).map((p: any) => String(p.id));
    // Till sync audit (F13): one product's fetch that throws (a timeout, a malformed answer) is that product's alone — it
    // keeps the choices it has (left out of the scope) and the pull, and the push stages after it, go on. A throw here
    // used to abort the whole syncAll, so a single slow product skipped every push of the pass.
    let choiceFailures = 0;
    for (const p of products.filter((p: any) => p.has_variants)) {
      try {
        const vRes = await syncFetch(`${_serverUrl}/api/variants/groups?product_id=${p.id}`, { headers: authHeaders() });
        if (vRes.ok) {
          const groups = await vRes.json();
          if (!Array.isArray(groups)) throw new Error('not a list');
          const gs: any[] = [], os: any[] = [];
          for (const g of groups) { gs.push(g); os.push(...(g.variant_options ?? [])); }
          variantGroups.push(...gs); variantOptions.push(...os);
          variantScope.push(String(p.id));
        }
      } catch { choiceFailures++; }
    }

    for (const p of products.filter((p: any) => p.has_modifiers)) {
      try {
        const mRes = await syncFetch(`${_serverUrl}/api/modifiers/groups?product_id=${p.id}`, { headers: authHeaders() });
        if (mRes.ok) {
          const groups = await mRes.json();
          if (!Array.isArray(groups)) throw new Error('not a list');
          const gs: any[] = [], os: any[] = [];
          for (const g of groups) { gs.push(g); os.push(...(g.modifier_options ?? [])); }
          modifierGroups.push(...gs); modifierOptions.push(...os);
          modifierScope.push(String(p.id));
        }
      } catch { choiceFailures++; }
    }
    if (choiceFailures) logLine('sync', `catalogue pull: ${choiceFailures} product(s)' choices could not be fetched - they keep what they have`);

    // Pull stock levels for this branch
    if (effectiveBranchId) {
      const sRes = await syncFetch(`${_serverUrl}/api/inventory?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
      if (sRes.ok) {
        const data = await sRes.json();
        stockLevels = data.filter((s: any) => s.id !== null); // exclude unstocked placeholder rows
      }
    }

    // Pull staff/users — reference data for offline cashier attribution (names on
    // shift/EOD reports). PULL-DOWN, remote wins. Wrapped so a 403/offline here
    // never aborts the catalogue sync that already succeeded above.
    try {
      const uRes = await syncFetch(`${_serverUrl}/api/staff`, { headers: authHeaders() });
      if (uRes.ok) users = await uRes.json();
    } catch { /* non-fatal — attribution falls back to id only */ }

    // Pull dining tables — reference data for the restaurant table map.
    // PULL-DOWN, remote wins. Non-restaurant businesses simply get an empty
    // list and the till keeps its product-grid behaviour. `fetched` is tracked
    // separately from emptiness so a failed request never wipes a good local
    // table map (an empty successful response legitimately clears it).
    if (effectiveBranchId) {
      try {
        const tRes = await syncFetch(`${_serverUrl}/api/tables?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
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
    if (effectiveBranchId) {
      try {
        const puRes = await syncFetch(`${_serverUrl}/api/pumps?branch_id=${effectiveBranchId}`, { headers: authHeaders() });
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

    // Print stations. Best-effort and non-fatal: a till that cannot fetch them keeps
    // whatever routing it already holds and carries on selling. Losing the catalogue
    // refresh must never take the till down — and until migration 44 is applied this
    // endpoint simply 404s, which is expected rather than an error.
    try {
      const stRes = await syncFetch(`${_serverUrl}/api/stations`, { headers: authHeaders() });
      if (stRes.ok) {
        stations = await stRes.json();
        console.log(`[sync] print stations: pulled ${stations?.length ?? 0}`);
      } else if (stRes.status !== 404) {
        console.warn(`[sync] stations fetch failed: HTTP ${stRes.status}`);
      }
    } catch (err: any) {
      console.warn('[sync] stations fetch error:', err?.message ?? err);
    }
  }

  // A482: a menu the cloud deleted (Clear test data → "Also delete the whole menu") never comes back — a branch server
  // that has not applied that clear yet still serves it, and the upserts below would restore it.
  {
    const f = dropPurgedMenu(db, { products, categories, comboItems, offers, variantGroups, variantOptions, modifierGroups, modifierOptions, stockLevels });
    if (f.dropped) {
      ({ products, categories, comboItems, offers, variantGroups, variantOptions, modifierGroups, modifierOptions, stockLevels } = f);
      logLine('sync', `menu deleted by ZapTill: ${f.dropped} row(s) of the old menu in this pull ignored`);
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

    // Custom payment methods (A96). Replaced wholesale like stations: a method
    // deactivated or deleted upstream must stop appearing at the till. Guarded on
    // a defined list so a partial response can't wipe the tenders. The built-in
    // Cash / M-Pesa / Card are not stored here — they live in the POS.
    if (Array.isArray(paymentMethods)) {
      db.prepare(`DELETE FROM payment_methods`).run();
      const insPm = db.prepare(`INSERT OR REPLACE INTO payment_methods (code, name, sort_order) VALUES (?, ?, ?)`);
      paymentMethods.forEach((m: { code: string; name: string }, i: number) => insPm.run(m.code, m.name, i));
    }

    // Stations and their routing. Replaced wholesale, not upserted: a station
    // deleted upstream, or a category unrouted from one, must disappear here too.
    // An upsert would leave stale routing behind and keep sending tickets to a
    // station that no longer exists — the failure being silent, as ever.
    //
    // Guarded on a successful fetch: `null` means we could not ask, and wiping
    // routing because the network blinked would stop the kitchen printing.
    if (stations !== null) {
      db.prepare(`DELETE FROM category_stations`).run();
      db.prepare(`DELETE FROM print_stations`).run();
      const upsertStation = db.prepare(`
        INSERT INTO print_stations (id, name, kind, sort_order, active, synced_at)
        VALUES (@id, @name, @kind, @sort_order, @active, @synced_at)
      `);
      const linkStation = db.prepare(`
        INSERT OR IGNORE INTO category_stations (category_id, station_id) VALUES (?, ?)
      `);
      for (const st of stations) {
        upsertStation.run({
          id: st.id,
          name: st.name,
          kind: st.kind ?? 'kitchen',
          sort_order: Number(st.sort_order) || 0,
          active: st.active === false ? 0 : 1,
          synced_at: now,
        });
        for (const catId of (st.category_ids ?? [])) linkStation.run(catId, st.id);
      }
      // A411: routing saved on this till and not yet on the cloud stays as the till has it.
      overlayPendingRouting(db);
    }

    // Combo components. Replaced wholesale rather than upserted — a component
    // REMOVED from a combo upstream must disappear here too, and an upsert would
    // leave it behind to be packed and cooked forever.
    // A445: the branch's offers, replaced wholesale — only when the source sent them. Each kept as the cleaned offer.
    if (offers !== null) {
      db.prepare(`DELETE FROM offers`).run();
      const putOffer = db.prepare(`INSERT OR REPLACE INTO offers (id, data) VALUES (?, ?)`);
      for (const raw of offers) {
        const c = cleanOffer(raw);
        if (c.ok && (c as { offer: Offer }).offer.id) putOffer.run((c as { offer: Offer }).offer.id, JSON.stringify((c as { offer: Offer }).offer));
      }
    }
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
      INSERT INTO products (id, category_id, name, description, base_price, branch_price, image_url, has_variants, has_modifiers, track_stock, status, barcode, plu, is_fuel, is_kitchen, show_days, synced_at)
      VALUES (@id, @category_id, @name, @description, @base_price, @branch_price, @image_url, @has_variants, @has_modifiers, @track_stock, @status, @barcode, @plu, @is_fuel, @is_kitchen, @show_days, @synced_at)
      ON CONFLICT(id) DO UPDATE SET
        category_id=excluded.category_id, name=excluded.name, description=excluded.description,
        base_price=excluded.base_price, branch_price=excluded.branch_price, image_url=excluded.image_url,
        has_variants=excluded.has_variants, has_modifiers=excluded.has_modifiers,
        track_stock=excluded.track_stock, status=excluded.status,
        barcode=excluded.barcode, plu=excluded.plu, is_fuel=excluded.is_fuel,
        is_kitchen=excluded.is_kitchen, show_days=excluded.show_days,
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
        // 0.6.31: the days it is on the grid (JSON array); null = every day. An older cloud sends none → every day.
        show_days:     (() => { const d = cleanShowDays((p as any).show_days); return d ? JSON.stringify(d) : null; })(),
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

    // A425: replaced, not only upserted — a group or option the cloud removed (every menu upload replaces a group's
    // options) must leave the till, or each upload adds another "Size" that has to be picked before the item can be rung.
    const vp = pruneChoices(db, VARIANT_TABLES, variantScope, variantGroups, variantOptions);
    const mp = pruneChoices(db, MODIFIER_TABLES, modifierScope, modifierGroups, modifierOptions);
    if (vp.groups + vp.options + mp.groups + mp.options > 0) {
      logLine('sync', `menu choices removed upstream dropped — variants ${vp.groups} groups / ${vp.options} options, add-ons ${mp.groups} / ${mp.options}`);
    }

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

    // Delta merge (A80). The upsert above set every level to the SERVER baseline,
    // which reflects only the orders the server has ingested — i.e. our SYNCED
    // orders. Orders still 'pending' here deducted stock locally in
    // createLocalOrder but that deduction is NOT yet in the server baseline, so
    // the plain overwrite just erased it — the till would show stale-high stock
    // from reconnect until the next pull, and worse while a push keeps failing.
    // Re-apply the pending deductions now, which is the "delta merge" the header
    // and this block always claimed but never actually did. 'pending' covers
    // failed-to-push orders too: the push failure branch never flips
    // orders.sync_status, so it stays 'pending' until a push finally succeeds.
    //
    // Scoped to THIS till's own device_id: on a till acting as the branch node,
    // `orders` also holds peer terminals' rows (nodeIngest replicates them), but
    // nodeIngest never touches stock_levels — only this till's own
    // createLocalOrder deducted local stock, so only its own pending orders may
    // be re-applied. Summing peers' rows would over-subtract phantom stock.
    const deviceId = getDeviceConfig()?.device_id ?? null;
    const pendingDeltas = db.prepare(`
      SELECT oi.product_id AS product_id, o.branch_id AS branch_id,
             SUM(oi.quantity) AS deducted
      FROM order_items oi
      JOIN orders   o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.sync_status = 'pending' AND p.track_stock = 1
        AND COALESCE(o.device_id,'') = COALESCE(@device_id,'')
      GROUP BY oi.product_id, o.branch_id
    `).all({ device_id: deviceId }) as Array<{ product_id: string; branch_id: string | null; deducted: number }>;

    // quantity may go negative — that is the A74 "sold beyond stock" state and
    // must survive the merge, so no floor here.
    const applyDelta = db.prepare(`
      UPDATE stock_levels SET quantity = quantity - @deducted
      WHERE product_id = @product_id AND branch_id = @branch_id
    `);
    for (const d of pendingDeltas) {
      applyDelta.run({
        product_id: d.product_id,
        branch_id:  d.branch_id ?? effectiveBranchId,
        deducted:   Number(d.deducted) || 0,
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
    // A448: this till's own changes that still wait (not yet answered, or with the owner) go back over what the pull wrote
    // — a pull never undoes a change made here.
    overlayLocalChanges(db);
  })();

  // PHASE5 §4b (A17): a NODE also pulls the branch staff roster so it can
  // authenticate cashiers offline. Node-only, best-effort, and AFTER the
  // catalogue is safely stored — a failure here must never fail the catalogue
  // pull. The endpoint 403s a non-node device, which is the correct outcome for
  // a plain till and is simply ignored.
  if (isNodeRole(getDeviceConfig()?.device_role)) {
    try {
      const rosterRes = await syncFetch(`${_serverUrl || getCloudUrl()}/api/pos/branch-staff`, { headers: authHeaders() });
      if (rosterRes.ok) {
        const { branch_id: rBranch, staff } = await rosterRes.json();
        if (rBranch && Array.isArray(staff)) storeBranchStaff(rBranch, staff);
      }
    } catch { /* the node keeps its existing roster; next pull retries */ }
  }
  // A496: a PEER no longer pulls the server's roster here (A20). staffRoster.ts does it every 20 s on every till — the
  // cloud's list first, the server's copy only when the cloud cannot be reached — and this second pull, after every
  // catalogue pull, could lay the server's older copy over the fresher list the cloud had just given.

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
  // Bound into every collection query below. A till pushes its own records;
  // on a node, pushing a peer's would double-push it — the peer pushes it too,
  // and the server sees one shift arriving from two devices.
  const ownDevice = getDeviceConfig()?.device_id ?? null;

  const shifts = db.prepare(`
    SELECT id, business_id, branch_id, cashier_id, opened_at, closed_at, status,
           opening_float, closing_float, expected_cash, cash_variance, notes, created_at,
           -- Attribution added by migration 41. These were missing from this SELECT,
           -- so every column that exists to tell three drawers apart stayed on the
           -- till: the cloud saw device_id and terminal_code as NULL for every
           -- shift a terminal originated, and the dashboard's Open Drawers screen
           -- showed "Till: unknown" for all of them.
           business_day_id, business_date, device_id, terminal_code, drawer_label, opened_by
    -- own: a till pushes ITS OWN records. On a node, pushing a peer's would
    -- double-push — the peer pushes it too and the server sees one shift
    -- arriving from two devices.
    FROM shifts WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')
    -- 'conflict' rows are excluded: the server refused them for a reason no
    -- retry clears, and re-sending every pass would loop forever while burying
    -- the real error in the sync log.
  `).all(ownDevice) as any[];
  const floats = db.prepare(`
    SELECT id, shift_id, branch_id, cashier_id, type, amount, reason, created_at,
           approved_by, approved_by_name,  -- 0.6.37 (A388; a cloud before 118 ignores them)
           order_id                        -- the sale a pay-out was made for (cloud migration 111)
    FROM float_transactions WHERE sync_status='pending'
      AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(ownDevice) as any[];
  const expenses = db.prepare(`
    SELECT id, business_id, branch_id, expense_category_id, description, amount,
           paid_by, expense_date, shift_id, created_at,
           COALESCE(payment_method, 'cash') AS payment_method,   -- 0.6.27 (a cloud before 111 ignores it)
           approved_by, approved_by_name                        -- 0.6.37 (A388; a cloud before 118 ignores them)
    FROM expenses WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(ownDevice) as any[];
  // Trading days. Pushed like shifts: the till originates them and the cloud is
  // the reporting surface, so a day closed on the terminal has to arrive or the
  // dashboard never sees a reconciled day at all.
  const business_days = db.prepare(`
    SELECT id, business_id, branch_id, device_id, terminal_code, business_date,
           opened_at, opened_by, closed_at, closed_by, status,
           counted_cash, expected_cash, cash_variance, notes
    FROM business_days WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(ownDevice) as any[];

  // 0.6.28: kitchen voids — sent items taken back (kitchenService.recordKitchenVoid). Cloud table: migration 112.
  const kitchen_voids = db.prepare(`
    SELECT id, business_id, branch_id, shift_id, order_number, order_id, product_id, product_name, quantity, unit_price,
           amount, reason, note, cooked, cashier_id, cashier_name, approved_by, approved_by_name, device_id, created_at
    FROM kitchen_voids WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(ownDevice) as any[];

  if (!shifts.length && !floats.length && !expenses.length && !business_days.length && !kitchen_voids.length) return 0;

  // Till sync audit (F18): a till long offline must never send one body over the cloud's 1 MB JSON limit (a 413 that
  // no retry clears). Sent in batches, days before shifts before the rest (cashBatches) — the cloud looks a float's
  // drawer and a shift's day up in its own tables, so a parent is always in an earlier (or the same) request.
  let total = 0;
  for (const batch of cashBatches({ business_days, shifts, floats, expenses, kitchen_voids })) {
    const n = await pushCashBatch(db, batch, errors);
    if (n < 0) break;   // the cloud did not take this batch — the rest waits for the next pass
    total += n;
  }
  return total;
}

/** Till sync audit (F18): rows per table per request. A shift row is ~1 KB, so 5 × 200 stays well under 1 MB. */
export const CASH_PUSH_CAP = 200;
export interface CashTables<T = any> { business_days: T[]; shifts: T[]; floats: T[]; expenses: T[]; kitchen_voids: T[] }
/** Split the pending cash rows into requests of at most `cap` rows per table: every day before any shift, every shift
 *  before any float / expense / kitchen void. Pure. */
export function cashBatches<T>(t: CashTables<T>, cap = CASH_PUSH_CAP): CashTables<T>[] {
  const out: CashTables<T>[] = [];
  let di = 0, si = 0, fi = 0, ei = 0, ki = 0;
  const left = () => di < t.business_days.length || si < t.shifts.length || fi < t.floats.length
    || ei < t.expenses.length || ki < t.kitchen_voids.length;
  while (left()) {
    const b: CashTables<T> = { business_days: [], shifts: [], floats: [], expenses: [], kitchen_voids: [] };
    b.business_days = t.business_days.slice(di, di + cap); di += b.business_days.length;
    if (di >= t.business_days.length) {
      b.shifts = t.shifts.slice(si, si + cap); si += b.shifts.length;
      if (si >= t.shifts.length) {
        b.floats = t.floats.slice(fi, fi + cap); fi += b.floats.length;
        b.expenses = t.expenses.slice(ei, ei + cap); ei += b.expenses.length;
        b.kitchen_voids = t.kitchen_voids.slice(ki, ki + cap); ki += b.kitchen_voids.length;
      }
    }
    out.push(b);
  }
  return out;
}

/** Codes the cloud refuses a cash row with for its DATA (no retry fixes them): its own named codes, and Postgres classes
 *  22 (data exception), 23 (integrity) and 42 (a column / table this payload names that the cloud does not have). */
export function isDataErrorCode(code: string | null | undefined): boolean {
  const c = String(code ?? '');
  if (['missing_shift', 'missing_business_day', 'duplicate_open_day', 'duplicate_open_shift', 'forbidden',
       'invalid_reason', 'invalid_quantity', 'invalid', 'validation'].includes(c)) return true;
  return /^(22|23|42)[0-9A-Z]{3}$/.test(c);
}

/** One request of pushLocalRecords. The number of rows sent, or -1 when the cloud did not take the request. */
async function pushCashBatch(db: ReturnType<typeof getLocalDb>, batch: CashTables, errors: string[]): Promise<number> {
  const { shifts, floats, expenses, business_days, kitchen_voids } = batch;
  const doPost = () => syncFetch(`${_serverUrl}/api/sync/push`, {
    method: 'POST',
    headers: pushAuthHeaders(),
    body: JSON.stringify({ shifts, floats, expenses, business_days, kitchen_voids }),
  });

  try {
    let res = await doPost();
    if (res.status === 401) {
      const refreshed = await refreshStaffToken();
      if (refreshed) res = await doPost();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const msg = describeServerError(err, res.status);
      errors.push(`Shift sync: ${msg}`);
      logLine('sync', `shift push rejected (HTTP ${res.status}): ${msg}`); // A178: was DB/errors-only — invisible in the log
      return -1;   // leave rows pending — they retry next pass (a 5xx / 503 is the cloud's passing state: never a conflict)
    }
    const body = await res.json().catch(() => null as any);
    // Till sync audit (F14): only the cloud's real answer marks anything synced. An empty or foreign body (a proxy's
    // page, a truncated answer) parsed as {} — no `rejected`, so every row was marked synced and never sent again.
    if (!body || body.ok !== true || !body.upserted || typeof body.upserted !== 'object') {
      errors.push('Shift sync: the cloud\'s answer could not be read — the records stay waiting');
      logLine('sync', `shift push: HTTP ${res.status} without the expected answer - nothing marked synced`);
      return -1;
    }

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

    // A rejection names the table it belongs to. This push carries four of them
    // and the server rejects rows in two of them today, so "rejected" has never
    // meant "a shift" — it only looked that way because shifts were the first
    // case written. Applying every rejection to `shifts` was silent: the UPDATE
    // matched zero rows for a business_day id, changed nothing, reported nothing,
    // and the row was then marked synced by the loop below. A refused trading day
    // was recorded as delivered and never retried again.
    const rejected: { id: string; code: string; table?: string; error: string }[] =
      Array.isArray(body?.rejected) ? body.rejected : [];

    // Fallback for a server that predates the `table` field. Codes are stable and
    // the set is small, so this is exact rather than a guess — but an unknown code
    // from a NEWER server is deliberately NOT defaulted to shifts. Defaulting is
    // what produced the bug above. Unknown goes to `null`, which parks the row
    // (see below) instead of writing a conflict to the wrong table.
    const TABLE_BY_CODE: Record<string, RejectableTable> = {
      duplicate_open_day:   'business_days',
      missing_business_day: 'shifts',
      duplicate_open_shift: 'shifts',
    };
    const tableOf = (r: { code: string; table?: string }): RejectableTable | null => {
      const t = r.table ?? TABLE_BY_CODE[r.code];
      return t === 'shifts' || t === 'business_days' ||
             t === 'float_transactions' || t === 'expenses' || t === 'kitchen_voids' ? t : null;
    };

    // Rejected ids per table. Keyed by table because two rows in different
    // tables can carry the same id in principle, and because every mark-synced
    // loop below has to consult its OWN table's set — not one shared set.
    const rejectedByTable: Record<RejectableTable, Set<string>> = {
      shifts: new Set(), business_days: new Set(),
      float_transactions: new Set(), expenses: new Set(), kitchen_voids: new Set(),
    };
    const unrouted: typeof rejected = [];

    if (rejected.length) {
      // Only `shifts` and `business_days` have a `notes` column locally. Writing
      // the reason into float_transactions or expenses throws "no such column",
      // which would abort this transaction and kill the whole cash push on the
      // first rejection of any kind. So the reason is recorded where there is
      // somewhere to record it, and the status is set everywhere.
      const markWithNote = (t: 'shifts' | 'business_days') => db.prepare(
        `UPDATE ${t} SET sync_status='conflict',
         notes = TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?`);
      // F10: the three tables without notes keep the cloud's code and words (sync_error, schema 72), so a row parked for a
      // passing reason can be told from one refused for its data (requeueTransientConflicts).
      const stmt = {
        shifts:             markWithNote('shifts'),
        business_days:      markWithNote('business_days'),
        float_transactions: db.prepare(`UPDATE float_transactions SET sync_status='conflict', sync_error=? WHERE id=?`),
        expenses:           db.prepare(`UPDATE expenses SET sync_status='conflict', sync_error=? WHERE id=?`),
        kitchen_voids:      db.prepare(`UPDATE kitchen_voids SET sync_status='conflict', sync_error=? WHERE id=?`),
      };

      db.transaction(() => {
        for (const r of rejected) {
          const t = tableOf(r);
          if (!t) {
            // Table unknown, so which set to put it in is unknown too. Put it in
            // ALL of them: the sets are only ever read to answer "was this row
            // refused?", and the answer is yes regardless of which table it came
            // from. Ids are UUIDs, so this cannot suppress an unrelated row.
            // Without this the row falls through to the commit loop and is marked
            // synced — the exact failure the routing above exists to stop, just
            // one branch further along.
            unrouted.push(r);
            for (const s of Object.values(rejectedByTable)) s.add(r.id);
            continue;
          }
          rejectedByTable[t].add(r.id);
          if (t === 'shifts' || t === 'business_days') {
            stmt[t].run(`Sync rejected: ${r.error}`, r.id);
          } else {
            stmt[t].run(`${r.code ?? 'error'}: ${String(r.error ?? '').slice(0, 300)}`, r.id);
          }
        }
      })();

      // A363: into the log too — until 0.6.20 a refusal reached only the Sync card, and the log said "pushed N cash
      // record(s)" as if all had landed (T1, 2026-09-29: a parked shift sat unseen for two hours).
      for (const r of rejected) logLine('sync', `refused by the cloud (${r.table ?? tableOf(r) ?? 'unknown table'} ${r.id}): ${r.error}`);

      // The server's own words. The previous hardcoded "a cashier has an open
      // drawer on another till" was wrong for every rejection that was not that
      // one — including the trading-day case, where it named the wrong problem
      // to whoever had to fix it.
      errors.push(
        rejected.length === 1
          ? `A record could not sync: ${rejected[0].error}`
          : `${rejected.length} records could not sync: ${rejected[0].error}`,
      );
    }

    // A rejection this build cannot place. It is NOT marked synced — that is the
    // whole failure this block exists to prevent — so the row stays pending and
    // is re-offered next pass. It will loop until someone updates the till, which
    // is visible and recoverable; silently dropping it is neither.
    if (unrouted.length) {
      errors.push(
        `${unrouted.length} record(s) were refused by the server for a reason this ` +
        `build does not recognise — update this till. First reason: ${unrouted[0].error}`,
      );
    }

    // Server has the open-shift fields now. Only a still-open shift is fully
    // done here — a closed one waits for reconcileClosedShifts to confirm the
    // server-computed close before it's marked synced.
    const openShifts = shifts
      // 'open' only: a force-closed drawer ('closed_unreconciled') waits for reconcileClosedShifts too (/force-close).
      .filter(s => s.status === 'open' && !rejectedByTable.shifts.has(s.id));
    // Till sync audit (F1): marked synced only if the row is STILL what was sent. A shift closed (or a day closed or
    // reopened) while this push was on its way used to be marked synced by its id — the close then never reached the
    // cloud: the cloud's drawer stayed open, and a lost day close got the next day refused (duplicate_open_day). A row
    // that changed stays pending and goes (or is reconciled) next pass.
    const markShift = db.prepare(`UPDATE shifts SET sync_status='synced'
      WHERE id=@id AND sync_status='pending' AND status IS @status AND closed_at IS @closed_at`);
    const markFloat = db.prepare(`UPDATE float_transactions SET sync_status='synced', sync_error=NULL WHERE id=? AND sync_status='pending'`);
    const markExp   = db.prepare(`UPDATE expenses SET sync_status='synced', sync_error=NULL WHERE id=? AND sync_status='pending'`);
    const markDay   = db.prepare(`UPDATE business_days SET sync_status='synced'
      WHERE id=@id AND sync_status='pending' AND status IS @status AND closed_at IS @closed_at
        AND counted_cash IS @counted_cash AND notes IS @notes`);
    const markKv    = db.prepare(`UPDATE kitchen_voids SET sync_status='synced', sync_error=NULL WHERE id=? AND sync_status='pending'`);
    // 0.6.28: a cloud before migration 112 ignores `kitchen_voids` — marking them synced would lose them. Only a cloud
    // that counts them (upserted.kitchenVoids) has stored them; otherwise they wait, pending, for the cloud's update.
    const cloudTakesKv = typeof body?.upserted?.kitchenVoids === 'number';
    if (kitchen_voids.length && !cloudTakesKv && kitchen_voids.length !== _kvWaitingLogged) {
      _kvWaitingLogged = kitchen_voids.length;   // once per count, not every pass
      logLine('sync', `${kitchen_voids.length} kitchen void(s) kept on the till — the cloud does not take them yet (migration 112)`);
    }
    // Every loop excludes its own table's rejections. Anything absent from
    // `rejected` is still treated as accepted — that design constraint is
    // unchanged and is why the routing above has to be right.
    db.transaction(() => {
      for (const s of openShifts)    markShift.run({ id: s.id, status: s.status ?? null, closed_at: s.closed_at ?? null });
      for (const f of floats)        if (!rejectedByTable.float_transactions.has(f.id)) markFloat.run(f.id);
      for (const e of expenses)      if (!rejectedByTable.expenses.has(e.id))           markExp.run(e.id);
      for (const d of business_days) if (!rejectedByTable.business_days.has(d.id)) {
        markDay.run({ id: d.id, status: d.status ?? null, closed_at: d.closed_at ?? null,
          counted_cash: d.counted_cash ?? null, notes: d.notes ?? null });
      }
      if (cloudTakesKv) for (const k of kitchen_voids) if (!rejectedByTable.kitchen_voids.has(k.id)) markKv.run(k.id);
    })();
    const pushedCount = shifts.length + floats.length + expenses.length + business_days.length + kitchen_voids.length;
    if (pushedCount) logLine('sync', `pushed ${pushedCount} cash record(s): ${shifts.length} shift, ${floats.length} float, ${expenses.length} expense, ${business_days.length} day, ${kitchen_voids.length} kitchen void`); // A178
    return pushedCount;
  } catch (err: any) {
    errors.push(`Shift sync: ${err.message}`);
    logLine('sync', `shift push failed: ${err?.message ?? err}`); // A178: network/schema throw was invisible in the log
    return -1;
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

  const doPost = () => syncFetch(`${_serverUrl}/api/branch-prices/sync`, {
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
      const msg = describeServerError(err, res.status);
      errors.push(`Price sync: ${msg}`);
      logLine('sync', `price push rejected (HTTP ${res.status}): ${msg}`); // A178
      return 0;   // leave rows unsynced — they retry next pass
    }
    const { applied } = await res.json() as { applied: string[] };
    // Only mark the products the server actually applied.
    const mark = db.prepare(`UPDATE local_price_edits SET synced = 1 WHERE product_id = ? AND synced = 0`);
    db.transaction(() => { for (const pid of (applied ?? [])) mark.run(pid); })();
    if ((applied ?? []).length) logLine('sync', `pushed ${(applied ?? []).length} price edit(s)`); // A178
    return (applied ?? []).length;
  } catch (err: any) {
    errors.push(`Price sync: ${err.message}`);
    logLine('sync', `price push failed: ${err?.message ?? err}`); // A178
    return 0;
  }
}
/** Till sync audit (F5): a queued sale whose drawer the cloud refused (parked) — it cannot go until the drawer does. */
// branch-wide: keyed by order id to this till's own sync_queue rows; the drawer test is by id.
export const PARKED_DRAWER_SQL = `EXISTS (SELECT 1 FROM orders o JOIN shifts s ON s.id = o.shift_id
  WHERE o.id = q.order_id AND s.sync_status IN ('conflict', 'failed'))`;
const SYNCED_QUEUE_KEEP_MS = 30 * 86400_000;   // F16
let _queuePrunedAt = 0;
/** Till sync audit (F16): synced queue rows older than 30 days go (their orders stay; failed / pending rows always stay). */
export function pruneSyncedQueue(now = Date.now()): number {
  const cutoff = new Date(now - SYNCED_QUEUE_KEEP_MS);
  // created_at is either an ISO string (the till) or SQLite's 'YYYY-MM-DD HH:MM:SS' (a branch-server relay): compare instants.
  return getLocalDb().prepare(`DELETE FROM sync_queue WHERE status = 'synced' AND julianday(created_at) < julianday(?)`)
    .run(cutoff.toISOString()).changes;
}

async function pushPendingOrders(errors: string[]): Promise<number> {
  const db = getLocalDb();
  // Till sync audit (F5): `ORDER BY created_at LIMIT 50` let 50 old sales waiting on a drawer not on the cloud (424, which
  // neither counts nor stops the batch) take every place of every pass — no newer sale ever went. Now a sale of a
  // drawer the cloud refused is left out (it goes with its drawer), and a 424 stamps drawer_wait_at: the sale then queues
  // BEHIND every sale not waiting (and behind the ones that waited longer), and the rest of its drawer's sales sit this
  // pass out (they would get the same answer). One drawer can no longer starve the rest; the moment the drawer is on the
  // cloud its sales go on the next pass.
  // Up to 50 sales are TRIED per pass. A page leaves out what this pass already tried and the drawers that answered 424 in
  // it, so the sales behind a waiting drawer are reached in the same pass.
  // branch-wide: this till's own sync_queue; orders are looked up by the queued order id.
  const page = db.prepare(`
    SELECT q.*, (SELECT o.shift_id FROM orders o WHERE o.id = q.order_id) AS _shift_id FROM sync_queue q
     WHERE q.status = 'pending'
       AND NOT ${PARKED_DRAWER_SQL}
       AND q.id NOT IN (SELECT value FROM json_each(?))
       -- branch-wide: by the queued order id (this till's own queue)
       AND COALESCE((SELECT o.shift_id FROM orders o WHERE o.id = q.order_id), '') NOT IN (SELECT value FROM json_each(?))
     ORDER BY (q.drawer_wait_at IS NOT NULL) ASC, q.drawer_wait_at ASC, q.created_at ASC LIMIT ?
  `);
  const drawerWaits = new Set<string>();   // drawers that answered 424 this pass
  const tried: number[] = [];
  let budget = 50;

  let pushed = 0;
  let triedAuthRefresh = false;  // refresh once per sync pass (A168)
  // F6: the staff renewal failed this pass — the rest of the batch goes under the till's own session (each sale names its
  // cashier; the cloud checks that claim against the branch's staff, routes/orders.ts), instead of each one stopping.
  let staffRenewalFailed = false;

  // S3: move BOTH rows to 'synced' in one transaction, so a crash between the
  // two writes can never leave sync_queue and orders disagreeing (queue synced
  // while the order still reads pending, or vice versa). Prepared once, reused
  // per row; the same statements the two success branches ran inline before.
  const _markQueueSynced = db.prepare(`UPDATE sync_queue SET status='synced', attempts=attempts+1, drawer_wait_at=NULL WHERE id=?`);
  const _markOrderSynced = db.prepare(`UPDATE orders SET sync_status='synced' WHERE id=?`);
  const markSynced = db.transaction((queueId: number, orderId: string) => {
    _markQueueSynced.run(queueId);
    _markOrderSynced.run(orderId);
  });

  // Every till pushes its OWN orders to the cloud, including tills that have a
  // branch node.
  //
  // This used to route through the node instead (till → node → cloud), on the
  // reasoning that a single path made duplicates impossible. That defence is
  // redundant now: order ids are client-generated UUIDs, the push carries
  // X-Idempotency-Key, the server upserts by id, and migration 50 made
  // idempotency_key NOT NULL. Two paths converge on the same row.
  //
  // What the single path cost was worse than what it bought. It made the node a
  // single point of failure for every peer's sales, which is the opposite of the
  // reason a branch server exists — and it forced 'node_ack', a third state in a
  // column that can only hold one destination's opinion. The node is now a
  // replica, reached separately by pushToNode(); see nodeIngest.ts.

  batch: while (budget > 0) {
  const pending = page.all(JSON.stringify(tried), JSON.stringify([...drawerWaits]), budget) as any[];
  if (!pending.length) break;
  for (const row of pending) {
    tried.push(row.id);
    if (row._shift_id && drawerWaits.has(String(row._shift_id))) continue;   // F5: its drawer just answered 424
    budget--;
    try {
      // A446 (session audit): a sale rung by a cashier who is no longer the one signed in (queued while offline, then
      // Brian signed in) goes up under the TILL's own session, which names the cashier in the sale (cashier_id — the
      // cloud checks it against the branch's staff, lib/cashier.ts). Under the person signed in now, it was credited
      // to them.
      let rungBy: string | null = null;
      try { rungBy = JSON.parse(row.payload)?.cashier_id ?? null; } catch { rungBy = null; }
      const now = signedInStaffId();
      let asTill = !!_accessToken && !!rungBy && ((!!now && rungBy !== now) || (staffRenewalFailed && !!_staffToken));
      const doPost = () => syncFetch(`${_serverUrl}/api/orders`, {
        method: 'POST',
        headers: {
          ...pushAuthHeaders(),
          ...(asTill ? { Authorization: `Bearer ${_accessToken}` } : {}),
          // Idempotency key — the stable local order id, so retries (even across
          // requeues) always dedupe to the same server order.
          'X-Idempotency-Key': row.order_id,
        },
        body: row.payload,
      });

      let res = await doPost();

      // A168: on a 401, refresh the token THIS push is actually sending, and
      // only that one. pushAuthHeaders() sends `_staffToken || _accessToken`, so
      // an online shift pushes under the staff token and an offline shift (no
      // staff token) pushes under the till's own token. The server sets
      // `cashier_id = req.userId` (the token subject, orders.ts), so re-pushing a
      // STAFF order under the till's own token would lose the staff token's own attribution
      // — never fall through. Mirror the selection instead: refresh whichever
      // token was sent. This closes the gap where an offline order's till-token
      // 401 was met with refreshStaffToken() (nothing to refresh) and the order
      // sat pending; the price path recovers via refreshAccessToken() but that
      // path isn't cashier-attributed, so its `staff || owner` fallthrough is
      // safe there and would NOT be safe here.
      if (res.status === 401 && !triedAuthRefresh) {
        triedAuthRefresh = true;
        const staffPath = !asTill && selectPushRefresh(liveStaffToken()) === 'staff';   // A504: the token actually sent
        const refreshed = staffPath ? await refreshStaffToken() : await refreshAccessToken();
        if (refreshed) res = await doPost();
        else if (staffPath && _accessToken && rungBy) {
          // F6: the staff session cannot be renewed right now — the sale goes under the till's own session, naming its
          // cashier, rather than the whole batch stopping on the 401.
          staffRenewalFailed = true;
          asTill = true;
          res = await doPost();
        }
      }
      // A495: the cloud now refuses a manual discount under a person's session that lacks sales.discount. A sale the
      // till already took (its discount allowed or approved at the counter, or the key removed since) goes up under the
      // till's own session, naming its cashier — never held for ever over a permission checked when it was rung.
      if (res.status === 403 && !asTill && _accessToken && rungBy) {
        const body403 = await res.clone().json().catch(() => null) as { code?: string; detail?: string } | null;
        // A505: also a refusal for orders.create — a sale already rung at this counter, never held over a key.
        if (body403?.code === 'DISCOUNT_NOT_ALLOWED' || /Missing permission: orders\.create/.test(String(body403?.detail ?? ''))) {
          logLine('sync', `order ${row.order_id}: refused under the cashier's session (discount or sell permission) - sent under the till's own`);
          asTill = true;
          res = await doPost();
        }
      }

      // F14: a 2xx is the cloud's only when it carries the order (a fresh create's orderId, or a duplicate's marker) —
      // an empty or foreign body (a proxy, a captive portal) is not proof the sale is stored.
      const okBody = res.ok ? await Promise.resolve().then(() => res.json()).catch(() => null) as any : null;
      const stored = res.ok && !!okBody && (typeof okBody.orderId === 'string' || typeof okBody.id === 'string' || okBody.duplicate === true);
      if (res.ok && !stored) {
        const message = `the cloud answered HTTP ${res.status} without the order - not marked synced`;
        db.prepare(`UPDATE sync_queue SET last_error=? WHERE id=?`).run(message, row.id);
        errors.push(`Order ${row.order_id}: ${message}`);
        logLine('sync', `order ${row.order_id}: ${message}`);
        break batch;   // the rest of the batch would get the same answer
      } else if (stored) {
        // res.ok covers both a fresh create (201) and an idempotent duplicate
        // (200 with { duplicate: true }) — both mean the server has this order,
        // so the local row is safely marked synced. A lost first response that
        // caused this retry therefore resolves correctly instead of duplicating.
        markSynced(row.id, row.order_id);
        pushed++;
      } else if (res.status === 409) {
        // A181: a 409 is the server refusing an order-NUMBER collision — a
        // DIFFERENT order already holds this (business, branch, order_number)
        // (orders.ts). It does NOT mean the server has THIS order. The old
        // "treat as synced" here SILENTLY LOST every order whose number collided
        // — e.g. a second till/install reusing T1--N over numbers an earlier till
        // already put on the cloud. Surface it (escalate to 'failed', log it) so
        // it is visible and can be recovered with a non-colliding number, instead
        // of a sale that reads synced on the till and is absent from the cloud.
        const err = await res.json().catch(() => ({} as any));
        const message = (err as any)?.error
          || 'order number already exists on the cloud (another till/session) — NOT stored';
        db.prepare(`
          UPDATE sync_queue SET attempts=attempts+1, last_error=?,
          status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?
        `).run(message, row.id);
        errors.push(`Order ${row.order_id}: ${message}`);
        logLine('sync', `order push rejected (409): ${message}`);
      } else if (res.status === 424) {
        // A338: the sale's drawer is not on the cloud yet (it goes up in the shift stage, before this one). Not a
        // fault and not this sale's to give up on: it stays pending, never counts towards 'failed', and goes next pass.
        const err = await res.json().catch(() => ({} as any));
        const message = (err as any)?.error || 'drawer not on the cloud yet';
        // F5: it queues behind the sales not waiting from now on, and its drawer's other sales sit this pass out.
        db.prepare(`UPDATE sync_queue SET last_error=?, drawer_wait_at=? WHERE id=?`)
          .run(message, new Date().toISOString(), row.id);
        if (row._shift_id) drawerWaits.add(String(row._shift_id));
        logLine('sync', `order ${row.order_id} waits for its drawer: ${message}`);
      } else if (isTransientStatus(res.status)) {
        // A446 (session audit): the cloud down (5xx), busy (429), or this till's session not renewable right now (401 after
        // the refresh failed) is not THIS sale's fault — it stays pending and never counts towards 'failed'. Counting it
        // turned every sale of a long outage 'failed', one every 2.5 minutes, and nothing retried them by itself.
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const message = describeServerError(err, res.status);
        db.prepare(`UPDATE sync_queue SET last_error=? WHERE id=?`).run(message, row.id);
        errors.push(`Order ${row.order_id}: ${message}`);
        break batch;   // the rest of the batch would get the same answer
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
      // A446 (session audit): a thrown fetch is the line, not the sale — no internet, the branch server off or with no
      // internet itself (UplinkDown), a timeout. It stays pending and never counts towards 'failed' (it used to: a 36-minute
      // outage would have left ~14 sales 'failed' until someone pressed retry). Anything else thrown still counts.
      const transport = isTransportError(err);
      db.prepare(transport
        ? `UPDATE sync_queue SET last_error=? WHERE id=?`
        : `UPDATE sync_queue SET attempts=attempts+1, last_error=?,
           status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?`,
      ).run(err.message ?? 'Push failed', row.id);
      errors.push(`Order ${row.order_id}: ${err.message}`);
      logLine('sync', `order push failed: ${err.message ?? err}`); // A177: push failures now reach the durable log too (were DB-only)
      // A177: a thrown fetch means the server is unreachable/timed out — the rest
      // of this batch will fail identically. Stop now rather than burn one full
      // timeout per remaining order; they retry next pass.
      break batch;
    }
  }
  }   // batch

  if (pushed) {
    logLine('sync', `pushed ${pushed} order(s) to the cloud`); // A178: confirms the queue is draining
    // A446: the line is back — sales left 'failed' by a connection problem (before this build, or a run of 5xx) go again.
    const back = db.prepare(`
      UPDATE sync_queue SET status='pending', attempts=0
       WHERE status='failed' AND (last_error LIKE '%fetch failed%' OR last_error LIKE '%timed out%' OR last_error LIKE '%cannot reach%'
          OR last_error LIKE '%ECONN%' OR last_error LIKE '%ENOTFOUND%' OR last_error LIKE '%EAI_AGAIN%' OR last_error LIKE '%HTTP 5%'
          OR last_error LIKE '%refused this till%' OR last_error LIKE '%network%' OR last_error LIKE '%aborted%')`).run().changes;
    if (back) logLine('sync', `${back} sale(s) left 'failed' by a connection problem are queued again`);
  }
  // F16: at most every 6 hours. Never fatal.
  if (Date.now() - _queuePrunedAt > 6 * 3600_000) {
    _queuePrunedAt = Date.now();
    try { const n = pruneSyncedQueue(); if (n) logLine('sync', `pruned ${n} synced queue row(s) older than 30 days`); }
    catch (e: any) { logLine('sync', `queue prune failed: ${e?.message ?? e}`); }
  }
  return pushed;
}

// Reconcile locally closed shifts once their orders have all synced (audit
// C6). Calls the existing POST /:id/close — the same formula the online till
// already uses to compute expected_cash/cash_variance server-side from real
// synced payments — instead of duplicating that math here or letting the
// till's own number be trusted outright. Runs after pushPendingOrders so
// "have all this shift's orders synced?" is a real answer, not a guess.
/** A446: a thrown fetch that is the LINE (no internet, branch server off or without internet, a timeout), not the sale. */
export function isTransportError(err: any): boolean {
  const name = String(err?.name ?? '');
  if (['UplinkDownError', 'NodeRefusedError', 'AbortError', 'TimeoutError'].includes(name)) return true;
  const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
  return /fetch failed|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket|network|aborted|cannot reach/i.test(text);
}
/** A446: an answer that is the cloud's or the session's state right now, not a verdict on the sale. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408 || status === 401;
}

/**
 * Replicate this till's own rows to the branch node.
 *
 * A SEPARATE DESTINATION from the cloud, with separate state. That separation is
 * the point of this function existing rather than being a branch inside the
 * cloud push. One `sync_status` column cannot hold two destinations' opinions,
 * and the attempt to make it — marking a node-acked order 'synced' — is what made
 * a peer till close its shift against a server that did not have the sales and
 * report a cash variance that did not exist. `node_ack` was the workaround for
 * that; node_queue is the fix, and node_ack is gone.
 *
 * Consequences of the separation, all deliberate:
 *   • The cloud never waits on the node. A branch server switched off does not
 *     delay a single sale reaching Supabase.
 *   • The node never waits on the cloud. An internet outage does not stop the
 *     branch report being complete on the LAN — which is the outage during which
 *     a manager most wants it.
 *   • Shift close depends on cloud state alone, which is the only state the
 *     server can compute a close from anyway (C6).
 *
 * Errors here are reported but never fatal: a till whose node is unreachable
 * keeps selling and keeps syncing to the cloud.
 */
async function pushToNode(errors: string[]): Promise<number> {
  const r = await replicateToNode();
  errors.push(...r.errors);
  return r.count;
}

// F10 (2026-10-14): replication to the branch server has its own beat (index.ts, every 15 s) — it used to run only
// inside syncPush/syncAll, which need a cloud sign-in and the internet, so a till with no cloud session never sent the
// server a single row however long it traded. Single-flight: the beat and a sync pass share one run.
let _nodePushInFlight: Promise<{ count: number; errors: string[] }> | null = null;
let _nodeBatchBytes = NODE_BATCH_BYTES;
let _clockCheckedAt = 0;
let _healthCheckedAt = 0;

/**
 * A501: once a minute, ask the server about itself (/node/health) and re-arm what an old identity refused when the
 * identity changed — the server's certificate, its device id, or THIS till's branch (a cloud sign-in can rebind a till
 * to another branch, every route then answers 403; changing back used to leave the outbox failed for good, since only a
 * new address or access code re-armed it). Exported for the test. Never throws.
 */
export async function checkNodeIdentity(force = false): Promise<void> {
  if (!force && Date.now() - _healthCheckedAt < 60_000) return;
  _healthCheckedAt = Date.now();
  try {
    const h = await checkNodeHealth();
    if (!h.ok || !h.info) return;   // no answer: nothing is known about who it is — nothing changes
    const cfg = getDeviceConfig();
    if (h.info.branch_id && cfg?.branch_id && h.info.branch_id !== cfg.branch_id) {
      logLine('node', `A501: this till is set to branch ${cfg.branch_id} but its branch server serves ${h.info.branch_id} — the server refuses its records until they match (Tech page › Branch sync)`);
    }
    const id = noteNodeIdentity(nodeIdentityKey({ certCode: securityCode(tillPin()), serverDevice: h.info.device_id, branch: cfg?.branch_id ?? null }));
    if (id.verdict !== 'same' && (id.rearmed || id.released)) {
      logLine('node', `A501: the branch server's identity ${id.verdict === 'first' ? 'was recorded' : 'changed'} (certificate, server or this till's branch) — ${id.rearmed} record(s) it refused before are offered again, ${id.released} held-back record(s) from other tills tried again`);
    }
  } catch (err: any) { logLine('node', `A501: branch server identity check failed: ${err?.message ?? err}`); }
}
let _clockWarnings: string[] = [];

/** Send this till's own rows to its branch server now (no cloud needed). Never throws. */
export function replicateToNode(): Promise<{ count: number; errors: string[] }> {
  if (_nodePushInFlight) return _nodePushInFlight;
  _nodePushInFlight = (async () => {
    const errors: string[] = [];
    let count = 0;
    try { count = await pushToNodeOnce(errors); }
    catch (err: any) { errors.push(`Branch replication: ${err?.message ?? err}`); }
    return { count, errors };
  })().finally(() => { _nodePushInFlight = null; });
  return _nodePushInFlight;
}

async function pushToNodeOnce(errors: string[]): Promise<number> {
  if (!hasNode()) return 0;
  const cfg = getDeviceConfig();

  // F2: a different server (or access code) than last pass — offer everything again (nodeIngest.noteNodeTarget).
  try {
    const t = noteNodeTarget(nodeTargetKey(cfg?.node_url, cfg?.node_secret));
    if (t === 'changed') logLine('node', 'the branch server (or its access code) changed — every row is offered to it again');
    if (t === 'first') logLine('node', 'branch replication: the last 14 days are offered to the server once more (F1 repair)');
  } catch (err: any) { logLine('node', `could not check the branch server identity: ${err?.message ?? err}`); }
  await checkNodeIdentity();   // A501: certificate, server device id, this till's branch

  try {
    fillNodeOutbox();
  } catch (err: any) {
    errors.push(`Branch replication: ${err.message}`);
    return 0;
  }

  // F2: after a re-arm, skip what the new server already holds (one /node/cursors) — re-offering is free, this only
  // makes it short.
  if (nodeRearmSkipOwed()) {
    const cursors = await fetchNodeCursors();
    if (cursors) {
      const skipped = skipHeldByNode(cursors);
      logLine('node', `the branch server already holds ${skipped} of this till's rows — not sent again`);
    }
  }

  let delivered = 0;
  for (let round = 0; round < 3; round++) {
    const batch = takeNodeQueueBatch(200, _nodeBatchBytes);   // F14: by size as well as count
    if (!batch.length) break;

    const tables: Record<string, any[]> = {};
    for (const q of batch) {
      try { (tables[q.table_name] ??= []).push(JSON.parse(q.payload)); } catch { /* the server cannot name it either — left pending */ }
    }
    const ids = batch.map(q => q.id);
    const out = await pushRowsToNode(tables);

    if (out.kind === 'transport') {
      // F3: no answer, a 5xx, or a 401 — none of it is about the rows. Retried without counting an attempt: a branch
      // server off for the weekend, or waiting for its new access code, must not mark a day's cash records 'failed'.
      markNodeQueueFailed(ids, out.error, false);
      // A501: a refusal of the TILL (its code or key 401, its branch 403, its connection 426, an unreadable request 400)
      // is said — it does not fix itself the way a server switched off does — but never counted against the rows.
      if (out.status === 401 || out.status === 400 || out.status === 403 || out.status === 426) errors.push(`Branch replication: ${out.error}`);
      break;
    }
    if (out.kind === 'too_large') {
      // F14: the server named it. Halve and send again; a single row too large is the row's own problem.
      if (batch.length > 1) { _nodeBatchBytes = Math.max(64_000, Math.floor(_nodeBatchBytes / 2)); continue; }
      markNodeQueueFailed(ids, out.error, true);
      errors.push(`Branch replication: ${out.error}`);
      continue;
    }
    if (out.kind === 'refused') {
      // The node ANSWERED and refused the batch as such. Escalate, so the reason reaches a human.
      markNodeQueueFailed(ids, out.error, true);
      errors.push(`Branch replication: ${out.error}`);
      break;
    }

    // F1: exactly what the server holds is delivered; what it refused is refused; the rest stays pending.
    const settled = settleNodeBatch(batch, out.results);
    markNodeQueueDelivered(settled.delivered);
    for (const r of settled.refused) markNodeQueueFailed([r.id], r.reason, true);
    delivered += settled.delivered.length;
    if (settled.refused.length) {
      errors.push(
        settled.refused.length === 1
          ? `The branch server refused a record: ${settled.refused[0].reason}`
          : `The branch server refused ${settled.refused.length} records: ${settled.refused[0].reason}`,
      );
    }
    if (!settled.delivered.length) break;   // nothing moved: do not spin on the same rows this pass
  }

  // Clock drift. Advisory — the till keeps trading either way. business_date
  // comes from each terminal's own clock, so two tills disagreeing across
  // midnight split one evening's takings over two trading days, and no report
  // will ever reconcile them. F15: the time ZONE as well. Measured at most once a minute (the beat is 15 s); the
  // warning stands between measurements.
  if (Date.now() - _clockCheckedAt > 60_000) {
    _clockCheckedAt = Date.now();
    const clock = await measureNodeClock();
    if (clock) {
      const warn: string[] = [];
      if (Math.abs(clock.driftMs) > 120_000) {
        const mins = Math.round(Math.abs(clock.driftMs) / 60_000);
        warn.push(`This till's clock is ${mins} minute(s) ${clock.driftMs > 0 ? 'ahead of' : 'behind'} the branch server. ` +
          'Correct it before the next day close — trading days are dated from each till\'s own clock.');
      }
      if (clock.tzMismatch && clock.nodeTzOffset !== null) {
        const zone = (off: number) => { const m = -off; const sign = m >= 0 ? '+' : '-'; const a = Math.abs(m); return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; };
        warn.push(`This till's time zone (${zone(clock.tzOffset)}) is not the branch server's (${zone(clock.nodeTzOffset)}). ` +
          'Set both to the shop\'s time zone in Windows — trading days are dated from each till\'s own time.');
      }
      _clockWarnings = warn;
    }
  }
  errors.push(..._clockWarnings);

  return delivered;
}

// ── F9/F10/P3: the branch-server beat (index.ts runs it every 15 s) ─────────
let _nodeBeatStarted = false;
let _nodePrunedAt = 0;
let _lastNodeError = '';

/**
 * One beat of LAN replication, independent of the cloud:
 *   - on the BRANCH SERVER: number its own new rows (F9 — without a seq they were never distributed), turn its refunds
 *     into events (F8), apply waiting events, and prune answered instructions (P3);
 *   - on a TILL behind one: send its rows (F10 — with or without a cloud session), prune delivered outbox rows (P3).
 * Never throws.
 */
export async function nodeReplicationTick(): Promise<void> {
  try {
    const cfg = getDeviceConfig();
    const pruneDue = Date.now() - _nodePrunedAt > 3_600_000;
    if (isNodeRole(cfg?.device_role)) {
      if (!_nodeBeatStarted) {
        _nodeBeatStarted = true;
        const n = backfillOwnSeq();   // F9: once — the rows this server made before it numbered its own
        if (n) logLine('node', `numbered ${n} of this server's own rows so the branch's tills receive them`);
      }
      numberOwnRows(500);
      emitRefundEvents();
      applyPendingEvents();
      if (pruneDue) { _nodePrunedAt = Date.now(); pruneNodeInstructions(7); }
      return;
    }
    if (!hasNode()) return;
    repairBillNumberRefusals();   // A500: once — sales refused / skipped for their bill number before this build
    const r = await replicateToNode();
    const msg = r.errors.join(' | ');
    if (msg && msg !== _lastNodeError) logLine('node', `branch replication: ${msg}`);
    _lastNodeError = msg;
    // A501: the server stopped answering — it may have moved (DHCP, the port fallback). Its own beacon, proven over TLS.
    const f = await followMovedServer();
    if (f.outcome === 'followed') { _healthCheckedAt = 0; void replicateToNode(); }
    if (pruneDue) { _nodePrunedAt = Date.now(); pruneNodeQueue(7); }
  } catch (err: any) {
    logLine('node', `branch replication beat failed: ${err?.message ?? err}`);
  }
}

/**
 * A363 (2026-09-29) — a trading-day clash parks a day and its shift for good; put them back ONCE.
 *
 * An offline close-and-reopen pushes yesterday's closing day and today's new one in one batch. Before the cloud wrote
 * closing days first (sync.ts, lib/dayOrder), the new day could land first and be refused as duplicate_open_day; its
 * shift was then refused as missing_business_day, and both were parked 'conflict' — nothing re-sent them, so the shift
 * never reached the cloud and every sale on it waited for its drawer (T1, 2026-09-29). Once the cloud accepts them,
 * this re-sends each such row ONE time (a local mark in maintenance_state, never in notes — a day's notes go to the
 * cloud), so a row refused again for a real reason is parked again and never loops. Its floats, expenses and sales
 * follow through requeueAfterDrawerClash once the shift is no longer parked.
 */
/**
 * Till sync audit (F10) — rows an OLDER cloud parked for a passing reason go again, ONCE.
 *
 * Before the cloud answered 503 for its own passing errors, a kitchen void or an expense it could not write right then (a
 * timeout, a dropped connection: code 'error', 08xxx, 57xxx…) came back in `rejected` and the till parked it 'conflict'
 * for good. Floats and drawer expenses are given back by requeueAfterDrawerClash once their drawer is not parked; a
 * kitchen void and an expense "Not from a drawer" (A466, no shift) had nothing to give them back. This re-sends each such
 * row one time (a mark in maintenance_state), unless the cloud refused it for its data (isDataErrorCode) — so a row
 * refused again is parked again and never loops.
 */
export function requeueTransientConflicts(): { kitchenVoids: number; expenses: number } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  const out = { kitchenVoids: 0, expenses: 0 };
  const codeOf = (e: string | null) => (e ? e.split(':')[0].trim() : null);
  db.transaction(() => {
    const once = (table: string, id: string): boolean => {
      const key = `resent_once:${table}:${id}`;
      if (db.prepare(`SELECT 1 FROM maintenance_state WHERE key = ?`).get(key)) return false;
      db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, 'transient', ?)`).run(key, new Date().toISOString());
      return true;
    };
    const sets: Array<[string, string, keyof typeof out]> = [
      // own: only this till pushes its kitchen voids and expenses, so only it re-sends them.
      ['kitchen_voids', `SELECT id, sync_error FROM kitchen_voids WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'')`, 'kitchenVoids'],
      ['expenses', `SELECT id, sync_error FROM expenses WHERE sync_status = 'conflict' AND shift_id IS NULL AND COALESCE(device_id,'') = COALESCE(?,'')`, 'expenses'],
    ];
    for (const [table, sql, k] of sets) {
      let rows: Array<{ id: string; sync_error: string | null }> = [];
      try { rows = db.prepare(sql).all(own) as any[]; } catch { continue; }
      for (const r of rows) {
        if (isDataErrorCode(codeOf(r.sync_error))) continue;
        if (!once(table, r.id)) continue;
        db.prepare(`UPDATE ${table} SET sync_status = 'pending' WHERE id = ? AND sync_status = 'conflict'`).run(r.id);
        out[k]++;
      }
    }
  })();
  if (out.kitchenVoids + out.expenses) logLine('sync', `re-sending once what an older cloud parked for a passing reason: ${out.kitchenVoids} kitchen void(s), ${out.expenses} expense(s)`);
  return out;
}

export const DAY_CLASH_NOTE ='Sync rejected: This till already has an open trading day. It must be closed before this one can sync.';
export const MISSING_DAY_NOTE = 'Sync rejected: This shift\'s trading day is not on the server — the day was refused or has not synced yet. Resolve the trading day first.';
export function requeueAfterDayClash(): { days: number; shifts: number } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  const once = (table: string, id: string): boolean => {
    const key = `resent_once:${table}:${id}`;
    if (db.prepare(`SELECT 1 FROM maintenance_state WHERE key = ?`).get(key)) return false;
    db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, 'A363', ?)`).run(key, new Date().toISOString());
    return true;
  };
  const strip = (notes: string | null, line: string) =>
    (notes ?? '').split(line).join('').replace(/^[\s\n\r]+|[\s\n\r]+$/g, '') || null;
  let days = 0, shifts = 0;
  db.transaction(() => {
    const parkedDays = db.prepare(`
      SELECT id, notes FROM business_days
       -- own: only this till pushes its days, so only it re-sends them.
       WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'') AND notes LIKE '%already has an open trading day%'
    `).all(own) as { id: string; notes: string | null }[];
    for (const d of parkedDays) {
      if (!once('business_days', d.id)) continue;
      db.prepare(`UPDATE business_days SET sync_status = 'pending', notes = ? WHERE id = ?`).run(strip(d.notes, DAY_CLASH_NOTE), d.id);
      days++;
    }
    const parkedShifts = db.prepare(`
      SELECT id, notes FROM shifts
       -- own: only this till pushes its drawers, so only it re-sends them.
       WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'') AND notes LIKE '%trading day is not on the server%'
    `).all(own) as { id: string; notes: string | null }[];
    for (const sh of parkedShifts) {
      if (!once('shifts', sh.id)) continue;
      db.prepare(`UPDATE shifts SET sync_status = 'pending', notes = ? WHERE id = ?`).run(strip(sh.notes, MISSING_DAY_NOTE), sh.id);
      shifts++;
    }
  })();
  if (days + shifts) logLine('sync', `A363 re-sending once after a trading-day clash: ${days} day(s), ${shifts} shift(s)`);
  return { days, shifts };
}

/**
 * A338 (2026-09-27) — one drawer must never stop another from syncing (owner: "one should never block the other").
 *
 * Until migration 107 the cloud refused a till's shift while another drawer was open on the same terminal (the web POS
 * standing in for this till): the shift was parked 'conflict' (duplicate_open_shift), its floats and expenses were refused
 * as missing_shift and parked too, and every sale on it failed its foreign key five times and went 'failed'. Nothing
 * retried any of it, and Force sync could not help. Once the cloud accepts such a drawer, this puts them back:
 *   - shifts parked for that reason → pending (the rejection line is taken out of the notes, which the close sends on);
 *   - floats / expenses parked while their drawer was missing → pending, once the drawer is no longer parked;
 *   - sales that failed because their drawer was missing → pending, ONCE (marked, so a sale refused for another reason
 *     cannot loop), and only once their drawer has reached the cloud.
 * Cheap and idempotent: each is a single UPDATE that matches nothing on a healthy till.
 */
export const DRAWER_CLASH_NOTE = 'Sync rejected: This cashier already has an open shift. It must be closed before this one can sync.';
export const REQUEUED_MARK = '[requeued after its drawer synced] ';
export const REQUEUE_ONCE = 1000;
export function requeueAfterDrawerClash(): { shifts: number; floats: number; expenses: number; orders: number } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  const shifts = db.prepare(`
    UPDATE shifts SET sync_status = 'pending', notes = NULLIF(TRIM(REPLACE(COALESCE(notes,''), ?, ''), ' ' || char(10) || char(13)), '')
     -- own: only this till pushes its drawers, so only it re-queues them.
     WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'') AND notes LIKE '%already has an open shift%'
  `).run(DRAWER_CLASH_NOTE, own).changes;
  const floats = db.prepare(`
    UPDATE float_transactions SET sync_status = 'pending'
     -- own: this till's drawer movements, whose drawer is no longer parked.
     WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'')
       AND shift_id IN (SELECT id FROM shifts WHERE sync_status != 'conflict')
  `).run(own).changes;
  const expenses = db.prepare(`
    UPDATE expenses SET sync_status = 'pending'
     -- own: this till's expenses, whose drawer is no longer parked.
     WHERE sync_status = 'conflict' AND COALESCE(device_id,'') = COALESCE(?,'')
       AND shift_id IN (SELECT id FROM shifts WHERE sync_status != 'conflict')
  `).run(own).changes;
  // Once only: attempts is set to REQUEUE_ONCE, which the failure path only ever increments — so a sale that fails
  // again goes straight back to 'failed' (attempts+1 >= 5) and is never matched here again. (A mark in last_error
  // would not hold: the failure path overwrites last_error.)
  const orders = db.prepare(`
    UPDATE sync_queue SET status = 'pending', attempts = ?, last_error = ? || COALESCE(last_error, '')
     WHERE status = 'failed' AND attempts < ?
       AND (last_error LIKE '%references a record the server does not have%' OR last_error LIKE '%drawer has not reached the cloud%')
       -- branch-wide: keyed by order id to this till's own sync_queue rows; the drawer test is by id.
       AND order_id IN (SELECT o.id FROM orders o JOIN shifts s ON s.id = o.shift_id WHERE s.sync_status = 'synced')
  `).run(REQUEUE_ONCE, REQUEUED_MARK, REQUEUE_ONCE).changes;
  if (shifts + floats + expenses + orders) {
    logLine('sync', `A338 requeued after a drawer clash: ${shifts} shift(s), ${floats} float(s), ${expenses} expense(s), ${orders} sale(s)`);
  }
  return { shifts, floats, expenses, orders };
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
    SELECT id, status, closing_float, notes, declared_methods, closed_at, closed_by
      FROM shifts
     -- own: reconciling a closed shift means asking the server to compute the
     -- close for a drawer THIS till owns. A peer reconciles its own.
     WHERE status IN ('closed', 'closed_unreconciled')
       AND sync_status = 'pending'
       AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(getDeviceConfig()?.device_id ?? null) as { id: string; status: string; closing_float: number | null; notes: string | null;
    declared_methods: string | null; closed_at: string | null; closed_by: string | null }[];
  if (!closed.length) return 0;
  // Till sync audit (F2): a drawer with an offline void or refund still to reach the cloud is not closed there yet —
  // the cloud would compute the close on the unvoided sale and show a shortage that is not there.
  const reversalWaits = (shiftId: string): boolean => {
    try {
      return !!db.prepare(`SELECT 1 FROM pending_reversals r JOIN orders o ON o.id = r.order_id
                            WHERE o.shift_id = ? AND r.sync_status = 'pending' LIMIT 1`).get(shiftId);
    } catch { return false; }   // a database before schema 61
  };

  let reconciled = 0;
  for (const shift of closed) {
    // Skip until every order from this shift is confirmed synced — closing
    // early would make the server read cash sales as short/zero and raise a
    // false variance (see the comment on pushLocalRecords for why).
    const pending = db.prepare(
      `SELECT COUNT(*) AS count FROM orders WHERE shift_id=? AND sync_status!='synced'`
    ).get(shift.id) as { count: number };
    if (pending.count > 0) continue;
    if (reversalWaits(shift.id)) continue;   // F2

    // A forced close has no count to report, so it cannot go through /close —
    // that route requires a closing_float, and inventing one would fabricate a
    // reconciliation nobody performed. /force-close records the same absence
    // server-side: expected_cash computed, closing_float and variance left NULL.
    const forced = shift.status === 'closed_unreconciled';
    const url = forced
      ? `${_serverUrl}/api/shifts/${shift.id}/force-close`
      : `${_serverUrl}/api/shifts/${shift.id}/close`;
    // Till sync audit (F3): the close as the till made it — when (the till's own clock, not the moment the push landed)
    // and by whom. A cloud before this ignores both.
    const when = { ...(shift.closed_at ? { closed_at: shift.closed_at } : {}), ...(shift.closed_by ? { closed_by: shift.closed_by } : {}) };
    const body = forced
      ? { reason: shift.notes?.trim() || 'Force-closed on terminal; no cash count was taken', ...when }
      : { closing_float: shift.closing_float, notes: shift.notes, ...when,
          // A365: the cashier's declaration of every method — the cloud then shows the shift as awaiting a manager.
          ...(shift.declared_methods ? { declared_methods: safeJson(shift.declared_methods) } : {}) };

    const doPost = () => syncFetch(url, {
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
      // Till sync audit (F3), with the cloud's contract: 2xx = closed now; 409 ALREADY_CLOSED = an earlier pass's close
      // landed and its answer was lost — both done. 404 = the cloud does NOT have this shift: it used to be taken as
      // done, and the drawer never existed on the cloud at all. Now the shift stays pending (re-armed), so the shift
      // push sends it (open) first and the close follows on the next pass. 5xx / out of reach: stays pending.
      //
      // 403 on a forced close means this staff token lacks manager rights.
      // Retrying will never fix that, but the shift must not be marked synced
      // either — it stays pending until a manager's session settles it, and the
      // message says so instead of repeating an opaque HTTP code every pass.
      const answer = res.ok ? null : await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (res.ok || (res.status === 409 && (answer as any)?.code === 'ALREADY_CLOSED')) {
        db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=? AND sync_status='pending'`).run(shift.id);
        reconciled++;
      } else if (res.status === 404) {
        db.prepare(`UPDATE shifts SET sync_status='pending' WHERE id=?`).run(shift.id);
        logLine('sync', `shift ${shift.id}: the cloud does not have this drawer - it is sent again, then closed`);
        errors.push('Shift close: the drawer is not on the cloud yet — it is sent again first.');
      } else if (forced && res.status === 403) {
        errors.push('A force-closed shift is waiting for a manager to sign in and sync it.');
      } else {
        errors.push(`Shift close: ${describeServerError(answer, res.status)}`);
      }
    } catch (err: any) {
      errors.push(`Shift close: ${err.message}`);
    }
  }
  return reconciled;
}

const safeJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };

/**
 * A365: send a manager's confirmation of a shift to the cloud — after the shift's close is there (sync_status
 * 'synced'). The till verified the manager's PIN; the cloud re-checks that person may confirm. 409 ALREADY_CONFIRMED
 * (an earlier pass landed, its answer lost) is done. A refusal that no retry fixes (403) is logged and parked; anything
 * else (incl. 404 from a cloud not yet deployed) stays pending for the next pass.
 */
async function pushShiftConfirmations(errors: string[]): Promise<number> {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT id, confirmed_methods, expected_methods, confirmed_by, confirmed_at, confirm_reasons
      FROM shifts
     -- own: a till sends the confirmations of the drawers it holds.
     WHERE confirm_sync = 'pending' AND confirmed_at IS NOT NULL AND sync_status = 'synced'
       AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(getDeviceConfig()?.device_id ?? null) as { id: string; confirmed_methods: string; expected_methods: string | null; confirmed_by: string; confirmed_at: string; confirm_reasons: string | null }[];
  let sent = 0;
  for (const r of rows) {
    const post = () => syncFetch(`${_serverUrl}/api/shifts/${r.id}/confirm`, {
      method: 'POST', headers: pushAuthHeaders(),
      body: JSON.stringify({
        confirmed_methods: safeJson(r.confirmed_methods), expected_methods: r.expected_methods ? safeJson(r.expected_methods) : undefined,
        confirmed_by: r.confirmed_by, confirmed_at: r.confirmed_at,
        ...(r.confirm_reasons ? { confirm_reasons: safeJson(r.confirm_reasons) } : {}),   // 0.6.27
      }),
    });
    try {
      let res = await post();
      if (res.status === 401 && await refreshStaffToken()) res = await post();
      const body = await res.json().catch(() => ({} as any));
      if (res.ok || (res.status === 409 && body?.code === 'ALREADY_CONFIRMED')) {
        db.prepare(`UPDATE shifts SET confirm_sync='synced' WHERE id=?`).run(r.id);
        sent++;
      } else if (res.status === 403) {
        // 403 only: the named person may not confirm, or the wrong till — no retry fixes that. A 404 is retried: a
        // cloud not yet deployed with /confirm answers 404 too, and parking then would lose the confirmation.
        db.prepare(`UPDATE shifts SET confirm_sync='refused' WHERE id=?`).run(r.id);
        logLine('sync', `A365 shift confirmation refused by the cloud (shift ${r.id}): ${describeServerError(body, res.status)}`);
        errors.push(`Shift confirmation: ${describeServerError(body, res.status)}`);
      } else {
        errors.push(`Shift confirmation: ${describeServerError(body, res.status)}`);
      }
    } catch (err: any) {
      errors.push(`Shift confirmation: ${err.message}`);
    }
  }
  if (sent) logLine('sync', `A365 pushed ${sent} shift confirmation(s)`);
  return sent;
}

/**
 * 0.6.30 (A336 stage 3): replay the voids and refunds this till made while it could not reach the cloud
 * (offlineReversal.ts). One request each, to the same routes the online path uses, carrying who approved it and when
 * (the cloud re-checks the approver and that this till holds the sale). Only once the sale itself is on the cloud — a
 * till's own sale after its order push; a web sale is the cloud's already. See replayOutcome for what each answer means.
 */
async function pushOfflineReversals(errors: string[]): Promise<number> {
  const db = getLocalDb();
  let rows: Array<{ id: string; order_id: string; kind: 'void' | 'refund'; reason: string; approved_by: string; done_by: string | null; approved_at: string }>;
  try {
    rows = db.prepare(`
      SELECT r.id, r.order_id, r.kind, r.reason, r.approved_by, r.done_by, r.approved_at
        FROM pending_reversals r JOIN orders o ON o.id = r.order_id
       -- own: a till replays what it did at its own counter.
       WHERE r.sync_status = 'pending' AND COALESCE(r.device_id,'') = COALESCE(?,'')
         AND (o.sync_status = 'synced' OR o.origin = 'web')
       ORDER BY r.approved_at ASC LIMIT 50
    `).all(getDeviceConfig()?.device_id ?? null) as any[];
  } catch { return 0; }   // a database before schema 61
  let sent = 0;
  for (const r of rows) {
    // A495: an offline replay is the TILL's record of what was done at its counter (who did it and who approved it are
    // in the body), so it goes under the till's own session — the cloud now refuses a replay under a person's token
    // (409 REPLAY_NEEDS_TILL_SESSION), which would hold every offline void/refund while someone is signed in.
    const post = () => syncFetch(`${_serverUrl}/api/orders/${encodeURIComponent(r.order_id)}/${r.kind}`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        reason: r.reason, offline_approved_by: r.approved_by, approved_at: r.approved_at,
        ...(r.done_by ? { offline_by: r.done_by } : {}),
      }),
    });
    try {
      let res = await post();
      if (res.status === 401 && await refreshAccessToken()) res = await post();
      const body = await res.json().catch(() => ({} as any));
      const outcome = replayOutcome(r.kind, res.status, body);
      if (outcome === 'done') {
        db.prepare(`UPDATE pending_reversals SET sync_status = 'synced', last_error = NULL WHERE id = ?`).run(r.id);
        sent++;
      } else if (outcome === 'refused') {
        const why = describeServerError(body, res.status);
        db.prepare(`UPDATE pending_reversals SET sync_status = 'refused', last_error = ? WHERE id = ?`).run(why, r.id);
        logLine('sync', `offline ${r.kind} refused by the cloud (order ${r.order_id}): ${why}`);
        errors.push(`Offline ${r.kind}: ${why}`);
      } else {
        db.prepare(`UPDATE pending_reversals SET last_error = ? WHERE id = ?`).run(describeServerError(body, res.status), r.id);
      }
    } catch (err: any) {
      errors.push(`Offline ${r.kind}: ${err?.message ?? err}`);
    }
  }
  if (sent) logLine('sync', `pushed ${sent} offline void/refund(s)`);
  return sent;
}

// Returns the currently open shift row (most recent), or null if none is open.
// Used to stamp shift_id onto offline orders for shift/EOD reporting (Phase C).
export function getOpenShift(): any | null {
  const db = getLocalDb();
  return db.prepare(
    // own: THE SELL GATE READS THIS. On a node, unscoped it returns the newest
    // open drawer anywhere at the branch — a shift belonging to a cashier at
    // another terminal — and the till would sell against it.
    `SELECT * FROM shifts WHERE status='open'
       AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY opened_at DESC LIMIT 1`
  ).get(getDeviceConfig()?.device_id ?? null) ?? null;
}

// ── Write a new order locally + deduct stock (delta merge) ──

export function createLocalOrder(orderPayload: any): string {
  // Phase 3: an office machine cannot sell. Same rule as openShift, same
  // layer — main is the door.
  if (!canSell(getDeviceConfig()?.device_role)) {
    throw new Error('This machine is a branch office/server — it cannot ring sales.');
  }
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
  // 0.6.27: a delivery fee only on a delivery (the sale screen sends one only with the client's 'delivery_fee' switch on).
  const deliveryFee = orderPayload.order_type === 'delivery' ? cleanDeliveryFee(orderPayload.delivery_fee) : 0;
  // What travels to the cloud is the same cleaned figure (its create_order_atomic reconciles the legs to total + tip + fee).
  if (deliveryFee > 0) orderPayload.delivery_fee = deliveryFee; else delete orderPayload.delivery_fee;
  // 0.6.33: a FREE delivery — the fee is still the rider's (paid from the drawer below), the customer paid none of it.
  const deliveryFree = isFreeDelivery(orderPayload.order_type, deliveryFee, orderPayload.delivery_free);
  if (deliveryFree) orderPayload.delivery_free = true; else delete orderPayload.delivery_free;

  db.transaction(() => {
    // A500: a sale is never refused over its bill number. A branch replica holding it is renamed (its copy here only);
    // a row of this till holding it (a stale reservation) gives this sale the next number. billNumber.ts.
    if (orderPayload.order_number) {
      const claim = claimOrderNumberForOwnSale(db, String(orderPayload.order_number), deviceId, getDeviceConfig()?.terminal_code);
      if (claim.renamedReplica) logLine('sale', `A500: bill ${orderPayload.order_number} was held by a branch copy of another till's sale (${claim.renamedReplica.id}) — that copy is now ${claim.renamedReplica.to} on this till`);
      if (claim.renumbered) logLine('sale', `A500: bill ${orderPayload.order_number} was already used on this till — this sale is ${claim.number}`);
      orderPayload.order_number = claim.number;
    }
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, delivery_person, status, subtotal, vat_amount, ctl_amount, discount_amount, tip_amount, total, covers, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, pump_id, notes, delivery_fee, delivery_free, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, session.business_id, orderPayload.branch_id, orderPayload.order_number,
      orderPayload.order_type ?? 'retail',
      orderPayload.order_type === 'delivery' ? (orderPayload.delivery_person ?? null) : null,
      orderPayload.subtotal, orderPayload.vat_amount,
      orderPayload.ctl_amount ?? 0,
      orderPayload.discount_amount ?? 0, orderPayload.tip_amount ?? 0,
      orderPayload.total,
      // Only dine-in has covers. A takeaway bag is one transaction, not one
      // diner, so forcing a headcount there would pollute APC with numbers that
      // mean nothing.
      Math.max(1, Number(orderPayload.covers) || 1),
      cashierId, shiftId,
      orderPayload.customer_id ?? null, orderPayload.customer_name ?? null, orderPayload.customer_phone ?? null,
      now, deviceId,
      // Pump attribution (fuel). Present in Postgres since migration 15 and in
      // SQLite since v45's migrateColumns — this write is the missing link.
      orderPayload.pump_id ?? null,
      // A367: the order's note, cleaned the same way the cloud cleans it (shared/orderNotes.ts).
      cleanNote(orderPayload.notes, ORDER_NOTE_MAX),
      deliveryFee,   // 0.6.27: on top of the bill, in the legs (like the tip); not in total
      deliveryFree ? 1 : 0,   // 0.6.33: free — the shop pays the rider; not in the legs
    );

    // 0.6.27 (the prospect's request 3): the rider is paid the delivery fee in CASH from this drawer, now — recorded as
    // a pay-out tied to the sale, so expected cash is the fee lower while the method the customer paid with carries it.
    // It syncs like any pay-out; voiding the sale puts it back (reverseRiderPayout). 0.6.33: a FREE delivery too — the
    // shop still pays the rider; only the customer did not.
    if (deliveryFee > 0) {
      const sh = db.prepare(`SELECT branch_id, cashier_id FROM shifts WHERE id=?`).get(shiftId) as { branch_id: string; cashier_id: string } | undefined;
      db.prepare(`
        INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, device_id, order_id, sync_status)
        VALUES (?, ?, ?, ?, 'float_out', ?, ?, ?, ?, ?, 'pending')
      `).run(uuid(), shiftId, sh?.branch_id ?? orderPayload.branch_id, cashierId ?? sh?.cashier_id ?? '', deliveryFee,
             riderPayoutReason(orderPayload.delivery_person, orderPayload.order_number), now, deviceId, orderId);
    }

    for (const item of orderPayload.items) {
      const itemId = uuid();
      db.prepare(`
        INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(itemId, orderId, item.product.id, item.product.name, item.product.categories?.name ?? null, item.unitPrice, item.quantity, item.lineTotal,
        item.course ?? null, item.fire_status === 'held' ? 'held' : 'fired', cleanNote(item.notes));

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
        // No floor (A81). The server's adjust_product_stock lets quantity go
        // negative — that is the A74 "sold beyond stock" state (a transfer
        // arrived and was sold before being received in the system). Clamping to
        // 0 here made the offline till disagree with the server until the next
        // pull and hid the oversell locally.
        const newQty = currentQty - item.quantity;

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
    `).run(orderId, JSON.stringify(
      // Built by the SHARED builder so this direct-to-cloud payload and the one
      // the branch node forwards for the same order (A19 relay) are identical —
      // the cloud keeps whichever arrives first, so they must not diverge.
      buildCloudOrderPayload(orderPayload, { shiftId, deviceId, orderId, createdAt: now, cashierId }),
    ), now);

    // A445: what offers took off this sale, and which — kept on the till (its reports, the reprint) and sent in the
    // payload as they are (the cloud checks them: POST /api/orders recomputes the offers the sale claims).
    const offerOff = Math.max(0, Number(orderPayload.offer_discount) || 0);
    if (offerOff > 0 && Array.isArray(orderPayload.offers) && orderPayload.offers.length) {
      db.prepare(`UPDATE orders SET offer_discount = ?, offers = ? WHERE id = ?`)
        .run(offerOff, JSON.stringify(orderPayload.offers.map((o: any) => ({ offer_id: String(o.offer_id ?? ''), name: String(o.name ?? ''), amount: Number(o.amount) || 0 }))), orderId);
    } else { delete orderPayload.offer_discount; delete orderPayload.offers; }

    // Keep the exact payload for a faithful reprint from Order History (A94).
    // Replayed through the same queueThermal path as the original, so the copy is
    // byte-identical and marked "Duplicate Print". Local-only, pruned to 200.
    db.prepare(`INSERT OR REPLACE INTO receipt_payloads (order_id, payload, created_at) VALUES (?, ?, ?)`)
      .run(orderId, JSON.stringify(orderPayload), now);
    db.prepare(`
      DELETE FROM receipt_payloads WHERE order_id NOT IN (
        SELECT order_id FROM receipt_payloads ORDER BY created_at DESC LIMIT 200
      )`).run();
  })();

  noteActivity('sale');   // A508: a sale (and its payment) — the till is in use
  return orderId;
}
