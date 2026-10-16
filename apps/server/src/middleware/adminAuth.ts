/**
 * adminAuth.ts — Middleware for SwiftPOS Admin Portal routes.
 *
 * Completely separate from the main requireAuth middleware which handles
 * business owner / cashier JWTs.  Admin tokens are signed with a different
 * secret (ADMIN_JWT_SECRET) and carry admin-specific claims.
 *
 * Token payload:
 *   { adminId, email, role: 'super_admin'|'agent', iat, exp }
 *
 * Usage:
 *   router.get('/clients', requireAdmin, async (req, res) => { ... })
 *   router.delete('/...', requireAdmin, requireSuperAdmin, async (req, res) => { ... })
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';

// No fallback: an unset secret must stop the server booting, never silently
// fall back to a value that is published in source control (which would let
// anyone forge a cross-tenant super_admin token). Mirrors JWT_SECRET handling.
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!ADMIN_JWT_SECRET) {
  throw new Error('[server] Missing ADMIN_JWT_SECRET in environment');
}

// Extend Express Request with admin claims
declare global {
  namespace Express {
    interface Request {
      adminId:    string;
      adminEmail: string;
      adminRole:  'super_admin' | 'agent';
    }
  }
}

// A495: a signed admin token is not enough on its own — a deactivated or demoted team member kept full access until
// the 8-hour token expired. Every request re-reads the account (one primary-key read), cached briefly per process.
const ADMIN_CACHE_MS = 30_000;
type AdminRow = { is_active: boolean; role: 'super_admin' | 'agent'; email: string };
const adminCache = new Map<string, { at: number; row: AdminRow | null }>();

/** A495: forget the cached account (after a team change on this process, and for tests). */
export function forgetAdmin(adminId?: string): void {
  if (adminId) adminCache.delete(adminId); else adminCache.clear();
}

export const ADMIN_ROLES = ['super_admin', 'agent'] as const;

async function currentAdmin(adminId: string): Promise<{ row: AdminRow | null } | { error: true }> {
  const hit = adminCache.get(adminId);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return { row: hit.row };
  const { data, error } = await supabase
    .from('admin_users').select('is_active, role, email').eq('id', adminId).maybeSingle();
  if (error) return { error: true };
  const row = (data as AdminRow | null) ?? null;
  adminCache.set(adminId, { at: Date.now(), row });
  return { row };
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Admin token required' });
    return;
  }

  const token = header.slice(7);
  let payload: { adminId: string; email: string; role: 'super_admin' | 'agent' };
  try {
    payload = jwt.verify(token, ADMIN_JWT_SECRET!, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
    return;
  }
  if (!payload?.adminId) { res.status(401).json({ error: 'Invalid or expired admin token' }); return; }

  let cur: { row: AdminRow | null } | { error: true };
  try { cur = await currentAdmin(String(payload.adminId)); } catch { cur = { error: true }; }
  if ('error' in cur) {
    res.status(503).json({ error: 'Could not verify your admin session right now — please try again', code: 'AUTH_BACKEND_UNAVAILABLE' });
    return;
  }
  if (!cur.row || cur.row.is_active !== true) {
    res.status(401).json({ error: 'This admin account is no longer active', code: 'ADMIN_INACTIVE' });
    return;
  }
  if (!(ADMIN_ROLES as readonly string[]).includes(cur.row.role)) {
    res.status(403).json({ error: 'This admin account has no valid role', code: 'ADMIN_ROLE_INVALID' });
    return;
  }
  req.adminId    = payload.adminId;
  req.adminEmail = cur.row.email ?? payload.email;
  // The CURRENT role, never the one in the token: a demotion takes effect on the next request (within the cache window).
  req.adminRole  = cur.row.role;
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.adminRole !== 'super_admin') {
    res.status(403).json({ error: 'Only a super admin can do this', code: 'SUPER_ADMIN_REQUIRED' });
    return;
  }
  next();
}

export function signAdminToken(payload: { adminId: string; email: string; role: string }): string {
  return jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '8h' });
}
