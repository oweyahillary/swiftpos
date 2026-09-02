/**
 * deviceRegistry.ts — a desktop till records itself, always.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * `user_devices` had no row for Beryl's till at all, and three subsystems that
 * look healthy were quietly doing nothing as a result:
 *
 *   * `checkDeviceBranch` returns ok:true for an unknown device — by design,
 *     "registration's job, not ours". So migration 52's anti-relocation control
 *     was inert: a till could be moved between branches and nothing would know.
 *   * `sync.ts`'s telemetry UPDATE matched no rows, so `app_version` and
 *     `schema_version` were never recorded and every diagnosis needed somebody
 *     physically at the machine. Worse, its warning blamed migration 43, which
 *     IS applied — a confidently wrong diagnostic.
 *   * The server cannot tell a node from an ordinary till (register A25), which
 *     blocks PHASE5 §4b: nothing may hand out branch credentials until the
 *     caller's role can be verified server-side.
 *
 * ── WHY NO ROW EXISTED ──────────────────────────────────────────────────────
 * `checkDeviceRegistration` (auth.ts) returns early unless the business has
 * opted into `require_device_registration`, and again for owners and elevated
 * roles. Beryl never opted in, and a desktop till signs in as the owner, so it
 * fell through both gates. Nothing was broken; registration was simply never
 * reached.
 *
 * ── APPROVAL AND REGISTRATION ARE DIFFERENT THINGS ──────────────────────────
 * That flag gates the right thing for the wrong population. It means "cashiers
 * must be approved before signing in from a new BROWSER" — a genuine, optional
 * security policy, and it is left exactly as it was.
 *
 * A desktop till is not a browser. It has a stable device_id generated once at
 * setup, it is bound to a branch, and it is the unit migration 52 exists to
 * control. **A till is a registered terminal by nature.** So registration here
 * is unconditional and independent of that setting.
 *
 * ── WHY 'approved' AND NOT 'pending' ────────────────────────────────────────
 * A pending row would block the shop until somebody opened the dashboard and
 * clicked — unacceptable at the remote, thin-internet sites this product is
 * being aimed at, and it would turn a diagnostic improvement into an outage.
 *
 * The trade is defensible: reaching this code already required a valid owner
 * token or a verified PIN against the business, which proves more than a
 * browser fingerprint does. Approval keeps its meaning where it was designed to
 * have it — browsers, via the untouched opt-in flag.
 *
 * Registration is NOT authorisation. This records that a terminal exists so it
 * can be seen, bound and diagnosed. It grants nothing. A25 still stands: before
 * any branch credential crosses to a device, `device_role` must be established
 * and verified, and that is deliberately not done here.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not set `branch_id`. `checkDeviceBranch` binds on first sighting and
 * owns the rebind window, the relocation history and the terminal-code conflict
 * rules. Guessing a branch here would pre-empt that and could bind a till to the
 * wrong branch permanently.
 *
 * Never throws. A telemetry row must not stop a shop trading.
 */

import { pickPriorTerminal, isMac, PriorTerminal } from './deviceRestore';
import { supabase } from './supabase';

export interface TerminalIdentity {
  deviceId:     string;
  appVersion?:  string | null;
  terminalCode?: string | null;
  ipAddress?:   string | null;
  label?:       string | null;
  /**
   * What the terminal says it is: 'till', 'node' or 'office'. A CLAIM, recorded
   * so it can be seen and audited — never on its own sufficient to authorise
   * anything. Migration 73.
   */
  role?:        string | null;
  /** A182: stable machine MAC (X-Device-Mac). A hint for identity restoration on
   *  reinstall, never a credential. */
  macAddress?:  string | null;
}

/** The three roles a desktop terminal may report (deviceConfig.ts:26). */
export const DEVICE_ROLES = ['till', 'node', 'office'] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

/**
 * Anything else — an unknown string, an empty header, an older build that sends
 * nothing — becomes null, meaning "has not reported". Migration 73's CHECK would
 * reject a bad value and take the whole registration down with it, so it is
 * filtered here rather than relied upon there.
 */
export function normaliseDeviceRole(raw: unknown): DeviceRole | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return (DEVICE_ROLES as readonly string[]).includes(v) ? (v as DeviceRole) : null;
}

