// deviceGrant.ts — the till's own sign-in (A164, A407; A415: never the owner's).
//
// Owner, 2026-10-06: "remove any linkage with the desktop app using owners credetials, we find a way to use some key
// or something that links the till to the business id and branch id never the owners session at all".
//
// A till signs in AS ITSELF. Its token names the till (deviceId), the business and the branch — and no person: there
// is no userId in it, and nothing on the till or in the cloud ties its session to the owner's account. What it may do:
//   * isOwner:false — branch-locked by rbac to its own branch, and requireWebSurface keeps it off web-only features;
//   * the A159 terminal write-guard (lib/terminalWrites.ts) bounds its writes to the till's own (sales, sync, shift
//     close, replays);
//   * every request checks the till is still on the business (middleware/auth.ts: its user_devices row is approved and
//     not retired) — retiring or revoking the till cuts it off at once;
//   * a step that needs a person (approving a void or refund, confirming a shift) needs that person's PIN — the till
//     itself never counts as one (lib/shiftConfirm.ts callerMayConfirm).
// It keeps ['*'] so rbac lets the till do its job within those bounds.
//
// The till gets its session from an admin enrolment code (/enrol/redeem) and renews it with its per-device secret
// (/device-token). The hashing/verify are here (pure, no DB) so they are unit-testable. The secret is high-entropy
// random, so sha256 (not bcrypt) is appropriate and matches the enrolment-code discipline — there is nothing to
// brute-force.

import crypto from 'crypto';

/** A versioned, high-entropy per-device secret. Returned to the device once. */
export function generateDeviceSecret(): string {
  return 'dg1.' + crypto.randomBytes(32).toString('base64url');
}

/** Store only this. The raw secret never touches the DB. */
export function hashDeviceSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Constant-time verify of a presented secret against the stored hash. */
export function verifyDeviceSecret(raw: string, hash: string | null | undefined): boolean {
  if (!raw || !hash) return false;
  const got = Buffer.from(hashDeviceSecret(raw));
  const want = Buffer.from(hash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** A device is grantable only in a good standing status. Anything else — pending,
 *  rejected, or any future revoked/blocked — is refused, which is how a lost or
 *  decommissioned terminal is cut off at the cloud (SCOPE §Revocation). */
const GRANTABLE_STATUS = new Set(['approved', 'active']);
export function isDeviceGrantable(status: string | null | undefined): boolean {
  return !!status && GRANTABLE_STATUS.has(status);
}

/** What a till's token names: the till, its business, its branch. No person. */
export interface TillClaims {
  deviceId:   string;
  businessId: string;
  branchId:   string | null;
  sessionId:  string;
}

/** The token payload for a till's own session. */
export function buildDeviceTokenPayload(c: TillClaims) {
  return {
    userId:             null,
    deviceId:           c.deviceId,
    till:               true as const,
    businessId:         c.businessId,
    branchId:           c.branchId,
    isOwner:            false,
    permissionKeys:     ['*'] as string[],
    permissionsVersion: 0,
    sessionId:          c.sessionId,
    surface:            'desktop',
  };
}

/** Is this token payload a till's own session? */
export function isTillPayload(p: { till?: unknown; deviceId?: unknown } | null | undefined): boolean {
  return !!p && p.till === true && typeof p.deviceId === 'string' && p.deviceId.length > 0;
}

/**
 * A till session from before A415: the owner's identity on the till (surface 'desktop', not a person's PIN sign-in,
 * not a till token). Never accepted for a request; /refresh replaces it with the till's own session.
 */
export function isOwnerEraTillPayload(p: { surface?: unknown; pinSignIn?: unknown; till?: unknown } | null | undefined): boolean {
  return !!p && p.surface === 'desktop' && p.pinSignIn !== true && p.till !== true;
}

/** Why a till may not use its session, or null when it may. The row is its user_devices row (null = not found). */
export function tillBlockReason(row: { status?: string | null; retired_at?: string | null } | null | undefined): 'unknown' | 'blocked' | 'retired' | null {
  if (!row) return 'unknown';
  if (row.retired_at) return 'retired';
  if (!isDeviceGrantable(row.status)) return 'blocked';
  return null;
}

/** The branch a till's session is for: the code's (a technician's fresh code may move it), else the one it is bound to,
 *  else the one it reports (bound on first sight, like checkDeviceBranch). */
export function tillBranch(codeBranch: string | null | undefined, boundBranch: string | null | undefined, reported: string | null | undefined): string | null {
  return codeBranch || boundBranch || reported || null;
}
