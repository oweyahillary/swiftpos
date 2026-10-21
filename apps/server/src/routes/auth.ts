/**
 * auth.ts — SwiftPOS Authentication Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Auth hardening (migration 13):
 *
 *   Fix 1 — Refresh tokens stored server-side (refresh_tokens table).
 *            Real logout, revocation of fired staff, detection of replay attacks.
 *
 *   Fix 2 — jti (JWT ID) on every token pair.
 *            Tokens are individually identifiable — rotation and revocation
 *            without full secret rotation.
 *
 *   Fix 3 — permissions_version in JWT (claim: pv).
 *            requireAuth compares token.pv to users.permissions_version.
 *            Mismatch → 401 PERMISSIONS_CHANGED → client refreshes immediately.
 *            Role/permission changes propagate in ≤15 min worst case,
 *            typically within one API request cycle.
 *
 *   Fix 4 — session_id groups tokens per login event.
 *            Enables "log out this device" without touching other sessions.
 *
 *   Fix 5 — Refresh token rotation: old token revoked, new token issued atomically.
 *            Replay of a stolen refresh token is detected (jti already revoked → 401).
 *
 * Routes:
 *   POST /api/auth/login           — email + password → token pair (web dashboard)
 *   POST /api/auth/enrol/redeem    — business_id + one-time code → the till's own session, surface='desktop' (A415: no person in it)
 *   POST /api/auth/device-token    — a till signs itself back in with its device secret
 *   POST /api/auth/refresh         — refresh token → new token pair (rotation)
 *   POST /api/auth/logout          — revoke refresh token (server-side)
 *   POST /api/auth/pos-login       — email + PIN → branch-scoped token pair
 *   POST /api/auth/verify-pin      — a person's PIN on a till (the till's session, or a PIN sign-in on a till — A494: not the web); branch licence check
 *   POST /api/auth/set-pin         — bcrypt PIN update
 *   PATCH /api/auth/me             — clears must_change_password
 */
import { forgetTill } from '../lib/authCache';   // A528
import { validateLoose } from '../middleware/validate';
import { LoginSchema } from '../lib/schemas';

import { Router }   from 'express';
import { registerDesktopTerminal, findPriorTerminalByMac } from '../lib/deviceRegistry';
import { generateDeviceSecret, hashDeviceSecret, verifyDeviceSecret, buildDeviceTokenPayload, isTillPayload, isOwnerEraTillPayload, tillBlockReason, tillBranch } from '../lib/deviceGrant';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase, authClient } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { findTenant, ownedTenantBusiness } from '../lib/tenant';   // A378: a client's own sign-in address
import { getWebAccess } from '../lib/webAccess';
import { resolveOwnerBusinesses } from '../lib/ownerBusiness';
import { refreshHandshakeDecision, type HandshakeDecision, type HandshakeSuccessor } from '../lib/refreshHandshake';   // A477
import { checkTillIdentity, resetTillIdentity } from '../lib/tillIdentity';   // A477
import { businessPosFeatures } from '../lib/posFeatureFlags';   // A398
import { sessionKind, revokeBrowserSessions, markTillSessionLost, clearTillSessionLost, markTillSecurityAlert } from '../lib/tillSessions';   // A407, A477
import { cleanEmail, passwordProblem, signInAccountForEmail, sendResetCode, checkResetCode, setOwnerPassword } from '../lib/passwordReset';   // A402, A550
import { otpGate, needsOtp, readOtpSettings, startTotpSetup, confirmTotpSetup, useEmailCodes, OtpSubject } from '../lib/loginOtp';   // A391
import jwt           from 'jsonwebtoken';
import bcrypt        from 'bcrypt';
import crypto        from 'crypto';
import { worksAtBranch } from '../lib/branchAccess';   // A426
import { effectiveKeysForRow, tokenKeys, clientPermissionMap } from '../lib/effectivePermissions';   // A490
import { isOwnerRoleName } from '../lib/ownerRole';   // A490
import { isBackOffice } from '../lib/permissions';   // A490
import { permissionsOpenBefore } from '../lib/permissionsState';   // A490
import { pinKey, pinLocked, notePinFailure, notePinSuccess, PIN_LOCKED_BODY, accountLocked, noteAccountFailure, noteAccountSuccess, ACCOUNT_LOCKED_BODY } from '../lib/pinAttempts';   // A494
import { keysFromGrants } from '../lib/effectiveKeys';   // A494
import { notifyAccountLocked } from '../lib/accountLockNotice';   // A507
import { resolvePartnerSignIn, checkPartner, writePartners, type PartnerCheck, type PartnerPerson } from '../lib/webPartners';   // A550

const router = safeRouter();

const JWT_SECRET         = process.env.JWT_SECRET!;
const ACCESS_EXPIRES_IN  = '15m';
const REFRESH_EXPIRES_IN = '30d';
const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const BCRYPT_ROUNDS      = 12;