/**
 * Does this machine SERVE its branch? The server-side twin of
 * `deviceConfig.isNodeRole()`, and the reason it exists is the warning in that
 * file: *"comparing against the literal 'node' anywhere else is how office
 * machines fall through cracks."*
 *
 * An office machine serves the branch and cannot sell. For every question about
 * serving — PHASE5 credential distribution, branch replication, promotion — it
 * counts, and it is arguably the BETTER holder of branch credentials because it
 * is the machine that is safe unattended.
 *
 * Never write `role === 'node'` anywhere. Use this.
 */
export function isNodeRole(role: string | null | undefined): boolean {
  return role === 'node' || role === 'office';
}

/** May this machine sell? A separate question from isNodeRole — do not conflate. */
export function canSell(role: string | null | undefined): boolean {
  return role !== 'office';
}

/**
 * Does this error mean a column is missing rather than the write being wrong?
 *
 * Migration 73 adds `device_role` and `role_reported_at`. Only 20 of this
 * repository's 66 migrations record themselves in `schema_migrations`, and 68
 * and 72 are absent from it entirely (register A4) — so "the migration has not
 * been applied" is a normal state here, not an edge case. A terminal must still
 * register when it happens.
 *
 * 42703 is Postgres' undefined_column; PGRST204 is PostgREST's schema-cache
 * equivalent, which is what actually surfaces through supabase-js.
 */
