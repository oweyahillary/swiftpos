/**
 * test-migration-179.mjs — A597 (owner, 2026-10-27): the owner's brand colours, business_branding.primary_hex and
 * secondary_hex — nullable, lower-case #rrggbb only (the format; never a legibility rule). Idempotent. Run for real
 * against the WHOLE schema (every migration before 179 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: either CHECK dropped → "only #rrggbb" fails; the IF NOT EXISTS guard on a constraint dropped →
 * "runs, and again" fails (the second ADD CONSTRAINT errors); the schema_migrations insert dropped → "recording itself" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '179_brand_colours.sql';
for (const f of files.filter((f) => num(f) < 179)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};


console.log('\nMigration 179 (brand colours: business_branding.primary_hex / secondary_hex) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B2 = id(0xb);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('businesses', { id: B2, name: 'Sample Cafe', type: 'restaurant' });
await put('business_branding', { business_id: A, accent_hex: '#0d9488', theme_id: 'ocean' });
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('179 runs, and again (idempotent), recording itself once', async () => {
  await db.exec(sanitize(sql)); await db.exec(sanitize(sql));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '179_brand_colours'`)).n, 1);
});
await ok('an existing branding row keeps its values; both colours start NULL (not chosen)', async () => {
  const r = await one(`SELECT accent_hex, theme_id, primary_hex, secondary_hex FROM public.business_branding WHERE business_id = $1`, [A]);
  assert.deepEqual([r.accent_hex, r.theme_id, r.primary_hex, r.secondary_hex], ['#0d9488', 'ocean', null, null]);
});
await ok('any #rrggbb colour is stored — white, black, yellow, mid-grey', async () => {
  for (const [p, s] of [['#ffffff', '#000000'], ['#ffff00', '#808080']]) {
    await db.query(`UPDATE public.business_branding SET primary_hex = $2, secondary_hex = $3 WHERE business_id = $1`, [A, p, s]);
    const r = await one(`SELECT primary_hex, secondary_hex FROM public.business_branding WHERE business_id = $1`, [A]);
    assert.deepEqual([r.primary_hex, r.secondary_hex], [p, s]);
  }
});
await ok('only #rrggbb (lower case) or NULL — a name, #rgb, upper case or junk is refused', async () => {
  for (const bad of ['red', '#fff', '#FFFFFF', '#12345g', 'ffffff', '#1234567']) {
    await assert.rejects(db.query(`UPDATE public.business_branding SET primary_hex = $2 WHERE business_id = $1`, [A, bad]), undefined, `primary ${bad}`);
    await assert.rejects(db.query(`UPDATE public.business_branding SET secondary_hex = $2 WHERE business_id = $1`, [A, bad]), undefined, `secondary ${bad}`);
  }
  await db.query(`UPDATE public.business_branding SET primary_hex = NULL, secondary_hex = NULL WHERE business_id = $1`, [A]);
});
await ok('a new business\'s row may carry only the colours', async () => {
  await db.query(`INSERT INTO public.business_branding (business_id, primary_hex) VALUES ($1, '#e11d48')`, [B2]);
  const r = await one(`SELECT primary_hex, secondary_hex, theme_id FROM public.business_branding WHERE business_id = $1`, [B2]);
  assert.deepEqual([r.primary_hex, r.secondary_hex, r.theme_id], ['#e11d48', null, null]);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
