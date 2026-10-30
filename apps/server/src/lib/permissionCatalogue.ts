/**
 * permissionCatalogue — the single source of truth for every permission key the
 * app uses, plus a boot-time self-heal that guarantees the live DB catalogue is
 * complete.
 *
 * WHY (A213): permission keys were registered piecemeal across migrations. A
 * consolidated-dump bootstrap can mark those migrations "applied" while their rows
 * are absent (the A211/A212/A220 root), so the live `permissions` table ends up
 * missing keys. An unregistered key can never attach to a role, so
 * `requirePermission` fails closed and the matching nav item silently disappears —
 * exactly the manager-portal breakage we chased. `seedDefaultRolePermissions`
 * makes it worse: it derives grants from whatever is *live*, so a missing key is
 * silently never granted.
 *
 * The durable fix is here: one canonical list, registered idempotently on every
 * boot (INSERT ... ON CONFLICT (key) DO NOTHING). Any DB that is missing a key —
 * for any reason — heals on the next deploy, for every tenant at once (the
 * catalogue is global; it has no business_id). Adding a new permission is a
 * one-line edit here, and `check-permission-catalogue` fails CI if code ever
 * references a key that is not in this list.
 *
 * Registration only — this never grants anything and never overwrites an existing
 * row (DO NOTHING), so it can't disturb an owner's configured rights.
 */

import { supabase } from './supabase';

import { PERMISSIONS, LEGACY } from '@zaptill/core/permissions';

export interface PermissionRow {
  key: string;
  label: string;
  module: string;
  description: string;
}

/**
 * A490: the rows the live `permissions` table must hold — every FINE key of the shared catalogue (permissions.ts, the
 * one place a key is defined), plus the broad keys it replaced, which stay registered (old role grants and overrides
 * reference them by id until migration 134 rewrites them; nothing checks them any more).
 */
export const PERMISSION_CATALOGUE: PermissionRow[] = [
  ...PERMISSIONS.map((p) => ({ key: p.key, label: p.label, module: p.group, description: p.description })),
  ...Object.keys(LEGACY).map((k) => ({ key: k, label: `${k} (replaced)`, module: 'legacy',
    description: `Replaced by A490 — stands for: ${LEGACY[k].join(', ')}` })),
];

/** All canonical keys, for quick membership checks. */
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE.map(p => p.key));

/**
 * Idempotently register every canonical key in the live catalogue. Safe to run on
 * every boot: it never overwrites an existing row and never grants anything. Never
 * throws — a shop's tills must not fail to start over this (mirrors the other boot
 * diagnostics in index.ts).
 */
export async function ensurePermissionsRegistered(): Promise<void> {
  try {
    const { error } = await supabase
      .from('permissions')
      .upsert(PERMISSION_CATALOGUE, { onConflict: 'key', ignoreDuplicates: true });
    if (error) {
      console.warn('[permissionCatalogue] could not self-heal the permissions catalogue:', error.message);
      return;
    }
    console.log(`[permissionCatalogue] catalogue verified (${PERMISSION_CATALOGUE.length} keys ensured registered)`);
  } catch (e: any) {
    console.warn('[permissionCatalogue] self-heal threw (ignored):', e?.message ?? e);
  }
}
