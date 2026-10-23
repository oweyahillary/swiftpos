// branchStaff.ts — the branch NODE's staff roster (PHASE5 §4a/§4c / A17).
// ─────────────────────────────────────────────────────────────────────────────
// Node-only. Populated from GET /api/pos/branch-staff on every catalogue pull,
// and read by POST /node/verify-pin so the node can authenticate a peer's
// cashier when the cloud is unreachable — closing the day-15 lockout for a
// remote branch.
//
// Mirrors pinCache exactly where it matters: bcrypt only, hashes wrapped with
// safeStorage, scan EVERY candidate and REFUSE ON TWO (a shared PIN books one
// cashier's sales to another; the node has no more right to guess than the
// server). Two deliberate differences from the peer cache:
//   * NO expiry — a node is the branch's authority and its roster is valid until
//     replaced (§4e). staff_pin_cache's TTL is a stolen-peer bound; a node is a
//     different threat model, addressed by the typed-Windows-password rule (§5).
//   * The whole roster is stored, replaced wholesale on each pull, so a
//     deactivated or removed staff member disappears here too.

import { safeStorage } from 'electron';
import bcrypt from 'bcryptjs';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { logLine } from './logFile';
import { overlayLocalChanges } from './localChanges';   // P3: a change made here stays over a stored list
import { isOwnerRole, isOwnerRoleEntry, backOffice, roleMap, refreshPermissionsFromRoster } from './tillAccess';   // A490

export interface BranchStaffRow {
  staff_id: string;
  name: string;
  role_name: string | null;
  permissions: unknown;
  pin_hash: string | null;
  override_pin_hash: string | null;
  status: string;
}

function canWrap(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/**
 * Replace this node's roster for a branch from a fresh pull. Wholesale, not
 * upsert: a staff member deactivated or removed upstream must vanish here, or a
 * sacked cashier keeps signing in at a remote node forever. A staff row with no
 * bcrypt PIN is skipped — it could never be matched offline anyway.
 */
export function storeBranchStaff(branchId: string, roster: BranchStaffRow[]): void {
  if (!canWrap()) { logLine('node', 'safeStorage unavailable — branch roster not stored'); return; }
  const db = getLocalDb();

  const wrap = (h: string | null): string | null => {
    if (!h || !h.startsWith('$2')) return null;   // bcrypt only
    try { return safeStorage.encryptString(h).toString('base64'); } catch { return null; }
  };

  // A496: a till holds ONE branch's list — the branch it is bound to. A till moved to another branch kept the old
  // branch's people (and PINs) for ever: only the incoming branch's rows were replaced. Now every other branch's rows go.
  const bound = (() => { try { return getDeviceConfig()?.branch_id ?? null; } catch { return null; } })();
  if (bound && bound !== branchId) logLine('staff', `a staff list for branch ${branchId.slice(0, 8)} while this till is bound to ${bound.slice(0, 8)} — stored; the old branch's list is dropped`);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM branch_staff WHERE branch_id = ? OR branch_id <> ?`).run(branchId, branchId);
    const ins = db.prepare(`
      INSERT INTO branch_staff
        (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, override_pin_hash_enc, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of roster) {
      const pinEnc = wrap(s.pin_hash);
      if (!pinEnc) continue;
      ins.run(
        s.staff_id, s.name, s.role_name ?? null, branchId,
        // A496: the override (manager approval) PIN hash is no longer kept on a till or served by a branch server —
        // nothing here reads it (approvals are checked by the cloud), and it was one more hash on every machine.
        JSON.stringify(s.permissions ?? {}), pinEnc, null,
        s.status ?? 'active', new Date().toISOString(),
      );
    }
  });

  try { tx(); } catch (err: any) { logLine('node', `could not store branch roster: ${err?.message ?? err}`); return; }
  // A534: the names on shift and day reports come from this list too (the whole pull no longer asks GET /api/staff).
  mirrorRosterNames(db, roster);
  // A490: the list carries each person's CURRENT role and permissions — the saved sign-ins take them, and the person
  // signed in on this till takes theirs at once (a manager who lost a key loses it now, not at their next sign-in).
  if (refreshPermissionsFromRoster(roster.map((r) => ({ staff_id: r.staff_id, role_name: r.role_name, permissions: r.permissions })))) {
    logLine('staff', 'the signed-in person’s permissions changed — the screens follow');
  }
  // P3 (2026-10-14): every path that stores a list lays the changes still waiting back over it — a cashier added or a PIN
  // set here (or relayed to this server) that the cloud has not taken yet. Only staffRoster's path used to; the
  // catalogue pull and promotion stored a list and quietly undid them until the next roster beat.
  // A521 (#6): freshStaff — a relayed staff change this list already shows is done (no longer laid over).
  try { overlayLocalChanges(db, { freshStaff: true }); } catch { /* the next store lays them again */ }
}

