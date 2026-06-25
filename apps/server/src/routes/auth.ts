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
 *   POST /api/auth/login           — email + password → token pair
 *   POST /api/auth/desktop-login   — same, no web_hosting gate, surface='desktop'
 *   POST /api/auth/refresh         — refresh token → new token pair (rotation)
 *   POST /api/auth/logout          — revoke refresh token (server-side)
 *   POST /api/auth/pos-login       — email + PIN → branch-scoped token pair
 *   POST /api/auth/verify-pin      — owner session required, branch licence check
 *   POST /api/auth/set-pin         — bcrypt PIN update
 *   PATCH /api/auth/me             — clears must_change_password
 */

import { Router }   from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase, authClient } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { getWebAccess } from '../lib/webAccess';
import jwt           from 'jsonwebtoken';
import bcrypt        from 'bcrypt';
import crypto        from 'crypto';

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
  userId:             string;
  businessId:         string;
  branchId:           string | null;
  roleId?:            string | null;
  roleName?:          string | null;
  isOwner:            boolean;
  permissionKeys:     string[];
  permissionsVersion: number;
  sessionId:          string;
  surface?:           string;
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
 * Store a refresh token in the DB.
 * jti stored as sha256 hash — raw token never touches the DB.
 */
async function storeRefreshToken(
  refreshToken: string,
  payload: TokenPayload,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  const jtiPayload = jwt.decode(refreshToken) as { jti: string };
  const jti = hashToken(jtiPayload.jti);

  await supabase.from('refresh_tokens').insert({
    jti,
    user_id:     payload.userId,
    business_id: payload.businessId,
    session_id:  payload.sessionId,
    device_hint: userAgent?.slice(0, 200) ?? null,
    ip_address:  ip ?? null,
    expires_at:  new Date(Date.now() + REFRESH_EXPIRES_MS).toISOString(),
  });
}

/**
 * Validate a refresh token against the DB.
 * Returns the stored row if valid, throws with a specific error code if not.
 */
