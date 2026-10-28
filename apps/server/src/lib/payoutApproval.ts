/**
 * payoutApproval.ts — 0.6.37 (A388): a manager approves a cash-out (pay-out) and an expense on the spot.
 *
 * Owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot". The web POS's twin of the
 * till's rule (desktop ipcHandlers payoutApprover): a manager signed in (callerMayConfirm — the owner, a manager role,
 * orders.void / shifts.manage / settings.manage) approves as themselves; anyone else sends a manager's PIN, checked
 * like a shift confirmation (confirmerByPin: the login PIN or the override PIN of someone who may confirm).
 */
import { supabase } from './supabase';
import { callerMayApprove } from './shiftConfirm';
import { confirmerByPin, SELF_APPROVAL_BODY, NO_CONFIRMER_BODY } from './confirmerLookup';
import { pinKey, pinLocked, notePinFailure, notePinSuccess, PIN_LOCKED_BODY } from './pinAttempts';   // A494

export type Approver = { id: string; name: string | null };
export type ApprovalResult =
  | { ok: true; approver: Approver }
  | { ok: false; status: 400 | 403 | 429; error: string;
      code: 'PAYOUT_APPROVAL_REQUIRED' | 'INVALID_CONFIRMER_PIN' | 'PIN_LOCKED' | 'SELF_APPROVAL' | 'NO_OVERRIDE_CONFIGURED' };

export const APPROVAL_REQUIRED = 'A manager must approve this — enter a manager’s PIN.';
export const PIN_NOT_RECOGNISED = 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.';

export async function payoutApprover(
  req: { businessId?: string; userId?: string | null; isOwner?: boolean; permissionKeys?: string[]; isTill?: boolean; deviceId?: string | null; ip?: string; body?: any },
  /** A494: the drawer's branch — the approver must work there (and is never the person asking). */
  branchId: string | null = null,
): Promise<ApprovalResult> {
  const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
  if (pin) {
    // A494: behind the one PIN limiter (lib/pinAttempts.ts) — a caller's wrong PINs pause their PIN entry.
    const key = pinKey(req);
    if (pinLocked(key)) return { ok: false, status: 429, error: PIN_LOCKED_BODY.error, code: 'PIN_LOCKED' };
    // A595: a pay-out / drawer expense / cash in is approved by someone holding shifts.approve_payout (a part of
    // shifts.confirm — every holder of it got the part in migration 176).
    const who = await confirmerByPin(req.businessId!, pin, req.body?.authorizer_id || undefined, { branchId, actorId: req.userId ?? null, key: 'shifts.approve_payout' });
    // A505: the asker's own PIN — not a wrong guess (no strike); someone else must approve.
    if (who === 'self') return { ok: false, status: 403, error: SELF_APPROVAL_BODY.error, code: 'SELF_APPROVAL' };
    // A518: nobody at the branch who may approve has a PIN — not a wrong guess (no strike); say who can fix it.
    if (who === 'none') return { ok: false, status: 400, error: NO_CONFIRMER_BODY.error, code: 'NO_OVERRIDE_CONFIGURED' };
    if (!who) notePinFailure(key); else notePinSuccess(key);
    return who ? { ok: true, approver: who }
      : { ok: false, status: 403, error: PIN_NOT_RECOGNISED, code: 'INVALID_CONFIRMER_PIN' };
  }
  if (callerMayApprove(req, 'shifts.approve_payout') && req.userId) {
    const { data } = await supabase.from('users').select('name').eq('id', req.userId).maybeSingle();
    return { ok: true, approver: { id: req.userId, name: (data as any)?.name ?? null } };
  }
  return { ok: false, status: 403, error: APPROVAL_REQUIRED, code: 'PAYOUT_APPROVAL_REQUIRED' };
}
