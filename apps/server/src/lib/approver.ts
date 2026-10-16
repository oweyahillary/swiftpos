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
import { worksAtBranch } from './branchAccess';

export interface ApproverRow {
  id: string;
  pin_hash?: string | null;
  override_pin_hash?: string | null;
  roles?: { name?: string | null; role_permissions?: Array<{ permissions?: { key?: string | null } | null }> | null } | null;
  user_permissions?: Array<{ granted?: boolean | null; permissions?: { key?: string | null } | null }> | null;
  /** A494: the branches they work at — needed when findApprover is given a branch (select `user_branches ( branch_id )`). */
  user_branches?: Array<{ branch_id: string | null }> | null;
}

/** A494: the business's owner — their own row (businesses.owner_id) or the owner's role. */
export function isOwnerRow(row: ApproverRow, ownerId: string | null | undefined): boolean {
  return (!!ownerId && row.id === ownerId) || isOwnerRoleName(row.roles?.name);
}

export type ApproverResult =
  | { result: 'ok'; userId: string; via: 'override' | 'pin' }
  | { result: 'invalid' }
  /** Nobody in the business can approve with a PIN (no override PINs, no approver with a sign-in PIN). */
  | { result: 'none' }
  /** A505: the PIN is the ASKER's own (sign-in or override PIN) — they may not approve their own action. Not a wrong
   *  PIN: the caller answers SELF_APPROVAL and never counts it towards the PIN limiter. Never for the owner. */
  | { result: 'self' };

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
    /** Who may approve (A494: with an override PIN too). Default: mayApprove (voids, refunds). A365 passes mayConfirm. */
    may?: (row: ApproverRow, ownerId: string | null | undefined) => boolean;
    /** A494: the branch of what is approved — an approver must work there (lib/branchAccess.ts; the owner anywhere).
     *  The rows MUST then carry `user_branches` — a row without it is refused (fail closed), never "every branch". */
    branchId?: string | null;
    /** A494: who is asking. They may not approve their own void / refund — unless they are the owner. */
    actorId?: string | null;
  },
  checks: {
    /** The sign-in PIN check (bcrypt, legacy SHA-256 fallback) — routes/auth.ts verifyPin. */
    loginPin: (pin: string, storedHash: string) => Promise<boolean>;
    /** The override PIN check (bcrypt). */
    overridePin: (pin: string, storedHash: string) => Promise<boolean>;
  },
): Promise<ApproverResult> {
  const may = opts.may ?? mayApprove;
  const eligible = (r: ApproverRow): boolean => {
    // A494: an override PIN no longer approves by itself — its holder must also hold the action's key (may), as a
    // sign-in PIN's holder must; someone whose role lost sales.void kept approving voids with an old override PIN.
    if (!may(r, opts.ownerId)) return false;
    const owner = isOwnerRow(r, opts.ownerId);
    if (opts.actorId && r.id === opts.actorId && !owner) return false;
    if (opts.branchId && !owner) {
      if (!Array.isArray(r.user_branches)) return false;   // fail closed: the caller did not select the branches
      if (!worksAtBranch(r.user_branches, opts.branchId)) return false;
    }
    return true;
  };
  const candidates = (opts.authorizerId ? rows.filter((r) => r.id === opts.authorizerId) : rows).filter(eligible);
  const withOverride = candidates.filter((r) => !!r.override_pin_hash);
  const withLogin = candidates.filter((r) => !!r.pin_hash);
  const pin = String(opts.pin ?? '').trim();

  // A505: the asker typed their OWN PIN. They are left out of the candidates (A494), so it matched nobody and read as a
  // wrong PIN — "That PIN was not recognised" and one more strike towards the PIN lock, for a manager who only needed to
  // be told someone else must approve. Checked only once nobody else matched (never for the owner, who may approve their own).
  const ownPin = async (): Promise<boolean> => {
    if (!pin || !opts.actorId) return false;
    if (opts.authorizerId && opts.authorizerId !== opts.actorId) return false;
    const me = rows.find((r) => r.id === opts.actorId);
    if (!me || isOwnerRow(me, opts.ownerId)) return false;
    // Only someone who COULD approve this (were it not theirs) is told so; anyone else's own PIN is a wrong PIN, as before.
    if (!may(me, opts.ownerId)) return false;
    if (me.override_pin_hash && await checks.overridePin(pin, String(me.override_pin_hash))) return true;
    return !!me.pin_hash && await checks.loginPin(pin, String(me.pin_hash));
  };

  if (withOverride.length === 0 && withLogin.length === 0) return (await ownPin()) ? { result: 'self' } : { result: 'none' };
  if (!pin) return { result: 'invalid' };

  for (const r of withOverride) {
    if (await checks.overridePin(pin, String(r.override_pin_hash))) return { result: 'ok', userId: r.id, via: 'override' };
  }
  for (const r of withLogin) {
    if (await checks.loginPin(pin, String(r.pin_hash))) return { result: 'ok', userId: r.id, via: 'pin' };
  }
  return (await ownPin()) ? { result: 'self' } : { result: 'invalid' };
}