async function validateRefreshToken(refreshToken: string): Promise<{
  payload: any;
  dbRow:   any;
}> {
  // 1. Verify JWT signature + expiry
  let payload: any;
  try {
    payload = jwt.verify(refreshToken, JWT_SECRET);
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

  if (error || !dbRow) {
    // Token not in DB — either never stored (old client) or already consumed.
    // Treat as invalid to be safe.
    throw Object.assign(new Error('Refresh token not recognised'), { code: 'TOKEN_UNKNOWN' });
  }

  if (dbRow.revoked_at) {
    // Token already used or explicitly revoked.
    // If it's been used twice this may be a replay attack — revoke the entire session.
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

  if (new Date(dbRow.expires_at) < new Date()) {
    throw Object.assign(new Error('Refresh token expired'), { code: 'TOKEN_EXPIRED' });
  }

  return { payload, dbRow };
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
  } catch {
    // Best-effort — don't fail the logout if revocation errors
  }
}

/**
 * Fetch the current permissions_version for a user.
 * Returns 1 as fallback if the column doesn't exist yet (pre-migration).
 */
async function getPermissionsVersion(userId: string): Promise<number> {
  const { data } = await supabase
    .from('users')
    .select('permissions_version')
    .eq('id', userId)
    .maybeSingle();
  return (data as any)?.permissions_version ?? 1;
}

/**
 * Build effective permissionKeys for a staff user (non-owner).
 * Role permissions + user-level overrides.
 */
async function buildPermissionKeys(roleId: string, userId: string): Promise<string[]> {
  const [{ data: rp }, { data: up }] = await Promise.all([
    supabase
      .from('role_permissions')
      .select('permissions ( key )')
      .eq('role_id', roleId),
    supabase
      .from('user_permissions')
      .select('granted, permissions ( key )')
      .eq('user_id', userId),
  ]);

  const effective: Record<string, boolean> = {};
  (rp ?? []).forEach((r: any) => { if (r.permissions?.key) effective[r.permissions.key] = true; });
  (up ?? []).forEach((u: any) => { if (u.permissions?.key) effective[u.permissions.key] = u.granted; });

  return Object.entries(effective).filter(([, g]) => g).map(([k]) => k);
}

// ── Legacy helpers (PIN hashing) ──────────────────────────────────────────────

function legacyPinHash(pin: string, businessId: string): string {
  return crypto.createHash('sha256').update(`${pin}:${businessId}`).digest('hex');
}

async function hashPinBcrypt(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

async function verifyPin(
  pin: string,
  storedHash: string,
  businessId: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (storedHash.startsWith('$2')) {
    const valid = await bcrypt.compare(pin, storedHash);
    return { valid, needsUpgrade: false };
  }
  const legacyHash = legacyPinHash(pin, businessId);
  const valid = crypto.timingSafeEqual(
    Buffer.from(legacyHash, 'hex'),
    Buffer.from(storedHash, 'hex'),
  );
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
// Roles that are always exempt from device registration.
// These users manage the system — blocking them from new devices is counterproductive
// (a manager could approve their own device anyway, making the check pointless).
const DEVICE_CHECK_EXEMPT_ROLES = new Set([
  'owner', 'admin', 'manager', 'supervisor', 'branch_manager',
]);

async function checkDeviceRegistration(
  businessId: string,
  userId:     string,
  req:        any,
  clientHint?: string,
  isOwner?:    boolean,
  roleName?:   string | null,
): Promise<{ result: 'allowed' | 'pending' | 'rejected'; deviceId?: string }> {
  // Owners and elevated staff (managers, supervisors) are never device-gated.
  // Owners manage the system; managers can approve their own devices anyway.
  if (isOwner) return { result: 'allowed' };
  if (roleName && DEVICE_CHECK_EXEMPT_ROLES.has(roleName.toLowerCase())) {
    return { result: 'allowed' };
  }

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
    }).catch(() => {});

    return { result: 'pending', deviceId: newDevice?.id };
  }

  if (device.status === 'approved') {
    // Update last_seen_at
    await supabase
      .from('user_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id)
      .catch(() => {});
    return { result: 'allowed', deviceId: device.id };
  }

  if (device.status === 'rejected') {
    return { result: 'rejected', deviceId: device.id };
  }

  // Still pending
  return { result: 'pending', deviceId: device.id };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const { data: business, error: bErr } = await supabase
    .from('businesses')
    .select('id, name, currency, type, status')
    .eq('owner_id', data.user.id)
    .single();

  if (bErr || !business) {
    res.status(403).json({ error: 'No business found for this account' });
    return;
  }

  if (business.status === 'suspended') {
    res.status(403).json({
      error: 'Your account has been suspended. Please contact SwiftPOS support.',
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
        : 'Web portal access is not enabled for your account. Please contact SwiftPOS to upgrade.',
      code:  webAccess.state === 'locked' ? 'WEB_ACCESS_EXPIRED' : 'WEB_HOSTING_REQUIRED',
    });
    return;
  }

  const { data: ownerUser } = await supabase
    .from('users')
    .select('id, must_change_password')
    .eq('business_id', business.id)
    .eq('email', data.user.email)
    .maybeSingle();

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

  // Fetch permissions_version for owner
  const pv = ownerUser ? await getPermissionsVersion((ownerUser as any).id) : 1;

  const sessionId = newSessionId();
  const payload: TokenPayload = {
    userId:             ownerUser ? (ownerUser as any).id : data.user.id,
    businessId:         business.id,
    branchId:           null,
    isOwner:            true,
    permissionKeys:     ['*'],
    permissionsVersion: pv,
    sessionId,
  };

  const { accessToken, refreshToken } = issueTokenPair(payload);

  // Store refresh token server-side
  await storeRefreshToken(refreshToken, payload,
    req.ip ?? undefined,
    req.headers['user-agent'] ?? undefined,
  );

  res.json({
    accessToken,
    refreshToken,
    token: accessToken, // legacy compat
    user: { id: data.user.id, email: data.user.email },
    business,
    mustChangePassword,
  });
});

