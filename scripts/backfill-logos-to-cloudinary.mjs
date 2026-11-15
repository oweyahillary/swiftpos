/**
 * backfill-logos-to-cloudinary.mjs — ONE-TIME: move each business's base64 brand logo (business_branding.logo_png) to
 * Cloudinary and store the URL on businesses.logo_url, then null the base64. This realises the egress saving for every
 * EXISTING business (new uploads already go to Cloudinary via the Branding page). Idempotent, and a DRY RUN by default.
 *
 * The OWNER runs this against production (Claude never touches prod). New uploads already use Cloudinary, and the readers
 * fall back to logo_png until a business is migrated — so this can run any time, in one pass or in batches, safely.
 *
 * Env (required):
 *   SUPABASE_URL                 the project's URL
 *   SUPABASE_SERVICE_ROLE_KEY    the service role key (bypasses RLS; prod secret — keep it out of shells/history)
 *   CLOUDINARY_CLOUD_NAME        same cloud the app uses (dashboard VITE_CLOUDINARY_CLOUD_NAME)
 *   CLOUDINARY_UPLOAD_PRESET     same unsigned preset the app uses (VITE_CLOUDINARY_UPLOAD_PRESET)
 *
 * Run:
 *   node scripts/backfill-logos-to-cloudinary.mjs            # DRY RUN — lists what it would do, uploads/writes nothing
 *   node scripts/backfill-logos-to-cloudinary.mjs --execute  # actually upload to Cloudinary + write the DB
 *   node scripts/backfill-logos-to-cloudinary.mjs --execute --limit 5   # do at most 5 (batch / smoke test)
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RASTER = /^data:image\/(?:png|jpe?g);base64,/i;

/**
 * The pure per-row decision (exported for the test). Given a business's current logo_png (base64 or null) and its
 * businesses.logo_url, decide what the backfill does: skip one already on a URL, skip one whose logo_png is not a
 * png/jpeg data-URI (e.g. already cleared, or an unexpected value), else upload it.
 */
export function planForRow(row) {
  const url = typeof row?.logo_url === 'string' ? row.logo_url.trim() : '';
  if (url) return { action: 'skip-has-url' };
  const png = typeof row?.logo_png === 'string' ? row.logo_png : '';
  if (!RASTER.test(png)) return { action: 'skip-bad-format' };
  return { action: 'upload', kb: Math.round((png.length * 0.75) / 1024) };
}

/** POST a base64 data-URI to Cloudinary's unsigned upload endpoint and return the secure_url. */
async function uploadToCloudinary(dataUri, cloudName, preset) {
  const body = new URLSearchParams({ file: dataUri, upload_preset: preset });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.secure_url) throw new Error('Cloudinary returned no secure_url');
  return j.secure_url;
}

async function main() {
  const EXECUTE = process.argv.includes('--execute');
  const li = process.argv.indexOf('--limit');
  const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : Infinity;
  const env = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_UPLOAD_PRESET'];
  const missing = env.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(1); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } = process.env;

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  console.log(EXECUTE ? '== EXECUTE: uploading to Cloudinary + writing the DB ==' : '== DRY RUN (no writes). Add --execute to apply ==');
  // Every business that still carries a base64 logo, with its businesses.logo_url so we can skip migrated ones.
  const { data: rows, error } = await supabase
    .from('business_branding')
    .select('business_id, logo_png, businesses!inner(id, name, logo_url)')
    .not('logo_png', 'is', null);
  if (error) { console.error('read failed:', error.message); process.exit(1); }

  let uploaded = 0, skipped = 0, failed = 0;
  for (const r of rows ?? []) {
    const biz = Array.isArray(r.businesses) ? r.businesses[0] : r.businesses;   // embed may be array or object
    const name = biz?.name ?? r.business_id;
    const plan = planForRow({ logo_png: r.logo_png, logo_url: biz?.logo_url });
    if (plan.action !== 'upload') { console.log(`skip  ${name} — ${plan.action === 'skip-has-url' ? 'already on a URL' : 'logo_png not a png/jpeg data-URI'}`); skipped++; continue; }
    if (uploaded >= LIMIT) { console.log(`stop  reached --limit ${LIMIT}`); break; }
    if (!EXECUTE) { console.log(`would upload ${name} (${plan.kb} KB) → Cloudinary, then null logo_png`); uploaded++; continue; }
    try {
      const url = await uploadToCloudinary(r.logo_png, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET);
      const { error: e1 } = await supabase.from('businesses').update({ logo_url: url }).eq('id', r.business_id);
      if (e1) throw new Error(`businesses.logo_url: ${e1.message}`);
      const { error: e2 } = await supabase.from('business_branding').update({ logo_png: null }).eq('business_id', r.business_id);
      if (e2) throw new Error(`business_branding.logo_png: ${e2.message}`);
      console.log(`done  ${name} → ${url}`);
      uploaded++;
    } catch (e) { console.error(`FAIL  ${name}: ${e.message}`); failed++; }
  }
  console.log(`\n${EXECUTE ? 'applied' : 'would apply'}: ${uploaded} · skipped: ${skipped} · failed: ${failed}`);
  process.exit(failed ? 1 : 0);
}

// Run only when invoked directly (the test imports planForRow without running main).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
