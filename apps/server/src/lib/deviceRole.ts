/**
 * deviceRole.ts — is this machine really its branch's server?
 *
 * Migration 73 let a terminal SAY what it is. This decides whether to believe
 * it, which is the difference between a diagnostic and a security control.
 *
 * `device_role` arrives in a header the till sets about itself. PHASE5 §4b wants
 * to hand the branch's PIN hashes to the machine that serves the branch, so
 * tills can authenticate staff with no internet. Gating that on an unverified
 * header would let any till — or anyone who lifted an owner token off one — ask
 * for the roster by claiming to be the node.
 *
 * ── SAME SHAPE AS MIGRATION 52, ON PURPOSE ──────────────────────────────────
 * Trust on first use, then closed, with a manager-granted window for legitimate
 * change. That is exactly how branch binding works, and a second trust mechanism
 * would be a second thing to learn and a second thing to get wrong.
 *
 * ── BUT IT FAILS CLOSED, WHERE 52 FAILS OPEN ────────────────────────────────
 * `checkDeviceBranch` waves an unbound device through, because refusing would
 * stop a shop trading over a diagnostic. Here an unconfirmed device is REFUSED
 * credentials, because the cost of a wrong answer is the branch's PIN hashes
 * rather than a misattributed sale. Refusing costs a device offline
 * authentication until somebody confirms it; granting wrongly cannot be undone.
 *
 * **Nothing here affects selling.** A refused device still trades, still syncs,
 * still serves its own tills over the LAN with the branch secret. The only thing
 * withheld is the branch roster.
 */

import { supabase } from './supabase';
import { isNodeRole } from './deviceRegistry';

/** Mirrors REBIND_WINDOW_MINUTES in deviceBinding.ts — same act, same shape. */
export const ROLE_HANDOVER_WINDOW_MINUTES = 60;

export interface RoleVerdict {
  /** May this device be treated as its branch's server? */
  confirmed: boolean;
  code?: 'not_serving' | 'unconfirmed' | 'conflict' | 'unknown_device';
  /** Safe to show a human. */
  reason?: string;
  /** The device id that already holds the role, when there is a conflict. */
  heldBy?: string | null;
}

/**
 * Confirm — or on first sight, establish — that this device serves its branch.
 *
 * Called from the registration path, so a branch server confirms itself simply
 * by signing in, with no owner interaction. That is deliberate: this product is
 * aimed at remote sites where "wait for the owner to open the dashboard" means
 * the shop does not open.
 *
 * Never throws. A confirmation problem must not stop a sign-in; it withholds
 * credentials, nothing more.
 */
