// techService.ts — desktop-side tech access (main process)
// ─────────────────────────────────────────────────────────────────────────────
// Gates the hidden tech panel entirely OFFLINE:
//   • verifies the Ed25519 tech token locally against the cached public key
//     (a stolen device can verify but never mint — it has no private key);
//   • guards expiry with a MONOTONIC clock floor so winding the POS clock back
//     can't revive an expired token / session;
//   • on a valid token opens a 4-hour active session, persisted locally so a
//     reboot or power-off restores the correct remaining window without needing
//     the network or any other machine;
//   • queues audit entries locally and flushes them to the server when reachable.
//
// The reveal code (doorknock) and public key are cached at activation via
// /api/tech/branch-config and stored in device_config / a small tech table.

import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { getDeviceConfig, getServerUrl } from './deviceConfig';

const ACTIVE_SESSION_MS = 4 * 60 * 60 * 1000; // 4h active session per unlock

export interface TechSession {
  techId: string; techName: string; branchId: string;
  startedAt: number; expiresAt: number; tokenHash: string;
}

// ── Local tech state table (singleton) ──────────────────────────────────────
function ensureTechTables() {
  const db = getLocalDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tech_state (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      public_key      TEXT,
      reveal_code     TEXT,
      clock_floor     INTEGER NOT NULL DEFAULT 0,
      session_json    TEXT,
      updated_at      TEXT
    );
    INSERT OR IGNORE INTO tech_state (id, clock_floor, updated_at) VALUES (1, 0, datetime('now'));

    CREATE TABLE IF NOT EXISTS tech_audit_queue (
      id           TEXT PRIMARY KEY,
      action       TEXT NOT NULL,
      detail_json  TEXT,
      device_id    TEXT,
      token_hash   TEXT,
      occurred_at  TEXT NOT NULL,
      synced       INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function row(): any {
  ensureTechTables();
  return getLocalDb().prepare(`SELECT * FROM tech_state WHERE id=1`).get();
}

// ── Monotonic clock floor ───────────────────────────────────────────────────
// "Now" never goes backwards: we track the highest timestamp ever seen (system
// clock, server time, token iat). Expiry checks use max(systemNow, floor) so a
// clock rollback can't make an expired token look valid again.
export function bumpClockFloor(ts: number) {
  ensureTechTables();
  const db = getLocalDb();
  const cur = (db.prepare(`SELECT clock_floor FROM tech_state WHERE id=1`).get() as any)?.clock_floor ?? 0;
  if (ts > cur) db.prepare(`UPDATE tech_state SET clock_floor=?, updated_at=datetime('now') WHERE id=1`).run(ts);
}

function trustedNow(): number {
  const floor = (row()?.clock_floor as number) ?? 0;
  const sys = Date.now();
  if (sys > floor) bumpClockFloor(sys);
  return Math.max(sys, floor);
}

// ── Cache branch config (reveal code + public key) at activation ────────────
export function cacheTechConfig(publicKey: string | null, revealCode: string | null) {
  ensureTechTables();
  getLocalDb().prepare(
    `UPDATE tech_state SET public_key=COALESCE(?, public_key), reveal_code=COALESCE(?, reveal_code), updated_at=datetime('now') WHERE id=1`
  ).run(publicKey, revealCode);
}

/** Fetch + cache the branch's reveal code and verification key from the server. */
export async function refreshTechConfig(ownerToken: string): Promise<void> {
  const cfg = getDeviceConfig();
  if (!cfg?.branch_id) return;
  const res = await fetch(`${getServerUrl()}/api/tech/branch-config/${cfg.branch_id}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  if (!res.ok) return;
  const data = await res.json();
  cacheTechConfig(data.public_key ?? null, data.reveal_code ?? null);
}

// ── Reveal code (doorknock) ─────────────────────────────────────────────────
export function checkRevealCode(code: string): boolean {
  const stored = row()?.reveal_code as string | undefined;
  if (!stored || !code) return false;
  const a = Buffer.from(stored.trim().toUpperCase());
  const b = Buffer.from(code.trim().toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Offline token verification (Ed25519) ────────────────────────────────────
interface TechTokenPayload {
  techId: string; techName: string; branchId: string;
  businessId: string; scope: string; iat: number; exp: number;
}

function verifyTokenOffline(token: string): TechTokenPayload | null {
  const pub = row()?.public_key as string | undefined;
  if (!pub) return null;                         // not activated / no key cached
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'st2') return null;
    const [, payloadB64, sigB64] = parts;
    const ok = crypto.verify(null, Buffer.from(payloadB64), pub, Buffer.from(sigB64, 'base64url'));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as TechTokenPayload;
    // Trusted-now expiry check (monotonic floor defeats clock rollback).
    if (Math.floor(trustedNow() / 1000) > payload.exp) return null;
    if (payload.iat) bumpClockFloor(payload.iat * 1000);
    return payload;
  } catch { return null; }
}

// ── Session ─────────────────────────────────────────────────────────────────
function persistSession(s: TechSession | null) {
  ensureTechTables();
  getLocalDb().prepare(`UPDATE tech_state SET session_json=?, updated_at=datetime('now') WHERE id=1`)
    .run(s ? JSON.stringify(s) : null);
}

/** Current active session if still within its window (per the monotonic clock). */
export function getActiveSession(): TechSession | null {
  const raw = row()?.session_json as string | undefined;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TechSession;
    if (trustedNow() >= s.expiresAt) { persistSession(null); return null; }
    const cfg = getDeviceConfig();
    if (cfg?.branch_id && s.branchId !== cfg.branch_id) return null; // wrong branch
    return s;
  } catch { return null; }
}

/**
 * Verify a token and open a 4-hour active session. The token must be for THIS
 * device's bound branch. Returns the session or an error reason.
 */
export function openTechSession(token: string): { ok: true; session: TechSession } | { ok: false; reason: string } {
  const payload = verifyTokenOffline(token);
  if (!payload) return { ok: false, reason: 'Invalid or expired token' };

  const cfg = getDeviceConfig();
  if (cfg?.branch_id && payload.branchId !== cfg.branch_id) {
    return { ok: false, reason: 'This token is for a different branch' };
  }

  const now = trustedNow();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session: TechSession = {
    techId: payload.techId, techName: payload.techName, branchId: payload.branchId,
    startedAt: now,
    // Active session ends at the sooner of +4h or the token's own expiry.
    expiresAt: Math.min(now + ACTIVE_SESSION_MS, payload.exp * 1000),
    tokenHash,
  };
  persistSession(session);
  logTechAction('tech.session.open', { techName: payload.techName });
  return { ok: true, session };
}

export function closeTechSession() {
  const s = getActiveSession();
  if (s) logTechAction('tech.session.close', { techName: s.techName });
  persistSession(null);
}

// ── Audit ───────────────────────────────────────────────────────────────────
export function logTechAction(action: string, detail?: Record<string, unknown>) {
  ensureTechTables();
  const cfg = getDeviceConfig();
  const s = (() => { try { return getActiveSession(); } catch { return null; } })();
  getLocalDb().prepare(`
    INSERT INTO tech_audit_queue (id, action, detail_json, device_id, token_hash, occurred_at, synced)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(
    crypto.randomUUID(), action, detail ? JSON.stringify(detail) : null,
    cfg?.device_id ?? null, s?.tokenHash ?? null, new Date().toISOString(),
  );
}

/** Flush queued audit entries to the server (best-effort, when reachable). */
export async function flushTechAudit(token: string): Promise<void> {
  const db = getLocalDb();
  ensureTechTables();
  const pending = db.prepare(`SELECT * FROM tech_audit_queue WHERE synced=0 ORDER BY occurred_at LIMIT 100`).all() as any[];
  for (const e of pending) {
    try {
      const res = await fetch(`${getServerUrl()}/api/tech/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tech-token': token },
        body: JSON.stringify({
          action: e.action,
          detail: e.detail_json ? JSON.parse(e.detail_json) : null,
          device_id: e.device_id,
          occurred_at: e.occurred_at,
        }),
      });
      if (res.ok) db.prepare(`UPDATE tech_audit_queue SET synced=1 WHERE id=?`).run(e.id);
    } catch { /* stay queued; retry next flush */ }
  }
}
