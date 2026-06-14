/**
 * deviceFingerprint.ts — Stable browser device fingerprint.
 *
 * Generates a short hash from stable browser attributes that won't change
 * between page loads but will change on a different device.
 *
 * We intentionally avoid canvas fingerprinting or aggressive entropy
 * gathering — this is an access control hint, not forensic tracking.
 * The User-Agent (collected server-side) is the primary discriminator;
 * this client hint adds screen/timezone stability for multi-user shared devices.
 *
 * The hash is sent as `device_hint` in the pos-login request body.
 * Server combines it with the User-Agent for the final fingerprint.
 */

export async function getDeviceHint(): Promise<string> {
  const parts = [
    navigator.language ?? '',
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency ?? ''),
  ].join('|');

  // SHA-256 via SubtleCrypto (available in all modern browsers, no dependency)
  try {
    const encoded = new TextEncoder().encode(parts);
    const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    // SubtleCrypto unavailable (non-HTTPS in dev) — return a coarser hint
    return btoa(parts).slice(0, 16).replace(/[+/=]/g, '0');
  }
}
