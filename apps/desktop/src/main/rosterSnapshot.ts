// rosterSnapshot.ts — A20 (register A163): replicate the branch staff roster to
// peers so a promoted till can authenticate cashiers and OPEN THE SHOP at the
// moment failover exists to prevent.
//
// A special case of the A24 downstream snapshot channel: the node serves the
// current roster + a version, the peer replaces its `branch_staff` WHOLESALE when
// it changes. It is a SEPARATE channel from /node/reference on purpose — this one
// carries PIN hashes, and keeping the sensitive path distinct and named keeps it
// auditable. The owner has accepted the tradeoff (a stolen peer yields the
// branch's bcrypt hashes; PHASE5 §10.1 "a branch is one trust domain"), with the
// PIN-rotation-on-missing-terminal runbook as the mitigation.
//
// WHY RAW BCRYPT CROSSES THE LAN, NOT THE STORED FORM. `branch_staff.pin_hash_enc`
// is the bcrypt hash wrapped with `safeStorage`, which is bound to the machine /
// OS account that wrapped it — a peer cannot decrypt the node's wrapped form
// (verifyPinAtNode already handles "wrapped under another OS account"). So the
// node UNWRAPS to the raw bcrypt to serve, and each peer RE-WRAPS with its own
// safeStorage via storeBranchStaff. This mirrors exactly how the node itself
// sources the roster from the cloud (raw bcrypt in, wrapped locally).
//
// This module is PURE (no DB, no Electron/safeStorage) so the guards are
// unit-testable. The safeStorage unwrap/rewrap and the DB reads/writes live in
// branchStaff.ts and syncEngine.ts.

/** A roster row as it crosses the wire — raw bcrypt, exactly what storeBranchStaff wants. */
export interface RosterStaff {
  staff_id: string;
  name: string;
  role_name: string | null;
  permissions: unknown;
  pin_hash: string | null;          // raw bcrypt ($2…)
  override_pin_hash: string | null; // raw bcrypt or null
  status: string;
}

export interface RosterSnapshot {
  source: 'node';
  branch_id: string;
  roster_version: string;
  roster: RosterStaff[];
}

const isBcrypt = (h: any): h is string => typeof h === 'string' && h.startsWith('$2');

/** Deterministic content version (FNV-1a). Changes iff the roster changes — incl.
 *  a PIN change — so a peer can skip re-applying an unchanged roster. */
export function rosterVersion(roster: RosterStaff[]): string {
  const key = [...roster]
    .map(s => `${s.staff_id}|${s.pin_hash ?? ''}|${s.override_pin_hash ?? ''}|${s.status}|${s.role_name ?? ''}|${s.name}`)
    .sort()
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Node side: reshape the node's own roster rows (already UNWRAPPED to raw bcrypt
 * by the caller) into the snapshot to serve. Only staff with a usable bcrypt PIN
 * are included — a row with no offline-matchable PIN could never authenticate a
 * peer's cashier anyway, and storeBranchStaff would drop it on the far side.
 */
export function buildRosterSnapshot(branchId: string, rows: RosterStaff[]): RosterSnapshot {
  const roster: RosterStaff[] = (rows ?? [])
    .filter(s => s && s.staff_id && isBcrypt(s.pin_hash))
    .map(s => ({
      staff_id: String(s.staff_id),
      name: String(s.name ?? ''),
      role_name: s.role_name ?? null,
      permissions: s.permissions ?? {},
      pin_hash: s.pin_hash as string,
      override_pin_hash: isBcrypt(s.override_pin_hash) ? s.override_pin_hash : null,
      status: s.status ?? 'active',
    }));
  return { source: 'node', branch_id: String(branchId), roster_version: rosterVersion(roster), roster };
}

export interface RosterApply {
  apply: boolean;
  branchId: string;
  version: string;
  roster: RosterStaff[];
  reason?: string;
}

/**
 * Peer side: validate a snapshot and decide whether to replace the local roster.
 *
 * THE GUARD THAT MATTERS. `storeBranchStaff` replaces wholesale (DELETE+INSERT),
 * so applying an empty or all-pinless snapshot would leave a peer that can
 * authenticate NO ONE — locking the shop out at exactly the moment A20 exists to
 * prevent. Unlike dining tables (legitimately empty for a non-restaurant), a
 * branch ALWAYS has staff, so an empty/pinless roster is ALWAYS a failed pull,
 * never a real state. So we refuse to apply it and keep the good local roster.
 */
export function unpackRosterSnapshot(snapshot: any): RosterApply {
  const empty: RosterApply = { apply: false, branchId: '', version: '', roster: [] };
  if (!snapshot || snapshot.source !== 'node' || !Array.isArray(snapshot.roster)) {
    return { ...empty, reason: 'not a node roster snapshot' };
  }
  const branchId = String(snapshot.branch_id ?? '');
  const version = String(snapshot.roster_version ?? '');
  if (!branchId) return { ...empty, version, reason: 'snapshot has no branch_id' };

  const usable: RosterStaff[] = snapshot.roster.filter((s: any) => s && s.staff_id && isBcrypt(s.pin_hash));
  if (usable.length === 0) {
    return { apply: false, branchId, version, roster: [], reason: 'roster empty or has no usable PINs — refusing to wipe the local roster' };
  }
  return { apply: true, branchId, version, roster: usable };
}
