/**
 * deviceBinding.ts — is this terminal reporting from the branch it belongs to?
 *
 * The till carries its own branch_id in local SQLite, and that file travels with
 * the machine. So the branch on an incoming payload is a claim by the device
 * about itself, and until now nothing could contradict it: a terminal moved from
 * Branch A to Branch B kept booking its takings to Branch A, and both branches'
 * cash counts stayed internally consistent while the totals were wrong.
 *
 * Migration 52 records the binding server-side, where the machine cannot edit
 * it. This is the check.
 *
 * ── FAILS OPEN UNTIL BOUND ──────────────────────────────────────────────────
 * A device with no recorded branch is bound to whatever it first reports.
 * Existing tills therefore keep working and bind themselves on their next sync;
 * only a CHANGE after that is refused. Guessing a branch for the existing fleet
 * would attribute history to the wrong one, which is worse than a day's delay in
 * enforcement.
 *
 * ── WHY THIS BLOCKS RATHER THAN WARNS ───────────────────────────────────────
 * A warning on a mismatch would be the safer-feeling choice and the wrong one.
 * The sale is already rung and the cash is already in the drawer by the time
 * this runs; accepting it books revenue to a branch that did not make it, and
 * every downstream figure — stock, commission, branch P&L, VAT by location — is
 * then wrong in a way no reconciliation will surface. Refusing the push leaves
 * the order on the till, where it can be re-pushed once the branch is corrected,
 * and nothing is lost.
 */

import { supabase } from './supabase';

export interface BindingCheck {
  ok: boolean;
  code?: 'branch_mismatch' | 'rebind_expired' | 'terminal_code_conflict';
  error?: string;
  boundBranchId?: string | null;
}

/** Grace window a manager grants for one relocation. */
export const REBIND_WINDOW_MINUTES = 60;

/**
 * Check — and on first sight, establish — the branch a device is bound to.
 *
 * Returns ok:true when the device may report for `claimedBranchId`. Callers
 * should treat ok:false as a 409, not a 500: the request is well formed, the
 * terminal is simply not where it says it is.
 *
 * Never throws. A database problem here must not stop a shop trading, so an
 * unreadable binding is treated as unbound and allowed through — the failure
 * mode of this check should be the status quo, not an outage.
 */
export async function checkDeviceBranch(
  businessId: string,
  deviceId: string | null | undefined,
  claimedBranchId: string | null | undefined,
): Promise<BindingCheck> {
  // Nothing to check. Plenty of legitimate paths carry neither — the dashboard,
  // the admin portal, a single-branch business that never sets one.
  if (!deviceId || !claimedBranchId) return { ok: true };

  try {
    const { data: device, error } = await supabase
      .from('user_devices')
      .select('id, branch_id, rebind_allowed_until, branch_change_count')
      .eq('business_id', businessId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (error || !device) return { ok: true };   // unknown device — registration's job, not ours

    // ── First sighting: bind it ────────────────────────────────────────────
    if (!device.branch_id) {
      await supabase.from('user_devices')
        .update({ branch_id: claimedBranchId, bound_at: new Date().toISOString() })
        .eq('id', device.id);
      return { ok: true, boundBranchId: claimedBranchId };
    }

    if (device.branch_id === claimedBranchId) return { ok: true, boundBranchId: device.branch_id };

    // ── It has moved ───────────────────────────────────────────────────────
    const allowedUntil = device.rebind_allowed_until
      ? new Date(device.rebind_allowed_until).getTime()
      : 0;

    if (allowedUntil > Date.now()) {
      // Authorised relocation. Record where it came from — "this till was at
      // Westlands until the 14th" is the question asked when figures are
      // queried later, and an overwritten field cannot answer it.
      const { error: moveErr } = await supabase.from('user_devices').update({
        previous_branch_id:   device.branch_id,
        branch_id:            claimedBranchId,
        branch_changed_at:    new Date().toISOString(),
        branch_change_count:  (device.branch_change_count ?? 0) + 1,
        rebind_allowed_until: null,
        rebind_authorised_by: null,
      }).eq('id', device.id);

      // 23505 here is the terminal-code index, not the device index: the
      // destination branch already has a till using this code. Both machines
      // would otherwise become 'T1' at the same branch, which is the exact
      // ambiguity migration 52 exists to prevent — and moving a till is when it
      // is most likely, because 'T1' is the default every install starts from.
      //
      // Refuse the move and say which thing to change. Silently renaming the
      // terminal would leave a machine whose on-screen code no longer matches
      // the labels on its shifts.
      if (moveErr) {
        const code = (moveErr as { code?: string }).code;
        if (code === '23505') {
          console.error(`[deviceBinding] rebind of ${deviceId} to ${claimedBranchId} blocked: terminal code already in use there`);
          return {
            ok: false,
            code: 'terminal_code_conflict',
            boundBranchId: device.branch_id,
            error:
              'This terminal cannot move to that branch yet: another till there already uses the ' +
              'same terminal code. Give one of them a different code first, then authorise the move again.',
          };
        }
        console.warn('[deviceBinding] rebind failed:', moveErr.message);
        return { ok: true };   // do not block trading on an update failure
      }

      console.warn(`[deviceBinding] device ${deviceId} rebound ${device.branch_id} -> ${claimedBranchId} (authorised)`);
      return { ok: true, boundBranchId: claimedBranchId };
    }

    console.error(
      `[deviceBinding] REFUSED: device ${deviceId} is registered to branch ${device.branch_id} ` +
      `but is reporting for ${claimedBranchId}.`,
    );
    return {
      ok: false,
      code: device.rebind_allowed_until ? 'rebind_expired' : 'branch_mismatch',
      boundBranchId: device.branch_id,
      error:
        'This terminal is registered to a different branch. If it has been moved, a manager must ' +
        'authorise the change in Settings → Terminals before it can sell here. Nothing has been lost — ' +
        'the sales are still on this till and will sync once the branch is corrected.',
    };
  } catch (err: any) {
    console.warn('[deviceBinding] check failed, allowing through:', err?.message ?? err);
    return { ok: true };
  }
}

/**
 * Is this terminal code already taken at this branch?
 *
 * Called from the setup screen before a device completes registration. The
 * unique index in migration 52 is the real guarantee; this exists so the person
 * installing finds out while they are still on the screen where they can change
 * it, rather than after a failed sync.
 */
export async function isTerminalCodeTaken(
  businessId: string,
  branchId: string,
  terminalCode: string,
  exceptDeviceId?: string | null,
): Promise<boolean> {
  try {
    let q = supabase
      .from('user_devices')
      .select('id, device_id, terminal_code')
      .eq('business_id', businessId)
      .eq('branch_id', branchId)
      .eq('status', 'approved');

    const { data } = await q;
    const wanted = terminalCode.trim().toUpperCase();
    return (data ?? []).some((d: { device_id?: string; terminal_code?: string }) =>
      (d.terminal_code ?? '').trim().toUpperCase() === wanted &&
      d.device_id !== exceptDeviceId);
  } catch {
    // Fail permissive: a lookup failure must not stop somebody installing a
    // till. The unique index still refuses a genuine duplicate at write time.
    return false;
  }
}
