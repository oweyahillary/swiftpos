/**
 * enrolCode.ts — mint and hash device-enrolment codes (register A69, D4).
 *
 * Issuance moved from the owner to the SwiftPOS admin portal (A69): a client can
 * no longer self-provision a till, so provisioning stays a billable act under
 * admin control. The code-shaping that used to live inline in routes/enrol.ts is
 * lifted here so the admin issue path and the (retired) owner path cannot drift,
 * and so it can be unit-tested on its own.
 *
 * The raw code is shown ONCE and never stored — only its SHA-256. Short-lived and
 * single-use, so a leaked code is worth little and briefly.
 */
import crypto from 'node:crypto';

// A read-aloud alphabet: no 0/O, 1/I/L — an admin reads the code to whoever is
// at the till, and those are the characters that get misheard and mistyped.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 30 chars
export const CODE_LEN = 10;                                // 30^10 ≈ 5.9e14 combinations
export const EXPIRES_MS = 15 * 60 * 1000;                  // 15 minutes

/** Rejection-sampled so the modulo bias toward the first `256 % 30` letters is gone. */
export function makeCode(): string {
  let out = '';
  while (out.length < CODE_LEN) {
    const b = crypto.randomBytes(1)[0];
    if (b >= 256 - (256 % ALPHABET.length)) continue; // drop the biased tail
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/** Codes are compared and stored by hash; the raw is never persisted. */
export function hashCode(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim().toUpperCase()).digest('hex');
}

/** ISO timestamp `EXPIRES_MS` from now — the code's death clock. */
export function expiryFromNow(now: number = Date.now()): string {
  return new Date(now + EXPIRES_MS).toISOString();
}
