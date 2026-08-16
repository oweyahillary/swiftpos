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

export type NodeVerdict =
  | { ok: true; staff: { staffId: string; name: string; roleName: string | null; permissions: unknown } }
  | { ok: false; reason: 'no_roster' | 'no_match' | 'ambiguous' | 'unavailable'; message: string };

/**
 * Verify a PIN against the node's roster. Scans every entry and refuses on two,
 * exactly as the server and pinCache do. No JWT is minted — the caller (a peer)
 * gets the identity and permissions and pushes orders under its own owner token
 * with this cashier_id, unchanged from the online path.
 */
export function verifyPinAtNode(pin: string, branchId: string): NodeVerdict {
  if (!canWrap()) {
    return { ok: false, reason: 'unavailable', message: 'This branch server cannot read its roster.' };
  }

  let rows: any[];
  try {
    rows = getLocalDb().prepare(`SELECT * FROM branch_staff WHERE branch_id = ?`).all(branchId) as any[];
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
