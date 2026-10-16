/**
 * limiterKeys.ts — A494: which bucket a request counts against (index.ts's limiters). Pure: the token check is passed in.
 *
 * Before A494 both limiters believed what the caller SAID: the auth limiter keyed on the last 24 characters of any
 * Authorization header (a made-up header per request = a fresh bucket per guess, so the sign-in brake never fired for
 * anyone who sent one), and the general limiter keyed on the x-device-id header first (any string the caller liked).
 *
 * Now:
 *   - the anonymous sign-in paths (/api/auth/login, /pos-login, /password/*, /enrol/redeem, /device-token and every
 *     /api/admin/auth/*) are keyed on the address ONLY — whatever header comes with them;
 *   - anywhere else a token picks the bucket only once it VERIFIES (its signature — A505: not its expiry): the till's own session by its
 *     device id, a person's by their sign-in session; a header that does not verify counts as the address.
 *   - x-device-id is never read.
 */

/**
 * A505: how index.ts verifies a token to pick its bucket — the signature (HS256, our secret) is what proves a token is not
 * made up; its EXPIRY is not. An access token lives 15 minutes, so a till's first request after an idle spell (a PIN
 * sign-in, a renewal-on-401) carries an expired one: verified strictly it counted against the shop's ADDRESS — shared by
 * every till and the office behind one router — and a 401 TOKEN_EXPIRED on /api/auth/verify-pin is a FAILED attempt for
 * the auth limiter (30 per 15 minutes). The bucket is still the till's / the person's own: an expired token is ours, and
 * an attacker cannot mint new ones. (Authentication itself — requireAuth — still refuses an expired token.)
 */
export const BUCKET_VERIFY_OPTIONS: { algorithms: ['HS256']; ignoreExpiration: true } = { algorithms: ['HS256'], ignoreExpiration: true };

export interface Claims {
  userId?: string | null;
  businessId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  till?: unknown;
}

const ANONYMOUS_AUTH = [
  /^\/api\/auth\/login\/?$/,
  /^\/api\/auth\/pos-login\/?$/,
  /^\/api\/auth\/password\//,
  /^\/api\/auth\/enrol\//,
  /^\/api\/auth\/device-token\/?$/,
  /^\/api\/admin\/auth(\/|$)/,
];

/** The path without its query string. */
const pathOf = (url: string): string => String(url ?? '').split('?')[0];

export function isAnonymousAuthPath(url: string): boolean {
  const p = pathOf(url);
  return ANONYMOUS_AUTH.some((re) => re.test(p));
}

/** The claims of a Bearer token that verifies, else null. `verify` throws on a bad token (jwt.verify). */
export function verifiedClaims(authorization: string | undefined | null, verify: (token: string) => unknown): Claims | null {
  const h = String(authorization ?? '');
  if (!h.startsWith('Bearer ')) return null;
  try {
    const c = verify(h.slice(7)) as Claims | null;
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

/** The bucket of a verified token: a till by its device, a person by their sign-in session (else their id). */
export function claimsKey(c: Claims): string | null {
  if (c.till === true && c.deviceId) return `d:${c.businessId ?? ''}:${c.deviceId}`;
  if (c.sessionId) return `s:${c.sessionId}`;
  if (c.userId) return `u:${c.businessId ?? ''}:${c.userId}`;
  return null;
}

export function authLimiterKeyFor(req: { url: string; authorization?: string | null; ipKey: string }, verify: (token: string) => unknown): string {
  if (isAnonymousAuthPath(req.url)) return req.ipKey;
  const c = verifiedClaims(req.authorization, verify);
  const k = c ? claimsKey(c) : null;
  return k ? `t:${k}` : req.ipKey;
}

export function apiLimiterKeyFor(req: { url: string; authorization?: string | null; ipKey: string }, verify: (token: string) => unknown): string {
  return authLimiterKeyFor(req, verify);
}