function isMissingColumn(err: { code?: string; message?: string }): boolean {
  const code = err?.code ?? '';
  if (code === '42703' || code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(err?.message ?? '');
}

/** The same patch with migration 73's columns removed. */
function withoutRoleColumns(patch: Record<string, unknown>): Record<string, unknown> {
  // Also drops mac_address (migration 93) — an older DB has neither, and the
  // registration must still land without the newest optional columns (A182).
  const { device_role: _r, role_reported_at: _t, mac_address: _m, ...rest } = patch;
  return rest;
}

/** A readable label for the fleet view, so an office box is not shown as a till. */
function labelFor(role: DeviceRole | null, given?: string | null): string {
  if (given) return String(given).slice(0, 64);
  switch (role) {
    case 'office': return 'SwiftPOS office server (view only)';
    case 'node':   return 'SwiftPOS till (branch server)';
    default:       return 'SwiftPOS till';
  }
}

/**
 * The fingerprint column is NOT NULL and, for browsers, holds a hash of headers.
 * A desktop till has something better: a device_id it generated once at setup
 * and keeps. Namespacing it keeps desktop identities in their own space so a
 * till can never collide with a browser fingerprint, and makes the origin of a
 * row obvious when reading the table by hand.
 */
export function desktopFingerprint(deviceId: string): string {
  return `desktop:${deviceId}`;
}

/**
 * Record (or refresh) this terminal. Returns the row id, or null if it could
 * not be recorded — callers should carry on regardless.
 */
export async function registerDesktopTerminal(
  businessId: string,
  userId:     string,
  identity:   TerminalIdentity,
): Promise<string | null> {
  const deviceId = String(identity.deviceId ?? '').trim().slice(0, 64);
  if (!businessId || !userId || !deviceId) return null;

  const now = new Date().toISOString();

  try {
    // Match on device_id, which is what `user_devices_device_id_unique`
    // (business_id, device_id) WHERE device_id IS NOT NULL enforces. Not on
    // user_id: the terminal is the thing being registered, and several staff
    // sign in on the same machine all day.
    const { data: existing, error: findErr } = await supabase
      .from('user_devices')
      .select('id, status')
      .eq('business_id', businessId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (findErr) {
      console.warn('[deviceRegistry] lookup failed, terminal not recorded:', findErr.message);
      return null;
    }

    const role = normaliseDeviceRole(identity.role);

    const patch: Record<string, unknown> = { last_seen_at: now };
    if (identity.appVersion)   patch.app_version   = String(identity.appVersion).slice(0, 32);
    if (identity.terminalCode) patch.terminal_code = String(identity.terminalCode).slice(0, 32);
    if (identity.ipAddress)    patch.ip_address    = identity.ipAddress;
    // A182: bind the machine MAC so a reinstall can be recognised and re-named
    // to its old terminal code. Normalised lower-case; only written when sent.
    if (identity.macAddress) {
      const mac = String(identity.macAddress).toLowerCase().trim().slice(0, 32);
      if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) patch.mac_address = mac;
    }
    // Migration 73. Only written when the terminal actually reported one — an
    // older build sends nothing, and overwriting a known role with NULL would
    // make a branch server look like a counter till until its next upgrade.
    if (role) {
      patch.device_role     = role;
      patch.role_reported_at = now;
    }

    if (existing) {
      // Deliberately does NOT touch `status`. If an owner rejected this
      // terminal, signing in again must not quietly re-approve it — that would
      // make the reject button meaningless.
      const { error: updErr } = await supabase
        .from('user_devices').update(patch).eq('id', (existing as any).id);

      if (updErr && isMissingColumn(updErr)) {
        // Migration 73 not applied. Drop the role and keep the rest — see
        // withoutRoleColumns.
        const { error: retryErr } = await supabase
          .from('user_devices').update(withoutRoleColumns(patch)).eq('id', (existing as any).id);
        if (retryErr) console.warn('[deviceRegistry] refresh failed:', retryErr.message);
      } else if (updErr) {
        console.warn('[deviceRegistry] refresh failed:', updErr.message);
      }
      return (existing as any).id;
    }

    const baseRow = {
      user_id:      userId,
      business_id:  businessId,
      fingerprint:  desktopFingerprint(deviceId),
      device_id:    deviceId,
      device_label: labelFor(role, identity.label),
      status:       'approved',   // see the header — registration is not authorisation
      requested_at: now,
      reviewed_at:  now,
    };

    let { data: created, error: insErr } = await supabase
      .from('user_devices')
      .insert({ ...baseRow, ...patch })
      .select('id')
      .maybeSingle();

    // Migration 73 not applied: the role columns do not exist. Register the
    // terminal ANYWAY without them. Registration is the thing that unblocks
    // branch binding and telemetry; the role is an enhancement, and losing the
    // whole row because one column is missing would be the tail wagging the dog.
    if (insErr && isMissingColumn(insErr)) {
      console.warn('[deviceRegistry] role columns absent — is migration 73 applied? Registering without them.');
      ({ data: created, error: insErr } = await supabase
        .from('user_devices')
        .insert({ ...baseRow, ...withoutRoleColumns(patch) })
        .select('id')
        .maybeSingle());
    }

    if (insErr) {
      // 23505 = two sign-ins raced and the other won. That is a success from
      // this caller's point of view: the terminal is registered.
      if ((insErr as { code?: string }).code === '23505') {
        const { data: raced } = await supabase
          .from('user_devices')
          .select('id')
          .eq('business_id', businessId)
          .eq('device_id', deviceId)
          .maybeSingle();
        return (raced as any)?.id ?? null;
      }
      console.warn('[deviceRegistry] could not register terminal:', insErr.message);
      return null;
    }

    console.log(`[deviceRegistry] registered terminal ${deviceId} for business ${businessId}`);
    return (created as any)?.id ?? null;
  } catch (err: any) {
    // Never let this stop a sign-in.
    console.warn('[deviceRegistry] unexpected failure:', err?.message ?? err);
    return null;
  }
}

// ── A182: identity restoration by MAC ────────────────────────────────────────

/**
 * Find the terminal code/name a reinstalled machine should get back. Given the
 * business and the machine's MAC, returns the most-recently-seen OTHER device that
 * shares that MAC, or null. Never throws.
 */
export async function findPriorTerminalByMac(
  businessId: string, macAddress: string, currentDeviceId: string,
): Promise<PriorTerminal | null> {
  const mac = String(macAddress || '').toLowerCase().trim();
  if (!businessId || !isMac(mac)) return null;
  try {
    const { data, error } = await supabase
      .from('user_devices')
      .select('terminal_code, device_label, device_id, last_seen_at')
      .eq('business_id', businessId)
      .eq('mac_address', mac);
    if (error) {                           // e.g. migration 93 not applied → column missing
      if (!isMissingColumn(error)) console.warn('[deviceRegistry] mac lookup failed:', error.message);
      return null;
    }
    return pickPriorTerminal((data ?? []) as PriorTerminal[], String(currentDeviceId ?? ''));
  } catch (err: any) {
    console.warn('[deviceRegistry] mac lookup error:', err?.message ?? err);
    return null;
  }
}
