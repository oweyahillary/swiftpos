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
import { logLine } from './logFile';

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

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM branch_staff WHERE branch_id = ?`).run(branchId);
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
        JSON.stringify(s.permissions ?? {}), pinEnc, wrap(s.override_pin_hash),
        s.status ?? 'active', new Date().toISOString(),
      );
    }
  });

  try { tx(); } catch (err: any) { logLine('node', `could not store branch roster: ${err?.message ?? err}`); }
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
      pin_hash: pin, override_pin_hash: unwrap(r.override_pin_hash_enc), status: r.status ?? 'active',
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
  const current = new Map(roster.map((s) => [s.staff_id, s.pin_hash]));
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
