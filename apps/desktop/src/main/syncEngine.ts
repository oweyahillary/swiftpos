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
import { logLine, describeResponse, getLogPath } from './logFile';
import { readSessionTokens, readStaffTokens, writeSessionTokens, writeStaffTokens } from './tokenStore';
import { getDeviceConfig, saveDeviceConfig, getServerUrl, canSell, isNodeRole } from './deviceConfig';
import { selectPushRefresh } from './authTransport';
import { storeBranchStaff } from './branchStaff';
import { refreshTechConfig } from './techService';
import { hasNode, pushRowsToNode, measureNodeDrift, refreshViaNode, fetchReferenceFromNode, fetchRosterFromNode } from './nodeClient';
import { unpackRosterSnapshot } from './rosterSnapshot';
import { unpackNodeBundle, numOrNull, type AcquiredReference } from './referenceBundle';
import { buildCloudOrderPayload } from './peerRelay';
import {
  fillNodeOutbox, takeNodeQueueBatch, markNodeQueueDelivered, markNodeQueueFailed,
  nodeQueueDepth,
} from './nodeIngest';
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
};

/**
 * The tables /api/sync/push can reject a row from. The server names one of these
 * in every `rejected[].table`; the client refuses to act on anything else rather
 * than guessing, because guessing "shifts" is exactly how a refused trading day
 * came to be marked synced and lost. Keep in step with the server's `rejected`
 * union in apps/server/src/routes/sync.ts.
 */
type RejectableTable = 'shifts' | 'business_days' | 'float_transactions' | 'expenses';

let _serverUrl   = '';
let _accessToken  = '';   // owner/device token — used for catalogue pull
let _refreshToken = '';
let _staffToken   = '';   // per-shift staff token — used for order push
let _staffRefresh = '';
let _isSyncing    = false;
// A177: when the current sync started, so a wedged _isSyncing can't block forever.
let _syncStartedAt = 0;
// A sync running longer than this is presumed wedged and no longer blocks a new
// pass. Generous: a legitimate pass of many timed-out fetches must not trip it.
const SYNC_STALE_MS = 3 * 60_000;

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
function syncFetch(url: string, opts: any = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`sync fetch timed out after ${SYNC_FETCH_TIMEOUT_MS}ms`)),
    SYNC_FETCH_TIMEOUT_MS);
  return globalThis.fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
// A20: last roster version this peer applied, in-memory. Skips re-wrapping an
// unchanged roster every pull; on restart it re-applies once, which is harmless.
let _lastRosterVersion = '';

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
// meantime. Anything holding the owner token must be able to refresh and retry.
/**
 * SINGLE-FLIGHT. Three call sites reach this — ownerFetch (the PIN pad), the
 * sync loop, and the order push — and they overlap at boot.
 *
 * Refresh tokens ROTATE: auth.ts revokes the consumed one before issuing the
 * replacement. So two concurrent refreshes present the same token, one wins,
 * and the loser is handed a 401 for a token that was valid when it read it.
 * That is not an auth failure, it is a race — but it surfaces as "signed out
 * again", and offline it is worse, because there is no way to sign back in.
 *
 * While a refresh is in flight every other caller awaits the same promise.
 */
let _refreshInFlight: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = doRefreshAccessToken().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

// Reads the persisted refresh token. Also the recovery path on a 401: the
// in-memory copy can lag what is on disk, and presenting a stale token to a
// rotating endpoint is an unnecessary logout.
function persistedRefresh(): string {
  return readSessionTokens().refreshToken;
}

