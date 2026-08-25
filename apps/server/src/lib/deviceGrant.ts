// deviceGrant.ts — A164, SCOPE-node-authority Phase 1 (cloud device-grant).
//
// A till recovers its own session by presenting its device_id + a per-device
// secret, instead of dropping to an owner re-login when its refresh lapses.
//
// THE SECURITY POINT (why the grant token is isOwner:false). Minting the grant
// isOwner:false is a real reduction over the enrolment owner-token for THREE
// reasons: (1) requireWebSurface's isOwner bypass (auth.ts:226) no longer lets it
// reach web-only features; (2) rbac branch-locks it to its own branch (an owner
// may read any branch); (3) it becomes subject to the per-request account-status
// + permissions-version recheck (auth.ts:111 runs only for !isOwner), so revoking
// the owner stops the device. It keeps ['*'] so rbac still lets the till do its
// job. NOTE: the A159 terminal write-guard (terminalWriteDenied, auth.ts:256)
// gates on surface==='desktop' ALONE, not isOwner, so it already bounds any
// desktop token regardless of this flag — do not rely on isOwner:false for that.
//
// The hashing/verify are here (pure, no DB) so they are unit-testable. The secret
// is high-entropy random, so sha256 (not bcrypt) is appropriate and matches the
// enrolment-code discipline — there is nothing to brute-force.

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

/** Claims for a device-grant session token. Structurally the server's
 *  TokenPayload; kept here as a plain shape so this stays DB/route-free. */
export interface DeviceGrantClaims {
  userId: string;
  businessId: string;
  branchId: string | null;
  permissionsVersion: number;
  sessionId: string;
}

/**
 * Build the token payload for a device grant. isOwner:false is deliberate and
 * load-bearing (see the security note above). branchId is bound to the device's
 * registered branch — an isOwner:false token is branch-LOCKED by rbac, so the
 * branch must be correct for the till's per-branch reads to resolve.
 */
export function buildDeviceTokenPayload(c: DeviceGrantClaims) {
  return {
    userId:             c.userId,
    businessId:         c.businessId,
    branchId:           c.branchId,
    isOwner:            false,
    permissionKeys:     ['*'] as string[],
    permissionsVersion: c.permissionsVersion,
    sessionId:          c.sessionId,
    surface:            'desktop',
  };
}