/**
 * A534 — staff names from the till's own staff list. Render log 2026-10-19: "[tillScope] DRY-RUN would refuse: a till's
 * own sign-in (device …) asked for staff.view on GET /api/staff". The whole catalogue pull asked the cloud for the whole
 * staff list (staff.view) with the till's own token, only to name cashiers on shift and day reports — names the till
 * already holds in its branch's list (A446). Owner, 2026-10-20: "add all of them since effort is small". The users table
 * (names for attribution) is now filled from that list: upserted, never cleared, so a person who has left keeps their
 * name on the old reports.
 */
export function rosterAsUsers(db: ReturnType<typeof getLocalDb> = getLocalDb()): Array<{ id: string; name: string; roles: { name: string | null }; status: string }> {
  try {
    const rows = db.prepare(`SELECT staff_id, name, role_name, status FROM branch_staff`).all() as Array<{ staff_id: string; name: string; role_name: string | null; status: string | null }>;
    return rows.map((r) => ({ id: r.staff_id, name: r.name, roles: { name: r.role_name ?? null }, status: r.status ?? 'active' }));
  } catch { return []; }
}
/** A534: the list's names into users (the names reports print). Never throws, never deletes. */
function mirrorRosterNames(db: ReturnType<typeof getLocalDb>, roster: BranchStaffRow[]): void {
  try {
    const up = db.prepare(`
      INSERT INTO users (id, name, role_name, status, synced_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, role_name=excluded.role_name, status=excluded.status, synced_at=excluded.synced_at
    `);
    const now = new Date().toISOString();
    db.transaction(() => { for (const s of roster) if (s?.staff_id && s.name) up.run(s.staff_id, s.name, s.role_name ?? null, s.status ?? 'active', now); })();
  } catch { /* the next list names them */ }
}

/**
 * A531: one person at a time — a change from GET /api/pos/changes (or the branch server's /node/live). Owner, 2026-10-19:
 * "if Eugene's PIN changes only Eugene's change gets synced, not all 150 staff." `upserts` are roster rows exactly as the
 * whole list carries them (bcrypt only — a row without one is removed: it could never be matched offline); `removeIds` are
 * people no longer on this branch's list (inactive, moved, deleted). The rest of the list is left as it is. As after a
 * whole list: the saved sign-ins of the people changed follow (a removed person's, or one whose PIN changed, go), the
 * signed-in person's permissions follow, and changes still waiting here are laid back over. Returns how many rows changed.
 */
