// SwiftPOS — at-rest secret encryption (AES-256-GCM).
//
// Used for secrets we must store but never expose: eTIMS control-unit comms keys
// (cmc_key) and similar. The key comes from APP_ENCRYPTION_KEY (32 bytes, hex or
// base64, or any string which we hash to 32 bytes). Output format:
//   v1:<ivB64>:<tagB64>:<cipherB64>
// so we can rotate the scheme later by version prefix.
//
// If APP_ENCRYPTION_KEY is unset we fail closed on encrypt (so a plaintext secret
// never silently lands in the DB) but pass through on decrypt of already-plain
// legacy values (prefix not 'v1:').

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is not set');
  // Accept hex (64 chars) or base64 (44 chars) directly; otherwise derive 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored?.startsWith('v1:')) return stored; // legacy plaintext — pass through
  const [, ivB64, tagB64, dataB64] = stored.split(':');
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored?.startsWith('v1:');
}
