/**
 * refreshHandshake.ts — A477: a till's renewal works like SYN / SYN-ACK / ACK, so an honest till is never locked out.
 *
 * Owner, 2026-10-14 (a branch server signed out on 2026-10-12: every renewal answered TOKEN_REPLAYED, its device secret
 * was missing, a technician had to rejoin it): "renewal like SYN / SYN-ACK / ACK" — a crash, an update restart, a lost
 * reply or a slow line must never cost a till its session; the key bound to the machine "to confirm that this till is
 * in the system".
 *
 * THE HANDSHAKE (migration 131: refresh_tokens.acked_at — null = the client has not confirmed it holds this token)
 *   1. /refresh with the live head T(n)          → mint T(n+1) (unacked), T(n).replaced_by = T(n+1). T(n) stays alive.
 *   2. the till writes T(n+1) to disk, then      → POST /refresh/ack { T(n+1) }: T(n+1) acked, T(n) revoked.
 *   3. /refresh with T(n) again before the ack   → the reply was lost (or the till crashed before writing): T(n+1) is
 *                                                  revoked and a fresh T(n+1)' minted. No session is touched.
 *   4. /refresh with T(n+1) before any ack       → an implicit ack (an older till never calls /ack): T(n+1) acked, T(n)
 *                                                  revoked, then rotate as usual.
 *   5. anything older (its successor confirmed and moved on, or revoked):
 *        a till's own session (session_kind 'device')  → refuse THAT token only (TOKEN_STALE); the session stays; the
 *                                                         owner is alerted (someone holds an old copy of the till's key);
 *        a person's session (web, PIN)                 → today's rule, unchanged: revoke the whole session (TOKEN_REPLAYED).
 *
 * Rows from before migration 131 were backfilled acked (acked_at = created_at) — all but a live successor whose parent
 * the old rotation already revoked: that one stays unconfirmed, so a reply lost just before the deploy is still re-asked
 * (A88) and its first use is an implicit ack. A session mid-flight therefore rotates exactly as it did. Without the column
 * at all (migration not run yet) the old rotation runs: revoke at rotation + A88's grace.
 *
 * Pure — no DB. routes/auth.ts reads the rows and applies what this decides.
 */

export type HandshakeAction =
  /** Mint a successor for this token (the live head). */
  | 'rotate'
  /** This token's successor never reached the client (or was revoked): revoke it, mint a fresh one, re-point. */
  | 'reask'
  /** A till's own session presented an outdated token: refuse it alone, keep the session, alert the owner. */
  | 'stale'
  /** A person's session presented an outdated token: revoke the whole session (A88's replay rule, unchanged). */
  | 'replay'
  | 'expired';

export interface HandshakeRow {
  revokedAt:  string | null | undefined;
  /** undefined = the column is not there (before migration 131); null = not confirmed yet. */
  ackedAt?:   string | null;
  replacedBy: string | null | undefined;
  expiresAt?: string | null;
}

export interface HandshakeSuccessor {
  revokedAt:  string | null | undefined;
  ackedAt?:   string | null;
  replacedBy: string | null | undefined;
}

export interface HandshakeInput {
  row: HandshakeRow;
  /** The row `row.replacedBy` names, or null when it names none (or it is gone). */
  successor: HandshakeSuccessor | null;
  /** The till's own session (refresh_tokens.session_kind 'device', or a till payload). */
  deviceSession: boolean;
  /** Migration 131 is in: the handshake runs. False → the rotation from before (revoke at rotation, A88 grace). */
  handshake: boolean;
  now?: number;
}

export interface HandshakeDecision {
  action: HandshakeAction;
  /** The presented token is the client's first use of an unconfirmed successor: confirm it and revoke its parent. */
  implicitAck: boolean;
  /** Revoke the presented token as it is consumed (only before migration 131 — the old rotation). */
  revokeConsumed: boolean;
}

const acked = (v: string | null | undefined): boolean => v !== null;   // undefined (no column) counts as confirmed