// ── POST /api/auth/desktop-login ──────────────────────────────────────────────

router.post('/desktop-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const { data: business, error: bErr } = await supabase
    .from('businesses')
    .select('id, name, currency, type, status')
    .eq('owner_id', data.user.id)
    .single();

  if (bErr || !business) {
    res.status(403).json({ error: 'No business found for this account' });
    return;
  }

  if (business.status === 'suspended') {
    res.status(403).json({
      error: 'Your account has been suspended. Please contact SwiftPOS support.',
      code:  'ACCOUNT_SUSPENDED',
    });
    return;
  }

  const { data: ownerUser } = await supabase
    .from('users')
    .select('id, must_change_password')
    .eq('business_id', business.id)
    .eq('email', data.user.email)
    .maybeSingle();

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

  const pv = ownerUser ? await getPermissionsVersion((ownerUser as any).id) : 1;

  const sessionId = newSessionId();
  const payload: TokenPayload = {
    userId:             ownerUser ? (ownerUser as any).id : data.user.id,
    businessId:         business.id,
    branchId:           null,
    isOwner:            true,
    permissionKeys:     ['*'],
    permissionsVersion: pv,
    sessionId,
    surface:            'web',
  };

  const { accessToken, refreshToken } = issueTokenPair(payload);

  await storeRefreshToken(refreshToken, payload,
    req.ip ?? undefined,
    req.headers['user-agent'] ?? undefined,
  );

  res.json({
    accessToken,
    refreshToken,
    token: accessToken,
    user: { id: data.user.id, email: data.user.email },
    business,
    mustChangePassword,
  });
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Validates the refresh token against the DB, rotates it (old revoked, new issued),
// and re-fetches permissions so role changes propagate immediately.

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }

  let payload: any;
  let dbRow: any;
  try {
    ({ payload, dbRow } = await validateRefreshToken(refreshToken));
  } catch (err: any) {
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }

  // Revoke the consumed token atomically before issuing the new pair
  await supabase
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', dbRow.id);

  const { tokenType, iat, exp, jti, ...cleanPayload } = payload;

  // Re-fetch permissions — catches role changes since last login
  if (cleanPayload.roleId && !cleanPayload.isOwner) {
    cleanPayload.permissionKeys = await buildPermissionKeys(
      cleanPayload.roleId,
      cleanPayload.userId,
    );
  }

  // Re-fetch permissions_version — embed fresh value
  cleanPayload.permissionsVersion = await getPermissionsVersion(cleanPayload.userId);

  // Keep the existing sessionId so device-level logout still works
  const newPayload: TokenPayload = { ...cleanPayload };
  const { accessToken, refreshToken: newRefreshToken } = issueTokenPair(newPayload);

  await storeRefreshToken(newRefreshToken, newPayload,
    req.ip ?? undefined,
    req.headers['user-agent'] ?? undefined,
  );

  res.json({ accessToken, refreshToken: newRefreshToken, token: accessToken });
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
      const payload = jwt.decode(token) as { userId?: string } | null;
      if (payload?.userId) {
        await supabase
          .from('refresh_tokens')
          .update({ revoked_at: new Date().toISOString() })
          .eq('user_id', payload.userId)
          .is('revoked_at', null);
      }
    } catch { /* best effort */ }
  } else if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  res.json({ success: true });
});

// ── POST /api/auth/pos-login ──────────────────────────────────────────────────

