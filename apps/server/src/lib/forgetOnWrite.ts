/**
 * forgetOnWrite.ts — A528: a write this server handles drops what the polled answers remember for that business.
 *
 * catalogue-version and branch-staff answer from versions remembered 15 s (lib/syncVersions.ts); the sign-in check
 * remembers a till's and a person's row 30 s (lib/authCache.ts). The database triggers (migration 150) are the source of
 * truth for the versions; this only makes a web edit reach the tills at once instead of after 15 s — and, for the sign-in
 * check, makes blocking a till or a person take effect on the very next request.
 *
 * Mounted per router in routes/index.ts. After ANY non-GET request on those routers finishes — success or not (a refused
 * request may have written part of its change, and forgetting costs one read) — for the request's business; an admin
 * portal write (no business of its own: it names one in the path) forgets every business.
 */
import type { Request, Response, NextFunction } from 'express';
import { forgetTopic } from './syncVersions';
import { forgetTillsOf, forgetPeopleOf, forgetAllAuth } from './authCache';
import { nudge, recheckBusiness } from './liveHub';   // A531

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ForgetWhat {
  /** The catalogue version (products, settings, branches, …). */
  catalogue?: boolean;
  /** The staff version (people, roles, grants, tills). */
  staff?: boolean;
  /** The sign-in check's remembered tills. */
  tills?: boolean;
  /** The sign-in check's remembered people, owner and owner role. */
  people?: boolean;
  /** Every business (an admin portal write). */
  everyBusiness?: boolean;
}

export function forgetOnWrite(what: ForgetWhat) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (READS.has(req.method)) { next(); return; }
    res.on('finish', () => {
      // A533: a write that changes nothing a till reads (a support log request) says so — no cache forgotten, no socket
      // made to sign in again.
      if ((res as { locals?: { forgetNothing?: boolean } }).locals?.forgetNothing) return;
      const biz = what.everyBusiness ? null : ((req as { businessId?: string }).businessId ?? null);
      if (!biz && !what.everyBusiness) return;   // never signed in: nothing of a business was written
      if (what.catalogue) forgetTopic(biz, 'catalogue');
      if (what.staff) forgetTopic(biz, 'staff');
      if (what.everyBusiness) {
        if (what.tills || what.people) forgetAllAuth();
        if (what.tills) recheckBusiness(null);   // A531: every till socket signs in again (a revoked till is refused)
        return;
      }
      if (what.tills) { forgetTillsOf(biz); recheckBusiness(biz); }   // A531: likewise for this business's sockets
      if (what.people) forgetPeopleOf(biz);
      // A531: the business's till sockets hear "changed" at once — a web edit reaches the tills in about a second (the
      // database wrote which rows; liveHub reads the newest entry and pushes when it moved). Nothing when none is open.
      nudge(biz);
    });
    next();
  };
}