async function doRefreshAccessToken(): Promise<boolean> {
  // The in-memory token is empty until configureSyncEngine() has run, which
  // happens on auth:getSession. Don't depend on that ordering — a handler can
  // fire before it. Fall back to whatever is persisted.
  let refresh = _refreshToken || persistedRefresh();
  if (!refresh) return false;

  // A160: when the cloud can't be reached (thrown) or answers a 5xx (down but
  // responding), a peer refreshes THROUGH its node instead of falling to a login.
  // The node brokers the refresh upstream and hands back a fresh pair — so an
  // offline peer keeps its session as long as the node has internet. A clean 401
  // (revoked) is NOT retried here: the node returns null and the session ends.
  const tryNodeRefresh = async (): Promise<boolean> => {
    if (!hasNode()) return false;
    const pair = await refreshViaNode(refresh);
    if (!pair) return false;
    _accessToken  = pair.accessToken;
    _refreshToken = pair.refreshToken;
    writeSessionTokens({ token: pair.accessToken, refreshToken: pair.refreshToken });
    clearInboundFailure('auth');
    logLine('auth', 'access token refreshed via the branch node (cloud unreachable)');
    return true;
  };

  const attempt = async (token: string) => {
    const res = await syncFetch(`${_serverUrl || getServerUrl()}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    return res;
  };

  try {
    let res = await attempt(refresh);

    // One retry, and only when disk holds a DIFFERENT token from the one just
    // rejected — that means something rotated it while we were holding a stale
    // copy, so the rejection is bookkeeping rather than a revoked session.
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
      // A160: a 5xx means the cloud answered but can't serve — treat it like
      // unreachable and let the node broker the refresh before giving up.
      if (res.status >= 500 && await tryNodeRefresh()) return true;
      // Rotation means a revoked token can never be recovered: the owner must
      // sign in again, and with no internet they cannot. Recording it is the
      // difference between "it logged me out again" and knowing which refresh
      // was rejected and when.
      noteInboundFailure('auth', `owner token refresh failed: ${await describeResponse(res)}`);
      return false;
    }
    const { accessToken, refreshToken } = await res.json();
    _accessToken  = accessToken;
    _refreshToken = refreshToken;
    // Persist immediately. The server has ALREADY revoked the old token by the
    // time this response arrives, so every instruction between here and the
    // write is a window in which a crash strands the till holding a dead token.
    // Client code cannot close that window — only a server-side grace period
    // can (register D13, part 3). Keep this write first and unconditional.
    writeSessionTokens({ token: accessToken, refreshToken });
    clearInboundFailure('auth');
    return true;
  } catch (err: any) {
    // A160: the cloud is unreachable (DNS/refused/timeout). Before giving up,
    // ask the node to broker the refresh — only the node needs internet.
    if (await tryNodeRefresh()) return true;
    noteInboundFailure('auth', `owner token refresh error: ${err?.message ?? err}`);
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

async function doRefreshStaffToken(): Promise<boolean> {
  let refresh = _staffRefresh || persistedStaffRefresh();
  if (!refresh) return false;
  const attempt = (token: string) => syncFetch(`${_serverUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      noteInboundFailure('auth', `staff token refresh failed: ${await describeResponse(res)}`);
      return false;
    }
    const { accessToken, refreshToken } = await res.json();
    _staffToken   = accessToken;
    _staffRefresh = refreshToken ?? _staffRefresh;
    writeStaffTokens({ token: _staffToken, refreshToken: _staffRefresh });
    clearInboundFailure('auth');
    return true;
  } catch (err: any) {
    noteInboundFailure('auth', `staff token refresh error: ${err?.message ?? err}`);
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────

export async function syncAll(): Promise<{ pulled: boolean; pushed: number; errors: string[] }> {
  if (!_accessToken || !_serverUrl) return { pulled: false, pushed: 0, errors: ['Not configured'] };
  if (!isOnline()) return { pulled: false, pushed: 0, errors: ['Offline'] };
  if (_isSyncing && Date.now() - _syncStartedAt < SYNC_STALE_MS) return { pulled: false, pushed: 0, errors: ['Sync already in progress'] };

  _isSyncing = true;
  _syncStartedAt = Date.now();
  const errors: string[] = [];
  let pulled = false;
  let pushed = 0;

  try {
    // Refresh the DEVICE token before it expires rather than after (A51). The
    // reactive branch below is untouched and stays the backstop — this only
    // stops the 10-minute tick colliding with the 15-minute lifetime and
    // 401'ing every second pull by construction.
    await refreshDeviceTokenIfExpiring();

    pulled = await pullCatalogue();
    // If pull returns false it may be a 401 — try refreshing once
    if (!pulled && _refreshToken) {
      const refreshed = await refreshAccessToken();
      if (refreshed) pulled = await pullCatalogue();
    }
    // A114: refresh the branch reveal code + tech public key on every online
    // sync, not just at owner login (which the till UI can't reach). This is what
    // lets a cashier-only till pick up a freshly-generated/backfilled reveal code.
    // Best-effort — a failure here must never affect the sync result.
    try { await refreshTechConfig(_accessToken); } catch { /* non-fatal */ }
    await pushLocalRecords(errors);     // shifts/floats/expenses first (FK parents)
    await pushBranchPriceEdits(errors); // manager's branch-price edits (independent)
    pushed = await pushPendingOrders(errors);
    await reconcileClosedShifts(errors); // close server-side now this shift's orders are in (C6)
    await pushToNode(errors);            // branch LAN replica — independent destination
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
  if (_isSyncing && Date.now() - _syncStartedAt < SYNC_STALE_MS) return { pushed: 0, errors: ['Sync already in progress'] };

  _isSyncing = true;
  _syncStartedAt = Date.now();
  const errors: string[] = [];
  let pushed = 0;
  try {
    await pushLocalRecords(errors);     // shifts/floats/expenses first (FK parents)
    await pushBranchPriceEdits(errors); // manager's branch-price edits (independent)
    pushed = await pushPendingOrders(errors);
    await reconcileClosedShifts(errors); // close server-side now this shift's orders are in (C6)
    await pushToNode(errors);            // branch LAN replica — independent destination
  } catch (err: any) {
    errors.push(err.message ?? 'Unknown sync error');
  } finally {
    _isSyncing = false;
  }
  return { pushed, errors };
}

export function getSyncStatus(): {
  online: boolean; pendingCount: number; failedCount: number;
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
} {
  const db = getLocalDb();
  const pending = db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending'`).get() as { count: number };
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
  const localPending = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM shifts             WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM float_transactions WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM expenses           WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) +
      (SELECT COUNT(*) FROM business_days      WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(:dev,'')) AS count
  `).get({ dev: ownDevice }) as { count: number };
  return {
    online: isOnline(),
    pendingCount: pending.count + localPending.count,
    failedCount: failed.count,
    failedReason: failureRow?.last_error ?? undefined,
    failedSince: failureRow?.since ?? undefined,
    pullError: currentInboundFailure()?.message ?? undefined,
    pullErrorSince: currentInboundFailure()?.since ?? undefined,
    logPath: getLogPath(),
    nodeBacklog: hasNode() ? nodeQueueDepth() : undefined,
  };
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
// other. The status field reported "owner token refresh failed" while the actual
// cause was BRANCH_NOT_LICENSED on the pull — a confident wrong message, which
// is the thing this whole change exists to stop.
const _inbound = new Map<string, { message: string; since: string }>();

// Order matters when both are set. A dead token explains a dead catalogue pull;
// a dead catalogue pull does not explain a dead token. Report the cause, not the
// symptom.
const SCOPE_PRIORITY = ['auth', 'sync'];

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
  if (Array.isArray(c.kitchenExclusions)) saveDeviceConfig({ kitchen_exclusions: JSON.stringify(c.kitchenExclusions) });
}

async function pullCatalogue(): Promise<boolean> {
  const db = getLocalDb();
  const now = new Date().toISOString();

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
  let stations: any[] | null = null;
  let variantGroups: any[] = [], variantOptions: any[] = [];
  let modifierGroups: any[] = [], modifierOptions: any[] = [];
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
  const nodeBundle = await fetchReferenceFromNode();
  if (nodeBundle) {
    const r: AcquiredReference = unpackNodeBundle(nodeBundle);
    ({ products, categories, comboItems, paymentMethods, stations,
       variantGroups, variantOptions, modifierGroups, modifierOptions,
       stockLevels, users, diningTables, tablesFetched, pumps, pumpsFetched } = r);
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
    if (!res.ok) {
      noteInboundFailure('sync', `catalogue pull failed: ${await describeResponse(res)}`);
      return false;
    }

    const _j = await res.json();
    clearInboundFailure('sync');
    products = _j.products; categories = _j.categories;
    comboItems = _j.comboItems; paymentMethods = _j.paymentMethods ?? null;
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
    });

    // Fetch variants + modifiers (per product — the N in the cloud's 7 + N).
    for (const p of products.filter((p: any) => p.has_variants)) {
      const vRes = await syncFetch(`${_serverUrl}/api/variants/groups?product_id=${p.id}`, { headers: authHeaders() });
      if (vRes.ok) {
        const groups = await vRes.json();
        for (const g of groups) {
          variantGroups.push(g);
          variantOptions.push(...(g.variant_options ?? []));
        }
      }
    }

    for (const p of products.filter((p: any) => p.has_modifiers)) {
      const mRes = await syncFetch(`${_serverUrl}/api/modifiers/groups?product_id=${p.id}`, { headers: authHeaders() });
      if (mRes.ok) {
        const groups = await mRes.json();
        for (const g of groups) {
          modifierGroups.push(g);
          modifierOptions.push(...(g.modifier_options ?? []));
        }
      }
    }

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
  })();

  // PHASE5 §4b (A17): a NODE also pulls the branch staff roster so it can
  // authenticate cashiers offline. Node-only, best-effort, and AFTER the
  // catalogue is safely stored — a failure here must never fail the catalogue
  // pull. The endpoint 403s a non-node device, which is the correct outcome for
  // a plain till and is simply ignored.
  if (isNodeRole(getDeviceConfig()?.device_role)) {
    try {
      const rosterRes = await syncFetch(`${_serverUrl || getServerUrl()}/api/pos/branch-staff`, { headers: authHeaders() });
      if (rosterRes.ok) {
        const { branch_id: rBranch, staff } = await rosterRes.json();
        if (rBranch && Array.isArray(staff)) storeBranchStaff(rBranch, staff);
      }
    } catch { /* the node keeps its existing roster; next pull retries */ }
  } else if (hasNode()) {
    // A20: a PEER pulls the roster from its NODE so a promotion can open the shop.
    // Best-effort, after the catalogue, and guarded twice: fetchRosterFromNode
    // returns null on any node problem (keep the local roster), and
    // unpackRosterSnapshot refuses an empty/pinless snapshot (never wipe → never
    // lock the shop out). Version-skip avoids re-wrapping the roster every pull.
    try {
      const snapshot = await fetchRosterFromNode();
      if (snapshot) {
        const decision = unpackRosterSnapshot(snapshot);
        if (decision.apply && decision.version !== _lastRosterVersion) {
          storeBranchStaff(decision.branchId, decision.roster);
          _lastRosterVersion = decision.version;
          logLine('sync', `roster pulled from node — ${decision.roster.length} staff`);
        }
      }
    } catch { /* keep the current roster; next pull retries */ }
  }

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
    SELECT id, shift_id, branch_id, cashier_id, type, amount, reason, created_at
    FROM float_transactions WHERE sync_status='pending'
      AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(ownDevice) as any[];
  const expenses = db.prepare(`
    SELECT id, business_id, branch_id, expense_category_id, description, amount,
           paid_by, expense_date, shift_id, created_at
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

  if (!shifts.length && !floats.length && !expenses.length && !business_days.length) return 0;

  const doPost = () => syncFetch(`${_serverUrl}/api/sync/push`, {
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
             t === 'float_transactions' || t === 'expenses' ? t : null;
    };

    // Rejected ids per table. Keyed by table because two rows in different
    // tables can carry the same id in principle, and because every mark-synced
    // loop below has to consult its OWN table's set — not one shared set.
    const rejectedByTable: Record<RejectableTable, Set<string>> = {
      shifts: new Set(), business_days: new Set(),
      float_transactions: new Set(), expenses: new Set(),
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
      const stmt = {
        shifts:             markWithNote('shifts'),
        business_days:      markWithNote('business_days'),
        float_transactions: db.prepare(`UPDATE float_transactions SET sync_status='conflict' WHERE id=?`),
        expenses:           db.prepare(`UPDATE expenses SET sync_status='conflict' WHERE id=?`),
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
            stmt[t].run(r.id);
          }
        }
      })();

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
    const openShiftIds = shifts
      .filter(s => s.status !== 'closed' && !rejectedByTable.shifts.has(s.id))
      .map(s => s.id);
    const markShift = db.prepare(`UPDATE shifts SET sync_status='synced' WHERE id=?`);
    const markFloat = db.prepare(`UPDATE float_transactions SET sync_status='synced' WHERE id=?`);
    const markExp   = db.prepare(`UPDATE expenses SET sync_status='synced' WHERE id=?`);
    const markDay   = db.prepare(`UPDATE business_days SET sync_status='synced' WHERE id=?`);
    // Every loop excludes its own table's rejections. Anything absent from
    // `rejected` is still treated as accepted — that design constraint is
    // unchanged and is why the routing above has to be right.
    db.transaction(() => {
      for (const id of openShiftIds) markShift.run(id);
      for (const f of floats)        if (!rejectedByTable.float_transactions.has(f.id)) markFloat.run(f.id);
      for (const e of expenses)      if (!rejectedByTable.expenses.has(e.id))           markExp.run(e.id);
      for (const d of business_days) if (!rejectedByTable.business_days.has(d.id))      markDay.run(d.id);
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
  let triedAuthRefresh = false;  // refresh once per sync pass (A168)

  // S3: move BOTH rows to 'synced' in one transaction, so a crash between the
  // two writes can never leave sync_queue and orders disagreeing (queue synced
  // while the order still reads pending, or vice versa). Prepared once, reused
  // per row; the same statements the two success branches ran inline before.
  const _markQueueSynced = db.prepare(`UPDATE sync_queue SET status='synced', attempts=attempts+1 WHERE id=?`);
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

  for (const row of pending) {
    try {
      const doPost = () => syncFetch(`${_serverUrl}/api/orders`, {
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

      // A168: on a 401, refresh the token THIS push is actually sending, and
      // only that one. pushAuthHeaders() sends `_staffToken || _accessToken`, so
      // an online shift pushes under the staff token and an offline shift (no
      // staff token) pushes under the owner token. The server sets
      // `cashier_id = req.userId` (the token subject, orders.ts), so re-pushing a
      // STAFF order under the owner token would reattribute the sale to the owner
      // — never fall through. Mirror the selection instead: refresh whichever
      // token was sent. This closes the gap where an offline order's owner-token
      // 401 was met with refreshStaffToken() (nothing to refresh) and the order
      // sat pending; the price path recovers via refreshAccessToken() but that
      // path isn't cashier-attributed, so its `staff || owner` fallthrough is
      // safe there and would NOT be safe here.
      if (res.status === 401 && !triedAuthRefresh) {
        triedAuthRefresh = true;
        const refreshed = selectPushRefresh(_staffToken) === 'staff'
          ? await refreshStaffToken()
          : await refreshAccessToken();
        if (refreshed) res = await doPost();
      }

      if (res.ok) {
        // res.ok covers both a fresh create (201) and an idempotent duplicate
        // (200 with { duplicate: true }) — both mean the server has this order,
        // so the local row is safely marked synced. A lost first response that
        // caused this retry therefore resolves correctly instead of duplicating.
        markSynced(row.id, row.order_id);
        pushed++;
      } else if (res.status === 409) {
        // Defensive: some deployments may signal an existing record with 409.
        // That still means the server holds the order — treat as synced.
        markSynced(row.id, row.order_id);
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
      logLine('sync', `order push failed: ${err.message ?? err}`); // A177: push failures now reach the durable log too (were DB-only)
      // A177: a thrown fetch means the server is unreachable/timed out — the rest
      // of this batch will fail identically. Stop now rather than burn one full
      // timeout per remaining order; they retry next pass.
      break;
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
  if (!hasNode()) return 0;

  try {
    fillNodeOutbox();
  } catch (err: any) {
    errors.push(`Branch replication: ${err.message}`);
    return 0;
  }

  const batch = takeNodeQueueBatch(200);
  if (!batch.length) return 0;

  // Group by table, remembering which queue row each payload came from so the
  // node's per-row verdict can be applied to the right one.
  const tables: Record<string, any[]> = {};
  const queueIdByRow = new Map<string, number>();
  for (const q of batch) {
    (tables[q.table_name] ??= []).push(JSON.parse(q.payload));
    queueIdByRow.set(`${q.table_name}:${q.row_id}`, q.id);
  }

  let results: Record<string, any> | null;
  try {
    results = await pushRowsToNode(tables);
  } catch (err: any) {
    // The node ANSWERED and refused. Escalate, so the reason reaches a human
    // rather than becoming a count that never clears.
    markNodeQueueFailed(batch.map(q => q.id), err.message ?? 'node refused', true);
    errors.push(`Branch replication: ${err.message}`);
    return 0;
  }

  if (results === null) {
    // The node did not answer. Retry indefinitely without escalating — a branch
    // server rebooting, or a shop with the node switched off overnight, must not
    // exhaust an attempt budget and mark a day's cash records 'failed'.
    markNodeQueueFailed(batch.map(q => q.id), 'branch server unreachable', false);
    return 0;
  }

  const delivered: number[] = [];
  const refused: Array<{ id: number; reason: string }> = [];

  for (const [table, res] of Object.entries(results)) {
    const rejectedIds = new Map<string, string>(
      (res?.rejected ?? []).map((r: any) => [String(r.id), String(r.reason)]),
    );
    for (const row of tables[table] ?? []) {
      const qid = queueIdByRow.get(`${table}:${row.id}`);
      if (qid === undefined) continue;
      const reason = rejectedIds.get(String(row.id));
      // A row rejected on its merits (wrong branch, no seq, a peer clash) will be
      // rejected identically every pass. Escalating it is what puts the node's own
      // words in front of somebody, instead of a queue depth that only grows.
      if (reason) refused.push({ id: qid, reason });
      else delivered.push(qid);
    }
  }

  markNodeQueueDelivered(delivered);
  for (const r of refused) markNodeQueueFailed([r.id], r.reason, true);
  if (refused.length) {
    errors.push(
      refused.length === 1
        ? `The branch server refused a record: ${refused[0].reason}`
        : `The branch server refused ${refused.length} records: ${refused[0].reason}`,
    );
  }

  // Clock drift. Advisory — the till keeps trading either way. business_date
  // comes from each terminal's own clock, so two tills disagreeing across
  // midnight split one evening's takings over two trading days, and no report
  // will ever reconcile them.
  const drift = await measureNodeDrift();
  if (drift !== null && Math.abs(drift) > 120_000) {
    const mins = Math.round(Math.abs(drift) / 60_000);
    errors.push(
      `This till's clock is ${mins} minute(s) ${drift > 0 ? 'ahead of' : 'behind'} the branch server. ` +
      'Correct it before the next day close — trading days are dated from each till\'s own clock.',
    );
  }

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
     -- own: reconciling a closed shift means asking the server to compute the
     -- close for a drawer THIS till owns. A peer reconciles its own.
     WHERE status IN ('closed', 'closed_unreconciled')
       AND sync_status = 'pending'
       AND COALESCE(device_id,'') = COALESCE(?,'')
  `).all(getDeviceConfig()?.device_id ?? null) as { id: string; status: string; closing_float: number | null; notes: string | null }[];
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

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, delivery_person, status, subtotal, vat_amount, ctl_amount, discount_amount, tip_amount, total, covers, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, pump_id, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
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

  return orderId;
}
