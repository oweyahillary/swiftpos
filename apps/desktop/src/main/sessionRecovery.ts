/**
 * sessionRecovery.ts — A407: what the till does when the cloud refuses its sign-in (pure; syncEngine and the PIN
 * screen do the I/O).
 *
 * Owner, 2026-10-05: "how do we prevent this from ever happening" — "does it mean a till that is fully offline will one
 * day fail to log in?" — "if a till is rejected when it comes online after a long offline period i should get an email".
 *
 *   - a refused renewal → the till signs itself back in with its device secret (POST /api/auth/device-token);
 *   - while it cannot, cashiers still sign in on the till's own PIN check and sell (as offline);
 *   - the cloud records a till that could not sign back in, and the watchdog emails ZapTill (critical).
 */

/** A 401 body that is about the till's session, not the person's PIN ("Invalid PIN" carries no code). */
export function isSessionRefusal(body: { error?: unknown; code?: unknown } | null | undefined): boolean {
  const code = String(body?.code ?? '');
  if (code) return /^(TOKEN_|SIGN_IN_AGAIN|PERMISSIONS_CHANGED|DEVICE_)/.test(code);
  return /invalid or expired token|please sign in again|authentication failed|not authenticated|jwt/i.test(String(body?.error ?? ''));
}

/** The body for POST /api/auth/device-token. An empty secret still goes: the cloud then records the till as lost. */
export function deviceGrantBody(businessId: string | null | undefined, deviceId: string | null | undefined, secret: string): Record<string, string> | null {
  if (!businessId || !deviceId) return null;
  return { business_id: businessId, device_id: deviceId, device_secret: secret ?? '' };
}