router.post('/pos-login', async (req, res) => {
  const { email, pin, branch_id, surface: callerSurface } = req.body;

  if (!email || !pin) {
    res.status(400).json({ error: 'email and pin are required' });
    return;
  }

  if (!/^\d{4,6}$/.test(String(pin))) {
    res.status(401).json({ error: 'Invalid email or PIN' });
    return;
  }

  const authError = { error: 'Invalid email or PIN' };

  const { data: user, error: userErr } = await supabase
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
    .ilike('email', email.trim())
    .single();

  if (userErr || !user) { res.status(401).json(authError); return; }
  if (!(user as any).pin_hash) { res.status(401).json(authError); return; }

  const { valid, needsUpgrade } = await verifyPin(
    String(pin),
    (user as any).pin_hash,
    (user as any).business_id,
  );
  if (!valid) { res.status(401).json(authError); return; }

  const role    = (user as any).roles;
  const isOwner = ['owner', 'admin'].includes((role?.name ?? '').toLowerCase());

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
    const allowed = accessibleBranches.find((b: any) => b.id === branch_id);
    if (!allowed) {
      res.status(403).json({ error: 'You are not assigned to this branch' });
      return;
    }
    if (!allowed.desktop_licensed) {
      res.status(403).json({
        error: `${allowed.name} does not have a desktop licence. Contact SwiftPOS to activate.`,
        code:  'BRANCH_NOT_LICENSED',
      });
      return;
    }
  } else if (accessibleBranches.length === 1) {
    resolvedBranchId = accessibleBranches[0].id;
  }

  if (needsUpgrade) {
    const newHash = await hashPinBcrypt(String(pin));
    await supabase.from('users').update({ pin_hash: newHash }).eq('id', (user as any).id);
  }

  const effectivePerms: Record<string, boolean> = {};
  if (isOwner) {
    effectivePerms['*'] = true;
  } else {
    ((user as any).roles?.role_permissions ?? []).forEach((rp: any) => {
      if (rp.permissions?.key) effectivePerms[rp.permissions.key] = true;
    });
    ((user as any).user_permissions ?? []).forEach((up: any) => {
      if (up.permissions?.key) effectivePerms[up.permissions.key] = up.granted;
    });
  }

  // ── Device registration check ───────────────────────────────────────────────
  const clientHint = req.body.device_hint as string | undefined;
  const devCheck   = await checkDeviceRegistration(
    (user as any).business_id, (user as any).id, req, clientHint,
    isOwner, role?.name ?? null,
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

  // Fix 5: revoke any prior active session for this user+device before issuing new one
  // (prevents stale sessions accumulating on shared devices)
  const userAgent = req.headers['user-agent']?.slice(0, 200) ?? null;
  if (userAgent) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', (user as any).id)
      .eq('device_hint', userAgent)
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
    permissionKeys:     Object.entries(effectivePerms).filter(([, g]) => g).map(([k]) => k),
    permissionsVersion: pv,
    sessionId,
    surface:            callerSurface === 'web' ? 'web' : 'desktop',
  };

  const { accessToken, refreshToken } = issueTokenPair(tokenPayload);

  await storeRefreshToken(refreshToken, tokenPayload,
    req.ip ?? undefined,
    userAgent ?? undefined,
  );

  res.json({
    accessToken, refreshToken, token: accessToken,
    staff:       { id: (user as any).id, name: (user as any).name, role: role?.name },
    permissions: effectivePerms,
    branchId:    resolvedBranchId,
    branches:    accessibleBranches.map((b: any) => ({ id: b.id, name: b.name, licensed: b.desktop_licensed })),
    needsBranchSelection: !resolvedBranchId && accessibleBranches.length > 1,
  });
});

// ── POST /api/auth/verify-pin ─────────────────────────────────────────────────

