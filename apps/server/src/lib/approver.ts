/**
 * approver.ts — A355 (2026-09-28): who may approve a void or a refund, and with which PIN.
 *
 * Owner, on v0.6.17: a manager's refund on the till failed with "Invalid supervisor PIN" — the till asked for a SECOND
 * PIN (the per-person override PIN, which the staff form forbids from matching the sign-in PIN), and nobody knew it.
 * "initially i was to have the role of a supervisor who can void and view sells but i think manager can replace that
 * role" → approved: **a manager approves with their own sign-in PIN**.
 *
 * The rule, in order:
 *   1. an override PIN (existing clients who set them keep working);
 *   2. the approver's OWN sign-in PIN — only for someone who may approve: the business owner, an owner/admin role, a
 *      '*' grant, or a role/person holding `orders.void` (managers by default, migration 59; never cashiers);
 *   3. the caller then falls back to the legacy business-wide supervisor PIN (routes/orders.ts), unchanged.
 * A PIN that matches a person who may NOT approve (a cashier) is simply not a match — the answer never reveals that a
 * PIN belongs to someone.
 *
 * Pure: the rows and the two PIN checks are passed in, so the test runs this exact rule.
 */

export interface ApproverRow {
  id: string;
  pin_hash?: string | null;
  override_pin_hash?: string | null;
  roles?: { name?: string | null; role_permissions?: Array<{ permissions?: { key?: string | null } | null }> | null } | null;
  user_permissions?: Array<{ granted?: boolean | null; permissions?: { key?: string | null } | null }> | null;
}

export type ApproverResult =
  | { result: 'ok'; userId: string; via: 'override' | 'pin' }
  | { result: 'invalid' }
  /** Nobody in the business can approve with a PIN (no override PINs, no approver with a sign-in PIN). */
  | { result: 'none' };

const APPROVE_KEY = 'orders.void';

/** May this person approve voids and refunds? Owner, owner/admin role, '*', or an effective `orders.void`. */
export function mayApprove(row: ApproverRow, ownerId: string | null | undefined): boolean {
  if (ownerId && row.id === ownerId) return true;
  const role = String(row.roles?.name ?? '').toLowerCase();
  if (role === 'owner' || role === 'admin') return true;
  const eff: Record<string, boolean> = {};
  for (const rp of row.roles?.role_permissions ?? []) { const k = rp?.permissions?.key; if (k) eff[k] = true; }
  // A per-person grant or revoke wins over the role (same order as the sign-in's effective permissions, auth.ts).
  for (const up of row.user_permissions ?? []) { const k = up?.permissions?.key; if (k) eff[k] = up.granted === true; }
  return eff['*'] === true || eff[APPROVE_KEY] === true;
}

export async function findApprover(
  rows: ApproverRow[],
  opts: { pin?: string | null; authorizerId?: string | null; ownerId?: string | null },
  checks: {
    /** The sign-in PIN check (bcrypt, legacy SHA-256 fallback) — routes/auth.ts verifyPin. */
    loginPin: (pin: string, storedHash: string) => Promise<boolean>;
    /** The override PIN check (bcrypt). */
    overridePin: (pin: string, storedHash: string) => Promise<boolean>;
  },
): Promise<ApproverResult> {
  const candidates = opts.authorizerId ? rows.filter((r) => r.id === opts.authorizerId) : rows;
  const withOverride = candidates.filter((r) => !!r.override_pin_hash);
  const withLogin = candidates.filter((r) => !!r.pin_hash && mayApprove(r, opts.ownerId));
  if (withOverride.length === 0 && withLogin.length === 0) return { result: 'none' };

  const pin = String(opts.pin ?? '').trim();
  if (!pin) return { result: 'invalid' };

  for (const r of withOverride) {
    if (await checks.overridePin(pin, String(r.override_pin_hash))) return { result: 'ok', userId: r.id, via: 'override' };
  }
  for (const r of withLogin) {
    if (await checks.loginPin(pin, String(r.pin_hash))) return { result: 'ok', userId: r.id, via: 'pin' };
  }
  return { result: 'invalid' };
}
