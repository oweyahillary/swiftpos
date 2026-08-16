/**
 * pinCache — lets a cashier sign in when the internet is down.
 *
 * WHY
 * ---
 * Everything else on this till works offline: the catalogue is local, orders
 * queue locally, shifts open locally. The one server-gated thing was the DOOR.
 * `auth:verifyPin` called /api/auth/verify-pin and threw on failure, and the
 * local `users` table carried no hash to check against, so a line fault meant
 * nobody could start a shift.
 *
 * WHAT IS CACHED, AND WHAT IS NOT
 * -------------------------------
 * Only staff who have signed in ON THIS TERMINAL while online. Three cashiers,
 * not the whole roster — a stolen till exposes what that till actually used.
 *
 * NEVER `override_pin_hash`. That PIN authorises voids, discounts past the
 * floor and refunds, and it is the only credential worth stealing off a till,
 * because the thief already has the till. Elevated actions stay online, or wait
 * for a manager on a connected terminal.
 *
 * Only bcrypt hashes. auth.ts also accepts a legacy format; a legacy user
 * upgrades on their next ONLINE sign-in and cannot work offline until then.
 * Caching a weaker credential to widen offline coverage is the wrong trade.
 *
 * PROTECTION, HONESTLY
 * --------------------
 * The hash is wrapped with Electron safeStorage — DPAPI on Windows, bound to
 * machine and user. That defeats a copied .db, a stolen backup and a pulled
 * disk. It does NOT defeat code running as the app user on that machine, so it
 * is only as strong as the Windows account: a till that auto-logs-in gives an
 * attacker who powers it on exactly the access the app has. PHASE2-3-DESIGN
 * §2d says the same thing about the database key, and the answer is the same —
 * a Windows password, and eventually BitLocker.
 *
 * A 4-6 digit PIN over bcrypt is a small space. Anyone who defeats the wrap can
 * recover the PINs. The mitigations are scope (this terminal only), content (no
 * override PIN) and time (the expiry below) — not the hash.
 *
 * If safeStorage is unavailable we cache NOTHING and offline sign-in is simply
 * unavailable. Failing closed beats writing credentials in the clear.
 */

import { safeStorage } from 'electron';
import bcrypt from 'bcryptjs';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { logLine } from './logFile';

/**
 * How long a cached credential stays usable without the server being reached.
 *
 * Bounds a till that has been stolen, or quietly retired and left in a back
 * room. Long enough for a bad week of connectivity; short enough that a
 * terminal off the network for a fortnight stops being a way in.
 */
export const PIN_CACHE_TTL_DAYS = 14;

export interface CachedStaff {
  staffId: string;
  name: string;
  roleName: string | null;
  permissions: unknown;
}

function canWrap(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Store one user's credential after a SUCCESSFUL ONLINE sign-in.
 *
 * Called only from the online path, so the server has just confirmed both the
 * PIN and that it is unique across the business. Silently does nothing when the
 * hash is not bcrypt or the platform cannot wrap it — offline sign-in is a
 * convenience, and it must never be the reason a credential lands in the clear.
 */
export function cacheStaffCredential(
  staff: CachedStaff,
  pinHash: string | null | undefined,
  branchId: string,
): void {
  if (!pinHash || !pinHash.startsWith('$2')) return;      // bcrypt only
  if (!canWrap()) {
    logLine('pin', 'safeStorage unavailable - not caching; offline sign-in stays off');
    return;
  }
  try {
    const wrapped = safeStorage.encryptString(pinHash).toString('base64');
    getLocalDb().prepare(`
      INSERT INTO staff_pin_cache (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(staff_id) DO UPDATE SET
        name=excluded.name, role_name=excluded.role_name, branch_id=excluded.branch_id,
        permissions=excluded.permissions, pin_hash_enc=excluded.pin_hash_enc,
        cached_at=excluded.cached_at
    `).run(
      staff.staffId, staff.name, staff.roleName ?? null, branchId,
      JSON.stringify(staff.permissions ?? {}), wrapped, new Date().toISOString(),
    );
  } catch (err: any) {
    logLine('pin', `could not cache credential: ${err?.message ?? err}`);
  }
}

export type OfflineVerdict =
  | { ok: true; staff: CachedStaff }
  | { ok: false; reason: 'no_cache' | 'expired' | 'no_match' | 'ambiguous' | 'unavailable'; message: string };

/**
 * Verify a PIN against the cache. ONLY the caller decides when this is allowed
 * to run — it must be a network failure, never a rejection. See ipcHandlers.
 *
 * Scans every cached entry rather than stopping at the first match, and refuses
 * on two, exactly as the server does. A shared PIN books one cashier's sales to
 * another, and the till has no more right to guess than the server does.
 */
export function verifyPinOffline(pin: string, branchId: string): OfflineVerdict {
  if (!canWrap()) {
    return { ok: false, reason: 'unavailable',
      message: 'Offline sign-in is not available on this machine. Reconnect to sign in.' };
  }

  let rows: any[];
  try {
    rows = getLocalDb().prepare(
      `SELECT * FROM staff_pin_cache WHERE branch_id = ?`).all(branchId) as any[];
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    return { ok: false, reason: 'no_cache',
      message: 'No connection, and this terminal has no saved sign-in. Sign in once while online.' };
  }

  const cutoff = Date.now() - PIN_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  // A till with a branch node configured NEVER time-expires its cache (A17,
  // owner's call): a remote site that relies on its node must not be locked out
  // by a clock — "an expiry date is a time bomb". Revocation for such a till is
  // the node's roster (wholesale-replaced each pull), not this TTL. Only a
  // STANDALONE till with no node keeps the fortnight bound, since it has no other
  // authority that could ever retire a credential.
  const nodeConfigured = !!getDeviceConfig()?.node_url;
  const fresh = nodeConfigured ? rows : rows.filter(r => Date.parse(r.cached_at) >= cutoff);
  if (fresh.length === 0) {
    return { ok: false, reason: 'expired',
      message: `Saved sign-in expired after ${PIN_CACHE_TTL_DAYS} days offline. Reconnect to sign in.` };
  }

  const matches: any[] = [];
  for (const row of fresh) {
    let hash: string;
    try {
      hash = safeStorage.decryptString(Buffer.from(row.pin_hash_enc, 'base64'));
    } catch {
      // Wrapped on another machine or another Windows account. Not an error —
      // the credential is simply unusable here.
      logLine('pin', `cached credential for ${row.staff_id} could not be unwrapped on this machine`);
      continue;
    }
    if (bcrypt.compareSync(pin, hash)) matches.push(row);
  }

  if (matches.length > 1) {
    logLine('pin', `offline sign-in refused: ${matches.length} cached staff share this PIN`);
    return { ok: false, reason: 'ambiguous',
      message: 'This PIN is shared by more than one staff member. Ask a manager to reset it.' };
  }
  if (matches.length === 0) {
    return { ok: false, reason: 'no_match', message: 'Invalid PIN' };
  }

  const m = matches[0];
  logLine('pin', `offline sign-in: ${m.name}`);
  let permissions: unknown = {};
  try { permissions = JSON.parse(m.permissions ?? '{}'); } catch { /* default */ }
  return { ok: true, staff: { staffId: m.staff_id, name: m.name, roleName: m.role_name, permissions } };
}

/** Cleared on logout and on wipe, so a decommissioned till keeps no way in. */
export function clearPinCache(): void {
  try {
    getLocalDb().prepare(`DELETE FROM staff_pin_cache`).run();
  } catch { /* nothing to clear */ }
}
