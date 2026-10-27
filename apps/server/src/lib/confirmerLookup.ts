/**
 * confirmerLookup.ts — who a manager's PIN belongs to (A365 shift confirmation; 0.6.28 the web POS's kitchen voids).
 *
 * Moved out of routes/shifts.ts unchanged so routes/orders.ts can ask the same question: the refund rule's lookup
 * (findApprover — the login PIN or the override PIN), widened to anyone who may confirm a shift (mayConfirm: the owner,
 * a manager/supervisor/admin role, or orders.void / shifts.manage / settings.manage).
 */
import bcrypt from 'bcrypt';
import { supabase } from './supabase';
import { findApprover, type ApproverRow } from './approver';
import { mayApproveWith, type ApprovalKey } from './shiftConfirm';
import { splitsPending } from './permissionsState';   // A595
import { verifyPin } from '../routes/auth';

export async function confirmerRows(businessId: string) {
  const [{ data: rows }, { data: biz }] = await Promise.all([
    supabase
      .from('users')
      .select('id, name, pin_hash, override_pin_hash, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) ), user_branches ( branch_id )')
      .eq('business_id', businessId)
      .eq('status', 'active'),
    supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle(),
  ]);
  return { rows: (rows ?? []) as (ApproverRow & { name?: string | null })[], ownerId: ((biz as any)?.owner_id ?? null) as string | null };
}

/** A494: `scope` — the branch of what is confirmed (the confirmer must work there) and who is asking (not themselves,
 *  unless the owner). Both optional: a caller that passes neither keeps the rule before A494, apart from the override-PIN
 *  holders now also having to pass mayConfirm. */
/** A505: 'self' = the PIN is the asker's own (lib/approver.ts) — the caller answers SELF_APPROVAL (403) and does not count
 *  it towards the PIN limiter. Never for the owner. */
export const SELF_APPROVAL_BODY = {
  error: 'Someone else must approve this - enter the PIN of another manager (or the owner).',
  code:  'SELF_APPROVAL',
} as const;

/**
 * A518 (A514 gap): 'none' = nobody at this branch who may confirm holds a PIN (sign-in or approval PIN) — no PIN could ever
 * match, so it is not a wrong PIN: the caller answers 400 NO_OVERRIDE_CONFIGURED (routes/orders.ts's words) and never
 * counts it towards the PIN limiter. Only when no particular person was picked (authorizer_id): a picked person who may
 * not confirm stays a wrong PIN, as before.
 */
export const NO_CONFIRMER_BODY = {
  error: 'Nobody at this branch can approve this yet. The owner or a manager gives someone who may approve a PIN in Staff.',
  code:  'NO_OVERRIDE_CONFIGURED',
} as const;

/** A595: `scope.key` — what the PIN approves (default: confirming a drawer, shifts.confirm; a pay-out
 *  shifts.approve_payout; a kitchen removal sales.approve_kitchen_void). */
export async function confirmerByPin(businessId: string, pin: string, authorizerId?: string,
  scope?: { branchId?: string | null; actorId?: string | null; key?: ApprovalKey }): Promise<{ id: string; name: string | null } | null | 'self' | 'none'> {
  const { rows, ownerId } = await confirmerRows(businessId);
  const may = mayApproveWith(scope?.key ?? 'shifts.confirm', splitsPending());
  const found = await findApprover(rows, { pin, authorizerId, ownerId, may, branchId: scope?.branchId ?? null, actorId: scope?.actorId ?? null }, {
    loginPin:    async (p, h) => (await verifyPin(p, h, businessId)).valid,
    overridePin: (p, h) => bcrypt.compare(p, h),
  });
  if (found.result === 'self') return 'self';   // A505
  if (found.result === 'none' && !authorizerId) return 'none';   // A518
  if (found.result !== 'ok') return null;
  const row = rows.find((r) => r.id === found.userId);
  return { id: found.userId, name: row?.name ?? null };
}
