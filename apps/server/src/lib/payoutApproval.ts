/**
 * payoutApproval.ts — 0.6.37 (A388): a manager approves a cash-out (pay-out) and an expense on the spot.
 *
 * Owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot". The web POS's twin of the
 * till's rule (desktop ipcHandlers payoutApprover): a manager signed in (callerMayConfirm — the owner, a manager role,
 * orders.void / shifts.manage / settings.manage) approves as themselves; anyone else sends a manager's PIN, checked
 * like a shift confirmation (confirmerByPin: the login PIN or the override PIN of someone who may confirm).
 */
import { supabase } from './supabase';
import { callerMayConfirm } from './shiftConfirm';
import { confirmerByPin } from './confirmerLookup';

export type Approver = { id: string; name: string | null };
export type ApprovalResult =
  | { ok: true; approver: Approver }
  | { ok: false; status: 403; error: string; code: 'PAYOUT_APPROVAL_REQUIRED' | 'INVALID_CONFIRMER_PIN' };

export const APPROVAL_REQUIRED = 'A manager must approve this — enter a manager’s PIN.';
export const PIN_NOT_RECOGNISED = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';

export async function payoutApprover(
  req: { businessId?: string; userId?: string; isOwner?: boolean; permissionKeys?: string[]; body?: any },
): Promise<ApprovalResult> {
  const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
  if (pin) {
    const who = await confirmerByPin(req.businessId!, pin, req.body?.authorizer_id || undefined);
    return who ? { ok: true, approver: who }
      : { ok: false, status: 403, error: PIN_NOT_RECOGNISED, code: 'INVALID_CONFIRMER_PIN' };
  }
  if (callerMayConfirm(req) && req.userId) {
    const { data } = await supabase.from('users').select('name').eq('id', req.userId).maybeSingle();
    return { ok: true, approver: { id: req.userId, name: (data as any)?.name ?? null } };
  }
  return { ok: false, status: 403, error: APPROVAL_REQUIRED, code: 'PAYOUT_APPROVAL_REQUIRED' };
}
