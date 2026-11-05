/**
 * sessionIfSent.ts — a session when the caller sends one, checked in full by requireAuth (an expired or refused token is
 * still a 401); no Authorization header at all = signed out, which the route then handles itself.
 *
 * For the few routes a signed-out ZapTill Android app may call (routes/appUpdate.ts status, routes/appErrors.ts): in
 * Stage 0 the app has no sign-in yet, and a crash before sign-in is the one that matters most.
 */
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';

export function sessionIfSent(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) { next(); return; }
  void requireAuth(req, res, next);
}
