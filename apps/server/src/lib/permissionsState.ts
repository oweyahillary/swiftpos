/**
 * permissionsState.ts — A490: has migration 134 rewritten the stored grants into fine keys yet?
 *
 * Until it has, nobody's role holds the keys for what had no check before A490 (giving discounts, cash in / out,
 * seeing every cashier's sales, reservations, parking, fuel, the staff list) — so every person is given them, exactly
 * as before (shared permissions.ts OPEN_BEFORE_A490), and the two POS switches that limited cashiers
 * (cashier_own_history, cashier_no_money_out) still apply. Once 134 is recorded, roles hold those keys themselves and
 * the owner decides per role. Read at boot and every 5 minutes; a failed read keeps the last answer (at first: open).
 */
import { supabase } from './supabase';

export const PERMISSIONS_MIGRATION = '134_permission_catalogue';
const REFRESH_MS = 5 * 60_000;

let migrated = false;
let checkedAt = 0;
let inFlight: Promise<void> | null = null;

async function check(): Promise<void> {
  try {
    const { data, error } = await supabase.from('schema_migrations').select('version')
      .eq('version', PERMISSIONS_MIGRATION).maybeSingle();
    if (!error) migrated = !!data;
  } catch { /* keep the last answer */ }
  checkedAt = Date.now();
}

/** Read now (boot) and keep it fresh. Never throws. */
export async function refreshPermissionsState(): Promise<void> {
  if (!inFlight) inFlight = check().finally(() => { inFlight = null; });
  await inFlight;
}

/** True until migration 134 is recorded: the keys nobody was refused before A490 go to everybody. */
export function permissionsOpenBefore(now = Date.now()): boolean {
  if (now - checkedAt > REFRESH_MS) void refreshPermissionsState();
  return !migrated;
}

/** Tests only. */
export function _setPermissionsMigrated(v: boolean): void { migrated = v; checkedAt = Date.now(); }
