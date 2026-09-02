/**
 * adminSeedGuard.ts — refuse the published seed credential, audit C4.
 *
 * migrations/admin_portal.sql and swiftpos_consolidated_migration.sql both seed
 * admin_users with a bcrypt hash that is a widely circulated tutorial example.
 * Its plaintext is public. Migration 48 disables and scrambles that row, and adds
 * a CHECK constraint so it cannot come back — but a migration only protects a
 * database somebody remembered to run it against.
 *
 * This is the same rule enforced in the code path, so a database that missed the
 * migration still cannot be logged into with a password the whole internet has.
 *
 * ── WHY THIS IS CHECKED AT LOGIN AND NOT AT BOOT ────────────────────────────
 * A boot check would need global state — a flag saying "this deployment is
 * compromised" — and then a decision about what to do when the check itself
 * fails. Failing closed locks an operator out of their own portal over a
 * transient database blip; failing open makes the check advisory. Neither is
 * good, and both are avoidable: the login handler already holds the exact row it
 * is about to authenticate, so it can simply refuse THAT row. No global state, no
 * availability risk, and correct even if the row is created a minute from now.
 *
 * The boot-time report below is therefore a diagnostic, not a gate. It exists so
 * the problem is visible in the log rather than only at the moment someone tries
 * to exploit it.
 */

import { supabase } from './supabase';

/**
 * The published hash. Present in the repository, in every archive of it, and in
 * whatever tutorial it was copied from originally.
 */
export const SEEDED_ADMIN_HASH =
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/Lewm8mCWhBiQF7zO2';

export function isSeededAdminHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && hash === SEEDED_ADMIN_HASH;
}

/**
 * What to tell someone who presents the seed credential.
 *
 * Deliberately explicit rather than a generic "Invalid credentials". Whoever
 * sees this is either the operator — who needs to know the account was retired
 * and how to restore it — or an attacker holding a password that no longer
 * works, to whom the message tells nothing they could not already establish by
 * reading the public repository.
 */
export const SEEDED_ADMIN_MESSAGE =
  'This account uses the published default password and has been retired. ' +
  'Restore access with: ADMIN_PASSWORD=<strong-password> npx tsx src/scripts/reset-admin.ts';

/**
 * Boot-time diagnostic. Never throws and never blocks startup: the POS API and
 * the admin portal share a process, and refusing to serve a shop's tills because
 * of an admin-portal seed would be a worse outcome than the seed itself.
 */
export async function reportSeededAdmins(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('email, is_active')
      .eq('password_hash', SEEDED_ADMIN_HASH);

    if (error) {
      console.warn('[adminSeedGuard] could not check for seeded admins:', error.message);
      return;
    }
    if (!data?.length) return;

    const active = data.filter((a: { is_active?: boolean }) => a.is_active !== false);
    console.error(
      `[adminSeedGuard] ${data.length} admin account(s) still carry the PUBLISHED seed password: ` +
      data.map((a: { email: string }) => a.email).join(', ') +
      `. ${active.length} of them ${active.length === 1 ? 'is' : 'are'} active. ` +
      'Login is refused for these regardless, but run migrations/48_retire_seeded_admin.sql ' +
      'and then scripts/reset-admin.ts to clear this properly.',
    );
  } catch (err: any) {
    console.warn('[adminSeedGuard] check failed:', err?.message ?? err);
  }
}