export async function confirmServingRole(
  businessId:  string,
  deviceId:    string,
  claimedRole: string | null | undefined,
): Promise<RoleVerdict> {
  if (!isNodeRole(claimedRole)) {
    return { confirmed: false, code: 'not_serving' };
  }

  try {
    // The branch is read from the device's OWN server-side row, never accepted
    // from a caller. `user_devices.branch_id` is what migration 52 bound and the
    // machine cannot edit — which is the entire reason that migration exists. A
    // branch supplied by the request would be a second claim propping up the
    // first, and this function's job is to stop exactly that.
    const { data: self, error: selfErr } = await supabase
      .from('user_devices')
      .select('branch_id')
      .eq('business_id', businessId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (selfErr || !self) return { confirmed: false, code: 'unknown_device' };

    const branchId = (self as any).branch_id as string | null;

    // A serving role is meaningless without a branch — the uniqueness guarantee
    // is per branch, and a NULL would let every unbound machine claim the same
    // empty slot. Migration 52 binds on first sighting, so this resolves itself
    // on the next sync rather than needing anybody to act.
    if (!branchId) {
      return { confirmed: false, code: 'unconfirmed',
               reason: 'This machine has no branch recorded yet, so it cannot be confirmed as that branch\'s server.' };
    }

    const { data: rows, error } = await supabase
      .from('user_devices')
      .select('id, device_id, device_role, role_confirmed_at, role_change_allowed_until, status')
      .eq('business_id', businessId)
      .eq('branch_id', branchId)
      .eq('status', 'approved')
      .in('device_role', ['node', 'office']);

    if (error) {
      // Cannot tell. Refuse — see the header: this path fails closed.
      console.warn('[deviceRole] could not read serving devices:', error.message);
      return { confirmed: false, code: 'unconfirmed', reason: 'Could not verify this machine\'s role.' };
    }

    const all      = (rows ?? []) as any[];
    const me       = all.find(r => r.device_id === deviceId);
    const incumbent = all.find(r => r.role_confirmed_at && r.device_id !== deviceId);

    if (!me) return { confirmed: false, code: 'unknown_device' };

    // Already confirmed, and still the only one. Nothing to do.
    if (me.role_confirmed_at && !incumbent) {
      return { confirmed: true };
    }

    // ── Somebody else holds it ────────────────────────────────────────────
    if (incumbent) {
      const windowOpen = incumbent.role_change_allowed_until
        && new Date(incumbent.role_change_allowed_until).getTime() > Date.now();

      if (!windowOpen) {
        // Record the refusal. Two machines claiming to serve one branch is
        // either a mistake or an impersonation, and A22 (split brain after a
        // promotion) is the common innocent cause — an old node unplugged
        // rather than dead, then reconnected. Either way somebody should see it.
        await supabase.from('user_devices').update({
          role_conflict_at:   new Date().toISOString(),
          role_conflict_with: incumbent.id,
        }).eq('id', me.id);

        console.warn(
          `[deviceRole] ${deviceId} claimed to serve branch ${branchId}, which ${incumbent.device_id} already holds. ` +
          `Refused. Grant a handover window to change it.`,
        );
        return {
          confirmed: false,
          code: 'conflict',
          heldBy: incumbent.device_id,
          reason: 'Another machine is already registered as this branch\'s server. ' +
                  'Authorise a handover from the dashboard to move it.',
        };
      }

      // ── Authorised handover ─────────────────────────────────────────────
      // Clear the outgoing device FIRST. `user_devices_one_server_per_branch`
      // forbids two confirmed rows, so doing it the other way round would be
      // refused by the index — and an interruption between the two leaves the
      // branch with NO confirmed server, which is the direction this must fail.
      const { error: clearErr } = await supabase.from('user_devices').update({
        role_confirmed_at:         null,
        role_confirmed_by:         null,
        role_change_allowed_until: null,
        role_change_authorised_by: null,
      }).eq('id', incumbent.id);

      if (clearErr) {
        console.warn('[deviceRole] handover aborted, incumbent not cleared:', clearErr.message);
        return { confirmed: false, code: 'conflict', heldBy: incumbent.device_id,
                 reason: 'Could not complete the handover. The previous server is still registered.' };
      }
      console.log(`[deviceRole] handover: branch ${branchId} server moves from ${incumbent.device_id} to ${deviceId}`);
    }

    // ── Take the role ─────────────────────────────────────────────────────
    const { error: setErr } = await supabase.from('user_devices').update({
      role_confirmed_at:  new Date().toISOString(),
      role_conflict_at:   null,
      role_conflict_with: null,
    }).eq('id', me.id);

    if (setErr) {
      // 23505 = another machine won the same race. Correct outcome: exactly one
      // confirmed server exists, it simply is not this one.
      if ((setErr as { code?: string }).code === '23505') {
        return { confirmed: false, code: 'conflict',
                 reason: 'Another machine was confirmed as this branch\'s server first.' };
      }
      console.warn('[deviceRole] could not confirm role:', setErr.message);
      return { confirmed: false, code: 'unconfirmed' };
    }

    console.log(`[deviceRole] ${deviceId} confirmed as server for branch ${branchId}`);
    return { confirmed: true };
  } catch (err: any) {
    console.warn('[deviceRole] unexpected failure:', err?.message ?? err);
    return { confirmed: false, code: 'unconfirmed' };
  }
}

/**
 * The gate PHASE5 §4b must call before any branch credential crosses to a
 * device. Reads only — it never confirms as a side effect, because a read that
 * quietly grants is how a check stops being one.
 *
 * Fails closed on every uncertainty, including its own errors.
 */
export async function isConfirmedBranchServer(
  businessId: string,
  deviceId:   string | null | undefined,
): Promise<boolean> {
  if (!businessId || !deviceId) return false;
  try {
    const { data, error } = await supabase
      .from('user_devices')
      .select('id')
      .eq('business_id', businessId)
      .eq('device_id', deviceId)
      .eq('status', 'approved')
      .in('device_role', ['node', 'office'])
      .not('role_confirmed_at', 'is', null)
      .maybeSingle();
    if (error) {
      console.warn('[deviceRole] gate check failed, refusing:', error.message);
      return false;
    }
    return !!data;
  } catch {
    return false;
  }
}