export function applyBranchStaffChanges(branchId: string, upserts: BranchStaffRow[], removeIds: string[]): number {
  if (!canWrap()) { logLine('node', 'safeStorage unavailable — staff change not stored'); return 0; }
  const db = getLocalDb();
  const wrap = (h: string | null): string | null => {
    if (!h || !h.startsWith('$2')) return null;   // bcrypt only
    try { return safeStorage.encryptString(h).toString('base64'); } catch { return null; }
  };
  let n = 0;
  const gone = new Set(removeIds);
  const tx = db.transaction(() => {
    // A496: a till holds ONE branch's list — a change for another branch is not this till's (rows of another branch go).
    db.prepare(`DELETE FROM branch_staff WHERE branch_id <> ?`).run(branchId);
    const del = db.prepare(`DELETE FROM branch_staff WHERE staff_id = ? AND branch_id = ?`);
    const ins = db.prepare(`
      INSERT INTO branch_staff
        (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, override_pin_hash_enc, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const id of removeIds) n += del.run(id, branchId).changes;
    for (const s of upserts) {
      del.run(s.staff_id, branchId);
      const pinEnc = wrap(s.pin_hash);
      if (!pinEnc || (s.status ?? 'active') !== 'active') { gone.add(s.staff_id); n++; continue; }
      ins.run(s.staff_id, s.name, s.role_name ?? null, branchId, JSON.stringify(s.permissions ?? {}), pinEnc, null,
        s.status ?? 'active', new Date().toISOString());
      n++;
    }
  });
  try { tx(); } catch (err: any) { logLine('node', `could not store a staff change: ${err?.message ?? err}`); return 0; }
  // Saved sign-ins of exactly these people: gone → dropped; a new PIN → the old saved one dropped.
  try {
    const drop = db.prepare(`DELETE FROM staff_pin_cache WHERE staff_id = ? AND branch_id = ?`);
    for (const id of gone) drop.run(id, branchId);
    const rows = db.prepare(`SELECT staff_id, pin_hash_enc FROM staff_pin_cache WHERE branch_id = ?`).all(branchId) as Array<{ staff_id: string; pin_hash_enc: string }>;
    const fresh = new Map(upserts.map((s) => [s.staff_id, s.pin_hash]));
    for (const r of rows) {
      if (!fresh.has(r.staff_id)) continue;
      let saved = '';
      try { saved = safeStorage.decryptString(Buffer.from(r.pin_hash_enc, 'base64')); } catch { saved = ''; }
      if (saved && saved !== fresh.get(r.staff_id)) drop.run(r.staff_id, branchId);
    }
  } catch { /* the next whole list prunes */ }
  if (refreshPermissionsFromRoster(upserts.map((r) => ({ staff_id: r.staff_id, role_name: r.role_name, permissions: r.permissions })))) {
    logLine('staff', 'the signed-in person’s permissions changed — the screens follow');
  }
  try { overlayLocalChanges(db, { freshStaff: true }); } catch { /* the next store lays them again */ }
  return n;
}

/**
 * A20: read this node's roster for SERVING to peers, unwrapping each PIN hash back
 * to raw bcrypt.
 *
 * The stored `pin_hash_enc` is safeStorage-wrapped, and safeStorage is bound to
 * the machine/OS account that wrapped it — a peer could not decrypt the node's
 * wrapped form. So the node unwraps to the raw bcrypt here, the peer re-wraps with
 * its own safeStorage via storeBranchStaff. A row this node itself cannot unwrap
 * (wrapped under another OS account) is skipped, not served half-formed. Returns
 * the shape rosterSnapshot.buildRosterSnapshot expects.
 */
export function readBranchStaffForServe(branchId: string): Array<{
  staff_id: string; name: string; role_name: string | null; permissions: unknown;
  pin_hash: string | null; override_pin_hash: string | null; status: string;
}> {
  if (!canWrap()) { logLine('node', 'safeStorage unavailable — cannot serve branch roster'); return []; }
  const unwrap = (enc: string | null | undefined): string | null => {
    if (!enc) return null;
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
  };
  let rows: any[];
  try {
    rows = getLocalDb().prepare(`SELECT * FROM branch_staff WHERE branch_id = ? AND COALESCE(status, 'active') = 'active'`).all(branchId) as any[];   // A459: an inactive person is neither served nor signed in
  } catch { return []; }

  const out: any[] = [];
  for (const r of rows) {
    const pin = unwrap(r.pin_hash_enc);
    if (!pin) continue;                       // unusable here — don't serve a PIN-less row
    let permissions: unknown = {};
    try { permissions = JSON.parse(r.permissions ?? '{}'); } catch { /* default */ }
    out.push({
      staff_id: r.staff_id, name: r.name, role_name: r.role_name ?? null, permissions,
      pin_hash: pin, override_pin_hash: null, status: r.status ?? 'active',   // A496: never served
    });
  }
  return out;
}

export type NodeVerdict =
  | { ok: true; staff: { staffId: string; name: string; roleName: string | null; permissions: unknown } }
  | { ok: false; reason: 'no_roster' | 'no_match' | 'ambiguous' | 'unavailable'; message: string };

/**
 * Verify a PIN against the node's roster. Scans every entry and refuses on two,
 * exactly as the server and pinCache do. No JWT is minted — the caller (a peer)
 * gets the identity and permissions and pushes orders under its own till token
 * with this cashier_id, unchanged from the online path.
 */
/**
 * F16 (2026-10-14): the same check without blocking. The branch server answers /node/verify-pin inside the app's own
 * main process, and bcrypt.compareSync over a branch of 20 staff is ~20 × 80 ms of a frozen server window per PIN
 * typed on any till. Scans every candidate and refuses on two, exactly like verifyPinAtNode.
 */
export async function verifyPinAtNodeAsync(pin: string, branchId: string): Promise<NodeVerdict> {
  if (!canWrap()) {
    return { ok: false, reason: 'unavailable', message: 'This branch server cannot read its roster.' };
  }
  let rows: any[];
  try {
    rows = getLocalDb().prepare(`SELECT * FROM branch_staff WHERE branch_id = ? AND COALESCE(status, 'active') = 'active'`).all(branchId) as any[];
  } catch { rows = []; }
  if (rows.length === 0) {
    return { ok: false, reason: 'no_roster', message: 'This branch server has no staff roster yet.' };
  }
  const matches: any[] = [];
  for (const row of rows) {
    let hash: string;
    try { hash = safeStorage.decryptString(Buffer.from(row.pin_hash_enc, 'base64')); }
    catch { continue; }
    if (await bcrypt.compare(pin, hash)) matches.push(row);
  }
  if (matches.length > 1) {
    logLine('node', `node verify-pin refused: ${matches.length} staff share this PIN`);
    return { ok: false, reason: 'ambiguous', message: 'This PIN is shared by more than one staff member. Ask a manager to reset it.' };
  }
  if (matches.length === 0) return { ok: false, reason: 'no_match', message: 'Invalid PIN' };
  const m = matches[0];
  let permissions: unknown = {};
  try { permissions = JSON.parse(m.permissions ?? '{}'); } catch { /* default */ }
  logLine('node', `node verify-pin: ${m.name}`);
  return { ok: true, staff: { staffId: m.staff_id, name: m.name, roleName: m.role_name, permissions } };
}

// ── F7: staff changes handed to the branch server by a till ───────────────────────────────────────────────────────
// /node/changes applies a till's change here too (A448). For staff, the till used to send the new person's role NAME
// and PERMISSIONS alongside (`_local`) — and the server wrote them into its list as given. Anyone with the branch code
// could therefore add a "cashier" with the owner's permissions and a PIN of their choosing, and sign in with it at
// every till of the branch. Now:
//   - a role is taken ONLY from the roles this server saved (roles_cache), by role_id — never from the change;
//   - a relayed change never creates (or moves anyone to) the owner's role or a role beyond the shop floor (A490);
//   - a relayed PIN change never touches the owner or anyone beyond the shop floor (A490: by permission, not by name).
// A refused change still reaches the cloud from the till that made it (it sends every change itself), and comes back
// in the branch's staff list from there.

// A490: "elevated" is a permission question now, not a role's name (it was /owner|admin|manager/ and three broad keys):
// the owner's role, or anyone holding a key beyond the shop floor (isBackOffice, tillAccess backOffice). The intent is
// unchanged — no relayed change makes anyone more powerful, and nobody more powerful than a cashier is changed from
// another till. The role's keys come only from this server's roles_cache (roleMap), never from the change.
export function isElevatedRole(name: string | null | undefined, perms: unknown): boolean {
  return isOwnerRole(name) || backOffice(name, perms);
}

/** The relayed changes this server may apply, each staff change made safe; the rest named with why. Never throws. */
export function vetRelayedStaffChanges(raws: unknown[], branchId: string | null):
  { accepted: unknown[]; refused: Array<{ id: string; reason: string }>; forward: unknown[] } {
  const accepted: unknown[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  const forward: unknown[] = [];   // A521: refused here, forwarded to the cloud (localChanges.acceptForwardOnly)
  const db = getLocalDb();
  let roles: any[] = [];
  try { roles = JSON.parse((db.prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as any)?.value ?? '[]'); } catch { roles = []; }
  if (!Array.isArray(roles)) roles = [];
  for (const raw of raws ?? []) {
    const c = raw as any;
    const id = String(c?.id ?? '?');
    const entity = String(c?.entity ?? '');
    if (entity !== 'staff' && entity !== 'staff_pin') { accepted.push(raw); continue; }
    const data = (c?.data && typeof c.data === 'object') ? c.data : {};
    try {
      // A496: a change that carries a PIN (a new cashier, a PIN change) is never applied here from a relay — the till
      // that made it sends it to the cloud itself, and once the cloud has applied it, it reaches this server (and every
      // till) in the branch's staff list within seconds (staffRoster). Applied here first, anyone holding the branch code
      // could plant a PIN of their choosing on every till of the branch.
      if (entity === 'staff_pin' || (entity === 'staff' && c?.op === 'create')) {
        refused.push({ id, reason: 'a PIN (or a new staff member) reaches the branch server from the cloud once the cloud has applied it' });
        forward.push(raw);   // A521 (#6): not applied here — forwarded to the cloud (it checks the maker), back in the staff list
        continue;
      }
      if (entity === 'staff' && c?.op !== 'create') {
        const target = db.prepare(`SELECT role_name, permissions FROM branch_staff WHERE staff_id = ?${branchId ? ' AND branch_id = ?' : ''}`)
          .get(...[String(c?.entity_id ?? ''), ...(branchId ? [branchId] : [])]) as { role_name: string | null; permissions: string | null } | undefined;
        // A496: only someone on THIS server's staff list for its branch is changed from a relay.
        if (!target) { refused.push({ id, reason: "that person is not on this branch server's staff list" }); continue; }
        let perms: unknown = null;
        try { perms = target?.permissions ? JSON.parse(target.permissions) : null; } catch { perms = null; }
        if (isElevatedRole(target.role_name, perms)) {
          refused.push({ id, reason: 'an owner, admin or manager is not changed from another till' });
          continue;
        }
      }
      if (data.role_id !== undefined && data.role_id !== null) {
        const role = roles.find((r) => r?.id === data.role_id);
        if (!role) { refused.push({ id, reason: 'that role is not known on the branch server yet — it arrives from the cloud' }); continue; }
        const perms = roleMap(role);
        if (isOwnerRoleEntry(role) || isElevatedRole(role?.name, perms)) { refused.push({ id, reason: `the ${role?.name ?? 'chosen'} role is not given from another till` }); continue; }
        accepted.push({ ...c, _local: { role_name: role?.name ?? null, permissions: perms, branch_id: branchId } });
        continue;
      }
      accepted.push({ ...c, _local: { role_name: null, permissions: null, branch_id: branchId } });
    } catch (err: any) {
      refused.push({ id, reason: String(err?.message ?? 'could not check the change') });
    }
  }
  return { accepted, refused, forward };
}

export function verifyPinAtNode(pin: string, branchId: string): NodeVerdict {
  if (!canWrap()) {
    return { ok: false, reason: 'unavailable', message: 'This branch server cannot read its roster.' };
  }

  let rows: any[];
  try {
    rows = getLocalDb().prepare(`SELECT * FROM branch_staff WHERE branch_id = ? AND COALESCE(status, 'active') = 'active'`).all(branchId) as any[];   // A459: an inactive person is neither served nor signed in
  } catch { rows = []; }
  if (rows.length === 0) {
    return { ok: false, reason: 'no_roster', message: 'This branch server has no staff roster yet.' };
  }

  const matches: any[] = [];
  for (const row of rows) {
    let hash: string;
    try { hash = safeStorage.decryptString(Buffer.from(row.pin_hash_enc, 'base64')); }
    catch { continue; }   // wrapped under another OS account — unusable here, not an error
    if (bcrypt.compareSync(pin, hash)) matches.push(row);
  }

  if (matches.length > 1) {
    logLine('node', `node verify-pin refused: ${matches.length} staff share this PIN`);
    return { ok: false, reason: 'ambiguous', message: 'This PIN is shared by more than one staff member. Ask a manager to reset it.' };
  }
  if (matches.length === 0) return { ok: false, reason: 'no_match', message: 'Invalid PIN' };

  const m = matches[0];
  let permissions: unknown = {};
  try { permissions = JSON.parse(m.permissions ?? '{}'); } catch { /* default */ }
  logLine('node', `node verify-pin: ${m.name}`);
  return { ok: true, staff: { staffId: m.staff_id, name: m.name, roleName: m.role_name, permissions } };
}

/**
 * A446: after a fresh list from the CLOUD, this till's saved sign-ins (staff_pin_cache — whoever signed in here online)
 * follow it: a person no longer on the branch's list, or whose PIN has changed since, is dropped. Before, a cashier removed
 * (or a PIN changed) upstream could still sign in on a till offline with the old PIN for as long as the cache kept it.
 * Returns how many saved sign-ins were dropped. Never runs on an empty list.
 */
export function pruneSavedSignIns(branchId: string, roster: BranchStaffRow[]): number {
  if (!roster.length) return 0;
  const db = getLocalDb();
  // A496: an inactive person counts as absent (their saved sign-in goes too).
  const current = new Map(roster.filter((s) => (s.status ?? 'active') === 'active').map((s) => [s.staff_id, s.pin_hash]));
  let rows: Array<{ staff_id: string; pin_hash_enc: string }> = [];
  try { rows = db.prepare(`SELECT staff_id, pin_hash_enc FROM staff_pin_cache WHERE branch_id = ?`).all(branchId) as any[]; }
  catch { return 0; }
  const drop = db.prepare(`DELETE FROM staff_pin_cache WHERE staff_id = ? AND branch_id = ?`);
  let n = 0;
  for (const r of rows) {
    const now = current.get(r.staff_id);
    let saved = '';
    try { saved = safeStorage.decryptString(Buffer.from(r.pin_hash_enc, 'base64')); } catch { saved = ''; }
    if (!now || (saved && saved !== now)) { drop.run(r.staff_id, branchId); n++; }
  }
  if (n) logLine('staff', `dropped ${n} saved sign-in(s) no longer on the branch's list (removed, or PIN changed)`);
  return n;
}