export function refreshHandshakeDecision(i: HandshakeInput): HandshakeDecision {
  const { row, successor, deviceSession, handshake } = i;
  const now = i.now ?? Date.now();
  const refuse = (): HandshakeDecision => ({ action: deviceSession ? 'stale' : 'replay', implicitAck: false, revokeConsumed: false });
  const succIsHead = !!successor && !successor.revokedAt && !successor.replacedBy;

  if (row.revokedAt) {
    // A lost reply: the successor is still the head and was never confirmed — mint it again (A88's grace, both eras).
    if (succIsHead && !acked(successor!.ackedAt)) return { action: 'reask', implicitAck: false, revokeConsumed: false };
    // The successor is the confirmed head. Before 131 (or a backfilled row) this was A88's lost reply too. A till now
    // confirms every token it keeps, so a till presenting this is holding an outdated copy; a person's browser never
    // confirms explicitly — keep A88's grace for it exactly.
    if (succIsHead && (!handshake || !deviceSession)) return { action: 'reask', implicitAck: false, revokeConsumed: false };
    return refuse();
  }

  if (row.expiresAt && Date.parse(row.expiresAt) < now) return { action: 'expired', implicitAck: false, revokeConsumed: false };

  if (!handshake) return { action: 'rotate', implicitAck: false, revokeConsumed: true };

  const implicitAck = !acked(row.ackedAt);
  if (!row.replacedBy || !successor) return { action: 'rotate', implicitAck, revokeConsumed: false };
  // Its successor was revoked (re-asked, or a store failed half-way) or never confirmed: the client did not get it.
  if (successor.revokedAt || !acked(successor.ackedAt)) return { action: 'reask', implicitAck, revokeConsumed: false };
  // The successor was confirmed — this token should already be revoked (the ack stopped half-way). Outdated.
  return refuse();
}

// ── the machine (A477 §2) ─────────────────────────────────────────────────────

export interface MachineIdentity {
  mac?:        string | null;
  /** SHA-256 (hex) of the Windows MachineGuid, hashed on the till. */
  guidHash?:   string | null;
  /** SHA-256 (hex) of the BIOS serial, hashed on the till. */
  serialHash?: string | null;
}

export interface IdentityDecision {
  verdict: 'pass' | 'mismatch';
  /** Columns to write on the till's row (trust on first use, a field seen for the first time, a new MAC). */
  update: { mac_address?: string; machine_guid_hash?: string; serial_hash?: string } | null;
  /** True when a stored guid or serial matched (or was stored now) — the request comes from the machine on record. */
  matched: boolean;
}

const HASH = /^[0-9a-f]{64}$/;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const cleanHash = (v: unknown): string | null => { const s = String(v ?? '').trim().toLowerCase(); return HASH.test(s) ? s : null; };
const cleanMac = (v: unknown): string | null => { const s = String(v ?? '').trim().toLowerCase(); return MAC.test(s) ? s : null; };

/** What a request says about its machine: X-Device-Mac / X-Device-Guid / X-Device-Serial (malformed = absent). */
export function presentedIdentity(h: (name: string) => unknown): MachineIdentity {
  const first = (v: unknown) => String(v ?? '').split(',')[0];
  return { mac: cleanMac(first(h('x-device-mac'))), guidHash: cleanHash(first(h('x-device-guid'))), serialHash: cleanHash(first(h('x-device-serial'))) };
}

/**
 * Is this request from the machine the till's row was first seen on?
 *   - no guid and no serial presented (a till from before A477)          → pass, nothing stored;
 *   - nothing on record yet                                               → pass and store (trust on first use);
 *   - the guid OR the serial matches                                      → pass (a new MAC, a guid after a Windows
 *                                                                           reinstall or a new serial are recorded);
 *   - nothing that can be compared (e.g. on record a guid, presented a serial) → pass, the new field stored;
 *   - on record and presented, and NEITHER matches                        → mismatch: another computer holds the till's
 *                                                                           data. Refused; the session is not revoked.
 */
export function identityDecision(stored: MachineIdentity | null | undefined, presented: MachineIdentity): IdentityDecision {
  const s = { mac: cleanMac(stored?.mac), guid: cleanHash(stored?.guidHash), serial: cleanHash(stored?.serialHash) };
  const p = { mac: cleanMac(presented.mac), guid: cleanHash(presented.guidHash), serial: cleanHash(presented.serialHash) };
  if (!p.guid && !p.serial) return { verdict: 'pass', update: null, matched: false };

  const update: NonNullable<IdentityDecision['update']> = {};
  if (!s.guid && !s.serial) {
    if (p.guid) update.machine_guid_hash = p.guid;
    if (p.serial) update.serial_hash = p.serial;
    if (p.mac && p.mac !== s.mac) update.mac_address = p.mac;
    return { verdict: 'pass', update, matched: true };
  }
  const guidCmp = !!(s.guid && p.guid), serialCmp = !!(s.serial && p.serial);
  const guidOk = guidCmp && s.guid === p.guid, serialOk = serialCmp && s.serial === p.serial;
  if ((guidCmp || serialCmp) && !guidOk && !serialOk) return { verdict: 'mismatch', update: null, matched: false };

  if (p.guid && p.guid !== s.guid) update.machine_guid_hash = p.guid;
  if (p.serial && p.serial !== s.serial) update.serial_hash = p.serial;
  if (p.mac && p.mac !== s.mac) update.mac_address = p.mac;
  return { verdict: 'pass', update: Object.keys(update).length ? update : null, matched: guidOk || serialOk };
}
