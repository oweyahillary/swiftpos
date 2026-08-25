import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { resolveOwnerBusinesses, firstOrNull } from '../lib/ownerBusiness';
import jwt from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      userId:             string;
      businessId:         string;
      branchId:           string | null;
      roleId:             string | null;
      permissionKeys:     string[];
      isOwner:            boolean;
      surface:            string | null;
      sessionId:          string | null;
      permissionsVersion: number;
    }
  }
}

const JWT_SECRET          = process.env.JWT_SECRET!;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;

// ── Token verification ────────────────────────────────────────────────────────
// Two token types supported, both verified locally (no network call):
//
//   1. SwiftPOS JWT  — signed with JWT_SECRET
//      Contains: userId, businessId, branchId, isOwner, permissionKeys,
//                permissionsVersion (pv), sessionId, jti
//
//   2. Supabase JWT  — signed with SUPABASE_JWT_SECRET
//      Contains: sub (Supabase user ID), role, exp
//      Used by: web dashboard owner login
//
// Fix 3: After verifying the SwiftPOS JWT signature, we check
// permissionsVersion against the DB. A mismatch means the user's role or
// permissions changed after this token was issued. We return 401
// PERMISSIONS_CHANGED so the client immediately refreshes — the new token
// will carry the current permissions.
//
// Cost: one indexed integer read per request (users PK). Supabase handles
// this in ~1ms. It's the minimum possible DB touch for stale-permission detection.

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  // ── 1. Try SwiftPOS JWT ───────────────────────────────────────────────────
  //
  // The try wraps ONLY jwt.verify (audit BUG-16). It used to wrap everything
  // down to and including next(), with `catch { fall through to Supabase }`.
  // That conflated two entirely different situations:
  //
  //   "this is not a SwiftPOS token"  → correct to fall through
  //   "the database did not answer"   → NOT correct to fall through
  //
  // The users lookup below is a network call. A transient blip threw, was
  // swallowed, and execution continued into the Supabase branch — which then
  // failed to verify a SwiftPOS token against the Supabase secret and returned
  // 401 "Invalid or expired token". A cashier holding a perfectly valid token
  // was logged out mid-service because Postgres hiccupped for 200ms.
  //
  // With the try narrowed, a DB failure now propagates to the Express error
  // handler as a 5xx — which is the truth, is retryable, and does not destroy
  // the session.
  let swiftPayload: {
    userId:              string;
    businessId:          string;
    branchId?:           string | null;
    roleId?:             string;
    permissionKeys?:     string[];
    isOwner?:            boolean;
    surface?:            string;
    sessionId?:          string;
    permissionsVersion?: number;
  } | null = null;

  try {
    swiftPayload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as typeof swiftPayload;
  } catch {
    // Not a SwiftPOS JWT — fall through to the Supabase check below. This is
    // the ONLY condition that may fall through.
    swiftPayload = null;
  }

  if (swiftPayload) {
    const payload = swiftPayload;

    req.userId             = payload.userId;
    req.businessId         = payload.businessId;
    req.branchId           = payload.branchId ?? null;
    req.roleId             = payload.roleId ?? null;
    req.permissionKeys     = payload.permissionKeys ?? [];
    req.isOwner            = payload.isOwner ?? false;
    req.surface            = payload.surface ?? null;
    req.sessionId          = payload.sessionId ?? null;
    req.permissionsVersion = payload.permissionsVersion ?? 0;

    // ── Fix 3 + M1: status & permissions_version check ───────────────────
    // One indexed PK read per non-owner request (users PK, ~1ms). Covers two
    // things: (a) the account is still active — closes the window where a
    // deactivated/fired staff member's access token kept working until it
    // expired; and (b) the token's permissions haven't been superseded.
    if (!req.isOwner) {
      // Destructured, not ignored: a failure here must be a 5xx, not a silent
      // fall-through that presents to the cashier as a bad PIN.
      const { data: userRow, error: uErr } = await supabase
        .from('users')
        .select('permissions_version, status')
        .eq('id', req.userId)
        .maybeSingle();

      if (uErr) {
        res.status(503).json({
          error: 'Could not verify your session right now — please try again',
          code:  'AUTH_BACKEND_UNAVAILABLE',
        });
        return;
      }

      const status = (userRow as any)?.status;
      if (status && status !== 'active') {
        res.status(401).json({
          error: 'Account is not active — please contact your manager',
          code:  'ACCOUNT_INACTIVE',
        });
        return;
      }

      // Skip pv check if pv = 0 (pre-migration tokens — they expire in ≤15m).
      if (req.permissionsVersion > 0) {
        const currentPv = (userRow as any)?.permissions_version ?? 1;
        if (currentPv !== req.permissionsVersion) {
          // Permissions changed since this token was issued.
          // Client must refresh immediately to get the current permission set.
          res.status(401).json({
            error: 'Permissions updated — please refresh your session',
            code:  'PERMISSIONS_CHANGED',
          });
          return;
        }
      }
    }

    if (terminalWriteBlocked(req, res)) return;
    next();
    return;
  }

  // ── 2. Try Supabase JWT (local verify — no network call) ─────────────────
  if (!SUPABASE_JWT_SECRET) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  let supabaseUserId: string;
  let supabaseEmail: string | undefined;
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string; email?: string };
    supabaseUserId = payload.sub;
    supabaseEmail  = payload.email;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // BUG-18: was .eq('owner_id').single(), which raised PGRST116 for an owner
  // with two businesses and reported it as "no business found". Middleware
  // cannot ask which one, so it takes the oldest — stable across requests — and
  // the CHOICE is made at login (routes/auth.ts), where a question can be asked.
  const ownedHere = await resolveOwnerBusinesses(supabaseUserId, 'id');
  if (ownedHere.kind === 'error') {
    res.status(503).json({
      error: 'Could not verify your session right now — please try again',
      code:  'AUTH_BACKEND_UNAVAILABLE',
    });
    return;
  }
  const business = firstOrNull(ownedHere);

  if (!business) {
    res.status(403).json({ error: 'No business found for this account' });
    return;
  }

  req.userId             = supabaseUserId;
  req.businessId         = (business as any).id;
  req.branchId           = null;
  req.isOwner            = true;
  req.surface            = 'web';
  req.sessionId          = null;
  req.permissionsVersion = 0; // Supabase tokens don't carry pv

  if (supabaseEmail) {
    const { data: userRow } = await supabase
      .from('users')
      .select('id')
      .eq('business_id', (business as any).id)
      .ilike('email', supabaseEmail)
      .maybeSingle();
    if ((userRow as any)?.id) req.userId = (userRow as any).id;
  }

  const { data: ownerRole } = await supabase
    .from('roles')
    .select('id')
    .eq('business_id', (business as any).id)
    .eq('name', 'owner')
    .single();

  req.roleId         = (ownerRole as any)?.id ?? null;
  req.permissionKeys = ['*'];

  next();
}

