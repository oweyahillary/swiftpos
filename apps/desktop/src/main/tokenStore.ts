/**
 * tokenStore — the session credentials on disk, wrapped at rest. Register D5.
 *
 * WHAT WAS WRONG
 * --------------
 * `session.token` / `session.refresh_token` and the staff equivalents were
 * plaintext in swiftpos.db. The refresh token is the durable one: it is valid
 * for 30 days and renews itself, so anyone who copied the file off a till —
 * a USB stick, a backup, a support ticket with the .db attached — held working
 * owner-scoped access long after the copy.
 *
 * WHAT THIS DOES
 * --------------
 * Values are wrapped with Electron safeStorage (DPAPI on Windows, machine+user
 * bound) into `*_enc` columns. The plaintext columns remain in the schema and
 * are read as a fallback, so an existing install keeps working and upgrades
 * itself on the next write.
 *
 * THE MIGRATION RULE — why plaintext is not cleared eagerly
 * --------------------------------------------------------
 * A naive version of this change is itself a lockout: if the wrap succeeds and
 * the unwrap later fails, the till has destroyed the only copy of a credential
 * it cannot re-obtain — and OFFLINE the owner cannot sign in again to replace
 * it. Rule: the plaintext is cleared only after the wrapped value has been read
 * back and compared IN THE SAME WRITE. If that round trip fails for any reason,
 * the plaintext stays and the till keeps working exactly as before.
 *
 * Same reasoning as pinCache.ts: where wrapping is not possible, carry on
 * unwrapped rather than break the till. This is defence in depth, not a gate.
 *
 * HONEST LIMIT
 * ------------
 * DPAPI is machine+user bound, so this defeats a copied .db, a stolen backup
 * and a pulled disk. It does NOT defeat code running as the app user on that
 * machine — a till that auto-logs-in gives an attacker who powers it on the
 * same access the app has. PHASE2-3-DESIGN §2d says the same about the database
 * key and reaches the same answer: a Windows password, then BitLocker.
 */

import { safeStorage } from 'electron';
import { getLocalDb } from './localDb';
import { logLine } from './logFile';

export interface TokenPair { token: string; refreshToken: string }

const EMPTY: TokenPair = { token: '', refreshToken: '' };

function canWrap(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function wrap(value: string): string | null {
  if (!value) return null;
  try {
    const sealed = safeStorage.encryptString(value).toString('base64');
    // Prove the round trip BEFORE any caller is told this succeeded. Writing a
    // value we cannot read back is how a credential is lost rather than hidden.
    if (safeStorage.decryptString(Buffer.from(sealed, 'base64')) !== value) return null;
    return sealed;
  } catch {
    return null;
  }
}

function unwrap(sealed: string | null | undefined): string {
  if (!sealed) return '';
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
  } catch {
    // Wrapped by another Windows account or on another machine. Not fatal —
    // the plaintext fallback below may still carry a usable value.
    return '';
  }
}

type Table = 'session' | 'staff_session';

function read(table: Table): TokenPair {
  let row: any;
  try {
    row = getLocalDb()
      .prepare(`SELECT token, refresh_token, token_enc, refresh_token_enc FROM ${table} WHERE id=1`)
      .get();
  } catch {
    return EMPTY;                                  // table not present yet
  }
  if (!row) return EMPTY;
  // Wrapped first, plaintext second. An install that predates this change, or
  // one where wrapping is unavailable, keeps working untouched.
  return {
    token:        unwrap(row.token_enc) || row.token || '',
    refreshToken: unwrap(row.refresh_token_enc) || row.refresh_token || '',
  };
}

function write(table: Table, pair: TokenPair): void {
  const db = getLocalDb();
  if (!canWrap()) {
    db.prepare(`UPDATE ${table} SET token = ?, refresh_token = ? WHERE id = 1`)
      .run(pair.token, pair.refreshToken);
    return;
  }
  const tokenEnc   = wrap(pair.token);
  const refreshEnc = wrap(pair.refreshToken);

  // Clear a plaintext column only where its wrapped counterpart round-tripped.
  // Partial success is fine and deliberate: one wrapped, one not, both usable.
  db.prepare(`
    UPDATE ${table}
       SET token             = ?,
           refresh_token     = ?,
           token_enc         = ?,
           refresh_token_enc = ?
     WHERE id = 1
  `).run(
    tokenEnc   ? '' : pair.token,
    refreshEnc ? '' : pair.refreshToken,
    tokenEnc, refreshEnc,
  );

  if (pair.token && !tokenEnc) {
    logLine('token', `could not wrap the ${table} access token - left unwrapped`);
  }
  if (pair.refreshToken && !refreshEnc) {
    logLine('token', `could not wrap the ${table} refresh token - left unwrapped`);
  }
}

export const readSessionTokens  = (): TokenPair => read('session');
export const readStaffTokens    = (): TokenPair => read('staff_session');
export const writeSessionTokens = (p: TokenPair): void => write('session', p);
export const writeStaffTokens   = (p: TokenPair): void => write('staff_session', p);

/**
 * Wrap whatever is already sitting in plaintext, without waiting for the next
 * refresh. Called once at startup so an upgraded till stops holding a usable
 * credential in the clear within seconds rather than within fifteen minutes.
 * A no-op when there is nothing to do.
 */
export function migratePlaintextTokens(): void {
  if (!canWrap()) return;
  for (const table of ['session', 'staff_session'] as Table[]) {
    try {
      const row = getLocalDb()
        .prepare(`SELECT token, refresh_token FROM ${table} WHERE id=1`).get() as any;
      if (!row) continue;
      if (!row.token && !row.refresh_token) continue;      // already wrapped, or empty
      write(table, { token: row.token ?? '', refreshToken: row.refresh_token ?? '' });
      logLine('token', `${table} credentials wrapped at rest`);
    } catch { /* leave it as it is; the till must still start */ }
  }
}
