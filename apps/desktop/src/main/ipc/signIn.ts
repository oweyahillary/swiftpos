// IPC: staff PIN sign-in (cloud, branch server or this till), unlock, sign-out, and the idle lock.
// Registered from ipcHandlers.ts (D10).
import { isNodeRole } from '../deviceConfig';
import { assertPayload } from '../ipcValidate';
import { getLocalDb } from '../localDb';
import { logLine, authLog, expectedRefusal } from '../logFile';
import { readStaffTokens } from '../tokenStore';
import { isSessionRefusal } from '../sessionRecovery';   // A407
import { verifyPinOffline } from '../pinCache';
import { assertPinAllowed, recordPinFailure, notePinSuccess, PIN_CLOUD_BUSY } from '../pinAttempts';   // A494: one limiter for every local PIN check
import { setIdleSurface, clearIdleLock, suppressIdleLock } from '../idleMonitor';
import { preloadAnswer, startupSettled } from '../lowImpactStart';
import { tillSessionRefusedRecently, configureStaffSession, syncAll, syncPush, pullWebSales } from '../syncEngine';
import { getDeviceConfig, saveDeviceConfig } from '../deviceConfig';
import { adoptCloudShift } from '../shiftService';
import { verifyPinAtNodeClient } from '../nodeClient';
import { isUnreachableStatus, ForeignPageError } from '../authTransport';   // A529: ForeignPageError
import { holdOfflinePin, clearOfflinePin } from '../offlineSession';
import { verifyPinAtNode } from '../branchStaff';
import { refreshStaffRosterNow } from '../staffRoster';
import os from 'os';
import { type IpcShared } from './shared';

/** Staff PIN sign-in, unlock and sign-out, and the idle lock. */
export function registerSignInHandlers(ctx: IpcShared) {
  const { handle, tillFetch, withinMs, persistCloudSignIn, verifyPinBody, tryUpgradeOfflineSession } = ctx;

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

  handle('auth:verifyPin', async (_event, payload) => {
    // D7: validate at the boundary. A malformed payload throws a clear error the
    // renderer already catches, instead of destructuring undefined mid-handler.
    const { pin, branch_id } = assertPayload<{ pin: string; branch_id: string }>(
      { pin: { t: 'string', min: 1 }, branch_id: { t: 'string', min: 1 } }, payload);
    // A494: too many wrong PINs on this till — nothing is checked until the lockout ends. A554: an expected answer.
    try { assertPinAllowed(); } catch (e) { throw expectedRefusal(e as Error); }
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
      throw expectedRefusal(new Error(nodeSaidNo ?? (v.reason === 'no_match' ? 'Invalid PIN' : verdict.message)));   // A554
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
      // A529: an answer that was not the cloud's (no X-ZapTill-Server — a suspended Render service, a Cloudflare page, a
      // captive portal) arrives here as ForeignPageError: no connection, whatever its status — never "Invalid PIN".
      logLine('pin', netErr instanceof ForeignPageError
        ? `HTTP ${netErr.status} at sign-in was not the cloud's page (no X-ZapTill-Server) - treating as unreachable, trying the local authority`
        : `server unreachable at sign-in (${netErr?.message ?? netErr}) - trying the local authority`);
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
      throw expectedRefusal(new Error(data.error ?? 'Invalid PIN'));   // A554: a wrong PIN is an answer, not an error
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
}