// ── requireWebSurface ─────────────────────────────────────────────────────────
export function requireWebSurface(req: Request, res: Response, next: NextFunction) {
  if (req.isOwner || req.surface !== 'desktop') { next(); return; }
  res.status(403).json({
    error: 'This feature requires web portal access. Please contact SwiftPOS to upgrade.',
    code:  'WEB_SURFACE_REQUIRED',
  });
}

// ── terminal write guard (A159) ───────────────────────────────────────────────
// A stolen till token (surface='desktop') must not be able to WRITE dashboard
// data — products, prices, users, settings. The till token is owner-scoped, so
// requireWebSurface's `isOwner` bypass lets it through; this closes that gap by
// gating on the surface claim directly, independent of owner-scope. The till's
// OWN writes are a short, known allowlist; every other write from a desktop
// surface is denied.
//
// Ships DRY-RUN by default (log-only) so a missed allowlist entry cannot break
// sync on a money system: it logs "would block" and lets the request through.
// Set TERMINAL_WRITE_ENFORCE=true to enforce (403) once the logs are clean.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TILL_WRITE_ALLOWLIST: RegExp[] = [
  /^\/api\/orders(\/|$|\?)/,              // sales push (incl. /:id/void, /:id/refund)
  /^\/api\/sync\/push(\/|$|\?)/,          // business_days / shifts / floats / expenses
  /^\/api\/branch-prices\/sync(\/|$|\?)/, // price reconciliation
  /^\/api\/shifts\/[^/]+\/(close|force-close)(\/|$|\?)/, // shift close / force-close — the till's own,
                                          // server-reconciled action (expected_cash/variance); NOT a
                                          // blanket /api/shifts open, so a shift DELETE from a till stays denied
  /^\/api\/auth\//,                       // verify-pin, set-pin, refresh, logout (no dashboard mutations live here)
  /^\/api\/tech\//,                       // tech audit / session (also tech-token gated)
];
export const TERMINAL_WRITE_ENFORCE =
  String(process.env.TERMINAL_WRITE_ENFORCE || '').toLowerCase() === 'true';

/** Pure decision: should a desktop-surface write to `path` be denied? */
export function terminalWriteDenied(surface: string | null | undefined, method: string, path: string): boolean {
  if (surface !== 'desktop') return false;           // only till tokens are gated
  if (!WRITE_METHODS.has(method)) return false;       // reads are always allowed
  const p = (path || '').split('?')[0];
  return !TILL_WRITE_ALLOWLIST.some((re) => re.test(p));
}

/** Guard wrapper. Returns true if the request was BLOCKED (response sent). */
function terminalWriteBlocked(req: Request, res: Response): boolean {
  const path = req.originalUrl || req.url || '';
  if (!terminalWriteDenied(req.surface, req.method, path)) return false;
  console.warn(
    `[terminal-write-guard]${TERMINAL_WRITE_ENFORCE ? '' : ' DRY-RUN'} ` +
    `desktop-surface ${req.method} ${path.split('?')[0]} — ` +
    `${TERMINAL_WRITE_ENFORCE ? 'BLOCKED' : 'would block'}`,
  );
  if (!TERMINAL_WRITE_ENFORCE) return false;          // dry-run: observe, don't break
  res.status(403).json({
    error: 'This terminal cannot make that change. Use the web dashboard.',
    code:  'TERMINAL_WRITE_FORBIDDEN',
  });
  return true;
}
