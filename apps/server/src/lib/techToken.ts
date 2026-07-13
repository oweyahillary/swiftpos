/**
 * techToken.ts — SwiftPOS asymmetric tech-access tokens (v2)
 * ─────────────────────────────────────────────────────────────────────────────
 * The desktop tech panel must be reachable on-site even when the till is fully
 * offline (the tech is often there *because* the connection is down). So tokens
 * are signed with an Ed25519 PRIVATE key held only on the server, and verified
 * with the matching PUBLIC key — which the desktop embeds/caches. A device can
 * therefore verify a token with no internet, but can never MINT one (it lacks
 * the private key). This is the key difference from the legacy HMAC tokens,
 * whose secret would have to live on every till to verify offline.
 *
 * Token format (v2):   st2.<base64url(payload)>.<base64url(ed25519 signature)>
 *   payload = { techId, techName, branchId, businessId, scope, iat, exp }
 *   exp is the TOKEN validity (48h, so it can be issued ahead of a visit).
 *   The 4-hour active *session* a token opens is enforced on the device, not here.
 *
 * Keys come from env in production:
 *   TECH_SIGNING_PRIVATE_KEY  (PKCS#8 PEM)  — server only, never shipped
 *   TECH_SIGNING_PUBLIC_KEY   (SPKI PEM)    — delivered to devices
 * In non-production, if they are unset an EPHEMERAL keypair is generated at
 * startup (nothing is committed). In production the server refuses to start
 * unless both are provided.
 */

import crypto from 'crypto';

// ── Signing keys ─────────────────────────────────────────────────────────────
// Production MUST supply both keys via env — there is no committed fallback, so
// there is nothing to leak or to trust by accident. In non-production, if the
// env vars are unset we generate an EPHEMERAL keypair at startup so local dev
// works out of the box; those tokens are only valid until the next restart and
// a device must fetch the current public key to verify them.
function loadSigningKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const envPriv = process.env.TECH_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const envPub  = process.env.TECH_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (envPriv && envPub) return { privateKeyPem: envPriv, publicKeyPem: envPub };

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'techToken: TECH_SIGNING_PRIVATE_KEY and TECH_SIGNING_PUBLIC_KEY must be set in ' +
      'production. Refusing to start without an explicitly provisioned Ed25519 keypair.'
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  console.warn(
    '[techToken] No TECH_SIGNING_* keys set — generated an EPHEMERAL dev keypair. ' +
    'Tokens are invalid after restart and must never be used in production.'
  );
  return {
    privateKeyPem: (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
    publicKeyPem:  (publicKey.export({ type: 'spki', format: 'pem' }) as string),
  };
}

const _keys = loadSigningKeys();
const PRIVATE_KEY_PEM = _keys.privateKeyPem;
export const PUBLIC_KEY_PEM = _keys.publicKeyPem;

const TOKEN_PREFIX = 'st2';
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h token validity

export interface TechTokenPayload {
  techId:     string;
  techName:   string;
  branchId:   string;
  businessId: string;
  scope:      string;
  iat:        number; // issued-at (epoch seconds)
  exp:        number; // expiry   (epoch seconds)
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Sign a new Ed25519 tech token (server-side; needs the private key). */
export function signTechToken(input: {
  techId: string; techName: string; branchId: string; businessId: string; scope?: string;
}): { token: string; payload: TechTokenPayload } {
  const now = Date.now();
  const payload: TechTokenPayload = {
    techId:     input.techId,
    techName:   input.techName,
    branchId:   input.branchId,
    businessId: input.businessId,
    scope:      input.scope ?? 'tech',
    iat:        Math.floor(now / 1000),
    exp:        Math.floor((now + TOKEN_TTL_MS) / 1000),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signature  = crypto.sign(null, Buffer.from(payloadB64), PRIVATE_KEY_PEM);
  const token      = `${TOKEN_PREFIX}.${payloadB64}.${b64url(signature)}`;
  return { token, payload };
}

/**
 * Verify an Ed25519 tech token against a public key (default: server's own).
 * Checks the signature and expiry only — branch scoping and single-use are the
 * caller's responsibility (and on the device, the monotonic clock floor guards
 * expiry against clock rollback). Returns the payload or null.
 */
export function verifyTechToken(token: string, publicKeyPem: string = PUBLIC_KEY_PEM): TechTokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, payloadB64, sigB64] = parts;
    const ok = crypto.verify(null, Buffer.from(payloadB64), publicKeyPem, Buffer.from(sigB64, 'base64url'));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as TechTokenPayload;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Per-branch reveal code ──────────────────────────────────────────────────
// The "doorknock" the tech keys after long-pressing the logo. It only reveals
// the token prompt — it grants nothing on its own — so it is a low-value secret.
// 8 alphanumeric chars, ambiguous characters (0/O, 1/I/L) removed so it's easy
// to read off a screen and key in. Distinct length from 4–6 digit staff PINs.
const REVEAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateRevealCode(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += REVEAL_ALPHABET[bytes[i] % REVEAL_ALPHABET.length];
  return out;
}
