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

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'swiftpos-admin-dev-secret-change-in-prod';

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

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Admin token required' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET) as {
      adminId: string;
      email:   string;
      role:    'super_admin' | 'agent';
    };
    req.adminId    = payload.adminId;
    req.adminEmail = payload.email;
    req.adminRole  = payload.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.adminRole !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

export function signAdminToken(payload: { adminId: string; email: string; role: string }): string {
  return jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '8h' });
}
