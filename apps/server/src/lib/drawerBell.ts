/**
 * drawerBell.ts — A535: a drawer changed through this server rings the business's branch server at once.
 *
 * Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills". A branch
 * server now asks the cloud about every drawer of its branch with ONE call (GET /api/pos/branch-drawers) on a 60 s beat
 * while its push channel is up; a drawer changed on the web — a close, a force-close, a confirmation, a web sale on a
 * till's drawer, a remote day close — rings it (lib/liveHub.ts ringDrawers: { type: 'changed', topics: ['drawers'] }) so
 * it asks at once instead of waiting for the beat.
 *
 * Mounted per router in routes/index.ts. After a non-GET request on those routers ends WELL (2xx) for the request's
 * business. `webOnly`: not for a till's own session (surface 'desktop') — a till's writes on that router are its own and
 * reach its branch server on the shop network. `skip`: read-only POSTs (a lookup with a body).
 */
import type { Request, Response, NextFunction } from 'express';
import { ringDrawers } from './liveHub';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function ringDrawersOnWrite(o: { webOnly?: boolean; skip?: RegExp } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (READS.has(req.method)) { next(); return; }
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const r = req as Request & { businessId?: string; surface?: string | null };
      if (o.webOnly && r.surface === 'desktop') return;
      if (o.skip && o.skip.test(String(req.originalUrl ?? '').split('?')[0])) return;
      ringDrawers(r.businessId ?? null);
    });
    next();
  };
}
