/**
 * serverSignature.ts — A529: every answer from this server says it is this server's.
 *
 * Owner, 2026-10-19 (Render suspended production over its bandwidth quota): "some users were not able to log in … and I
 * thought we had said when the desktop is offline or render unavailable all users should be able to log in", and "the
 * could not sync error some clients did not like it". A suspended Render service, a Cloudflare error page or a shop's
 * captive portal answers with ITS OWN page — a 404, a 403, a 200 HTML — and the till read that status as the cloud's
 * verdict: "Invalid PIN" at the PIN pad, sales counted towards 'failed'.
 *
 * So every answer — a route's, an unknown route's 404, the error handler's 500, the rate limiter's 429, /health — carries
 * `X-ZapTill-Server: 1`. It is set FIRST in the middleware chain (index.ts), before anything that can answer, so no path
 * can skip it. A till (apps/desktop/src/main/authTransport.ts) treats an answer without it — once this cloud has been
 * seen to sign its answers — exactly like no connection. The branch server's gateway passes it through unchanged
 * (apps/desktop/src/main/nodeGateway.ts). Not a secret: it says who answered, nothing more.
 */
import type { Request, Response, NextFunction } from 'express';

export const SERVER_SIGNATURE_HEADER = 'X-ZapTill-Server';
export const SERVER_SIGNATURE_VALUE = '1';

export function signAnswers(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(SERVER_SIGNATURE_HEADER, SERVER_SIGNATURE_VALUE);
  next();
}
