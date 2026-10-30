/**
 * tillIdentity.ts — A477: the till's key is bound to its machine.
 *
 * Owner, 2026-10-14: the key bound to the machine (MAC + serial) "to confirm that this till is in the system".
 *
 * A till sends X-Device-Mac (as A182), X-Device-Guid (SHA-256 of the Windows MachineGuid) and X-Device-Serial (SHA-256 of
 * the BIOS serial) on enrolment, renewal, the renewal's ack and the device grant. The first time the cloud sees them on a
 * till's row it keeps them (trust on first use); after that a renewal or a device grant passes when the guid OR the
 * serial matches (a new MAC is just recorded) and is refused — the session NOT revoked, the owner alerted — when
 * neither does (lib/refreshHandshake.ts identityDecision). A till from before A477 sends no guid / serial and passes, as
 * before. A technician's rejoin (a fresh enrolment code) records the machine it is done on.
 *
 * Before migration 131 the columns are not there: everything passes and nothing is stored.
 */
import { supabase } from './supabase';
import { identityDecision, presentedIdentity, type MachineIdentity } from './refreshHandshake';
import { markTillSecurityAlert } from './tillSessions';

export const MISMATCH_REASON = 'The POS\'s data is being used on another computer (its sign-in came from a machine that is not the one on record)';

export interface TillIdentityResult {
  verdict: 'pass' | 'mismatch';
  /** A stored guid / serial matched, or was stored now. */
  matched: boolean;
  /** The request said which machine it is (an A477 till). */
  presented: boolean;
}

const SEEN_EVERY_MS = 60 * 60_000;

/** Check (and on first sight, record) the machine behind a till's request. Never throws. */
export interface TillIdentityRow { id: string; mac_address?: string | null; machine_guid_hash?: string | null; serial_hash?: string | null; identity_seen_at?: string | null }
/** A593: the columns checkTillIdentity reads — a caller that reads the till's row anyway (the renewal) reads them with it. */
export const IDENTITY_COLS = 'id, mac_address, machine_guid_hash, serial_hash, identity_seen_at';

export async function checkTillIdentity(businessId: string, deviceId: string, header: (name: string) => unknown, now = new Date(),
  known?: TillIdentityRow | null): Promise<TillIdentityResult> {
  const p = presentedIdentity(header);
  const presented = !!(p.guidHash || p.serialHash);
  if (!presented) return { verdict: 'pass', matched: false, presented };
  try {
    // A593: the renewal's own read of the till's row carries these columns — the same row, not a second read.
    const { data, error } = known !== undefined ? { data: known, error: null } : await supabase.from('user_devices')
      .select(IDENTITY_COLS)
      .eq('business_id', businessId).eq('device_id', deviceId).maybeSingle();
    if (error || !data) return { verdict: 'pass', matched: false, presented };   // before migration 131 / no row
    const row = data as { id: string; mac_address?: string | null; machine_guid_hash?: string | null; serial_hash?: string | null; identity_seen_at?: string | null };
    const d = identityDecision({ mac: row.mac_address, guidHash: row.machine_guid_hash, serialHash: row.serial_hash }, p);
    if (d.verdict === 'mismatch') {
      console.error(`[auth] A477 DEVICE_MISMATCH: till ${deviceId} (business ${businessId}) — its key came from another machine; refused, the session kept`);
      await markTillSecurityAlert(businessId, deviceId, MISMATCH_REASON, now);
      return { verdict: 'mismatch', matched: false, presented };
    }
    const seenLongAgo = !row.identity_seen_at || now.getTime() - Date.parse(row.identity_seen_at) > SEEN_EVERY_MS;
    if (d.update || (d.matched && seenLongAgo)) {
      const { error: upErr } = await supabase.from('user_devices')
        .update({ ...(d.update ?? {}), identity_seen_at: now.toISOString() }).eq('id', row.id);
      if (upErr) console.warn('[auth] A477: the till\'s machine could not be recorded', { deviceId, error: upErr.message });
    }
    return { verdict: 'pass', matched: d.matched, presented };
  } catch {
    return { verdict: 'pass', matched: false, presented };
  }
}

/** A technician's rejoin: the machine it is done on becomes the till's machine (nothing presented → cleared). */
export async function resetTillIdentity(businessId: string, deviceId: string, header: (name: string) => unknown, now = new Date()): Promise<void> {
  const p: MachineIdentity = presentedIdentity(header);
  try {
    const { error } = await supabase.from('user_devices').update({
      machine_guid_hash: p.guidHash ?? null, serial_hash: p.serialHash ?? null,
      identity_seen_at: p.guidHash || p.serialHash ? now.toISOString() : null,
    }).eq('business_id', businessId).eq('device_id', deviceId);
    if (error && !/machine_guid_hash|serial_hash|identity_seen_at|PGRST204|42703/.test(`${error.message} ${(error as any).code ?? ''}`)) {
      console.warn('[enrol] A477: the till\'s machine could not be recorded', { deviceId, error: error.message });
    }
  } catch { /* the join stands without it */ }
}
