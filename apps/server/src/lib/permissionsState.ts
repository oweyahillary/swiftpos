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
/** A595: the migration that carries every holder of a broad key over to its parts (shared permissions.ts SPLITS). */
export const SPLITS_MIGRATION = '176_permission_splits';
const REFRESH_MS = 5 * 60_000;

let migrated = false;
let splitsMigrated = false;
let checkedAt = 0;
let inFlight: Promise<void> | null = null;

async function check(): Promise<void> {
  try {
    // A595: both answers in one read (A593: no extra call).
    const { data, error } = await supabase.from('schema_migrations').select('version')
      .in('version', [PERMISSIONS_MIGRATION, SPLITS_MIGRATION]);
    if (!error) {
      const got = new Set(((data ?? []) as Array<{ version?: string }>).map((r) => r.version));
      migrated = got.has(PERMISSIONS_MIGRATION);
      splitsMigrated = got.has(SPLITS_MIGRATION);
    }
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

/**
 * A595: true until migration 176 is recorded — every role and override still holds only the broad keys, so a broad key
 * (a parent) brings all of its parts, exactly what it meant before the split (shared permissions.ts withParts). From 176
 * on the stored grants hold the parts themselves, and a part not held was taken away on purpose.
 */
export function splitsPending(now = Date.now()): boolean {
  if (now - checkedAt > REFRESH_MS) void refreshPermissionsState();
  return !splitsMigrated;
}

/** Tests only. */
export function _setPermissionsMigrated(v: boolean): void { migrated = v; checkedAt = Date.now(); }
/** Tests only (A595). */
export function _setSplitsMigrated(v: boolean): void { splitsMigrated = v; checkedAt = Date.now(); }