router.post('/verify-pin', requireAuth, async (req, res) => {
  const { pin, branch_id } = req.body;

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

  if (!(branch as any).desktop_licensed) {
    res.status(403).json({
      error: `This branch (${(branch as any).name}) does not have a desktop licence. Please contact SwiftPOS to activate.`,
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

  let matchedUser: any = null;
  let needsUpgrade     = false;

  for (const staff of staffList ?? []) {
    if (!(staff as any).pin_hash) continue;
    const { valid, needsUpgrade: upgrade } = await verifyPin(
      String(pin),
      (staff as any).pin_hash,
      req.businessId,
    );
    if (valid) { matchedUser = staff; needsUpgrade = upgrade; break; }
  }

  if (!matchedUser) {
    res.status(401).json({ error: 'Invalid PIN' });
    return;
  }

  const branchAccess = matchedUser.user_branches ?? [];
  if (branchAccess.length > 0 && !branchAccess.some((b: any) => b.branch_id === branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  if (needsUpgrade) {
    const newHash = await hashPinBcrypt(String(pin));
    await supabase.from('users').update({ pin_hash: newHash }).eq('id', matchedUser.id);
  }

  const effectivePerms: Record<string, boolean> = {};
  (matchedUser.roles?.role_permissions ?? []).forEach((rp: any) => {
    if (rp.permissions?.key) effectivePerms[rp.permissions.key] = true;
  });
  (matchedUser.user_permissions ?? []).forEach((up: any) => {
    if (up.permissions?.key) effectivePerms[up.permissions.key] = up.granted;
  });

  const role    = matchedUser.roles;
  const isOwner = ['owner', 'admin'].includes((role?.name ?? '').toLowerCase());

  // ── Device registration check ───────────────────────────────────────────────
  const clientHintV = req.body.device_hint as string | undefined;
  const devCheckV   = await checkDeviceRegistration(
    req.businessId, matchedUser.id, req, clientHintV,
    isOwner, role?.name ?? null,
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

  // Fix 5: revoke prior session for this user on this device
  const userAgent = req.headers['user-agent']?.slice(0, 200) ?? null;
  if (userAgent) {
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', matchedUser.id)
      .eq('device_hint', userAgent)
      .is('revoked_at', null);
  }

  const sessionId = newSessionId();
  const pv = matchedUser.permissions_version ?? 1;

  const tokenPayload: TokenPayload = {
    userId:             matchedUser.id,
    businessId:         req.businessId,
    branchId:           isOwner ? null : branch_id,
    roleId:             role?.id ?? null,
    roleName:           role?.name ?? null,
    isOwner,
    permissionKeys:     Object.entries(effectivePerms).filter(([, g]) => g).map(([k]) => k),
    permissionsVersion: pv,
    sessionId,
    surface:            req.surface ?? 'web',
  };

  const { accessToken, refreshToken } = issueTokenPair(tokenPayload);

  await storeRefreshToken(refreshToken, tokenPayload,
    req.ip ?? undefined,
    userAgent ?? undefined,
  );

  res.json({
    accessToken, refreshToken, token: accessToken,
    staff:       { id: matchedUser.id, name: matchedUser.name, role: role?.name },
    permissions: effectivePerms,
    branchId:    branch_id,
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

  const { data: target, error: tErr } = await supabase
    .from('users').select('id').eq('id', targetId).eq('business_id', req.businessId).single();

  if (tErr || !target) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
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

// ── PATCH /api/auth/me ────────────────────────────────────────────────────────

router.patch('/me', requireAuth, async (req, res) => {
  const { must_change_password } = req.body;
  if (must_change_password !== false) { res.json({ success: true }); return; }

  try {
    const { data: ownerRole } = await supabase
      .from('roles').select('id').eq('business_id', req.businessId)
      .or('name.ilike.owner,name.ilike.admin').limit(1).maybeSingle();

    if (ownerRole) {
      await supabase.from('users')
        .update({ must_change_password: false, updated_at: new Date().toISOString() })
        .eq('business_id', req.businessId).eq('role_id', (ownerRole as any).id);
    } else {
      await supabase.from('users')
        .update({ must_change_password: false, updated_at: new Date().toISOString() })
        .eq('business_id', req.businessId).eq('must_change_password', true);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to update profile' });
  }
});

export default router;
