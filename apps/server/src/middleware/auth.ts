import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
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
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId:              string;
      businessId:          string;
      branchId?:           string | null;
      roleId?:             string;
      permissionKeys?:     string[];
      isOwner?:            boolean;
      surface?:            string;
      sessionId?:          string;
      permissionsVersion?: number;
    };

    req.userId             = payload.userId;
    req.businessId         = payload.businessId;
    req.branchId           = payload.branchId ?? null;
    req.roleId             = payload.roleId ?? null;
    req.permissionKeys     = payload.permissionKeys ?? [];
    req.isOwner            = payload.isOwner ?? false;
    req.surface            = payload.surface ?? null;
    req.sessionId          = payload.sessionId ?? null;
    req.permissionsVersion = payload.permissionsVersion ?? 0;

    // ── Fix 3: permissions_version check ─────────────────────────────────
    // Skip for owners (wildcard '*' permissions — no role to be stale).
    // Skip if pv = 0 (pre-migration tokens — let them through, they expire in ≤15m).
    if (!req.isOwner && req.permissionsVersion > 0) {
      const { data: userRow } = await supabase
        .from('users')
        .select('permissions_version')
        .eq('id', req.userId)
        .maybeSingle();

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

    next();
    return;
  } catch {
    // Not a SwiftPOS JWT — fall through to Supabase check
  }

  // ── 2. Try Supabase JWT (local verify — no network call) ─────────────────
  if (!SUPABASE_JWT_SECRET) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  let supabaseUserId: string;
  let supabaseEmail: string | undefined;
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET) as { sub: string; email?: string };
    supabaseUserId = payload.sub;
    supabaseEmail  = payload.email;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const { data: business, error: bErr } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', supabaseUserId)
    .single();

  if (bErr || !business) {
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