if (!JWT_SECRET) throw new Error('[server] Missing JWT_SECRET in environment');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** sha256 hash of a token — what we store in DB, never the raw token. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generate a cryptographically random session ID for grouping token pairs. */
function newSessionId(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface TokenPayload {
  /** The person. null for a till's own session (A415) — a till is not a person. */
  userId:             string | null;
  /** A415: the till's own session — which till. */
  deviceId?:          string;
  till?:              true;
  businessId:         string;
  branchId:           string | null;
  roleId?:            string | null;
  roleName?:          string | null;
  isOwner:            boolean;
  permissionKeys:     string[];
  permissionsVersion: number;
  sessionId:          string;
  surface?:           string;
  /** A494: the owner's password sign-in (/login) — the real owner (middleware isOwnerPasswordSession). */
  ownerLogin?:        true;
  /** A550: a partner's password sign-in (/login, lib/webPartners.ts) — a person with their own keys, never the owner. Their
   *  branches (partnerBranches; allBranches = every one) are worked out at sign-in and again at every renewal. */
  webPartner?:        true;
  partnerBranches?:   string[];
  allBranches?:       boolean;
  /** A159: a person's PIN sign-in on a till — may use the manager screens' writes (lib/terminalWrites.ts). Carried
   *  through refresh with the rest of the payload. The till's device token (enrolment) never has it. */
  pinSignIn?:         boolean;
}

interface IssuedTokenPair {
  accessToken:  string;
  refreshToken: string;
  sessionId:    string;
}

/**
 * Issue an access + refresh token pair.
 * Each pair gets a unique jti. The refresh token's jti is stored in the DB.
 * Returns the raw tokens — caller is responsible for storing the refresh token.
 */
function issueTokenPair(payload: TokenPayload): IssuedTokenPair {
  const accessJti  = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();

  const accessToken = jwt.sign(
    { ...payload, jti: accessJti, tokenType: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN },
  );

  const refreshToken = jwt.sign(
    { ...payload, jti: refreshJti, tokenType: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES_IN },
  );

  return { accessToken, refreshToken, sessionId: payload.sessionId };
}

/**
 * What counts as "this device" for session bookkeeping.
 *
 * Prefers the client's own stable device id, falling back to the User-Agent.
 *
 * The fallback used to be the ONLY identifier, and on a multi-till site that is
 * badly wrong: every till runs the same Electron build on the same Windows
 * version, so their User-Agents are byte-identical. Signing in on till 2 as the
 * owner therefore revoked till 1's refresh token, and till 3 revoked till 2's —
 * each new install silently signed out the one before it, and the till only
 * discovered it on its next refresh, reporting "this till was signed out" with
 * no cause a person could see.
 *
 * The desktop has had a stable device_id since install; it simply was not being
 * sent. It now is, and it is what this keys on.
 *
 * The User-Agent fallback stays for the web portal and for older desktop builds
 * that do not send device_id — for those, previous behaviour is unchanged.
 */
function deviceKey(req: any): string | null {
  const explicit = typeof req?.body?.device_id === 'string' ? req.body.device_id.trim() : '';
  if (explicit) return explicit.slice(0, 200);
  const ua = req?.headers?.['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 200) : null;
}

/**
 * Store a refresh token in the DB.
 * jti stored as sha256 hash — raw token never touches the DB.
 */
async function storeRefreshToken(
  refreshToken: string,
  payload: TokenPayload,
  ip?: string,
  /**
   * What identifies the DEVICE this session belongs to (audit BUG-22).
   *
   * Named userAgent before, and the owner login paths passed exactly that — the
   * User-Agent string. Every till in a fleet runs the same Electron build, so
   * every row held an identical value and device_hint distinguished nothing.
   * Worse, the PIN paths revoke with .eq('device_hint', devKey) using the
   * DEVICE ID, so an owner session could never be matched by a revoke and stale
   * rows accumulated silently.
   *
   * Callers pass device_id when the client sends one and fall back to the
   * User-Agent only when it genuinely has nothing better.
   */
  deviceHint?: string,
): Promise<string | null> {
  const jtiPayload = jwt.decode(refreshToken) as { jti: string };
  const jti = hashToken(jtiPayload.jti);

  const row = {
    jti,
    user_id:     payload.userId,
    business_id: payload.businessId,
    session_id:  payload.sessionId,
    device_hint: deviceHint?.slice(0, 200) ?? null,
    ip_address:  ip ?? null,
    expires_at:  new Date(Date.now() + REFRESH_EXPIRES_MS).toISOString(),
  };
  // A407: what the session is (device = the till itself, pin, web) — owner actions never revoke a device session.
  let { data, error } = await supabase.from('refresh_tokens')
    .insert({ ...row, session_kind: sessionKind(payload as { surface?: string; pinSignIn?: boolean }) }).select('id').single();
  // Before migration 125 the column is not there: store the session without it rather than lose the sign-in.
  if (error && /session_kind/.test(error.message ?? '')) ({ data } = await supabase.from('refresh_tokens').insert(row).select('id').single());
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Validate a refresh token against the DB.
 * Returns the stored row if valid, throws with a specific error code if not.
 */
async function validateRefreshToken(refreshToken: string): Promise<{
  payload: any;
  dbRow:   any;
  decision: HandshakeDecision;
  /** Migration 131 is in (refresh_tokens.acked_at): the A477 handshake runs. */
  handshake: boolean;
  deviceSession: boolean;
}> {
  // 1. Verify JWT signature + expiry
  let payload: any;
  try {
    payload = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw Object.assign(new Error('Invalid or expired refresh token'), { code: 'TOKEN_INVALID' });
  }

  if (payload.tokenType !== 'refresh') {
    throw Object.assign(new Error('Not a refresh token'), { code: 'TOKEN_INVALID' });
  }

  // 2. Look up jti in DB
  const jti = hashToken(payload.jti);
  const { data: dbRow, error } = await supabase
    .from('refresh_tokens')
    .select('*')
    .eq('jti', jti)
    .maybeSingle();

  // P2-18: a failed READ is not an unknown token — answering 401 TOKEN_UNKNOWN to a database hiccup signed a till out (or
  // set it re-joining) for good. 503: the client keeps its token and asks again.
  if (error) {
    throw Object.assign(new Error('Could not check the sign-in key just now — try again'), { code: 'DB_UNAVAILABLE' });
  }
  if (!dbRow) {
    // Token not in DB — either never stored (old client) or already consumed.
    // Treat as invalid to be safe.
    throw Object.assign(new Error('Refresh token not recognised'), { code: 'TOKEN_UNKNOWN' });
  }

  // A477: the handshake (lib/refreshHandshake.ts). Chain-based, as A88 / D13: the successor this token names tells a
  // lost reply (re-ask) from an outdated copy. Nothing is written here — the handler applies the decision only once
  // the till may renew (a blocked till keeps its token unspent).
  const handshake = Object.prototype.hasOwnProperty.call(dbRow, 'acked_at');   // migration 131 is in
  const deviceSession = dbRow.session_kind === 'device' || isTillPayload(payload) || isOwnerEraTillPayload(payload);
  let successor: HandshakeSuccessor | null = null;
  if (dbRow.replaced_by) {
    const { data: succ, error: succErr } = await supabase
      .from('refresh_tokens')
      .select(handshake ? 'revoked_at, acked_at, replaced_by' : 'revoked_at, replaced_by')
      .eq('id', dbRow.replaced_by)
      .maybeSingle();
    // P2-18: a failed successor read must not be judged a replay (revoking the whole session) or a stale copy.
    if (succErr) throw Object.assign(new Error('Could not check the sign-in key just now — try again'), { code: 'DB_UNAVAILABLE' });
    if (succ) successor = { revokedAt: (succ as any).revoked_at, ackedAt: (succ as any).acked_at, replacedBy: (succ as any).replaced_by };
  }
  // Before migration 131 the successor's own successor was not consulted (A88): a successor that is not revoked was the
  // head, because the old rotation revoked every token it consumed. Keep that reading exactly.
  if (!handshake && successor) successor = { ...successor, replacedBy: null };
  const decision = refreshHandshakeDecision({
    row: { revokedAt: dbRow.revoked_at, ackedAt: dbRow.acked_at, replacedBy: dbRow.replaced_by, expiresAt: dbRow.expires_at },
    successor, deviceSession, handshake,
  });

  if (decision.action === 'replay') {
    // A person's session: an outdated token (its successor already rotated, or revoked by logout) — revoke the whole
    // session, as before (A88).
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('session_id', dbRow.session_id)
      .is('revoked_at', null);

    throw Object.assign(
      new Error('Refresh token already used — all sessions revoked for security'),
      { code: 'TOKEN_REPLAYED' },
    );
  }
  if (decision.action === 'stale') {
    // A477: the till's own session is never revoked for an outdated token — an honest till reads its token from disk
    // and confirms every one it keeps, so an older copy is somebody else's (a copied disk or backup). Refuse THIS token,
    // keep the session, tell the owner.
    const deviceId = String(payload.deviceId ?? dbRow.device_hint ?? '').slice(0, 64);
    console.error(`[auth] A477 TOKEN_STALE: an outdated refresh token of till ${deviceId || '?'} (business ${payload.businessId}) was presented — refused alone, the session kept`);
    if (deviceId && payload.businessId) {
      await markTillSecurityAlert(payload.businessId, deviceId, 'An outdated copy of this till\'s sign-in key was used — possibly a copy of the till\'s data on another computer');
    }
    throw Object.assign(new Error('This sign-in key was already replaced — the till uses its newest one'), { code: 'TOKEN_STALE' });
  }
  if (decision.action === 'expired') {
    throw Object.assign(new Error('Refresh token expired'), { code: 'TOKEN_EXPIRED' });
  }

  return { payload, dbRow, decision, handshake, deviceSession };
}

/**
 * Revoke a single refresh token by jti hash.
 */
async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const payload = jwt.decode(refreshToken) as { jti?: string } | null;
    if (!payload?.jti) return;
    const jti = hashToken(payload.jti);
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('jti', jti)
      .is('revoked_at', null);
    // A477: a token not confirmed yet leaves the one it replaced alive (the handshake) — signing out retires that too.
    const { data: row } = await supabase.from('refresh_tokens').select('id').eq('jti', jti).maybeSingle();
    if ((row as { id?: string } | null)?.id) await revokeParentOf((row as { id: string }).id);
  } catch {
    // Best-effort — don't fail the logout if revocation errors
  }
}

/**
 * Fetch the current permissions_version for a user.
 * Returns 1 as fallback if the column doesn't exist yet (pre-migration).
 */
/**
 * Resolve the public.users row for an owner, by email, within one business.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two sites (/login and the retired owner login on a till) did `.eq('email', data.user.email)` —
 * a CASE-SENSITIVE match against a column that stores whatever was typed at
 * signup, while Supabase Auth lowercases. A miss is not harmless: both callers
 * fall back to `data.user.id`, which is an **auth.users** id, and mint a token
 * carrying it as `userId`.
 *
 * `orders.cashier_id` is `REFERENCES public.users(id)`. So a token built from
 * that fallback makes every order push fail 23503 for the entire life of the
 * refresh chain — /refresh reuses `cleanPayload.userId` and never re-resolves.
 * That is the shape of the eight orders lost on 2026-08-07.
 *
 * pos-login already solved this (BUG-05): a coarse escaped `ilike` to get
 * candidates, then an exact case-insensitive compare in JS. `ilike` alone is a
 * PATTERN match and `_` is a legal email character, so `john_doe@x` would match
 * `johnXdoe@x`. Same approach here rather than a second, subtly different one.
 */
async function resolveOwnerUserRow(
  businessId: string,
  email: string | null | undefined,
): Promise<{ id: string; must_change_password?: boolean } | null> {
  const needle = String(email ?? '').trim().toLowerCase();
  if (!needle) return null;

  const likeSafe = needle.replace(/[\\%_]/g, ch => `\\${ch}`);

  const { data: candidates, error } = await supabase
    .from('users')
    .select('id, email, must_change_password')
    .eq('business_id', businessId)
    .ilike('email', likeSafe)
    .limit(200);

  if (error) return null;

  // Exact match, not a pattern match. This is what neutralises % and _.
  const match = (candidates ?? []).find(
    (u: any) => String(u.email ?? '').trim().toLowerCase() === needle,
  );
  return (match as any) ?? null;
}

/**
 * A451 (owner, 2026-10-13: "A451 is important and needed"): the owner ALWAYS signs in as a users row of their business.
 * An owner with none signed in with the auth.users id — and every write naming the person (a void, a refund, a sale's
 * cashier) was refused by the database (the 500 on the owner's void of order 8a523b99…). In order:
 *   1. their row by email (resolveOwnerUserRow);
 *   2. the row businesses.owner_id names, when it is a users row of this business;
 *   3. else a row is created for them, as a new client's owner is (admin.ts / onboarding.ts): the business's owner
 *      (else admin) role, active, linked to the main branch. Logged, once.
 * Returns null only when none could be found or made (the caller keeps today's logged fallback).
 */
export async function ensureOwnerUserRow(
  businessId: string,
  email: string | null | undefined,
): Promise<{ id: string; must_change_password?: boolean; created?: boolean } | null> {
  const byEmail = await resolveOwnerUserRow(businessId, email);
  if (byEmail) return byEmail;

  const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  const ownerId = (biz as { owner_id?: string | null } | null)?.owner_id ?? null;
  if (ownerId) {
    const { data: row } = await supabase.from('users').select('id, must_change_password')
      .eq('id', ownerId).eq('business_id', businessId).maybeSingle();
    if (row) return row as { id: string; must_change_password?: boolean };
  }

  const cleanEmail = String(email ?? '').trim();
  if (!cleanEmail) return null;
  const { data: roles } = await supabase.from('roles').select('id, name').eq('business_id', businessId);
  const pick = (n: string) => (roles ?? []).find((r: any) => String(r.name ?? '').toLowerCase() === n) as { id: string } | undefined;
  const role = pick('owner') ?? pick('admin') ?? null;
  const { data: created, error } = await supabase.from('users').insert({
    business_id: businessId, name: cleanEmail.split('@')[0] || 'Owner', email: cleanEmail,
    role_id: role?.id ?? null, status: 'active', must_change_password: false,
  }).select('id, must_change_password').single();
  if (error || !created) {
    // A row with this email may have appeared since (another sign-in raced this one): take it.
    const again = await resolveOwnerUserRow(businessId, cleanEmail);
    if (again) return again;
    console.error('[auth] A451: could not create the owner\'s users row', { businessId, error: error?.message });
    return null;
  }
  const { data: main } = await supabase.from('branches').select('id').eq('business_id', businessId).eq('is_main', true).maybeSingle();
  if ((main as { id?: string } | null)?.id) {
    await supabase.from('user_branches').insert({ user_id: (created as any).id, branch_id: (main as any).id });
  }
  console.warn('[auth] A451: the owner had no users row — one was created', { businessId, userId: (created as any).id });
  return { ...(created as { id: string; must_change_password?: boolean }), created: true };
}

async function getPermissionsVersion(userId: string): Promise<number> {
  const { data } = await supabase
    .from('users')
    .select('permissions_version')
    .eq('id', userId)
    .maybeSingle();
  return (data as any)?.permissions_version ?? 1;
}

// ── Legacy helpers (PIN hashing) ──────────────────────────────────────────────

function legacyPinHash(pin: string, businessId: string): string {
  return crypto.createHash('sha256').update(`${pin}:${businessId}`).digest('hex');
}

async function hashPinBcrypt(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function verifyPin(
  pin: string,
  storedHash: string,
  businessId: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (storedHash.startsWith('$2')) {
    const valid = await bcrypt.compare(pin, storedHash);
    return { valid, needsUpgrade: false };
  }
  const legacyHash = legacyPinHash(pin, businessId);
  // A451: a stored hash of another shape (not bcrypt, not this hex) is simply no match — timingSafeEqual THROWS on
  // buffers of different lengths, and one odd row failed every manager-PIN check of the business with a 500.
  const a = Buffer.from(legacyHash, 'hex'), b = Buffer.from(String(storedHash ?? ''), 'hex');
  const valid = a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
  return { valid, needsUpgrade: valid };
}


// ── Device registration helpers ───────────────────────────────────────────────

/**
 * Build a stable device fingerprint from the request.
 * We use: sha256(User-Agent + client_hint) where client_hint is an optional
 * canvas/screen hash sent by the client for extra stability.
 * Falls back to sha256(User-Agent) alone if no client_hint provided.
 */
function buildFingerprint(req: any, clientHint?: string): string {
  const ua  = req.headers['user-agent'] ?? 'unknown';
  const raw = clientHint ? `${ua}::${clientHint}` : ua;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Build a human-readable device label from the User-Agent.
 * e.g. "Chrome on Windows", "Safari on iPhone", "Firefox on Mac"
 */
function buildDeviceLabel(ua: string): string {
  const browsers = [
    { re: /Edg\//, name: 'Edge' },
    { re: /OPR\/|Opera/, name: 'Opera' },
    { re: /Chrome\//, name: 'Chrome' },
    { re: /Firefox\//, name: 'Firefox' },
    { re: /Safari\//, name: 'Safari' },
  ];
  const platforms = [
    { re: /iPhone|iPad/, name: 'iPhone/iPad' },
    { re: /Android/, name: 'Android' },
    { re: /Windows/, name: 'Windows' },
    { re: /Mac OS X/, name: 'Mac' },
    { re: /Linux/, name: 'Linux' },
  ];
  const browser  = browsers.find(b => b.re.test(ua))?.name ?? 'Browser';
  const platform = platforms.find(p => p.re.test(ua))?.name ?? 'Device';
  return `${browser} on ${platform}`;
}

/**
 * Check if device registration is required for this business, and if so
 * whether the device is approved. Returns 'allowed', 'pending', or 'rejected'.
 * If registration is not required, always returns 'allowed'.
 */
// Who is always exempt from device registration: the owner and anyone "back office" (A490: isBackOffice — holding
// anything beyond the shop floor's keys; it used to be the role names owner/admin/manager/supervisor/branch_manager).
// These users manage the system — blocking them from new devices is counterproductive
// (a manager could approve their own device anyway, making the check pointless).

async function checkDeviceRegistration(
  businessId: string,
  userId:     string,
  req:        any,
  clientHint?: string,
  isOwner?:    boolean,
  held?:       ReadonlySet<string>,
): Promise<{ result: 'allowed' | 'pending' | 'rejected'; deviceId?: string }> {
  // Owners and back-office staff are never device-gated.
  // Owners manage the system; managers can approve their own devices anyway.
  if (isOwner) return { result: 'allowed' };
  if (held && isBackOffice(held)) return { result: 'allowed' };

  // 1. Check if the business has device registration enabled
  const { data: setting } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', businessId)
    .eq('key', 'require_device_registration')
    .maybeSingle();

  const required = setting?.value === 'true' || setting?.value === true;
  if (!required) return { result: 'allowed' };

  // 2. Build fingerprint and check user_devices
  const fingerprint = buildFingerprint(req, clientHint);

  const { data: device } = await supabase
    .from('user_devices')
    .select('id, status')
    .eq('user_id', userId)
    .eq('fingerprint', fingerprint)
    .maybeSingle();

  if (!device) {
    // Unknown device — register as pending and notify owner
    const ua          = req.headers['user-agent'] ?? 'unknown';
    const deviceLabel = buildDeviceLabel(ua);
    const { data: newDevice } = await supabase
      .from('user_devices')
      .insert({
        user_id:      userId,
        business_id:  businessId,
        fingerprint,
        device_label: deviceLabel,
        ip_address:   req.ip ?? null,
        status:       'pending',
      })
      .select('id')
      .single();

    // Notify the owner
    await supabase.from('notifications').insert({
      business_id: businessId,
      type:        'device_pending',
      title:       'New device login request',
      message:     `A cashier is trying to log in from a new device (${deviceLabel}). Go to Settings → Devices to approve or reject.`,
      link:        '/dashboard/settings?tab=devices',
    });

    return { result: 'pending', deviceId: newDevice?.id };
  }

  if (device.status === 'approved') {
    // Update last_seen_at, and the app build this till is running.
    //
    // Written here because it is the one place every till touches on every
    // sign-in. Best-effort throughout: if migration 36 has not been applied the
    // column does not exist and this update errors — which must NOT stop
    // somebody signing in to sell. The version is a diagnostic, not a gate.
    const reportedVersion = typeof (req as any)?.body?.app_version === 'string'
      ? String((req as any).body.app_version).slice(0, 32)
      : (typeof req?.headers?.['x-app-version'] === 'string'
          ? String(req.headers['x-app-version']).slice(0, 32)
          : null);

    // The till's own device_id. Already sent on every verify-pin and previously
    // discarded; stored so sync telemetry has a stable key to attach to, and so
    // the fleet view can join a terminal to the orders it actually rang.
    const reportedDeviceId = typeof (req as any)?.body?.device_id === 'string'
      ? String((req as any).body.device_id).slice(0, 64)
      : null;

    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
    if (reportedVersion) patch.app_version = reportedVersion;
    if (reportedDeviceId) patch.device_id = reportedDeviceId;

    const { error: seenErr } = await supabase
      .from('user_devices')
      .update(patch)
      .eq('id', device.id);

    if (seenErr && reportedVersion) {
      // Most likely the column is missing. Retry without it so last_seen_at
      // still lands, and say so once rather than failing silently forever.
      console.warn('[device-version] could not record app_version — is migration 36 applied?', seenErr.message);
      await supabase
        .from('user_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', device.id);
    }
    return { result: 'allowed', deviceId: device.id };
  }

  if (device.status === 'rejected') {
    return { result: 'rejected', deviceId: device.id };
  }

  // Still pending
  return { result: 'pending', deviceId: device.id };
}

/**
 * A391: a users row as a code subject — its method, secret and version, read on their own so a cloud running before
 * migration 119 still signs people in (by email code, version 1).
 */
async function otpSubjectFor(userId: string, email: string, name?: string | null): Promise<OtpSubject> {
  const { data, error } = await supabase
    .from('users').select('otp_method, otp_totp_secret, otp_version').eq('id', userId).maybeSingle();
  if (error) console.error('[otp] could not read the sign-in code settings — is migration 119 applied?', error.message);
  return {
    kind: 'user', id: userId, email, name: name ?? null,
    method: (data as any)?.otp_method ?? 'email', secret: (data as any)?.otp_totp_secret ?? null, version: (data as any)?.otp_version ?? 1,
  };
}

/**
 * A550: a partner's password sign-in (lib/webPartners.ts) — reached from /login once the password is right, the account is
 * not the owner of the business asked for, and resolvePartnerSignIn has checked the grant, the account link, the person
 * (active, not on the owner's role) and their branches. The business must be open to the web as for the owner (suspension,
 * web access). The one-time code is ALWAYS asked (A391's second step, as for back office, whatever their keys — not the
 * client's 'Sign-in codes' switch, which is the owner's own sign-in): a password alone never opens the dashboard to
 * someone who is not the owner. No device approval: as for the owner and back office, a partner runs the system
 * (checkDeviceRegistration exempts both).
 */
async function partnerSignIn(req: any, res: any, authUser: { id: string; email?: string | null }, email: string,
  businessId: string, check: Extract<PartnerCheck, { ok: true }>): Promise<void> {
  const { data: business, error: bErr } = await supabase.from('businesses')
    .select('id, name, currency, type, status').eq('id', businessId).maybeSingle();
  if (bErr || !business) { res.status(503).json({ error: 'Could not sign you in right now — please try again' }); return; }
  const biz = business as { id: string; name?: string; status?: string };
  if (biz.status === 'suspended') {
    res.status(403).json({ error: 'Your account has been suspended. Please contact ZapTill support.', code: 'ACCOUNT_SUSPENDED' });
    return;
  }
  const webAccess = await getWebAccess(biz.id, biz.status);
  if (!webAccess.canLogin) {
    res.status(403).json({
      error: webAccess.state === 'locked'
        ? 'Your web portal subscription has expired. Please renew to continue.'
        : 'Web portal access is not enabled for your account. Please contact ZapTill to upgrade.',
      code:  webAccess.state === 'locked' ? 'WEB_ACCESS_EXPIRED' : 'WEB_HOSTING_REQUIRED',
    });
    return;
  }
  const person: PartnerPerson = check.person;
  const gate = await otpGate(await otpSubjectFor(person.id, authUser.email ?? email, person.name), req.body);
  if (gate.ok === false) { res.status(gate.status).json(gate.body); return; }

  const held = effectiveKeysForRow(person as any);
  if (held.has('*')) { res.status(401).json({ error: 'Invalid email or password' }); return; }   // never the owner's '*'
  if (check.record.status === 'invited') {
    const err = await writePartners(businessId, { ...check.map,
      [person.id]: { ...check.record, status: 'active', activated_at: new Date().toISOString() } });
    if (err) console.warn('[auth] A550: could not mark a partner active', { businessId, userId: person.id });
  }

  const payload: TokenPayload = {
    userId:             person.id,   // their own users row — every action is recorded as them, never as the owner
    businessId,
    branchId:           check.allBranches ? null : (check.branchIds[0] ?? null),
    roleId:             person.role_id ?? null,
    roleName:           person.roles?.name ?? null,
    isOwner:            false,
    webPartner:         true,
    partnerBranches:    check.branchIds,
    allBranches:        check.allBranches,
    permissionKeys:     tokenKeys(held),
    permissionsVersion: person.permissions_version ?? 1,
    sessionId:          newSessionId(),
    surface:            'web',
  };
  const { accessToken, refreshToken } = issueTokenPair(payload);
  await storeRefreshToken(refreshToken, payload, req.ip ?? undefined,
    (req.body?.device_id as string | undefined) ?? req.headers['user-agent'] ?? undefined);
  console.log(`[auth] A550: partner ${person.id} signed in to business ${businessId}`);
  res.json({
    accessToken, refreshToken, token: accessToken,
    user: { id: authUser.id, email: authUser.email },
    business, mustChangePassword: false, partner: true,
    permissions: clientPermissionMap(held),
    ...(gate.trust ? { otp_trust: gate.trust } : {}),
  });
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', validateLoose(LoginSchema), async (req, res) => {
  const { email, password, business_id, subdomain } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  // A494: failed sign-ins per ACCOUNT (lib/pinAttempts.ts) — the address-keyed limit alone lets many addresses guess on.
  if (accountLocked(email)) { res.status(429).json(ACCOUNT_LOCKED_BODY); return; }

  // A378: signed in on a client's own address (africanfries.<root>) — only that business may be opened. Looked up
  // BEFORE the password is checked, so an unknown address never says whether a password was right.
  const tenant = await findTenant(subdomain);
  if (tenant.kind === 'error') { res.status(503).json({ error: 'Could not sign you in right now — please try again' }); return; }
  if (tenant.kind === 'unknown') {
    res.status(404).json({ error: 'No ZapTill business uses this address.', code: 'UNKNOWN_SUBDOMAIN' });
    return;
  }

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (noteAccountFailure(email)) notifyAccountLocked(email, req.ip, 'the web dashboard');   // A494; A507: the account is told
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  noteAccountSuccess(email);

  // BUG-18: was .single(), which raises PGRST116 on more than one row. An owner
  // with two businesses got "No business found for this account" — the opposite
  // of what happened — and could not log in to either. Same class as BUG-05.
  //
  // Login is the one place that CAN ask, so it asks. business_id in the body
  // picks one; without it, a second business produces a 409 naming both rather
  // than a silent guess about which shop's till you are opening.
  const owned = await resolveOwnerBusinesses(
    data.user.id, 'id, name, currency, type, status',
    tenant.kind === 'found' ? tenant.tenant.id : (business_id ?? null));

  // A550: not the owner of the business asked for (the client's address, or the one picked), or of any — a partner's
  // sign-in if the account is one there (lib/webPartners.ts: the owner's grant AND the account's own link, both). The
  // owner of the business asked for never comes here: their sign-in below is exactly as before. An account that is
  // neither — a revoked or deactivated partner, a deleted person — gets the wrong-password answer, word for word.
  const wanted: string | null = tenant.kind === 'found' ? tenant.tenant.id : (business_id ?? null);
  if (owned.kind !== 'error' && (owned.kind === 'none' || (wanted && !ownedTenantBusiness(owned, wanted)))) {
    const partner = await resolvePartnerSignIn(data.user, { businessId: wanted });
    if (partner.kind === 'error') { res.status(503).json({ error: 'Could not sign you in right now — please try again' }); return; }
    if (partner.kind === 'one') { await partnerSignIn(req, res, data.user, email, partner.businessId, partner.check); return; }
    if (partner.kind === 'many') {
      res.status(409).json({
        error: 'This account opens more than one business. Choose which one to open.',
        code:  'MULTIPLE_BUSINESSES',
        businesses: partner.businesses,
      });
      return;
    }
    if (owned.kind === 'none') { res.status(401).json({ error: 'Invalid email or password' }); return; }
  }

  // A378: on a client's address the account must own THAT business — not another one it also owns, and no choice list.
  if (tenant.kind === 'found') {
    if (owned.kind !== 'error' && !ownedTenantBusiness(owned, tenant.tenant.id)) {
      res.status(403).json({ error: `This account is not part of ${tenant.tenant.name}.`, code: 'NOT_THIS_BUSINESS' });
      return;
    }
  }

  if (owned.kind === 'error') {
    res.status(503).json({ error: 'Could not sign you in right now — please try again' });
    return;
  }
  // (owned.kind 'none' is answered above, A550 — a partner's sign-in, or the wrong-password answer; it used to be 403
  // "No business found for this account", which told a revoked partner their password was right.)
  if (owned.kind === 'many') {
    res.status(409).json({
      error: 'This account owns more than one business. Choose which one to open.',
      code:  'MULTIPLE_BUSINESSES',
      businesses: owned.businesses.map(b => ({ id: b.id, name: b.name })),
    });
    return;
  }
  const business = owned.business;

  if (business.status === 'suspended') {
    res.status(403).json({
      error: 'Your account has been suspended. Please contact ZapTill support.',
      code:  'ACCOUNT_SUSPENDED',
    });
    return;
  }

  // Web portal access gate. Uses the central state helper so the renewal ladder
  // (active → grace → reports_only → locked) is enforced from one place. For
  // accounts without a dated subscription this falls back to the legacy
  // feature_flags.web_hosting boolean, so existing logins are unchanged.
  const webAccess = await getWebAccess(business.id, business.status);
  if (!webAccess.canLogin) {
    res.status(403).json({
      error: webAccess.state === 'locked'
        ? 'Your web portal subscription has expired. Please renew to continue.'
        : 'Web portal access is not enabled for your account. Please contact ZapTill to upgrade.',
      code:  webAccess.state === 'locked' ? 'WEB_ACCESS_EXPIRED' : 'WEB_HOSTING_REQUIRED',
    });
    return;
  }

  // Case-insensitive, pattern-safe. A miss here used to fall through to
  // data.user.id (an auth.users id) and poison every order push — see
  // resolveOwnerUserRow.
  const ownerUser = await ensureOwnerUserRow(business.id, data.user.email);   // A451: found, or created

  let mustChangePassword = (ownerUser as any)?.must_change_password ?? false;
  if (mustChangePassword) {
    const passwordWasUpdated =
      data.user.updated_at &&
      data.user.created_at &&
      new Date(data.user.updated_at) > new Date(data.user.created_at);
    if (passwordWasUpdated) {
      await supabase
        .from('users')
        .update({ must_change_password: false, updated_at: new Date().toISOString() })
        .eq('id', (ownerUser as any).id);
      mustChangePassword = false;
    }
  }

  // A391: an owner enters a one-time code (emailed, or from their authenticator app). A398: only when the admin portal
  // has turned 'Sign-in codes' on for this client.
  const ownerGate = !(await businessPosFeatures(business.id)).login_codes ? { ok: true as const } : await otpGate(
    await otpSubjectFor(ownerUser ? (ownerUser as any).id : data.user.id, data.user.email ?? email, (ownerUser as any)?.name),
    req.body);
  if (ownerGate.ok === false) { res.status(ownerGate.status).json(ownerGate.body); return; }

  // Fetch permissions_version for owner
  const pv = ownerUser ? await getPermissionsVersion((ownerUser as any).id) : 1;

  if (!ownerUser) {
    console.error(
      '[auth] no public.users row for this owner — issuing a token whose userId ' +
      'is an auth.users id. Every order pushed under it will fail 23503 on ' +
      'orders_cashier_id_fkey until a users row exists and the owner signs in again.',
      { businessId: business.id, email: data.user.email },
    );
  }

  const sessionId = newSessionId();
  const payload: TokenPayload = {
    // FALLBACK OF LAST RESORT. data.user.id is an auth.users id, and
    // orders.cashier_id REFERENCES public.users(id) — so a token built from
    // this branch makes every order push fail 23503 until the owner signs in
    // again, because /refresh reuses userId and never re-resolves it.
    // Login is NOT refused here: a release is in flight and an owner who works
    // today must still work tomorrow. But it is no longer silent.
    userId:             ownerUser ? (ownerUser as any).id : data.user.id,
    businessId:         business.id,
    branchId:           null,
    isOwner:            true,
    ownerLogin:         true,   // A494: the real owner (requireAuth skips the users-row checks for this session only)
    permissionKeys:     ['*'],
    permissionsVersion: pv,
    sessionId,
  };

  const { accessToken, refreshToken } = issueTokenPair(payload);

  // Store refresh token server-side
  await storeRefreshToken(refreshToken, payload,
    req.ip ?? undefined,
    // device_id first: the User-Agent is identical across the whole fleet, so
    // storing it made every row look like every other row (BUG-22).
    (req.body?.device_id as string | undefined)
      ?? req.headers['user-agent'] ?? undefined,
  );

  res.json({
    accessToken,
    refreshToken,
    token: accessToken, // legacy compat
    user: { id: data.user.id, email: data.user.email },
    business,
    mustChangePassword,
    ...(ownerGate.trust ? { otp_trust: ownerGate.trust } : {}),
  });
});

// ── POST /api/auth/enrol/redeem ───────────────────────────────────────────────
// A till joins the business with a single-use CODE ZapTill issues in the admin portal (POST
// /api/admin/clients/:id/branches/:branchId/enrol-code) — never a password. The business is identified by its id.
//
// A415 (owner, 2026-10-06: "never the owners session at all"): the session minted here is the TILL's own — its token
// names the till (device_id), the business and the branch, and no person. A technician joins the same till again with a
// fresh code (`rejoin: true`, from the till's technician console) without clearing its data: the till keeps its device
// id, and this route approves it again, clears a retirement, sets the code's branch and issues a new device secret.
//
// No requireAuth: the caller has no session yet; the code IS the credential. This route sits on /api/auth so it
// inherits authLimiter — a code must be brute-force-protected.
router.post('/enrol/redeem', async (req, res) => {
  const businessId = String(req.body?.business_id ?? '').trim();
  const rawCode    = String(req.body?.code ?? '').trim().toUpperCase();
  const deviceId   = String(req.body?.device_id ?? '').trim().slice(0, 64);
  const rejoin     = req.body?.rejoin === true;
  if (!businessId || !rawCode || !deviceId) {
    res.status(400).json({ error: 'business_id, code and device_id are required' });
    return;
  }
  const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  const nowIso   = new Date().toISOString();

  // A415: a rejoin keeps the till's data, which is its own branch's — a code for another branch is refused BEFORE it
  // is spent, so the technician can still use it on the right till.
  const ownBranch = String(req.body?.branch_id ?? '').trim();
  if (rejoin && ownBranch) {
    const { data: pending } = await supabase.from('device_enrolment_codes').select('branch_id')
      .eq('code_hash', codeHash).eq('business_id', businessId).eq('status', 'active').gt('expires_at', nowIso).maybeSingle();
    const codeBranch = (pending as { branch_id?: string | null } | null)?.branch_id;
    if (codeBranch && codeBranch !== ownBranch) {
      res.status(409).json({ error: 'That code is for a different branch. Rejoin needs a code for this till\'s own branch.', code: 'REJOIN_OTHER_BRANCH' });
      return;
    }
  }

  // THE BURN — one atomic UPDATE ... WHERE ... RETURNING (proven in
  // test-migration-81.mjs). Redeemable iff active AND unexpired AND this
  // business's; the flip to 'redeemed' is what makes it single-use, so two
  // concurrent redeems cannot both win. Scoped to business_id so a code cannot
  // be spent against another tenant.
  const { data: burned, error: burnErr } = await supabase
    .from('device_enrolment_codes')
    .update({ status: 'redeemed', redeemed_at: nowIso, redeemed_device_id: deviceId })
    .eq('code_hash', codeHash)
    .eq('business_id', businessId)
    .eq('status', 'active')
    .gt('expires_at', nowIso)
    .select('id, business_id, branch_id')
    .maybeSingle();

  if (burnErr) { sendError(res, burnErr); return; }
  if (!burned) {
    // Uniform message: never tell an attacker whether the code was wrong,
    // expired, already used, or for another business.
    res.status(401).json({ error: 'Invalid, expired or already-used code', code: 'ENROL_INVALID' });
    return;
  }

  // A suspended business must not bring a till online. Also the fields the till needs for its session row.
  const { data: biz } = await supabase
    .from('businesses').select('id, name, currency, type, status').eq('id', businessId).maybeSingle();
  if (!biz) { res.status(500).json({ error: 'Business not found for a valid code', code: 'ENROL_STATE' }); return; }
  if ((biz as any).status === 'suspended') {
    res.status(403).json({ error: 'Your account has been suspended. Please contact ZapTill support.', code: 'ACCOUNT_SUSPENDED' });
    return;
  }

  // Record the terminal (D14) — the till itself, no person on the row.
  await registerDesktopTerminal(businessId, {
    deviceId,
    appVersion:   String(req.body?.app_version ?? req.headers['x-app-version'] ?? '') || null,
    terminalCode: req.body?.terminal_code ?? null,
    label:        req.body?.device_name ?? null,   // A273 follow-up: the till's setup name
    ipAddress:    req.ip ?? null,
    role:         req.body?.device_role ?? req.headers['x-device-role'] ?? null,
    macAddress:   (req.headers['x-device-mac'] ?? req.body?.mac_address ?? null) as string | null,   // A182
  });
  const { data: dev, error: devErr } = await supabase
    .from('user_devices').select('id, branch_id').eq('business_id', businessId).eq('device_id', deviceId).maybeSingle();
  if (devErr || !dev) {
    res.status(500).json({ error: 'This till could not be recorded on the business — try again with a new code.', code: 'ENROL_STATE' });
    return;
  }

  // The branch: the code's (admin codes are always for one branch), else the one the till is bound to, else the one it
  // reports — checked to be this business's.
  let reported: string | null = null;
  const reportedRaw = String(req.body?.branch_id ?? '').trim();
  if (reportedRaw && !(burned as any).branch_id && !(dev as any).branch_id) {
    const { data: br } = await supabase.from('branches').select('id').eq('id', reportedRaw).eq('business_id', businessId).maybeSingle();
    reported = (br as { id?: string } | null)?.id ?? null;
  }
  const branchId = tillBranch((burned as any).branch_id, (dev as any).branch_id, reported);

  // A fresh code from ZapTill joins the till (again): approved, not retired, its branch, a new device secret — the
  // secret is what the till renews with when its session is refused (/device-token).
  const deviceSecret = generateDeviceSecret();
  const { error: joinErr } = await supabase.from('user_devices').update({
    status: 'approved', retired_at: null, reviewed_at: nowIso,
    device_secret_hash: hashDeviceSecret(deviceSecret), device_secret_set_at: nowIso,
    ...(branchId && branchId !== (dev as any).branch_id ? { branch_id: branchId, bound_at: nowIso } : {}),
  }).eq('id', (dev as any).id);
  forgetTill(businessId, deviceId);   // A528: joined again (perhaps at another branch) — the sign-in check reads it afresh
  if (joinErr) { sendError(res, joinErr); return; }

  const payload: TokenPayload = buildDeviceTokenPayload({ deviceId, businessId, branchId, sessionId: newSessionId() });
  const { accessToken, refreshToken } = issueTokenPair(payload);
  await storeRefreshToken(refreshToken, payload, req.ip ?? undefined, deviceId);
  await clearTillSessionLost(businessId, deviceId);   // A407: joined again — the alert clears
  await resetTillIdentity(businessId, deviceId, (n) => req.header(n));   // A477: the machine it was (re)joined on
  console.log(`[enrol] till ${deviceId} ${rejoin ? 'rejoined' : 'joined'} business ${businessId}${branchId ? ` (branch ${branchId})` : ''}`);

  // A182: if this machine's MAC was seen before at this business (a reinstall),
  // hand back the previous terminal code/name so the till can restore its identity
  // instead of being re-named "T1" and colliding (A181). Best-effort hint only.
  let restore: { terminal_code: string | null; device_label: string | null } | null = null;
  try {
    const mac = String(req.headers['x-device-mac'] ?? req.body?.mac_address ?? '');
    const prior = mac && !rejoin ? await findPriorTerminalByMac(businessId, mac, deviceId) : null;
    if (prior) restore = { terminal_code: prior.terminal_code, device_label: prior.device_label };
  } catch { /* additive — enrolment must not fail over the hint */ }

  res.json({
    accessToken,
    refreshToken,
    token: accessToken,
    till:     { device_id: deviceId, branch_id: branchId },
    business: biz,                       // id, name, currency, type, status
    businessId,
    branchId,
    deviceSecret,                        // A164 — the till keeps this to sign itself back in
    restore,                             // A182 — { terminal_code, device_label } to reuse, or null
  });
});

// ── POST /api/auth/device-token ───────────────────────────────────────────────
// A164/A407: a till whose session was refused (revoked, or lapsed after a long time offline) signs itself back in with
// its device_id + per-device secret. A415: the session is the till's own (buildDeviceTokenPayload) — no person.
router.post('/device-token', async (req, res) => {
  const businessId = String(req.body?.business_id ?? '').trim();
  const deviceId   = String(req.body?.device_id ?? '').trim();
  const secret     = String(req.body?.device_secret ?? '').trim();
  if (!businessId || !deviceId) {
    res.status(400).json({ error: 'business_id and device_id are required' });
    return;
  }
  // A407: a till asks here only when its session was refused. With no secret (enrolled before it kept one) it cannot
  // sign back in — record it so ZapTill is emailed (watchdog, critical), and say so.
  if (!secret) {
    await markTillSessionLost(businessId, deviceId, 'Its sign-in was refused and it holds no device secret');
    res.status(401).json({ error: 'This till needs a technician to rejoin it to the business.', code: 'DEVICE_NO_SECRET' });
    return;
  }

  const { data: dev, error: devErr } = await supabase
    .from('user_devices')
    .select('id, device_id, business_id, branch_id, status, retired_at, device_secret_hash')
    .eq('business_id', businessId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (devErr) { sendError(res, devErr); return; }

  // Uniform failure — never reveal which check failed (unknown device, wrong
  // secret, or a revoked/retired/pending till all look identical to a caller).
  const blocked = tillBlockReason(dev as { status?: string; retired_at?: string } | null);
  if (blocked || !verifyDeviceSecret(secret, (dev as any).device_secret_hash)) {
    // A407: a till ZapTill blocked or retired is not "lost" — no alert for a deliberate block.
    if (dev && !blocked) await markTillSessionLost(businessId, deviceId, 'Its sign-in was refused and its device secret was not accepted');
    res.status(401).json({ error: 'Device grant refused', code: 'DEVICE_GRANT_INVALID' });
    return;
  }
  // A477: the secret is the machine's — from another computer it is refused and the owner alerted.
  const ident = await checkTillIdentity(businessId, deviceId, (n) => req.header(n));
  if (ident.verdict === 'mismatch') {
    res.status(401).json({ error: 'This till\'s sign-in belongs to another computer.', code: 'DEVICE_MISMATCH' });
    return;
  }
  await clearTillSessionLost(businessId, deviceId);   // A407: back

  // A suspended business must not bring a session online, same as the other paths.
  const { data: biz } = await supabase
    .from('businesses').select('id, name, currency, type, status').eq('id', businessId).maybeSingle();
  if (!biz) { res.status(500).json({ error: 'Business not found for a valid device', code: 'DEVICE_GRANT_STATE' }); return; }
  if ((biz as any).status === 'suspended') {
    res.status(403).json({ error: 'Your account has been suspended. Please contact ZapTill support.', code: 'ACCOUNT_SUSPENDED' });
    return;
  }

  const branchId = (dev as any).branch_id ?? null;
  const payload: TokenPayload = buildDeviceTokenPayload({ deviceId, businessId, branchId, sessionId: newSessionId() });
  const { accessToken, refreshToken } = issueTokenPair(payload);
  await storeRefreshToken(refreshToken, payload, req.ip ?? undefined, deviceId);

  res.json({
    accessToken,
    refreshToken,
    token: accessToken,
    businessId,
    branchId,
    business: biz,
  });
});


// Validates the refresh token against the DB, rotates it and re-fetches permissions so role changes propagate
// immediately. A477: the consumed token is NOT revoked here — the till confirms the new one (POST /refresh/ack, or by
// presenting it) and only then is the old one revoked (lib/refreshHandshake.ts). Answers `ack: true` so a till knows to.

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }

  let payload: any;
  let dbRow: any;
  let decision: HandshakeDecision;
  let handshake = false;
  try {
    ({ payload, dbRow, decision, handshake } = await validateRefreshToken(refreshToken));
  } catch (err: any) {
    // Deliberate token errors carry a TOKEN_* code and a user-safe message —
    // surface those so the client can react. Anything else is unexpected and
    // must not be leaked.
    if (err?.code === 'DB_UNAVAILABLE') {
      // P2-18: the database, not the token — keep the token, try again (a client treats 5xx as "retry later").
      res.status(503).json({ error: err.message, code: 'DB_UNAVAILABLE' });
    } else if (typeof err?.code === 'string' && err.code.startsWith('TOKEN_')) {
      res.status(401).json({ error: err.message, code: err.code });
    } else {
      sendError(res, err, { status: 401, message: 'Authentication failed' });
    }
    return;
  }

  const { tokenType, iat, exp, jti, ...cleanPayload } = payload;

  // A415: a till's session renews as the till's own — and a till session from before A415 (the owner's identity on the
  // till) is replaced by one here. Worked out BEFORE the consumed token is spent, so a till that may not renew keeps
  // nothing half-done.
  const tillSession = isTillPayload(cleanPayload) || isOwnerEraTillPayload(cleanPayload);
  let newPayload: TokenPayload;
  let personPermissions: Record<string, true> | null = null;   // A490: the renewed person's permission map
  let tillDevice: { device_id: string; device_secret_hash: string | null; identityMatched: boolean } | null = null;
  if (tillSession) {
    const header = String(req.header('x-device-id') ?? '').split(',')[0].trim();
    // Which till: the token's own id; a pre-A415 session is matched by the device it was issued to (or the id the till
    // sends, for one issued before the device id was kept).
    const candidates = [...new Set([isTillPayload(cleanPayload) ? String(cleanPayload.deviceId) : '', dbRow.device_hint ?? '', header]
      .map((x) => String(x).trim()).filter((x) => x && x.length <= 64))];
    const { data: rows, error: devErr } = candidates.length
      ? await supabase.from('user_devices').select('device_id, branch_id, status, retired_at, device_secret_hash')
          .eq('business_id', cleanPayload.businessId).in('device_id', candidates)
      : { data: [], error: null };
    if (devErr) { sendError(res, devErr); return; }
    const row = candidates.map((c) => (rows ?? []).find((r: any) => r.device_id === c)).find(Boolean) as any;
    if (!row) {
      res.status(401).json({ error: 'This till is no longer joined to the business. A technician can rejoin it.', code: 'DEVICE_UNKNOWN' });
      return;
    }
    if (tillBlockReason(row)) {
      res.status(401).json({ error: 'This till is no longer joined to the business. A technician can rejoin it.', code: 'DEVICE_BLOCKED' });
      return;
    }
    // A477: the key is bound to the machine — from another computer it is refused (the session is NOT revoked, the
    // owner is alerted); the token stays unspent.
    const ident = await checkTillIdentity(cleanPayload.businessId, row.device_id, (n) => req.header(n));
    if (ident.verdict === 'mismatch') {
      res.status(401).json({ error: 'This till\'s sign-in belongs to another computer.', code: 'DEVICE_MISMATCH' });
      return;
    }
    tillDevice = { device_id: row.device_id, device_secret_hash: row.device_secret_hash ?? null, identityMatched: ident.matched };
    newPayload = buildDeviceTokenPayload({
      deviceId: row.device_id, businessId: cleanPayload.businessId,
      branchId: tillBranch(null, row.branch_id, cleanPayload.branchId), sessionId: cleanPayload.sessionId,
    });
    if (!isTillPayload(cleanPayload)) console.log(`[refresh] till ${row.device_id}: owner-era session replaced by the till's own`);
  } else if (cleanPayload.webPartner === true) {
    // A550: a partner renews only while the owner's grant stands and they are still an active person of the business, not
    // on the owner's role, with an open branch (lib/webPartners.ts checkPartner) — their keys and branches read afresh.
    // Anything else: 401 SIGN_IN_AGAIN, the same answer whichever it is. Never the owner (isOwner stays false).
    const c = await checkPartner(String(cleanPayload.businessId ?? ''), String(cleanPayload.userId ?? ''), null);
    if (c.ok === false) {
      if (c.reason === 'DB_ERROR') { res.status(503).json({ error: 'Could not check the sign-in just now — try again', code: 'DB_UNAVAILABLE' }); return; }
      console.warn(`[refresh] A550: partner ${c.reason} — renewal refused`, { userId: cleanPayload.userId, businessId: cleanPayload.businessId });
      res.status(401).json({ error: 'Please sign in again.', code: 'SIGN_IN_AGAIN', reason: 'PARTNER_ENDED' });
      return;
    }
    const held = effectiveKeysForRow(c.person as any);
    if (held.has('*')) { res.status(401).json({ error: 'Please sign in again.', code: 'SIGN_IN_AGAIN', reason: 'PARTNER_ENDED' }); return; }
    cleanPayload.isOwner = false;
    cleanPayload.roleId = c.person.role_id ?? null;
    cleanPayload.roleName = c.person.roles?.name ?? null;
    cleanPayload.permissionKeys = tokenKeys(held);
    cleanPayload.permissionsVersion = c.person.permissions_version ?? 1;
    cleanPayload.partnerBranches = c.branchIds;
    cleanPayload.allBranches = c.allBranches;
    cleanPayload.branchId = c.allBranches ? null
      : (cleanPayload.branchId && c.branchIds.includes(cleanPayload.branchId) ? cleanPayload.branchId : (c.branchIds[0] ?? null));
    personPermissions = clientPermissionMap(held);
    newPayload = { ...cleanPayload };
  } else {
    // A451: an owner session that carries no users row (issued before A451) is mended at its next renewal — it takes
    // the owner's row (found, or created) instead of the auth.users id the database refuses.
    if (cleanPayload.isOwner && cleanPayload.userId && cleanPayload.businessId) {
      const { data: mine } = await supabase.from('users').select('id')
        .eq('id', cleanPayload.userId).eq('business_id', cleanPayload.businessId).maybeSingle();
      if (!mine) {
        const { data: authUser } = await supabase.auth.admin.getUserById(cleanPayload.userId).catch(() => ({ data: null } as any));
        const row = await ensureOwnerUserRow(cleanPayload.businessId, (authUser as any)?.user?.email ?? null);
        if (row) {
          console.warn('[refresh] A451: owner session moved to its users row', { businessId: cleanPayload.businessId, userId: row.id });
          cleanPayload.userId = row.id;
        }
      }
    }
    // A494: a person's renewal re-reads WHO they are, every time — role, the role's keys, their overrides, status,
    // business and branches. It used to copy the old token forward (a deactivated person, or one whose role was taken
    // away, renewed for 30 days; an "Admin" PIN sign-in stayed the owner after their role changed). Missing / not active
    // / another business → 401 SIGN_IN_AGAIN; the token's branch no longer theirs → 401 SIGN_IN_AGAIN (BRANCH_REMOVED).
    // The owner's password session (ownerLogin, or the real owner with no users row — A451's fallback) keeps '*'.
    const ownerPassword = cleanPayload.isOwner === true
      && (cleanPayload.ownerLogin === true || (!cleanPayload.surface && !cleanPayload.roleId && cleanPayload.pinSignIn !== true));
    const { data: me, error: meErr } = await supabase.from('users')
      .select('id, status, business_id, role_id, permissions_version, roles ( id, name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) ), user_branches ( branch_id )')
      .eq('id', cleanPayload.userId).maybeSingle();
    if (meErr) { res.status(503).json({ error: 'Could not check the sign-in just now — try again', code: 'DB_UNAVAILABLE' }); return; }
    const refuse = (reason: string) => {
      console.warn(`[refresh] A494: ${reason} — renewal refused`, { userId: cleanPayload.userId, businessId: cleanPayload.businessId });
      res.status(401).json({ error: 'Please sign in again.', code: 'SIGN_IN_AGAIN', reason });
    };
    if (!me) {
      if (!ownerPassword) { refuse('ACCOUNT_GONE'); return; }
      // The owner with no users row (A451 could not make one): as before — the owner's '*'.
      personPermissions = { '*': true };
      cleanPayload.permissionKeys = ['*'];
      cleanPayload.permissionsVersion = 1;
    } else {
      const row = me as any;
      if (row.business_id !== cleanPayload.businessId) { refuse('OTHER_BUSINESS'); return; }
      if (row.status !== 'active') { refuse('ACCOUNT_INACTIVE'); return; }
      const roleOwner = isOwnerRoleName(row.roles?.name);
      const isOwnerNow = ownerPassword || roleOwner;
      if (!isOwnerNow && cleanPayload.branchId && !worksAtBranch(row.user_branches, cleanPayload.branchId)) {
        refuse('BRANCH_REMOVED'); return;
      }
      if (!isOwnerNow && !cleanPayload.branchId) { refuse('NO_BRANCH'); return; }   // never a non-owner without a branch
      cleanPayload.roleId = row.role_id ?? null;
      cleanPayload.roleName = row.roles?.name ?? null;
      cleanPayload.isOwner = isOwnerNow;
      if (isOwnerNow) {
        cleanPayload.permissionKeys = ['*'];
        personPermissions = { '*': true };
        if (!ownerPassword) cleanPayload.branchId = null;   // the owner's role works at every branch (as at sign-in)
      } else {
        const held = keysFromGrants(row.roles?.role_permissions, row.user_permissions, permissionsOpenBefore());
        cleanPayload.permissionKeys = tokenKeys(held);
        personPermissions = clientPermissionMap(held);
      }
      // Embed the fresh permissions_version. Keep the existing sessionId so device-level logout still works.
      cleanPayload.permissionsVersion = row.permissions_version ?? 1;
    }
    newPayload = { ...cleanPayload };
  }

  // A477: apply the handshake's decision, now that the till may renew.
  const nowIso = new Date().toISOString();
  if (decision!.implicitAck) {
    // The client's first use of a successor it never confirmed (an older till never calls /ack): confirm it, and
    // retire the token it replaced.
    const { error: ackErr } = await supabase.from('refresh_tokens').update({ acked_at: nowIso }).eq('id', dbRow.id).is('acked_at', null);
    if (ackErr) console.warn('[refresh] A477: implicit ack not recorded', ackErr.message);
    await revokeParentOf(dbRow.id);
  }
  if (decision!.action === 'reask') {
    // The successor never reached the client (a lost reply, a crash before the till wrote it): revoke that orphan so the
    // session stays single-headed, then mint a fresh one below and re-point the chain. No session-wide revoke.
    if (dbRow.replaced_by) {
      await supabase
        .from('refresh_tokens')
        .update({ revoked_at: nowIso })
        .eq('id', dbRow.replaced_by)
        .is('revoked_at', null);
    }
  } else if (decision!.revokeConsumed) {
    // Before migration 131: the old rotation — revoke the consumed token before issuing the new pair.
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: nowIso })
      .eq('id', dbRow.id);
  }

  const { accessToken, refreshToken: newRefreshToken } = issueTokenPair(newPayload);

  const newId = await storeRefreshToken(newRefreshToken, newPayload,
    req.ip ?? undefined,
    // Carry the ORIGINAL device key forward rather than re-deriving it (a till: its own id).
    //
    // A refresh does not carry a request body, so deviceKey() would fall back to
    // the User-Agent and the row would silently revert to the shared value on the
    // first rotation — undoing the fix an hour after sign-in, which is worse than
    // not having made it, because the failure would look intermittent.
    tillDevice?.device_id ?? dbRow.device_hint ?? req.headers['user-agent'] ?? undefined,
  );

  // Link the consumed (or re-asked) token to its replacement so a later presentation can tell a lost reply from an
  // outdated copy (A88 / D13, A477). On the re-ask this re-points the chain from the orphaned successor to the fresh one.
  if (newId) {
    await supabase
      .from('refresh_tokens')
      .update({ replaced_by: newId })
      .eq('id', dbRow.id);
  }

  // A407 / A477: every till holds a device secret — its way back in if this session is ever refused. Given on a
  // renewal when the till's row has none; and when the till says it lost its copy (X-Device-Secret-Missing: 1) a fresh
  // one replaces it — only for a request from the machine on record (its guid or serial matched).
  let deviceSecret: string | null = null;
  const lostCopy = String(req.header('x-device-secret-missing') ?? '').trim() === '1';
  const issueSecret = async (till: { device_id: string; device_secret_hash: string | null }, businessId: string): Promise<string | null> => {
    const raw = generateDeviceSecret();
    let q = supabase.from('user_devices')
      .update({ device_secret_hash: hashDeviceSecret(raw), device_secret_set_at: nowIso })
      .eq('business_id', businessId).eq('device_id', till.device_id);
    // Only over the hash this renewal saw (none, or the lost one) — two renewals at once never hand out two secrets.
    q = till.device_secret_hash ? q.eq('device_secret_hash', till.device_secret_hash) : q.is('device_secret_hash', null);
    const { error: secErr } = await q;
    if (secErr) return null;
    console.log(`[refresh] till ${till.device_id}: ${till.device_secret_hash ? 'its lost device secret replaced' : 'given a device secret'}`);
    return raw;
  };
  if (tillDevice) {
    try {
      if (!tillDevice.device_secret_hash) {
        deviceSecret = await issueSecret(tillDevice, newPayload.businessId);
      } else if (lostCopy && tillDevice.identityMatched) {
        // A477: the till lost its copy — a fresh one, only for the machine on record.
        deviceSecret = await issueSecret(tillDevice, newPayload.businessId);
      }
      await clearTillSessionLost(newPayload.businessId, tillDevice.device_id);
    } catch { /* additive — the renewal stands without it */ }
  }

  // A477: `ack: true` — confirm the new token (POST /refresh/ack) once it is kept.
  res.json({ accessToken, refreshToken: newRefreshToken, token: accessToken, ...(deviceSecret ? { deviceSecret } : {}), ...(handshake ? { ack: true } : {}),
    ...(personPermissions ? { permissions: personPermissions } : {}) });   // A490: a person's token only (never the till's own)
});

/** A477: retire the token a confirmed successor replaced (one row, by id). */
async function revokeParentOf(id: string): Promise<void> {
  const { data: parents, error } = await supabase.from('refresh_tokens').select('id').eq('replaced_by', id).is('revoked_at', null);
  if (error) { console.warn('[refresh] A477: the replaced token could not be found', error.message); return; }
  for (const p of (parents ?? []) as Array<{ id: string }>) {
    await supabase.from('refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', p.id).is('revoked_at', null);
  }
}

// ── POST /api/auth/refresh/ack ────────────────────────────────────────────────
// A477: the till has written its new token to disk — the token it replaced is retired. Harmless to repeat, harmless to
// lose (the next renewal with the new token is an implicit ack). Answers 401 for a token that is not the live head.
router.post('/refresh/ack', async (req, res) => {
  const presented = String(req.body?.refreshToken ?? '');
  if (!presented) { res.status(400).json({ error: 'refreshToken is required' }); return; }
  let payload: any;
  try {
    payload = jwt.verify(presented, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token', code: 'TOKEN_INVALID' }); return;
  }
  if (payload?.tokenType !== 'refresh' || !payload.jti) { res.status(401).json({ error: 'Not a refresh token', code: 'TOKEN_INVALID' }); return; }
  const { data: row, error } = await supabase.from('refresh_tokens').select('*').eq('jti', hashToken(payload.jti)).maybeSingle();
  if (error) { sendError(res, error); return; }
  if (!row) { res.status(401).json({ error: 'Refresh token not recognised', code: 'TOKEN_UNKNOWN' }); return; }
  if (!Object.prototype.hasOwnProperty.call(row, 'acked_at')) { res.json({ ok: true, acked: false }); return; }   // before migration 131
  if ((row as any).revoked_at) { res.status(401).json({ error: 'This sign-in key was already replaced', code: 'TOKEN_STALE' }); return; }
  // The till's own session: only from the machine on record (the same rule as the renewal).
  if (isTillPayload(payload) && payload.businessId) {
    const ident = await checkTillIdentity(payload.businessId, String(payload.deviceId), (n) => req.header(n));
    if (ident.verdict === 'mismatch') {
      res.status(401).json({ error: 'This till\'s sign-in belongs to another computer.', code: 'DEVICE_MISMATCH' }); return;
    }
  }
  if (!(row as any).acked_at) {
    const { error: ackErr } = await supabase.from('refresh_tokens').update({ acked_at: new Date().toISOString() }).eq('id', (row as any).id).is('acked_at', null);
    if (ackErr) { sendError(res, ackErr); return; }
  }
  await revokeParentOf((row as any).id);
  res.json({ ok: true, acked: true });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// Revokes the specific refresh token. The access token expires naturally (≤15 min).
// Pass logoutAll: true to revoke every active session for this user.

router.post('/logout', async (req, res) => {
  const { refreshToken, logoutAll } = req.body;

  if (logoutAll && req.headers.authorization) {
    // Revoke all sessions for this user — used for "log out everywhere"
    try {
      const token = req.headers.authorization.slice(7);
      // A494: VERIFIED, never decoded — a made-up token naming someone else signed that person out everywhere.
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; businessId?: string } | null;
      // A407: every browser of this user. A till's own session names no person, so it is never among them (A415).
      if (payload?.userId) await revokeBrowserSessions([payload.userId], payload.businessId ? [payload.businessId] : []);
    } catch { /* best effort */ }
  } else if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  res.json({ success: true });
});

// ── POST /api/auth/pos-login ──────────────────────────────────────────────────

router.post('/pos-login', async (req, res) => {
  const { email, pin, branch_id, surface: callerSurface, subdomain } = req.body;

  if (!email || !pin) {
    res.status(400).json({ error: 'email and pin are required' });
    return;
  }
  // A494: failed sign-ins per ACCOUNT (lib/pinAttempts.ts): 10 in 15 minutes and this e-mail is paused, from anywhere.
  if (accountLocked(email)) { res.status(429).json(ACCOUNT_LOCKED_BODY); return; }
  const fail401 = (body: object) => {
    if (noteAccountFailure(email)) notifyAccountLocked(email, req.ip, 'the web POS');   // A507: the account is told
    res.status(401).json(body);
  };

  // A378: on a client's own address only that business's people may sign in (see the filter below).
  const tenant = await findTenant(subdomain);
  if (tenant.kind === 'error') { res.status(503).json({ error: 'Could not sign you in right now — please try again' }); return; }
  if (tenant.kind === 'unknown') {
    res.status(404).json({ error: 'No ZapTill business uses this address.', code: 'UNKNOWN_SUBDOMAIN' });
    return;
  }

  if (!/^\d{4,6}$/.test(String(pin))) {
    fail401({ error: 'Invalid email or PIN' });
    return;
  }

  const authError = { error: 'Invalid email or PIN' };

  // ── Resolving WHICH user this is ────────────────────────────────────────
  //
  // This used to be a single global .ilike(...).single(). Two things were wrong
  // with that, and both failed CLOSED with the same misleading message, so
  // neither was ever going to be reported as anything but "the PIN is broken".
  //
  // 1. TENANT COLLISION. users is UNIQUE (business_id, email) — see
  //    00_baseline.sql — so the SAME email is allowed to exist in two
  //    businesses. When it does, .single() returns PGRST116, userErr is truthy,
  //    and the cashier is told "Invalid email or PIN" forever. Resetting the PIN
  //    does not help, because the PIN was never the problem.
  //
  // 2. ilike IS A PATTERN MATCH. % and _ are LIKE metacharacters, and _ is a
  //    LEGAL EMAIL CHARACTER. So john_doe@x.com would also match johnXdoe@x.com.
  //    A login field should never accept wildcards at all.
  //
  // The fix: use ilike only as a coarse, index-friendly, case-insensitive
  // filter, then require an EXACT case-insensitive match in JS (which no
  // wildcard can satisfy), and disambiguate across tenants using the branch the
  // till is logging in to.
  const needle = String(email).trim().toLowerCase();

  // `_` and `%` are LIKE WILDCARDS, and `_` is a perfectly legal character in
  // an email address (audit C4). Passing the address straight into .ilike()
  // meant `john_doe@x.com` also matched `johnXdoe@x.com` — and with `.limit(20)`
  // on top, an address containing `_` at a business with enough similar
  // addresses could push the REAL row outside the window and produce "Invalid
  // email or PIN" for a correct email and a correct PIN. That is the exact
  // symptom BUG-05 was supposed to have killed, arriving by another route.
  //
  // PostgREST's ilike takes `*` as its wildcard and passes `%` and `_` through
  // to LIKE, so both must be neutralised. Escaping makes the coarse filter mean
  // what it says; the exact comparison below is still what decides.
  const likeSafe = needle.replace(/[\\%_]/g, ch => `\\${ch}`);

  const { data: candidates, error: userErr } = await supabase
    .from('users')
    .select(`
      id, name, email, status, pin_hash, business_id,
      permissions_version,
      roles ( id, name,
        role_permissions ( permissions ( id, key ) )
      ),
      user_branches ( branch_id, branches ( id, name, desktop_licensed ) ),
      user_permissions ( granted, permissions ( key ) )
    `)
    .eq('status', 'active')
    .ilike('email', likeSafe)
    // 20 was a truncation risk with an unescaped pattern. Escaped, this can
    // only ever match genuine case variants of one address, which is bounded by
    // the number of tenants an address appears in — but the cap stays, raised,
    // because a cap that can silently hide the row you need is worth being
    // generous about.
    .limit(200);

  if (userErr) { res.status(401).json(authError); return; }

  // Exact match, not a pattern match. This is what neutralises % and _.
  let matches = (candidates ?? []).filter(
    (u: any) => String(u.email ?? '').trim().toLowerCase() === needle,
  );
  // A378: a client's address admits that business's people only — the same answer as a wrong email, so the address
  // does not tell anyone which emails exist elsewhere. It also settles an email registered with two businesses.
  if (tenant.kind === 'found') {
    matches = matches.filter((u: any) => u.business_id === tenant.tenant.id);
  }

  // Same email in more than one business: the branch being logged in to says
  // which tenant is meant. The branch is validated against the user's own
  // accessible branches further down, so this narrows without granting anything.
  if (matches.length > 1 && branch_id) {
    const { data: branchRow } = await supabase
      .from('branches')
      .select('business_id')
      .eq('id', branch_id)
      .maybeSingle();
    if (branchRow?.business_id) {
      matches = matches.filter((u: any) => u.business_id === branchRow.business_id);
    }
  }

  if (matches.length > 1) {
    // Say what is actually wrong. Silently failing here is what turns a
    // five-minute fix into a day of support calls about a working PIN.
    res.status(409).json({
      error: 'This email is registered with more than one business. '
           + 'Select a branch on this device, or contact ZapTill support.',
      code:  'AMBIGUOUS_ACCOUNT',
    });
    return;
  }

  const user = matches[0];
  if (!user) { fail401(authError); return; }
  if (!(user as any).pin_hash) { fail401(authError); return; }

  const { valid, needsUpgrade } = await verifyPin(
    String(pin),
    (user as any).pin_hash,
    (user as any).business_id,
  );
  if (!valid) { fail401(authError); return; }
  noteAccountSuccess(email);

  const role    = (user as any).roles;
  const isOwner = isOwnerRoleName(role?.name);   // A490: the one place a role name decides (lib/ownerRole)

  // A37 — the surface that EXEMPTS a caller from the per-branch desktop licence
  // must be earned, not asserted. /pos-login serves the web POS AND, from a
  // misusing client, a till claiming surface:'web' to skip the licence. Honour
  // 'web' only when the business actually holds web access — the same server
  // check /login gates on (webAccess.ts). A caller with no web entitlement that
  // claims 'web' is treated as a desktop till, so the licence gate below applies
  // and pos.ts's gate (which reads this token's surface) can no longer be dodged.
  const posWebAccess = await getWebAccess((user as any).business_id);
  const effectiveSurface: 'web' | 'desktop' =
    callerSurface === 'web' && posWebAccess.canLogin ? 'web' : 'desktop';

  let accessibleBranches: { id: string; name: string; desktop_licensed: boolean }[];
  if (isOwner || ((user as any).user_branches ?? []).length === 0) {
    const { data: allBranches } = await supabase
      .from('branches')
      .select('id, name, desktop_licensed')
      .eq('business_id', (user as any).business_id)
      .eq('status', 'active')
      .order('name');
    accessibleBranches = allBranches ?? [];
  } else {
    accessibleBranches = ((user as any).user_branches ?? []).map((ub: any) => ub.branches).filter(Boolean);
  }

  let resolvedBranchId: string | null = branch_id ?? null;
  if (branch_id) {
    if (!accessibleBranches.find((b: any) => b.id === branch_id)) {
      res.status(403).json({ error: 'You are not assigned to this branch' });
      return;
    }
  } else if (accessibleBranches.length === 1) {
    resolvedBranchId = accessibleBranches[0].id;
  }
  // A494: never a non-owner token without a branch (a branchless token used to read every branch — rbac.branchScope).
  if (!isOwner && !resolvedBranchId && accessibleBranches.length === 0) {
    res.status(403).json({ error: 'You are not assigned to an open branch. Ask the owner to add you to one.', code: 'NO_BRANCH' });
    return;
  }
  // Desktop-licence gate applies to desktop tills only. A web POS login is gated by web access, not by the branch's
  // desktop licence. effectiveSurface (A37) is 'web' only if the business truly holds web access, so a till claiming
  // 'web' without web entitlement is licence-checked. A494: on the RESOLVED branch — the one branch picked for the caller
  // was never checked.
  const resolvedBranch = resolvedBranchId ? accessibleBranches.find((b: any) => b.id === resolvedBranchId) : null;
  if (resolvedBranch && effectiveSurface !== 'web' && !resolvedBranch.desktop_licensed) {
    res.status(403).json({
      error: `${resolvedBranch.name} does not have a desktop licence. Contact ZapTill to activate.`,
      code:  'BRANCH_NOT_LICENSED',
    });
    return;
  }

  if (needsUpgrade) {
    const newHash = await hashPinBcrypt(String(pin));
    await supabase.from('users').update({ pin_hash: newHash }).eq('id', (user as any).id);
  }

  // A490: one rule (lib/effectivePermissions): fine keys, broad grants expanded, '*' for the owner.
  const heldKeys = effectiveKeysForRow(user as any);
  const effectivePerms = clientPermissionMap(heldKeys);

  // ── Device registration check ───────────────────────────────────────────────
  const clientHint = req.body.device_hint as string | undefined;
  const devCheck   = await checkDeviceRegistration(
    (user as any).business_id, (user as any).id, req, clientHint,
    isOwner, heldKeys,
  );

  if (devCheck.result === 'pending') {
    res.status(403).json({
      error: 'This device is not yet approved. Please ask your manager to approve it in Settings → Devices.',
      code:  'DEVICE_NOT_REGISTERED',
      deviceId: devCheck.deviceId,
    });
    return;
  }

  if (devCheck.result === 'rejected') {
    res.status(403).json({
      error: 'This device has been blocked. Please contact your manager.',
      code:  'DEVICE_REJECTED',
    });
    return;
  }

  // A391: owners and managers enter a one-time code too (mandatory); cashiers do not. A till never comes here — it signs
  // in by enrolment and PIN (/verify-pin), offline as well. A494: whatever surface the caller CLAIMS — claiming
  // 'desktop' used to skip the code.
  let posGate: { trust?: string; pass?: string } = {};
  // Same people the web sends to the manager screens (posRouting.ts): A490 — anyone back office (isBackOffice).
  // A398: only when the admin portal has turned 'Sign-in codes' on for this client.
  if (needsOtp(heldKeys, isOwner)
      && (await businessPosFeatures((user as any).business_id)).login_codes) {
    const g = await otpGate(await otpSubjectFor((user as any).id, (user as any).email, (user as any).name), req.body);
    if (g.ok === false) { res.status(g.status).json(g.body); return; }
    posGate = g;
  }

  // A494: more than one branch and none chosen — the branch list only, no session. The caller asks again with branch_id
  // (the web POS's branch picker does), and only then is a token issued — for that branch.
  if (!resolvedBranchId && accessibleBranches.length > 1) {
    res.json({
      needsBranchSelection: true,
      staff:    { id: (user as any).id, name: (user as any).name, role: role?.name },
      branchId: null,
      branches: accessibleBranches.map((b: any) => ({ id: b.id, name: b.name, licensed: b.desktop_licensed })),
      ...(posGate.trust ? { otp_trust: posGate.trust } : {}),
      ...(posGate.pass ? { otp_pass: posGate.pass } : {}),
    });
    return;
  }

  // Revoke any prior active session for this user ON THIS DEVICE before issuing
  // a new one, so stale sessions do not accumulate when someone signs in
  // repeatedly on one machine.
  //
  // Keyed on deviceKey(), NOT the User-Agent — see its docblock. Keying on the
  // User-Agent meant one till's sign-in revoked every other till's session,
  // because they are all the same build on the same OS.
  const userAgent = req.headers['user-agent']?.slice(0, 200) ?? null;
  const devKey = deviceKey(req);
  // till-safe: this person's own sessions on this browser (a browser's key is never a till's device_id)
  if (devKey) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', (user as any).id)
      .eq('device_hint', devKey)
      .is('revoked_at', null);
  }

  const sessionId = newSessionId();
  const pv = (user as any).permissions_version ?? 1;

  const tokenPayload: TokenPayload = {
    userId:             (user as any).id,
    businessId:         (user as any).business_id,
    branchId:           isOwner ? null : (resolvedBranchId ?? null),
    roleId:             role?.id ?? null,
    roleName:           role?.name ?? null,
    isOwner,
    permissionKeys:     tokenKeys(heldKeys),   // A490: fine keys (or '*') — the cloud checks these
    permissionsVersion: pv,
    sessionId,
    surface:            effectiveSurface,
  };

  const { accessToken, refreshToken } = issueTokenPair(tokenPayload);

  await storeRefreshToken(refreshToken, tokenPayload,
    req.ip ?? undefined,
    // Store the SAME key the revoke above queries on. Storing the User-Agent
    // while revoking on device id would mean nothing ever matched, and stale
    // sessions would pile up unnoticed.
    devKey ?? userAgent ?? undefined,
  );

  res.json({
    accessToken, refreshToken, token: accessToken,
    staff:       { id: (user as any).id, name: (user as any).name, role: role?.name },
    permissions: effectivePerms,
    branchId:    resolvedBranchId,
    branches:    accessibleBranches.map((b: any) => ({ id: b.id, name: b.name, licensed: b.desktop_licensed })),
    needsBranchSelection: false,
    ...(posGate.trust ? { otp_trust: posGate.trust } : {}),
    ...(posGate.pass ? { otp_pass: posGate.pass } : {}),
  });
});

// ── POST /api/auth/verify-pin ─────────────────────────────────────────────────

router.post('/verify-pin', requireAuth, async (req, res) => {
  const { pin, branch_id } = req.body;

  // A494: a PIN sign-in on a TILL — asked by the till's own session (the desktop's PIN pad) or by a person's PIN sign-in
  // on a till. Any other session (a web browser, a web POS cashier, the owner's dashboard) could otherwise try every
  // PIN of the business and walk away with the session of whoever it matched. Nothing on the web calls it.
  if (!(req.isTill || req.pinSignIn)) {
    res.status(403).json({ error: 'PIN sign-in is for tills.', code: 'TILL_ONLY' });
    return;
  }
  // A494: one PIN limiter (lib/pinAttempts.ts) — per till (or person), the right PIN refused too while paused. The
  // desktop reads a 429 as "cannot ask the cloud now" and checks the PIN on its own staff list meanwhile.
  const pk = pinKey(req);
  if (pinLocked(pk)) { res.status(429).json(PIN_LOCKED_BODY); return; }

  if (!pin || !branch_id) {
    res.status(400).json({ error: 'pin and branch_id are required' });
    return;
  }

  if (!/^\d{4,6}$/.test(String(pin))) {
    res.status(400).json({ error: 'PIN must be 4–6 digits' });
    return;
  }

  const { data: branch, error: branchErr } = await supabase
    .from('branches')
    .select('id, name, desktop_licensed')
    .eq('id', branch_id)
    .eq('business_id', req.businessId)
    .single();

  if (branchErr || !branch) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }

  // verify-pin runs behind requireAuth; the owner opening the web POS carries
  // surface='web'. The desktop-licence gate is for desktop tills only — web POS
  // access is already granted by web access at owner login.
  if (req.surface === 'desktop' && !(branch as any).desktop_licensed) {
    res.status(403).json({
      error: `This branch (${(branch as any).name}) does not have a desktop licence. Please contact ZapTill to activate.`,
      code:  'BRANCH_NOT_LICENSED',
    });
    return;
  }

  const { data: staffList, error: staffErr } = await supabase
    .from('users')
    .select(`
      id, name, status, pin_hash, permissions_version,
      roles ( id, name,
        role_permissions ( permissions ( id, key ) )
      ),
      user_branches ( branch_id ),
      user_permissions ( granted, permissions ( key ) )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'active');

  if (staffErr) {
    res.status(500).json({ error: 'Failed to load staff' });
    return;
  }

  // Match the PIN against active staff. CRITICAL for attribution (finding #11):
  // if two cashiers share a PIN, the old code took the FIRST match and every
  // sale one of them rang was booked to the other. We now scan ALL staff and
  // refuse if more than one matches, rather than silently mis-attributing.
  // Uniqueness is also enforced at set-pin time (below), so a collision here
  // means legacy data that predates that guard — and it must be corrected, not
  // guessed past.
  const matches: any[] = [];
  let needsUpgrade = false;
  for (const staff of staffList ?? []) {
    if (!(staff as any).pin_hash) continue;
    const { valid, needsUpgrade: upgrade } = await verifyPin(
      String(pin),
      (staff as any).pin_hash,
      req.businessId,
    );
    if (valid) {
      matches.push(staff);
      if (upgrade) needsUpgrade = true;
    }
  }

  if (matches.length > 1) {
    notePinFailure(pk);   // A494: a shared PIN still says something about other people's PINs — counted
    // Ambiguous — two staff share this PIN. Refuse rather than attribute a shift
    // and every subsequent sale to the wrong person.
    res.status(409).json({
      error: 'This PIN is shared by more than one staff member. Ask a manager to reset the affected PINs before signing in.',
      code: 'PIN_NOT_UNIQUE',
    });
    return;
  }

  const matchedUser: any = matches[0] ?? null;

  if (!matchedUser) {
    notePinFailure(pk);   // A494
    res.status(401).json({ error: 'Invalid PIN' });
    return;
  }
  notePinSuccess(pk);

  if (!worksAtBranch(matchedUser.user_branches, branch_id)) {   // A426: one rule with the branch server's roster
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  if (needsUpgrade) {
    const newHash = await hashPinBcrypt(String(pin));
    await supabase.from('users').update({ pin_hash: newHash }).eq('id', matchedUser.id);
  }

  // A490: one rule (lib/effectivePermissions). The owner holds '*' here too — the till decided that by role name.
  const heldKeys = effectiveKeysForRow(matchedUser as any);
  const effectivePerms = clientPermissionMap(heldKeys);

  const role    = matchedUser.roles;
  const isOwner = isOwnerRoleName(role?.name);

  // ── Device registration check ───────────────────────────────────────────────
  const clientHintV = req.body.device_hint as string | undefined;
  const devCheckV   = await checkDeviceRegistration(
    req.businessId, matchedUser.id, req, clientHintV,
    isOwner, heldKeys,
  );

  if (devCheckV.result === 'pending') {
    res.status(403).json({
      error: 'This device is not yet approved. Please ask your manager to approve it in Settings → Devices.',
      code:  'DEVICE_NOT_REGISTERED',
      deviceId: devCheckV.deviceId,
    });
    return;
  }

  if (devCheckV.result === 'rejected') {
    res.status(403).json({
      error: 'This device has been blocked. Please contact your manager.',
      code:  'DEVICE_REJECTED',
    });
    return;
  }

  // Same as above: this device only, not every till sharing a User-Agent.
  const userAgent = req.headers['user-agent']?.slice(0, 200) ?? null;
  const devKeyV = deviceKey(req);
  // This person's earlier sessions on this device end. A415: the till's own session names no person (user_id is
  // null on its rows), so a PIN sign-in — the owner's included — can never end the till's session.
  // till-safe: by this person's id only — a till's own session has no person (A415)
  if (devKeyV) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', matchedUser.id)
      .eq('device_hint', devKeyV)
      .is('revoked_at', null);
  }

  const sessionId = newSessionId();

  // D14 — a cashier signing in on a till is the other moment a terminal
  // announces itself. checkDeviceRegistration above still owns BROWSER approval
  // and is untouched; this records the terminal regardless, and only for
  // desktop. Between this and enrolment every till gets a row on its first
  // sign-in without anybody enabling anything.
  if (req.surface === 'desktop') {
    await registerDesktopTerminal(req.businessId as string, {
      deviceId:     String(req.body?.device_id ?? ''),
      appVersion:   String(req.body?.app_version ?? req.headers['x-app-version'] ?? '') || null,
      terminalCode: req.body?.terminal_code ?? null,
      label:        req.body?.device_name ?? null,   // A273 follow-up: the till's setup name
      ipAddress:    req.ip ?? null,
      role:         req.body?.device_role ?? req.headers['x-device-role'] ?? null,
      macAddress:   (req.headers['x-device-mac'] ?? req.body?.mac_address ?? null) as string | null,   // A182
    });
  }
  const pv = matchedUser.permissions_version ?? 1;

  const tokenPayload: TokenPayload = {
    userId:             matchedUser.id,
    businessId:         req.businessId,
    branchId:           isOwner ? null : branch_id,
    roleId:             role?.id ?? null,
    roleName:           role?.name ?? null,
    isOwner,
    permissionKeys:     tokenKeys(heldKeys),   // A490: fine keys (or '*') — the cloud checks these
    permissionsVersion: pv,
    sessionId,
    surface:            req.surface ?? 'web',
    ...(req.surface === 'desktop' ? { pinSignIn: true } : {}),   // A159: a person, not the till's device token
  };

  const { accessToken, refreshToken } = issueTokenPair(tokenPayload);

  await storeRefreshToken(refreshToken, tokenPayload,
    req.ip ?? undefined,
    devKeyV ?? userAgent ?? undefined,
  );

  res.json({
    accessToken, refreshToken, token: accessToken,
    staff:       { id: matchedUser.id, name: matchedUser.name, role: role?.name },
    permissions: effectivePerms,
    branchId:    branch_id,
    // Offline sign-in (register D-offline). A desktop terminal caches this so a
    // line fault does not stop the floor starting a shift — everything else on
    // a till already works offline; the door was the exception.
    //
    // Deliberate constraints:
    //   * DESKTOP ONLY. A browser has nowhere safe to put it and never needs to.
    //   * The user's OWN hash only, and only the one that just authenticated —
    //     the terminal never receives the roster.
    //   * bcrypt only. `needsUpgrade` above rewrites legacy hashes on sign-in,
    //     so a legacy user is upgraded here and cacheable from the next time.
    //   * NEVER override_pin_hash. That PIN authorises voids, discounts past the
    //     floor and refunds, and is the one credential worth stealing off a
    //     till, because the thief already has the till.
    //
    // The till wraps it with safeStorage (DPAPI), scopes it to this terminal and
    // expires it. See apps/desktop/src/main/pinCache.ts.
    offlineAuth: req.surface === 'desktop' && typeof matchedUser.pin_hash === 'string'
      && matchedUser.pin_hash.startsWith('$2')
      ? { pinHash: matchedUser.pin_hash }
      : undefined,
  });
});

// ── POST /api/auth/set-pin ────────────────────────────────────────────────────

router.post('/set-pin', requireAuth, async (req, res) => {
  const { user_id, pin } = req.body;

  if (!pin || !/^\d{4,6}$/.test(String(pin))) {
    res.status(400).json({ error: 'PIN must be 4–6 digits' });
    return;
  }

  const targetId = user_id ?? req.userId;
  if (!req.isOwner && targetId !== req.userId) {
    res.status(403).json({ error: 'You can only change your own PIN' });
    return;
  }
  // A494: the PIN limiter (lib/pinAttempts.ts). The uniqueness check below is an answer about OTHER people's PINs
  // ("that PIN is taken" = someone signs in with it), so each refusal counts as a failed PIN and the caller is paused
  // after 10 — the same budget as guessing at a till.
  const pk = pinKey(req);
  if (pinLocked(pk)) { res.status(429).json(PIN_LOCKED_BODY); return; }

  const { data: target, error: tErr } = await supabase
    .from('users').select('id').eq('id', targetId).eq('business_id', req.businessId).single();

  if (tErr || !target) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }

  // Enforce PIN uniqueness across the business (finding #11). Two staff sharing a
  // PIN makes sales attribution ambiguous — a login can no longer tell who is
  // ringing. bcrypt hashes are salted, so a plain unique index cannot catch this;
  // we compare the new PIN against every OTHER active user's hash. N bcrypt
  // compares on a rare admin action (setting a PIN) is an acceptable cost to keep
  // attribution unambiguous on the hot path (login).
  const { data: others } = await supabase
    .from('users')
    .select('id, pin_hash')
    .eq('business_id', req.businessId)
    .eq('status', 'active')
    .not('pin_hash', 'is', null)
    .neq('id', targetId);

  for (const other of others ?? []) {
    if (!(other as any).pin_hash) continue;
    if ((await verifyPin(String(pin), String((other as any).pin_hash), req.businessId)).valid) {
      // A494: KEPT (two people on one PIN cannot be told apart at a till — verify-pin refuses that PIN for both) but
      // rate-limited, and the words no longer say another person holds it.
      notePinFailure(pk);
      res.status(409).json({
        error: 'That PIN cannot be used. Please choose a different one.',
        code: 'PIN_NOT_UNIQUE',
      });
      return;
    }
  }

  const newHash = await hashPinBcrypt(String(pin));
  const { error: updateErr } = await supabase
    .from('users').update({ pin_hash: newHash }).eq('id', targetId);

  if (updateErr) {
    res.status(500).json({ error: 'Failed to update PIN' });
    return;
  }

  res.json({ success: true, message: 'PIN updated successfully' });
});

// ── A402: an owner resets (forgot) or changes their own password ─────────────────────────────────────────────────
// On /api/auth, so authLimiter (brute force) covers all three. lib/passwordReset.ts has the rules.

// The same answer whoever asks — the page never says which emails belong to a ZapTill owner (or partner, A550).
const FORGOT_REPLY = 'If that email is a ZapTill dashboard sign-in, a 6-digit code is on its way to it. It works for 15 minutes.';

router.post('/password/forgot', async (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email.includes('@')) { res.status(400).json({ error: 'Enter the email you sign in with.' }); return; }
  const acct = await signInAccountForEmail(email);   // A550: an owner's, or a partner's with a live grant
  if (acct) {
    const r = await sendResetCode(acct);
    if (r === 'failed') { res.status(503).json({ error: 'Could not send the code just now. Try again in a minute, or call ZapTill support.' }); return; }
  }
  res.json({ ok: true, message: FORGOT_REPLY });
});

router.post('/password/reset', async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const code = String(req.body?.code ?? '').replace(/[\s-]/g, '');
  const problem = passwordProblem(req.body?.new_password);
  if (!email.includes('@') || !/^\d{6}$/.test(code)) { res.status(400).json({ error: 'Enter your email and the 6-digit code.' }); return; }
  if (problem) { res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' }); return; }
  const acct = await signInAccountForEmail(email);   // A550
  const check = acct ? await checkResetCode(acct.authId, code) : 'expired';
  if (check === 'expired') { res.status(400).json({ error: 'That code has expired or was tried too often. Ask for a new code.', code: 'RESET_EXPIRED' }); return; }
  if (check === 'wrong') { res.status(400).json({ error: 'That code is not right. Check the email and try again.', code: 'RESET_INVALID' }); return; }
  const err = await setOwnerPassword(acct!.authId, String(req.body.new_password));
  if (err) { res.status(500).json({ error: 'Could not set the new password. Try again, or call ZapTill support.' }); return; }
  console.log(`[password-reset] dashboard password reset by emailed code (${acct!.authId})`);   // the owner's, or a partner's (A550)
  res.json({ ok: true, message: 'Your password is changed. Sign in with the new one.' });
});

router.post('/password/change', requireAuth, async (req, res) => {
  // A550: a partner changes the password of THEIR OWN sign-in account (the one the owner's grant names) — never the owner's.
  let authId: string | null | undefined = null;
  if (req.webPartner) {
    const c = await checkPartner(req.businessId, String(req.userId ?? ''), null);
    if (c.ok === false) { res.status(403).json({ error: 'Your web dashboard access has ended — ask the owner.', code: 'PARTNER_ENDED' }); return; }
    authId = c.record.auth_user_id;
  } else {
  if (!req.isOwner) { res.status(403).json({ error: 'Only the owner signs in with a password. Managers use their PIN — the owner can change it in Staff.' }); return; }
  const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', req.businessId).maybeSingle();
  authId = (biz as { owner_id?: string | null } | null)?.owner_id;
  }
  const problem = passwordProblem(req.body?.new_password);
  if (problem) { res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' }); return; }
  if (!authId) { res.status(400).json({ error: 'This business has no owner sign-in account.' }); return; }
  const { data: acct } = await supabase.auth.admin.getUserById(authId);
  const email = acct?.user?.email;
  if (!email) { res.status(400).json({ error: 'This business has no owner sign-in account.' }); return; }
  const { error: wrong } = await authClient.auth.signInWithPassword({ email, password: String(req.body?.current_password ?? '') });
  if (wrong) { res.status(400).json({ error: 'Your current password is not right.', code: 'WRONG_PASSWORD' }); return; }
  if (String(req.body.new_password) === String(req.body.current_password)) { res.status(400).json({ error: 'The new password is the same as the old one.' }); return; }
  // Every other signed-in browser is signed out; this one stays.
  const err = await setOwnerPassword(authId, String(req.body.new_password), req.sessionId ?? null);
  if (err) { res.status(500).json({ error: 'Could not change the password. Try again.' }); return; }
  res.json({ ok: true, message: 'Password changed. Other browsers signed in to this account were signed out.' });
});

// ── A391: my sign-in code — email (default) or an authenticator app ─────────────────────────────────────────────
// For owners and the manager tier (who must enter a code on the web). Cashiers have none, so nothing to set.
async function otpSelf(req: any, res: any): Promise<{ id: string; email: string } | null> {
  const { data: u } = await supabase
    .from('users').select('id, email, roles ( name )').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle();
  if (!u) { res.status(404).json({ error: 'Account not found' }); return null; }
  // A490: back office (isBackOffice), not a role name. A550: a partner always enters a code (whatever their keys).
  if (!needsOtp(req.permissionKeys ?? [], req.isOwner || req.webPartner === true)) {
    res.status(403).json({ error: 'Sign-in codes are for owners and managers.' }); return null;
  }
  return { id: (u as any).id, email: (u as any).email };
}

router.get('/otp', requireAuth, async (req, res) => {
  const me = await otpSelf(req, res); if (!me) return;
  // A398: enabled — whether this client's sign-in asks for the code at all (the admin portal's 'Sign-in codes' switch).
  const enabled = (await businessPosFeatures(req.businessId)).login_codes;
  res.json({ ...(await readOtpSettings('user', me.id) ?? { method: 'email', email: me.email }), enabled });
});

router.post('/otp/totp/start', requireAuth, async (req, res) => {
  const me = await otpSelf(req, res); if (!me) return;
  res.json(startTotpSetup('user', me.id, me.email));
});

router.post('/otp/totp/confirm', requireAuth, async (req, res) => {
  const me = await otpSelf(req, res); if (!me) return;
  const r = await confirmTotpSetup('user', me.id, req.body?.setup_token, req.body?.code);
  if (r.ok === false) { res.status(r.status).json({ error: r.error }); return; }
  res.json({ method: 'totp' });
});

router.post('/otp/email', requireAuth, async (req, res) => {
  const me = await otpSelf(req, res); if (!me) return;
  if (await useEmailCodes('user', me.id)) { res.status(500).json({ error: 'Could not save — is migration 119 applied?' }); return; }
  res.json({ method: 'email' });
});

// ── GET /api/auth/session ─────────────────────────────────────────────────────
// A550: who the web dashboard is signed in as — the owner ('*', every branch) or a partner (their own keys and branches),
// so the dashboard shows what they may use, offers the branches they work at, and hides what is the owner's alone. Read
// only; the cloud decides every request on its own (requirePermission, branchScope).
router.get('/session', requireAuth, async (req, res) => {
  if (req.isTill) { res.status(403).json({ error: 'A till has no dashboard session.', code: 'PERSON_ONLY' }); return; }
  const { data: me } = req.userId
    ? await supabase.from('users').select('name').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle()
    : { data: null };
  const owner = req.isOwner === true;
  res.json({
    owner,
    partner: req.webPartner === true,
    name: (me as { name?: string } | null)?.name ?? null,
    permissions: owner ? { '*': true } : clientPermissionMap(new Set(req.permissionKeys ?? [])),
    allBranches: owner || req.allBranches === true,
    branchIds: owner ? null : (req.webPartner ? req.partnerBranches : (req.branchId ? [req.branchId] : [])),
  });
});

// ── PATCH /api/auth/me ────────────────────────────────────────────────────────

router.patch('/me', requireAuth, async (req, res) => {
  const { must_change_password } = req.body;
  if (must_change_password !== false) { res.json({ success: true }); return; }

  // A494: the caller's OWN row only. It cleared the flag on every owner/admin-role row of the business (or, with no
  // such role, on everybody's) for ANY signed-in person — a cashier could switch off the owner's forced password change.
  if (!req.userId) { res.status(403).json({ error: 'No person is signed in on this session.' }); return; }
  try {
    const { error } = await supabase.from('users')
      .update({ must_change_password: false, updated_at: new Date().toISOString() })
      .eq('id', req.userId).eq('business_id', req.businessId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    sendError(res, err, { message: 'Failed to update profile' });
  }
});

export default router;
