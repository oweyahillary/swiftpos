/**
 * otpTrust.ts — A391: "Remember this browser for 30 days" after a sign-in code. The cloud signs the token; this browser
 * keeps it per email and sends it with the next sign-in. A reset or change of the person's sign-in method voids it on
 * the cloud, and the next sign-in asks for a code again (the stale token is dropped here then).
 */
const PREFIX = 'zaptill_otp_trust:';
const key = (email: string) => PREFIX + String(email ?? '').trim().toLowerCase();

export function readOtpTrust(email: string): string {
  try { return localStorage.getItem(key(email)) ?? ''; } catch { return ''; }
}

export function saveOtpTrust(email: string, token: unknown): void {
  if (typeof token !== 'string' || !token) return;
  try { localStorage.setItem(key(email), token); } catch { /* private window */ }
}

export function dropOtpTrust(email: string): void {
  try { localStorage.removeItem(key(email)); } catch { /* private window */ }
}

/** "123 456" → "123456"; only digits, at most 6. */
export function cleanOtpInput(v: string): string {
  return String(v ?? '').replace(/[^\d]/g, '').slice(0, 6);
}
