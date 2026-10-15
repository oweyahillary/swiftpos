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
 *   2. the approver's OWN sign-in PIN — only for someone who may approve: the business owner, the owner's role, a
 *      '*' grant, or a role/person holding `sales.void` for a void / `sales.refund` for a refund (A490; managers by
 *      default; never cashiers);
 *   3. the caller then falls back to the legacy business-wide supervisor PIN (routes/orders.ts), unchanged.
 * A PIN that matches a person who may NOT approve (a cashier) is simply not a match — the answer never reveals that a
 * PIN belongs to someone.
 *
 * Pure (no database): the rows and the two PIN checks are passed in, so the test runs this exact rule.
 */

import { hasPermission, hasAnyPermission } from './permissions';
import { isOwnerRoleName } from './ownerRole';
import { keysForRow } from './effectiveKeys';

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

/** A490: what is being approved — a void needs `sales.void`, a refund `sales.refund` (orders.void covered both). */
export type ApproveAction = 'void' | 'refund';
const APPROVE_KEY: Record<ApproveAction, string> = { void: 'sales.void', refund: 'sales.refund' };

/**
 * May this person approve this void or refund? The business owner, the owner's role (lib/ownerRole.ts), '*', or the
 * action's own key held (role grants + their overrides, worked out by lib/effectivePermissions.ts — a broad orders.void
 * grant from before migration 134 still counts, expanded). No action given: either key (the rule before A490).
 */
export function mayApprove(row: ApproverRow, ownerId: string | null | undefined, action?: ApproveAction): boolean {
  if (ownerId && row.id === ownerId) return true;
  if (isOwnerRoleName(row.roles?.name)) return true;
  const held = keysForRow(row, false);
  return action ? hasPermission(held, APPROVE_KEY[action]) : hasAnyPermission(held, [APPROVE_KEY.void, APPROVE_KEY.refund]);
}

export async function findApprover(
  rows: ApproverRow[],
  opts: {
    pin?: string | null; authorizerId?: string | null; ownerId?: string | null;
    /** Who may approve with their own sign-in PIN. Default: mayApprove (voids, refunds). A365 passes mayConfirm. */
    may?: (row: ApproverRow, ownerId: string | null | undefined) => boolean;
  },
  checks: {
    /** The sign-in PIN check (bcrypt, legacy SHA-256 fallback) — routes/auth.ts verifyPin. */
    loginPin: (pin: string, storedHash: string) => Promise<boolean>;
    /** The override PIN check (bcrypt). */
    overridePin: (pin: string, storedHash: string) => Promise<boolean>;
  },
): Promise<ApproverResult> {
  const candidates = opts.authorizerId ? rows.filter((r) => r.id === opts.authorizerId) : rows;
  const withOverride = candidates.filter((r) => !!r.override_pin_hash);
  const may = opts.may ?? mayApprove;
  const withLogin = candidates.filter((r) => !!r.pin_hash && may(r, opts.ownerId));
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
