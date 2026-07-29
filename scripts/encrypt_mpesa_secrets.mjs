/**
 * scripts/encrypt_mpesa_secrets.mjs
 *
 * One-time backfill for audit H9: encrypts any business_settings rows for
 * mpesa_consumer_secret / mpesa_passkey that are still plaintext (pre-dating
 * this fix). Safe to run more than once — already-encrypted rows (prefixed
 * 'v1:') are skipped. Mirrors scripts/encrypt_webhook_secrets.mjs (H7).
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ENCRYPTION_KEY
 * (must be the SAME key the running server uses, or nothing already
 * encrypted will decrypt correctly).
 *
 * Run once, after APP_ENCRYPTION_KEY is provisioned (render.yaml) and the
 * business.ts / mpesa.ts code changes are deployed:
 *   node scripts/encrypt_mpesa_secrets.mjs
 */
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encKeyRaw = process.env.APP_ENCRYPTION_KEY;

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!encKeyRaw) {
  console.error('APP_ENCRYPTION_KEY is required — encryptSecret() fails closed without it.');
  process.exit(1);
}

// Mirrors lib/crypto.ts exactly (kept standalone so this script has no
// dependency on the compiled server build).
function getKey() {
  if (/^[0-9a-fA-F]{64}$/.test(encKeyRaw)) return Buffer.from(encKeyRaw, 'hex');
  try {
    const b = Buffer.from(encKeyRaw, 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return crypto.createHash('sha256').update(encKeyRaw).digest();
}
function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

const supabase = createClient(url, serviceKey);

const KEYS_TO_ENCRYPT = ['mpesa_consumer_secret', 'mpesa_passkey'];

const { data: rows, error } = await supabase
  .from('business_settings')
  .select('id, business_id, key, value')
  .in('key', KEYS_TO_ENCRYPT);

if (error) { console.error('Failed to read business_settings:', error.message); process.exit(1); }

const toMigrate = (rows ?? []).filter(r => typeof r.value === 'string' && r.value && !r.value.startsWith('v1:'));
console.log(`Found ${rows?.length ?? 0} matching row(s) across all businesses, ${toMigrate.length} plaintext to encrypt.`);

for (const row of toMigrate) {
  const encrypted = encryptSecret(row.value);
  const { error: updErr } = await supabase.from('business_settings').update({ value: encrypted }).eq('id', row.id);
  if (updErr) console.error(`  ✗ business ${row.business_id} / ${row.key}: ${updErr.message}`);
  else console.log(`  ✓ business ${row.business_id} / ${row.key} encrypted`);
}

console.log('Done.');
